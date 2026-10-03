'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, startServer, Client, loginAdmin, createAdmin } = require('./helpers');
const mailer = require('../src/lib/mailer');
const { formatCode } = require('../src/lib/codes');

let srv;
let admin;
let electionId;
const q = (sql, ...a) => db.get().prepare(sql).all(...a);
const one = (sql, ...a) => db.get().prepare(sql).get(...a);

before(async () => {
  srv = await startServer();
  createAdmin({ username: 'chief', fullName: 'Chief Admin', password: 'ChiefPass123' });
  createAdmin({ username: 'auditor', fullName: 'Audit Person', password: 'AuditPass123', role: 'auditor' });
  admin = await loginAdmin(srv.base, 'chief', 'ChiefPass123');
});
after(() => srv.close());

test('admin sets up an election end to end', async () => {
  let r = await admin.post('/admin/elections', { name: 'MANAGE Alumni Association Election', term: '2026-2028' });
  assert.equal(r.status, 303);
  electionId = one('SELECT id FROM elections ORDER BY id DESC').id;
  const positions = q('SELECT * FROM positions WHERE election_id = ? ORDER BY sort_order', electionId);
  assert.deepEqual(positions.map((p) => p.title), ['President', 'Vice President', 'General Secretary', 'Joint Secretary', 'Treasurer']);

  const opens = new Date(Date.now() - 60e3);
  const closes = new Date(Date.now() + 864e5);
  const local = (d) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 16);
  r = await admin.post('/admin/election', { name: 'MANAGE Alumni Association Election', term: '2026-2028', opens_at: local(new Date(Date.now() + 3600e3)), closes_at: local(closes), support_email: 'help@example.org', show_turnout_publicly: '1', public_results_show_totals: '1' });
  assert.equal(r.status, 303);
  assert.ok(one('SELECT closes_at FROM elections WHERE id = ?', electionId).closes_at);

  // Candidates: two for each contested post, one for Treasurer (unopposed)
  const add = async (pos, name, status = 'approved') => {
    const fd = new FormData();
    fd.append('_csrf', admin.csrf()); fd.append('full_name', name); fd.append('position_id', String(pos.id)); fd.append('batch', 'PGDAEM 2010'); fd.append('status', status);
    const res = await fetch(srv.base + '/admin/candidates', { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: admin.cookieHeader() } });
    assert.equal(res.status, 303);
  };
  for (const p of positions.slice(0, 4)) { await add(p, `${p.title} Candidate A`); await add(p, `${p.title} Candidate B`); }
  await add(positions[4], 'Treasurer Person');
  await add(positions[0], 'Draft Person', 'draft');
  const treasurerCand = one("SELECT id FROM candidates WHERE full_name = 'Treasurer Person'");
  r = await admin.post(`/admin/positions/${positions[4].id}`, { title: 'Treasurer', kind: 'unopposed', unopposed_candidate_id: String(treasurerCand.id) });
  assert.equal(one('SELECT kind FROM positions WHERE id = ?', positions[4].id).kind, 'unopposed');

  // Voters
  for (let i = 1; i <= 5; i++) {
    r = await admin.post('/admin/voters', { full_name: `Voter ${i}`, email: i === 5 ? '' : `voter${i}@example.org`, eligibility: 'eligible' });
    assert.equal(r.status, 303);
  }
  await admin.post('/admin/voters', { full_name: 'Not Eligible', email: 'ne@example.org', eligibility: 'ineligible' });

  // Codes cannot be generated before approval
  r = await admin.post('/admin/codes/generate', {});
  assert.equal(one('SELECT COUNT(*) n FROM voting_codes WHERE election_id = ?', electionId).n, 0);

  r = await admin.post('/admin/voters/approve-list', { confirm: 'yes' });
  assert.equal(r.status, 303);
  r = await admin.post('/admin/codes/generate', {});
  r = await admin.post('/admin/codes/generate', {}); // idempotent
  assert.equal(one("SELECT COUNT(*) n FROM voting_codes WHERE election_id = ? AND status = 'active'", electionId).n, 5);

  // Invitations: 4 voters with email
  r = await admin.get('/admin/invitations/confirm?mode=unsent');
  assert.match(r.text, /You are about to send voting invitations to 4 eligible voters/);
  r = await admin.post('/admin/invitations/send', { mode: 'unsent', confirm: 'yes' });
  assert.equal(r.status, 303);
  await mailer.processQueue(100);
  const sent = q("SELECT i.*, c.code, v.email FROM invitations i JOIN voting_codes c ON c.id = i.code_id JOIN voters v ON v.id = i.voter_id WHERE i.status = 'sent'");
  assert.equal(sent.length, 4);
  // Every email contains that voter's own code and only that code
  const outbox = q('SELECT * FROM email_outbox');
  for (const s of sent) {
    const msg = outbox.find((o) => o.invitation_id === s.id);
    assert.equal(msg.to_email, s.email);
    assert.ok(msg.body_text.includes(formatCode(s.code)));
    for (const other of sent.filter((x) => x.id !== s.id)) assert.ok(!msg.body_text.includes(formatCode(other.code)));
    assert.ok(msg.body_text.includes('http://vote.test/'));
  }
  // Sending again does not duplicate
  r = await admin.get('/admin/invitations/confirm?mode=unsent');
  assert.match(r.text, /no voters to send to/);

  // Mark ready, then open voting
  r = await admin.post('/admin/election/transition', { action: 'mark_ready' });
  assert.equal(one('SELECT status FROM elections WHERE id = ?', electionId).status, 'ready');
  r = await admin.post('/admin/election/transition', { action: 'open_now', confirm: 'yes' });
  assert.equal(one('SELECT status FROM elections WHERE id = ?', electionId).status, 'open');

  // Ballot configuration is now locked
  r = await admin.post('/admin/positions', { title: 'New post' });
  assert.equal(one("SELECT COUNT(*) n FROM positions WHERE title = 'New post'").n, 0);
});

async function vote(code, choose) {
  const v = await new Client(srv.base).init();
  let r = await v.post('/vote', { code });
  if (r.status !== 303) return { client: v, r };
  r = await v.get('/ballot');
  const contested = q("SELECT * FROM positions WHERE election_id = ? AND kind = 'contested' ORDER BY sort_order", electionId);
  const body = {};
  for (const p of contested) {
    const cands = q("SELECT id FROM candidates WHERE position_id = ? AND status = 'approved' ORDER BY sort_order", p.id);
    body[`pos_${p.id}`] = choose(p, cands);
  }
  r = await v.post('/ballot', body);
  assert.equal(r.status, 303, 'ballot accepted for review');
  r = await v.get('/ballot/review');
  const token = r.text.match(/name="submission_token" value="([^"]+)"/)[1];
  return { client: v, token };
}

test('voter flow: code entry, review, single submission, locked afterwards', async () => {
  const code = one("SELECT c.code FROM voting_codes c JOIN voters v ON v.id = c.voter_id WHERE v.full_name = 'Voter 1'").code;
  // Incomplete ballot is rejected
  const v0 = await new Client(srv.base).init();
  await v0.post('/vote', { code: formatCode(code).toLowerCase().replace(/-/g, ' ') });
  let r = await v0.post('/ballot', {});
  assert.equal(r.status, 422);
  assert.match(r.text, /Please make a choice for every contested position/);
  // The voter's own name is shown for confirmation
  assert.match(r.text, /Welcome, Voter 1/);
  assert.match(r.text, /Chief Election Commissioner on WhatsApp/);
  // Unopposed shown, no voting control for it
  assert.match(r.text, /Treasurer Person<\/strong>[\s\S]{0,120}Elected unopposed/);
  assert.doesNotMatch(r.text, /Draft Person/);

  const { client, token } = await vote(code, (p, c) => (p.sort_order === 2 ? 'abstain' : String(c[0].id)));
  // Double-click: two simultaneous submits with the same token
  const [a, b] = await Promise.all([
    client.post('/ballot/submit', { submission_token: token }),
    client.post('/ballot/submit', { submission_token: token }),
  ]);
  assert.ok([a.status, b.status].every((s) => s === 303), `statuses ${a.status} ${b.status}`);
  assert.equal(one('SELECT COUNT(*) n FROM ballots').n, 1);
  r = await client.get('/thank-you');
  assert.match(r.text, /Thank you for voting/);
  assert.match(r.text, /1<\/strong> of <strong data-eligible>5<\/strong> eligible alumni have voted \(<strong data-pct>20.0%/);
  const ballot = one('SELECT * FROM ballots');
  assert.equal(q('SELECT * FROM ballot_choices WHERE ballot_id = ?', ballot.id).length, 4);
  assert.equal(one('SELECT COUNT(*) n FROM ballot_choices WHERE candidate_id IS NULL').n, 1);
  assert.equal(one('SELECT status FROM voting_codes WHERE code = ?', code).status, 'used');

  // Reusing the code from another device
  const other = await new Client(srv.base).init();
  r = await other.post('/vote', { code });
  assert.match(r.text, /A ballot has already been submitted using this code/);
  // Refresh / resubmit from the same browser after success -> still one ballot
  r = await client.post('/ballot/submit', { submission_token: token });
  assert.equal(one('SELECT COUNT(*) n FROM ballots').n, 1);
});

test('simultaneous submissions from many tabs/devices produce exactly one ballot', async () => {
  const code = one("SELECT c.code FROM voting_codes c JOIN voters v ON v.id = c.voter_id WHERE v.full_name = 'Voter 2'").code;
  const sessions = [];
  for (let i = 0; i < 8; i++) sessions.push(await vote(code, (p, c) => String(c[i % c.length].id)));
  const results = await Promise.all(sessions.map((s) => s.client.post('/ballot/submit', { submission_token: s.token })));
  const ok = results.filter((r) => r.status === 303).length;
  assert.equal(ok, 1, 'exactly one submission accepted');
  assert.ok(results.filter((r) => r.status === 409).every((r) => /already been submitted/.test(r.text)));
  const voterId = one("SELECT id FROM voters WHERE full_name = 'Voter 2'").id;
  assert.equal(one('SELECT COUNT(*) n FROM ballots WHERE voter_id = ?', voterId).n, 1);
  assert.equal(one('SELECT COUNT(*) n FROM ballot_choices bc JOIN ballots b ON b.id = bc.ballot_id WHERE b.voter_id = ?', voterId).n, 4);
});

test('invalid, revoked and replaced codes', async () => {
  const v = await new Client(srv.base).init();
  let r = await v.post('/vote', { code: 'AAAA-BBBB-CCCC-DDDD' });
  assert.match(r.text, /The voting code you entered is not valid/);
  const voter3 = one("SELECT v.id, c.code FROM voters v JOIN voting_codes c ON c.voter_id = v.id WHERE v.full_name = 'Voter 3'");
  r = await admin.post(`/admin/codes/voter/${voter3.id}/replace`, { reason: 'test' });
  r = await v.post('/vote', { code: voter3.code });
  assert.match(r.text, /This voting code is no longer active/);
  const fresh = one("SELECT code FROM voting_codes WHERE voter_id = ? AND status = 'active'", voter3.id);
  assert.ok(fresh && fresh.code !== voter3.code);
  assert.equal(one("SELECT COUNT(*) n FROM voting_codes WHERE voter_id = ? AND status IN ('active','used')", voter3.id).n, 1);

  // Voted voter cannot get a new code or be reset
  const voter1 = one("SELECT id FROM voters WHERE full_name = 'Voter 1'").id;
  r = await admin.post(`/admin/codes/voter/${voter1}/replace`, { reason: 'try' });
  r = await admin.post(`/admin/codes/voter/${voter1}/generate`, {});
  r = await admin.post(`/admin/voters/${voter1}/eligibility`, { eligibility: 'ineligible', amend_reason: 'x' });
  assert.equal(one('SELECT COUNT(*) n FROM voting_codes WHERE voter_id = ?', voter1).n, 1);
  assert.equal(one('SELECT eligibility FROM voters WHERE id = ?', voter1).eligibility, 'eligible');

  // Resend uses the same code
  const voter4 = one("SELECT v.id, c.id code_id FROM voters v JOIN voting_codes c ON c.voter_id = v.id AND c.status='active' WHERE v.full_name = 'Voter 4'");
  r = await admin.post(`/admin/invitations/voter/${voter4.id}/send`, { confirm: 'yes' });
  await mailer.processQueue(10);
  const invs = q('SELECT * FROM invitations WHERE voter_id = ? ORDER BY id', voter4.id);
  assert.equal(invs.length, 2);
  assert.equal(invs[1].kind, 'resend');
  assert.ok(invs.every((i) => i.code_id === voter4.code_id));
});

test('database rejects any modification of accepted ballots', () => {
  const d = db.get();
  const b = one('SELECT * FROM ballots LIMIT 1');
  assert.throws(() => d.prepare('UPDATE ballots SET submitted_at = ? WHERE id = ?').run('x', b.id), /locked/);
  assert.throws(() => d.prepare('DELETE FROM ballots WHERE id = ?').run(b.id), /locked/);
  assert.throws(() => d.prepare('UPDATE ballot_choices SET candidate_id = NULL WHERE ballot_id = ?').run(b.id), /locked/);
  assert.throws(() => d.prepare('DELETE FROM ballot_choices WHERE ballot_id = ?').run(b.id), /locked/);
  assert.throws(() => d.prepare('INSERT INTO ballot_choices (ballot_id, position_id, candidate_id) VALUES (?, 999, NULL)').run(b.id), /already accepted/);
  assert.throws(() => d.prepare("UPDATE voting_codes SET status = 'active' WHERE id = ?").run(b.code_id), /final/);
  assert.throws(() => d.prepare("INSERT INTO voting_codes (election_id, voter_id, code, status, created_at) VALUES (?, ?, 'ZZZZZZZZZZZZZZZZ', 'revoked', 'x')").run(b.election_id, b.voter_id), /already voted/);
  assert.throws(() => d.prepare('DELETE FROM audit_log').run(), /append-only/);
});

test('permissions and audited ballot access', async () => {
  const voter1 = one("SELECT id FROM voters WHERE full_name = 'Voter 1'").id;
  const auditor = await loginAdmin(srv.base, 'auditor', 'AuditPass123');
  let r = await auditor.get(`/admin/records/${voter1}`);
  assert.equal(r.status, 403);
  r = await auditor.get('/admin/records/export.csv');
  assert.equal(r.status, 403);
  r = await admin.get(`/admin/records/${voter1}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Submitted ballot, locked/);
  assert.match(r.text, /Abstain/);
  const log = one("SELECT * FROM audit_log WHERE category = 'ballot_access' ORDER BY id DESC LIMIT 1");
  assert.match(log.action, /Chief Admin viewed submitted ballot for Voter 1/);
  // Results hidden while open
  r = await admin.get('/admin/results');
  assert.match(r.text, /Results are available after the election closes/);
  r = await new Client(srv.base).get('/results');
  assert.match(r.text, /Results not yet published/);
  r = await new Client(srv.base).get('/api/turnout');
  const t = JSON.parse(r.text);
  assert.deepEqual(Object.keys(t).sort(), ['available', 'eligible', 'pct', 'status', 'voted']);
});

test('close, reconcile, export and publish', async () => {
  let r = await admin.post('/admin/election/transition', { action: 'close', confirm: 'yes' });
  assert.equal(one('SELECT status FROM elections WHERE id = ?', electionId).status, 'closed');
  // No more ballots after close
  const code = one("SELECT c.code FROM voting_codes c JOIN voters v ON v.id = c.voter_id WHERE v.full_name = 'Voter 4' AND c.status = 'active'").code;
  r = await new Client(srv.base).init().then((c) => c.post('/vote', { code }));
  assert.match(r.text, /Voting has closed/);

  r = await admin.get('/admin/results');
  assert.match(r.text, /All contested positions reconcile/);
  r = await admin.get('/admin/results/publish');
  assert.equal(r.status, 200);
  const { computeResults } = require('../src/lib/results');
  const res = computeResults(electionId);
  assert.equal(res.ballots, 2);
  for (const p of res.positions.filter((x) => !x.unopposed)) assert.equal(p.total, 2);
  r = await admin.get('/admin/results/export.csv');
  assert.match(r.text, /Accepted ballots,2/);
  r = await admin.get('/admin/records/export.csv');
  assert.match(r.text, /CONFIDENTIAL, INDIVIDUAL VOTING RECORDS/);

  // Publication requires explicit confirmation
  r = await admin.post('/admin/election/transition', { action: 'publish' });
  assert.equal(one('SELECT status FROM elections WHERE id = ?', electionId).status, 'closed');
  r = await admin.post('/admin/election/transition', { action: 'publish', confirm: 'yes' });
  assert.equal(one('SELECT status FROM elections WHERE id = ?', electionId).status, 'published');
  r = await new Client(srv.base).get('/results');
  assert.match(r.text, /Official results/);
  assert.match(r.text, /Treasurer Person/);
  assert.doesNotMatch(r.text, /Voter 1/);
});

test('welcome page keeps description paragraphs', async () => {
  db.get().prepare("UPDATE elections SET description = ? WHERE id = ?").run('First paragraph.\r\n\r\nSecond paragraph,\r\nsame paragraph line.', electionId);
  const r = await new Client(srv.base).get('/');
  assert.match(r.text, /About this Election/);
  assert.match(r.text, /<p>First paragraph\.<\/p>\s*<p>Second paragraph,<br>same paragraph line\.<\/p>/);
  assert.match(r.text, /Review and submit your ballot/);
});
