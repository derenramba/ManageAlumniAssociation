'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, startServer, loginAdmin, createAdmin } = require('./helpers');

let srv; let admin; let eid;
const one = (sql, ...a) => db.get().prepare(sql).get(...a);

before(async () => {
  srv = await startServer();
  createAdmin({ username: 'chief', fullName: 'Chief Admin', password: 'ChiefPass123' });
  admin = await loginAdmin(srv.base, 'chief', 'ChiefPass123');
  await admin.post('/admin/elections', { name: 'Import test election' });
  eid = one('SELECT id FROM elections ORDER BY id DESC').id;
});
after(() => srv.close());

async function upload(csv) {
  const fd = new FormData();
  fd.append('_csrf', admin.csrf());
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'voters.csv');
  const res = await fetch(srv.base + '/admin/import', { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: admin.cookieHeader() } });
  assert.equal(res.status, 303);
  const id = new URL(res.headers.get('location'), srv.base).searchParams.get('id');
  const preview = await admin.get(`/admin/import?id=${id}`);
  return { id, preview: preview.text };
}

test('import flags issues and repeat imports never duplicate voters', async () => {
  const csv = 'Member ID,Name,E-mail,Phone,Batch\n' +
    'M1,Asha Rao,asha@example.org,+91 90000 00001,2001\n' +
    'M2,Ravi Rao,asha@example.org,+91 90000 00002,2002\n' +
    'M3,No Email Person,,+91 90000 00003,2003\n' +
    'M4,Bad Email,not-an-email,,2004\n' +
    'M1,Asha Rao Again,asha2@example.org,,2001\n' +
    ',,,,\n';
  const { id, preview } = await upload(csv);
  assert.match(preview, /Possible duplicate: same email as row 2/);
  assert.match(preview, /Missing email/);
  assert.match(preview, /Invalid email/);
  assert.match(preview, /Duplicate Voter ID in file/);
  await admin.post(`/admin/import/${id}/apply`, { eligibility: 'pending' });
  assert.equal(one('SELECT COUNT(*) n FROM voters WHERE election_id = ?', eid).n, 4);
  // Both people sharing an email are kept (not disqualified)
  assert.equal(one("SELECT COUNT(*) n FROM voters WHERE email = 'asha@example.org'").n, 2);

  // Re-import the same people (one with updated phone, one without Voter ID but same name+email)
  const again = await upload('Voter ID,Full Name,Email,Mobile,Batch\nM1,Asha Rao,asha@example.org,+91 99999 99999,2001\n,No Email Person,,+91 90000 00003,2003\nM9,New Person,new@example.org,,2010\n');
  await admin.post(`/admin/import/${again.id}/apply`, { eligibility: 'pending' });
  assert.equal(one('SELECT COUNT(*) n FROM voters WHERE election_id = ?', eid).n, 5);
  assert.equal(one("SELECT mobile FROM voters WHERE voter_ref = 'M1'").mobile, '+91 99999 99999');
  // Applying the same preview twice does nothing
  await admin.post(`/admin/import/${again.id}/apply`, { eligibility: 'pending' });
  assert.equal(one('SELECT COUNT(*) n FROM voters WHERE election_id = ?', eid).n, 5);
});
