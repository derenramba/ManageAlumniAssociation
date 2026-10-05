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
  await admin.post('/admin/elections', { name: 'SMS test election' });
  eid = one('SELECT id FROM elections ORDER BY id DESC').id;
  const d = db.get();
  const add = d.prepare("INSERT INTO voters (election_id, voter_ref, full_name, mobile, whatsapp, eligibility) VALUES (?, ?, ?, ?, ?, 'eligible')");
  add.run(eid, 'S1', 'Mr. Ravi Teja', '98480 22338', null);
  add.run(eid, 'S2', 'Ms. Anna Smith', '+44 7700 900456', null);
  add.run(eid, 'S3', 'Nobody', null, null);
  for (const v of all('SELECT id FROM voters WHERE election_id = ?', eid)) {
    d.prepare("INSERT INTO voting_codes (election_id, voter_id, code, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(eid, v.id, generateCode(), new Date().toISOString());
  }
  d.prepare('UPDATE elections SET voter_list_approved_at = ? WHERE id = ?').run(new Date().toISOString(), eid);
});
after(() => srv.close());

test('test mode SMS: own code per voter, stored in outbox', async () => {
  const r = await admin.get('/admin/invitations/confirm?mode=unsent&channel=sms');
  assert.match(r.text, /send SMS messages to 2 eligible voters/);
  await admin.post('/admin/invitations/send', { mode: 'unsent', channel: 'sms', confirm: 'yes' });
  await mailer.processQueue(20);
  const rows = all(`SELECT i.*, c.code FROM invitations i JOIN voting_codes c ON c.id = i.code_id WHERE i.channel = 'sms' ORDER BY i.to_email`);
  assert.deepEqual(rows.map((x) => [x.to_email, x.status]), [['+447700900456', 'sent'], ['+919848022338', 'sent']]);
  for (const x of rows) assert.ok(one('SELECT body_text FROM email_outbox WHERE invitation_id = ?', x.id).body_text.includes(formatCode(x.code)));
});

test('connected SMS: calls Twilio and records delivery from the signed callback', async () => {
  Object.assign(config.twilio, { accountSid: 'AC123', authToken: 'tok', from: '+15005550006' });
  const oldBase = config.publicBaseUrl;
  config.publicBaseUrl = 'https://vote.test';
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.twilio.com/')) return realFetch(url, opts);
    calls.push({ url, auth: opts.headers.Authorization, form: Object.fromEntries(new URLSearchParams(opts.body)) });
    return new Response(JSON.stringify({ sid: 'SM' + calls.length }), { status: 201 });
  };
  try {
    const v1 = one("SELECT id FROM voters WHERE voter_ref = 'S1'").id;
    await admin.post(`/admin/invitations/voter/${v1}/send`, { channel: 'sms', confirm: 'yes' });
    await mailer.processQueue(10);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal(calls[0].auth, 'Basic ' + Buffer.from('AC123:tok').toString('base64'));
    assert.equal(calls[0].form.To, '+919848022338');
    assert.equal(calls[0].form.From, '+15005550006');
    assert.equal(calls[0].form.StatusCallback, 'https://vote.test/webhooks/twilio');
    const code = one("SELECT code FROM voting_codes WHERE voter_id = ? AND status = 'active'", v1).code;
    assert.ok(calls[0].form.Body.includes(formatCode(code)));
    assert.doesNotMatch(calls[0].form.Body, /[–—]/);

    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], 'https://vote.test/webhooks/twilio');
    const sig = crypto.createHmac('sha1', 'tok').update(data).digest('base64');
    let r = await fetch(`${srv.base}/webhooks/twilio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' }, body: new URLSearchParams(params) });
    assert.equal(r.status, 403);
    r = await fetch(`${srv.base}/webhooks/twilio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params) });
    assert.equal(r.status, 200);
    assert.equal(one("SELECT status FROM invitations WHERE provider_message_id = 'SM1'").status, 'delivered');
  } finally {
    global.fetch = realFetch;
    config.publicBaseUrl = oldBase;
    Object.assign(config.twilio, { accountSid: '', authToken: '', from: '' });
  }
});

test('WhatsApp through Twilio: Content Template with five variables, failure from signed callback', async () => {
  Object.assign(config.twilio, { accountSid: 'AC123', authToken: 'tok', from: '', whatsappFrom: '+14155238886', whatsappContentSid: 'HX0123' });
  const oldBase = config.publicBaseUrl;
  config.publicBaseUrl = 'https://vote.test';
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.twilio.com/')) return realFetch(url, opts);
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(opts.body)) });
    return new Response(JSON.stringify({ sid: 'MMWA' + calls.length }), { status: 201 });
  };
  try {
    const r0 = await admin.get('/admin/invitations');
    assert.match(r0.text, /Connected via Twilio/);
    const v2 = one("SELECT id FROM voters WHERE voter_ref = 'S2'").id;
    await admin.post(`/admin/invitations/voter/${v2}/send`, { channel: 'whatsapp', confirm: 'yes' });
    await mailer.processQueue(10);
    assert.equal(calls.length, 1);
    const f = calls[0].form;
    assert.equal(f.To, 'whatsapp:+447700900456');
    assert.equal(f.From, 'whatsapp:+14155238886');
    assert.equal(f.ContentSid, 'HX0123');
    assert.equal(f.StatusCallback, 'https://vote.test/webhooks/twilio');
    const vars = JSON.parse(f.ContentVariables);
    const code = one("SELECT code FROM voting_codes WHERE voter_id = ? AND status = 'active'", v2).code;
    assert.equal(vars['1'], 'Anna');
    assert.equal(vars['3'], formatCode(code));
    assert.equal(vars['4'], 'https://vote.test/');

    const params = { MessageSid: 'MMWA1', MessageStatus: 'undelivered', ErrorCode: '63016' };
    const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], 'https://vote.test/webhooks/twilio');
    const sig = crypto.createHmac('sha1', 'tok').update(data).digest('base64');
    const r = await fetch(`${srv.base}/webhooks/twilio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params) });
    assert.equal(r.status, 200);
    const inv = one("SELECT status, error FROM invitations WHERE provider_message_id = 'MMWA1'");
    assert.equal(inv.status, 'failed');
    assert.match(inv.error, /WhatsApp message could not be delivered.*63016/);
  } finally {
    global.fetch = realFetch;
    config.publicBaseUrl = oldBase;
    Object.assign(config.twilio, { accountSid: '', authToken: '', from: '', whatsappFrom: '', whatsappContentSid: '' });
  }
});
