'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, startServer, loginAdmin, createAdmin } = require('./helpers');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const { generateCode } = require('../src/lib/codes');

let srv; let admin; let eid;
const one = (sql, ...a) => db.get().prepare(sql).get(...a);
const all = (sql, ...a) => db.get().prepare(sql).all(...a);

before(async () => {
  srv = await startServer();
  createAdmin({ username: 'chief', fullName: 'Chief Admin', password: 'ChiefPass123' });
  admin = await loginAdmin(srv.base, 'chief', 'ChiefPass123');
  await admin.post('/admin/elections', { name: 'Backup email election' });
  eid = one('SELECT id FROM elections ORDER BY id DESC').id;
  const d = db.get();
  const add = d.prepare("INSERT INTO voters (election_id, voter_ref, full_name, email, eligibility) VALUES (?, ?, ?, ?, 'eligible')");
  add.run(eid, 'B1', 'Asha Rao', 'asha@example.com');
  add.run(eid, 'B2', 'Vikram Shah', 'vikram@example.com');
  for (const v of all('SELECT id FROM voters WHERE election_id = ?', eid)) {
    d.prepare("INSERT INTO voting_codes (election_id, voter_id, code, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(eid, v.id, generateCode(), new Date().toISOString());
  }
  d.prepare('UPDATE elections SET voter_list_approved_at = ? WHERE id = ?').run(new Date().toISOString(), eid);
});
after(() => srv.close());

test('main account over its limit: emails go out through the backup account', async () => {
  const oldSmtp = { ...config.smtp, backup: { ...config.smtp.backup } };
  Object.assign(config.smtp, { host: 'smtp.gmail.com', user: 'main@gmail.com', pass: 'x', from: 'MANAGE Alumni Association Elections <main@gmail.com>' });
  Object.assign(config.smtp.backup, { host: 'smtp.gmail.com', user: 'backup@gmail.com', pass: 'y', from: '' });
  const mainSent = []; const backupSent = [];
  mailer.setTransport({ sendMail: async (m) => { mainSent.push(m); throw new Error('550 5.4.5 Daily user sending limit exceeded'); } });
  mailer.setBackupTransport({ sendMail: async (m) => { backupSent.push(m); return { messageId: 'b' + backupSent.length }; } });
  try {
    const r = await admin.get('/admin/invitations');
    assert.match(r.text, /Backup email account: <strong>backup@gmail.com/);
    await admin.post('/admin/invitations/send', { mode: 'unsent', confirm: 'yes' });
    await mailer.processQueue(10);
    const rows = all("SELECT status FROM invitations WHERE election_id = ? AND channel = 'email'", eid);
    assert.deepEqual(rows.map((x) => x.status), ['sent', 'sent']);
    assert.equal(mainSent.length, 1, 'after the first failure the main account is skipped');
    assert.equal(backupSent.length, 2);
    assert.equal(backupSent[0].from, '"MANAGE Alumni Association Elections" <backup@gmail.com>');
  } finally {
    Object.assign(config.smtp, oldSmtp);
    mailer.setTransport(null);
    mailer.setBackupTransport(null);
  }
});
