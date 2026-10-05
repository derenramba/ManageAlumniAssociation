'use strict';
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, startServer, loginAdmin, createAdmin } = require('./helpers');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const { formatCode, generateCode } = require('../src/lib/codes');

let srv; let admin; let eid;
const one = (sql, ...a) => db.get().prepare(sql).get(...a);
const all = (sql, ...a) => db.get().prepare(sql).all(...a);

before(async () => {
  srv = await startServer();
  createAdmin({ username: 'chief', fullName: 'Chief Admin', password: 'ChiefPass123' });
  admin = await loginAdmin(srv.base, 'chief', 'ChiefPass123');
  await admin.post('/admin/elections', { name: 'WhatsApp test election' });
  eid = one('SELECT id FROM elections ORDER BY id DESC').id;
  const d = db.get();
  const add = d.prepare("INSERT INTO voters (election_id, voter_ref, full_name, email, mobile, whatsapp, batch, eligibility) VALUES (?, ?, ?, ?, ?, ?, '2012-14', 'eligible')");
  add.run(eid, 'W1', 'Mr. Arun Kumar', 'a@example.org', '9037057089', null);
  add.run(eid, 'W2', 'Dr. Priya Rao', null, '+1 559 862 9663', null);
  add.run(eid, 'W3', 'No Phone Person', 'c@example.org', null, null);
  add.run(eid, 'W4', 'Separate WhatsApp', null, '9000000001', '+44 7700 900123');
  d.prepare('UPDATE elections SET voter_list_approved_at = ? WHERE id = ?').run(new Date().toISOString(), eid);
  for (const v of all('SELECT id FROM voters WHERE election_id = ?', eid)) {
    d.prepare("INSERT INTO voting_codes (election_id, voter_id, code, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(eid, v.id, generateCode(), new Date().toISOString());
  }
});
after(() => srv.close());

test('test mode: each voter gets their own code on their own number; no phone is skipped', async () => {
  let r = await admin.get('/admin/invitations/confirm?mode=unsent&channel=whatsapp');
  assert.match(r.text, /send WhatsApp messages to 3 eligible voters/);
  await admin.post('/admin/invitations/send', { mode: 'unsent', channel: 'whatsapp', confirm: 'yes' });
  await mailer.processQueue(50);
  const sent = all(`SELECT i.*, c.code, v.full_name FROM invitations i JOIN voting_codes c ON c.id = i.code_id JOIN voters v ON v.id = i.voter_id
    WHERE i.channel = 'whatsapp' ORDER BY v.voter_ref`);
  assert.deepEqual(sent.map((s) => [s.full_name, s.to_email, s.status]), [
    ['Mr. Arun Kumar', '+919037057089', 'sent'],
    ['Dr. Priya Rao', '+15598629663', 'sent'],
    ['Separate WhatsApp', '+447700900123', 'sent'],
  ]);
  for (const s of sent) {
    const msg = one('SELECT * FROM email_outbox WHERE invitation_id = ?', s.id);
    assert.equal(msg.channel, 'whatsapp');
    assert.ok(msg.body_text.includes(formatCode(s.code)));
    for (const o of sent.filter((x) => x.id !== s.id)) assert.ok(!msg.body_text.includes(formatCode(o.code)));
  }
  assert.match(one("SELECT body_text FROM email_outbox WHERE to_email = '+919037057089'").body_text, /^Dear Arun,/);
  // Email invitations are tracked separately and are still unsent
  r = await admin.get('/admin/invitations/confirm?mode=unsent');
  assert.match(r.text, /send voting invitations to 2 eligible voters/);
  // Nothing left to send on WhatsApp; a resend keeps the same code
  r = await admin.get('/admin/invitations/confirm?mode=unsent&channel=whatsapp');
  assert.match(r.text, /no voters to send to/);
  const v1 = one("SELECT id FROM voters WHERE voter_ref = 'W1'").id;
  await admin.post(`/admin/invitations/voter/${v1}/send`, { channel: 'whatsapp', confirm: 'yes' });
  await mailer.processQueue(10);
  const both = all("SELECT code_id, kind FROM invitations WHERE voter_id = ? AND channel = 'whatsapp' ORDER BY id", v1);
  assert.equal(both.length, 2);
  assert.equal(both[1].kind, 'resend');
  assert.equal(both[0].code_id, both[1].code_id);
});

test('connected mode: sends the approved template and records delivery from the signed webhook', async () => {
  Object.assign(config.whatsapp, { token: 'test-token', phoneNumberId: '123456', appSecret: 'shh', verifyToken: 'verify-me' });
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://graph.facebook.com/')) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    calls.push({ url, body, auth: opts.headers.Authorization });
    if (body.to === '15598629663') return new Response(JSON.stringify({ error: { message: 'Recipient is not a valid WhatsApp user', code: 131026 } }), { status: 400 });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${body.to}` }] }), { status: 200 });
  };
  try {
    const d = db.get();
    const v1 = one("SELECT id FROM voters WHERE voter_ref = 'W1'").id;
    const v2 = one("SELECT id FROM voters WHERE voter_ref = 'W2'").id;
    await admin.post('/admin/invitations/confirm', { ids: [String(v1), String(v2)], channel: 'whatsapp' });
    await admin.post('/admin/invitations/send', { mode: 'selected', channel: 'whatsapp', ids: [String(v1), String(v2)], confirm: 'yes' });
    await mailer.processQueue(10);
    assert.equal(calls.length, 2);
    const c1 = calls.find((c) => c.body.to === '919037057089');
    assert.equal(c1.url, 'https://graph.facebook.com/v21.0/123456/messages');
    assert.equal(c1.auth, 'Bearer test-token');
    assert.equal(c1.body.template.name, 'voting_code');
    const code1 = one("SELECT code FROM voting_codes WHERE voter_id = ? AND status = 'active'", v1).code;
    assert.deepEqual(c1.body.template.components[0].parameters.map((p) => p.text).slice(0, 3), ['Arun', 'WhatsApp test election', formatCode(code1)]);
    const last1 = one("SELECT * FROM invitations WHERE voter_id = ? AND channel = 'whatsapp' ORDER BY id DESC", v1);
    assert.equal(last1.status, 'sent');
    assert.equal(last1.provider_message_id, 'wamid.919037057089');
    const last2 = one("SELECT * FROM invitations WHERE voter_id = ? AND channel = 'whatsapp' ORDER BY id DESC", v2);
    assert.equal(last2.status, 'failed');
    assert.match(last2.error, /not a valid WhatsApp user/);

    // Webhook: verification handshake and signed status update
    let r = await fetch(`${srv.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
    assert.equal(await r.text(), '42');
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.919037057089', status: 'delivered' }] } }] }] });
    r = await fetch(`${srv.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body: payload });
    assert.equal(r.status, 403);
    const sig = `sha256=${crypto.createHmac('sha256', 'shh').update(payload).digest('hex')}`;
    r = await fetch(`${srv.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
    assert.equal(r.status, 200);
    assert.equal(one('SELECT status FROM invitations WHERE id = ?', last1.id).status, 'delivered');
    // Failed WhatsApp never affects eligibility or the code
    assert.equal(one("SELECT status FROM voting_codes WHERE voter_id = ? AND status = 'active'", v2).status, 'active');
    void d;
  } finally {
    global.fetch = realFetch;
    Object.assign(config.whatsapp, { token: '', phoneNumberId: '', appSecret: '', verifyToken: '' });
  }
});
