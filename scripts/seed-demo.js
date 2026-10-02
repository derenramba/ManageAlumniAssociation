'use strict';
/**
 * Creates a clearly-labelled DEMONSTRATION election with sample voters, codes, invitations and ballots.
 *
 *   npm run seed:demo            # create (or recreate) the demo election
 *   npm run seed:demo -- --closed  # demo election already closed (to test results / publication)
 *
 * Only data belonging to elections marked is_demo = 1 (and demo admin accounts) is ever removed.
 */
const crypto = require('crypto');
const db = require('../src/db');
const { hashPassword } = require('../src/lib/security');
const { ROLES } = require('../src/lib/permissions');
const { generateCode, formatCode } = require('../src/lib/codes');
const election = require('../src/lib/election');

const closed = process.argv.includes('--closed');
const d = db.get();

// Deterministic pseudo-random so demo data is stable between runs.
let seed = 20261008;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function purgeDemo() {
  const demos = d.prepare('SELECT id FROM elections WHERE is_demo = 1').all().map((r) => r.id);
  if (!demos.length) return;
  db.setSetting('allow_demo_purge', 'yes');
  try {
    d.transaction(() => {
      for (const id of demos) {
        d.prepare('DELETE FROM ballot_choices WHERE ballot_id IN (SELECT id FROM ballots WHERE election_id = ?)').run(id);
        d.prepare('DELETE FROM ballots WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM email_outbox WHERE invitation_id IN (SELECT id FROM invitations WHERE election_id = ?)').run(id);
        d.prepare('DELETE FROM invitations WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM voting_codes WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM voter_imports WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM voters WHERE election_id = ?').run(id);
        d.prepare('UPDATE positions SET unopposed_candidate_id = NULL WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM candidates WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM positions WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM audit_log WHERE election_id = ?').run(id);
        d.prepare('DELETE FROM elections WHERE id = ?').run(id);
      }
    })();
  } finally {
    db.setSetting('allow_demo_purge', 'no');
  }
}

function ensureDemoAdmins() {
  const accounts = [
    { username: 'demo.admin', fullName: 'Demo Main Administrator', role: 'main_admin', password: 'DemoAdmin2026' },
    { username: 'demo.officer', fullName: 'Demo Election Officer', role: 'election_officer', password: 'DemoOfficer2026', extra: ['view_individual_votes', 'export_individual_votes', 'publish_results'] },
    { username: 'demo.manager', fullName: 'Demo Election Administrator', role: 'election_admin', password: 'DemoManager2026' },
    { username: 'demo.auditor', fullName: 'Demo Auditor', role: 'auditor', password: 'DemoAuditor2026' },
  ];
  for (const a of accounts) {
    const perms = [...new Set([...ROLES[a.role].permissions, ...(a.extra || [])])];
    const existing = d.prepare('SELECT id FROM admin_users WHERE username = ?').get(a.username);
    if (existing) {
      d.prepare('UPDATE admin_users SET password_hash = ?, role = ?, permissions = ?, active = 1, is_demo = 1 WHERE id = ?').run(hashPassword(a.password), a.role, JSON.stringify(perms), existing.id);
    } else {
      d.prepare('INSERT INTO admin_users (username, full_name, password_hash, role, permissions, is_demo) VALUES (?, ?, ?, ?, ?, 1)').run(a.username, a.fullName, hashPassword(a.password), a.role, JSON.stringify(perms));
    }
  }
  return accounts;
}

const FIRST = ['Rahul', 'Priya', 'Amit', 'Sneha', 'Venkatesh', 'Lakshmi', 'Arjun', 'Kavitha', 'Suresh', 'Anjali', 'Ravi', 'Deepa', 'Mohan', 'Swathi', 'Kiran', 'Meena',
  'Srinivas', 'Pooja', 'Rajesh', 'Divya', 'Harish', 'Nandini', 'Vikram', 'Revathi', 'Sanjay', 'Shalini', 'Prakash', 'Geetha', 'Naveen', 'Bhavana', 'Gopal', 'Aparna'];
const LAST = ['Sharma', 'Rao', 'Patel', 'Reddy', 'Kumar', 'Naidu', 'Iyer', 'Singh', 'Menon', 'Gupta', 'Das', 'Pillai', 'Verma', 'Joshi', 'Nair', 'Chowdary', 'Mishra', 'Hegde'];

function main() {
  purgeDemo();
  const admins = ensureDemoAdmins();
  const adminId = d.prepare("SELECT id FROM admin_users WHERE username = 'demo.admin'").get().id;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const opensAt = iso(now - 2 * 864e5);
  const closesAt = closed ? iso(now - 3600e3) : iso(now + 6 * 864e5);

  const out = d.transaction(() => {
    const eid = d.prepare(`INSERT INTO elections (name, term, description, opens_at, closes_at, status, support_name, support_email, support_phone,
      show_turnout_publicly, public_results_show_totals, voter_list_approved_at, voter_list_approved_by, opened_at, closed_at, is_demo,
      email_subject, email_intro, email_instructions, email_closing, email_support)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
      'MANAGE Alumni Association Election 2026 (Demo)', 'Term 2026 to 2028',
      'Help choose the next team for our alumni association. Enter your personal voting code to vote for the contested positions. Posts already declared elected unopposed are shown for information. Please review your choices before submitting, as your ballot can be submitted only once.',
      opensAt, closesAt, closed ? 'closed' : 'open', 'MANAGE Alumni Association Election Committee', 'elections@example.org', '+91 40 0000 0000',
      iso(now - 3 * 864e5), adminId, opensAt, closed ? closesAt : null,
      election.DEFAULT_EMAIL.email_subject, election.DEFAULT_EMAIL.email_intro, election.DEFAULT_EMAIL.email_instructions, election.DEFAULT_EMAIL.email_closing, election.DEFAULT_EMAIL.email_support,
    ).lastInsertRowid;

    const positions = [
      { title: 'President', cands: [['Dr. Rahul Sharma', 'PGDAEM 2001'], ['Dr. Lakshmi Narayanan', 'PGDAEM 1999'], ['Shri Venkata Ramana Reddy', 'PGDAEM 2003']] },
      { title: 'Vice President', cands: [['Dr. Priya Rao', 'PGDAEM 2006'], ['Shri Amit Kumar Singh', 'PGDAEM 2005']] },
      { title: 'General Secretary', cands: [['Smt. Kavitha Menon', 'PGDAEM 2010'], ['Dr. Suresh Babu', 'PGDAEM 2008'], ['Shri Arjun Patel', 'PGDAEM 2011']] },
      { title: 'Joint Secretary', cands: [['Dr. Sneha Iyer', 'PGDAEM 2014'], ['Shri Harish Chowdary', 'PGDAEM 2013']] },
      { title: 'Treasurer', unopposed: ['Dr. Meena Gupta', 'PGDAEM 2004'] },
    ];
    const posIds = [];
    positions.forEach((p, i) => {
      const pid = d.prepare('INSERT INTO positions (election_id, title, sort_order, kind) VALUES (?, ?, ?, ?)').run(eid, p.title, i + 1, p.unopposed ? 'unopposed' : 'contested').lastInsertRowid;
      const cids = [];
      if (p.unopposed) {
        const cid = d.prepare("INSERT INTO candidates (election_id, position_id, full_name, batch, status, sort_order) VALUES (?, ?, ?, ?, 'approved', 1)").run(eid, pid, p.unopposed[0], p.unopposed[1]).lastInsertRowid;
        d.prepare('UPDATE positions SET unopposed_candidate_id = ? WHERE id = ?').run(cid, pid);
      } else {
        p.cands.forEach((c, j) => cids.push(d.prepare("INSERT INTO candidates (election_id, position_id, full_name, batch, status, sort_order) VALUES (?, ?, ?, ?, 'approved', ?)").run(eid, pid, c[0], c[1], j + 1).lastInsertRowid));
      }
      posIds.push({ pid, cids, contested: !p.unopposed });
    });
    // A withdrawn candidate (does not appear on ballot)
    d.prepare("INSERT INTO candidates (election_id, position_id, full_name, batch, status, sort_order) VALUES (?, ?, 'Shri Gopal Verma', 'PGDAEM 2009', 'withdrawn', 9)").run(eid, posIds[2].pid);

    // Voters
    const voters = [];
    const used = new Set();
    for (let i = 1; i <= 60; i++) {
      let name;
      do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(name));
      used.add(name);
      const batch = `PGDAEM ${1998 + Math.floor(rand() * 23)}`;
      let email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.org`;
      let mobile = `+91 9${String(Math.floor(rand() * 1e9)).padStart(9, '0')}`;
      let elig = 'eligible';
      if (i === 7 || i === 23 || i === 41) email = null; // no email — must be delivered externally
      if (i === 15) email = 'not an email';
      if (i === 33) email = voters[5].email; // shared family email: flagged as possible duplicate
      if (i === 34) mobile = voters[9].mobile;
      if (i === 58 || i === 59) elig = 'ineligible';
      if (i === 52) mobile = null;
      const id = d.prepare('INSERT INTO voters (election_id, voter_ref, full_name, email, mobile, whatsapp, batch, eligibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(eid, `MAA${String(1000 + i).padStart(5, '0')}`, name, email, mobile, i % 3 === 0 ? mobile : null, batch, elig).lastInsertRowid;
      voters.push({ id, name, email, mobile, elig, idx: i });
    }

    // Codes, invitations and ballots
    const sampleCodes = [];
    let k = 0;
    for (const v of voters) {
      if (v.elig !== 'eligible') continue;
      k++;
      const code = generateCode();
      const createdAt = iso(now - 3 * 864e5 + k * 1000);
      const codeId = d.prepare("INSERT INTO voting_codes (election_id, voter_id, code, status, created_at, created_by) VALUES (?, ?, ?, 'active', ?, ?)").run(eid, v.id, code, createdAt, adminId).lastInsertRowid;
      if (v.idx === 44) {
        // One code was revoked and replaced (e.g. voter reported it was forwarded).
        d.prepare("UPDATE voting_codes SET status = 'revoked', revoked_at = ?, revoked_reason = 'Replaced: voter reported code was forwarded' WHERE id = ?").run(iso(now - 1.5 * 864e5), codeId);
        const newId = d.prepare("INSERT INTO voting_codes (election_id, voter_id, code, status, created_at, created_by, replaces_code_id) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(eid, v.id, generateCode(), iso(now - 1.5 * 864e5), adminId, codeId).lastInsertRowid;
        v.codeId = newId;
      } else v.codeId = codeId;
      v.code = d.prepare('SELECT code FROM voting_codes WHERE id = ?').get(v.codeId).code;

      if (v.email && v.idx !== 50 && v.idx !== 51) {
        const failed = v.idx === 15 || v.idx === 27 || v.idx === 38;
        const t = iso(now - 2 * 864e5 + k * 60e3);
        d.prepare(`INSERT INTO invitations (election_id, voter_id, code_id, kind, status, to_email, error, attempts, requested_by, created_at, last_attempt_at, sent_at)
          VALUES (?, ?, ?, 'initial', ?, ?, ?, 1, ?, ?, ?, ?)`).run(eid, v.id, v.codeId, failed ? 'failed' : 'sent', v.email, failed ? 'Delivery failed: 550 mailbox unavailable' : null, adminId, t, t, failed ? null : t);
      }
    }

    // Some voters have voted (complete ballots, inserted atomically like real submissions).
    const eligibleVoters = voters.filter((v) => v.elig === 'eligible');
    const voting = eligibleVoters.filter((v, i) => (closed ? i % 5 !== 0 : i % 9 < 4) && v.idx !== 44);
    for (const [n, v] of voting.entries()) {
      const at = iso(now - 2 * 864e5 + (n + 1) * (closed ? 40 : 75) * 60e3);
      const ballotId = d.prepare('INSERT INTO ballots (election_id, voter_id, code_id, submission_token, submitted_at, receipt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(eid, v.id, v.codeId, crypto.randomUUID(), at, crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join(' ')).lastInsertRowid;
      for (const p of posIds.filter((x) => x.contested)) {
        const r = rand();
        const cand = r < 0.1 ? null : p.cids[Math.min(p.cids.length - 1, Math.floor(Math.pow(rand(), 1.3) * p.cids.length))];
        d.prepare('INSERT INTO ballot_choices (ballot_id, position_id, candidate_id) VALUES (?, ?, ?)').run(ballotId, p.pid, cand);
      }
      d.prepare("UPDATE voting_codes SET status = 'used', used_at = ? WHERE id = ?").run(at, v.codeId);
    }
    for (const v of eligibleVoters) {
      if (!voting.includes(v) && sampleCodes.length < 8 && v.email) sampleCodes.push({ name: v.name, code: formatCode(v.code) });
    }

    const log = d.prepare("INSERT INTO audit_log (at, election_id, admin_id, admin_name, action, category, entity_type, entity_id, entity_label) VALUES (?, ?, ?, 'Demo Main Administrator', ?, ?, 'election', ?, ?)");
    const ename = 'MANAGE Alumni Association Election 2026 (Demo)';
    log.run(iso(now - 5 * 864e5), eid, adminId, 'Election created', 'election', eid, ename);
    log.run(iso(now - 4 * 864e5), eid, adminId, 'Candidate approved', 'ballot', eid, ename);
    log.run(iso(now - 3.5 * 864e5), eid, adminId, 'Voters imported', 'voters', eid, ename);
    log.run(iso(now - 3 * 864e5), eid, adminId, 'Voter list approved', 'voters', eid, ename);
    log.run(iso(now - 3 * 864e5), eid, adminId, 'Codes generated', 'codes', eid, ename);
    log.run(iso(now - 2 * 864e5), eid, adminId, 'Invitations sent', 'invitations', eid, ename);
    log.run(opensAt, eid, adminId, 'Election opened', 'election', eid, ename);
    if (closed) log.run(closesAt, eid, adminId, 'Election closed', 'election', eid, ename);
    return { eid, sampleCodes, voted: voting.length, eligible: eligibleVoters.length };
  })();

  db.setSetting('current_election_id', out.eid);
  console.log('\n=== DEMO DATA CREATED (clearly marked as demonstration data) ===');
  console.log(`Election: MANAGE Alumni Association Election 2026 (Demo) — status ${closed ? 'CLOSED' : 'OPEN'}`);
  console.log(`Eligible voters: ${out.eligible}, ballots already submitted: ${out.voted}`);
  console.log('\nDemo admin accounts:');
  for (const a of admins) console.log(`  ${a.username.padEnd(14)} ${a.password.padEnd(16)} ${ROLES[a.role].label}${a.extra ? ' (+ individual votes)' : ''}`);
  if (!closed) {
    console.log('\nUnused demo voting codes you can vote with:');
    for (const s of out.sampleCodes) console.log(`  ${s.code}   (${s.name})`);
  }
  console.log('\nThe demo election is now the current election. Create a real election under Admin → All elections.\n');
}

main();
