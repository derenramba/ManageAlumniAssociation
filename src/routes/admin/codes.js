'use strict';
const express = require('express');
const db = require('../../db');
const election = require('../../lib/election');
const audit = require('../../lib/audit');
const voters = require('../../lib/voters');
const mailer = require('../../lib/mailer');
const { generateCode, formatCode } = require('../../lib/codes');
const { nowIso } = require('../../lib/time');
const { sendCsv } = require('../../lib/csv');
const { flash, clean, asInt, httpError } = require('../../lib/http');
const { requirePerm, requireElection } = require('./guards');

const router = express.Router();
const numericId = (req, res, next) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function insertCode(d, electionId, voterId, adminId, replacesId = null) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    try {
      return d.prepare('INSERT INTO voting_codes (election_id, voter_id, code, status, created_at, created_by, replaces_code_id) VALUES (?, ?, ?, \'active\', ?, ?, ?)')
        .run(electionId, voterId, code, nowIso(), adminId, replacesId).lastInsertRowid;
    } catch (err) {
      if (/voting_codes\.code/.test(err.message)) continue; // astronomically unlikely collision: retry
      throw err;
    }
  }
  throw new Error('Could not generate a unique code');
}

/** Generates one code for every eligible voter who has no active or used code. Idempotent. */
function generateMissing(electionId, adminId) {
  const d = db.get();
  return d.transaction(() => {
    const targets = d.prepare(`SELECT v.id FROM voters v WHERE v.election_id = ? AND v.eligibility = 'eligible'
      AND NOT EXISTS (SELECT 1 FROM voting_codes c WHERE c.voter_id = v.id AND c.status IN ('active','used'))
      AND NOT EXISTS (SELECT 1 FROM ballots b WHERE b.voter_id = v.id)`).all(electionId);
    for (const t of targets) insertCode(d, electionId, t.id, adminId);
    return targets.length;
  }).immediate();
}

router.get('/codes', requireElection, requirePerm('manage_codes'), (req, res) => {
  const e = req.election;
  const d = db.get();
  const stats = {
    eligible: d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'eligible'").get(e.id).n,
    active: d.prepare("SELECT COUNT(*) n FROM voting_codes WHERE election_id = ? AND status = 'active'").get(e.id).n,
    used: d.prepare("SELECT COUNT(*) n FROM voting_codes WHERE election_id = ? AND status = 'used'").get(e.id).n,
    revoked: d.prepare("SELECT COUNT(*) n FROM voting_codes WHERE election_id = ? AND status = 'revoked'").get(e.id).n,
  };
  stats.missing = d.prepare(`SELECT COUNT(*) n FROM voters v WHERE v.election_id = ? AND v.eligibility = 'eligible'
    AND NOT EXISTS (SELECT 1 FROM voting_codes c WHERE c.voter_id = v.id AND c.status IN ('active','used'))`).get(e.id).n;
  const q = { q: clean(req.query.q, 100), code: req.query.code, filter: req.query.filter, eligibility: 'eligible' };
  const page = Math.max(1, asInt(req.query.page) || 1);
  const { total, rows } = voters.listVoters(e.id, q, { limit: 100, offset: (page - 1) * 100 });
  res.render('admin/codes', { title: 'Voting codes', stats, rows, total, page, pages: Math.max(1, Math.ceil(total / 100)), q, listApproved: !!e.voter_list_approved_at });
});

router.post('/codes/generate', requireElection, requirePerm('manage_codes'), (req, res) => {
  const e = req.election;
  if (!e.voter_list_approved_at) {
    flash(res, 'error', 'Approve the final eligible voter list before generating voting codes.');
    return res.redirect(303, '/admin/codes');
  }
  if (['closed', 'results_review', 'published', 'archived'].includes(e.status)) {
    flash(res, 'error', 'Voting has closed; no new voting codes can be generated.');
    return res.redirect(303, '/admin/codes');
  }
  const n = generateMissing(e.id, req.admin.id);
  if (n) audit.log(req, 'Codes generated', { category: 'codes', entityType: 'election', entityId: e.id, entityLabel: e.name, details: { generated: n } });
  flash(res, 'success', n ? `${n} voting code(s) generated. Every eligible voter now has exactly one voting entitlement.` : 'Every eligible voter already has a voting code. No new codes were created.');
  res.redirect(303, '/admin/codes');
});

function loadVoter(req) {
  const v = voters.getVoterRow(req.election.id, asInt(req.params.id));
  if (!v) throw httpError(404, 'Voter not found.');
  return v;
}

router.post('/codes/voter/:id/generate', numericId, requireElection, requirePerm('manage_codes'), (req, res) => {
  const v = loadVoter(req);
  const e = req.election;
  const back = `/admin/voters/${v.id}`;
  if (v.ballot_id) { flash(res, 'error', 'This voter has already voted. A new voting entitlement cannot be issued.'); return res.redirect(303, back); }
  if (v.eligibility !== 'eligible') { flash(res, 'error', 'Only eligible voters can receive a voting code.'); return res.redirect(303, back); }
  if (!e.voter_list_approved_at) { flash(res, 'error', 'Approve the final voter list before generating codes.'); return res.redirect(303, back); }
  if (v.code_status_raw) { flash(res, 'error', 'This voter already has an active voting code. Use "Replace code" if the code must be changed.'); return res.redirect(303, back); }
  if (['closed', 'results_review', 'published', 'archived'].includes(e.status)) { flash(res, 'error', 'Voting has closed.'); return res.redirect(303, back); }
  const d = db.get();
  d.transaction(() => insertCode(d, e.id, v.id, req.admin.id)).immediate();
  audit.log(req, 'Code generated', { category: 'codes', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})` });
  flash(res, 'success', `Voting code generated for ${v.full_name}.`);
  res.redirect(303, back);
});

router.post('/codes/voter/:id/revoke', numericId, requireElection, requirePerm('manage_codes'), (req, res) => {
  const v = loadVoter(req);
  const back = req.body.back === 'codes' ? '/admin/codes' : `/admin/voters/${v.id}`;
  if (v.ballot_id || v.code_status_raw === 'used') { flash(res, 'error', 'This code has been used to submit a ballot and cannot be revoked.'); return res.redirect(303, back); }
  if (v.code_status_raw !== 'active') { flash(res, 'error', 'This voter has no active code to revoke.'); return res.redirect(303, back); }
  const reason = clean(req.body.reason, 300) || 'Revoked by administrator';
  const changed = db.get().prepare("UPDATE voting_codes SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ? AND status = 'active'").run(nowIso(), reason, v.code_id).changes;
  if (changed) audit.log(req, 'Code revoked', { category: 'codes', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})`, details: { reason } });
  flash(res, changed ? 'success' : 'error', changed ? `Voting code for ${v.full_name} revoked. The voter cannot vote until a replacement code is issued.` : 'The code could not be revoked (it may have just been used).');
  res.redirect(303, back);
});

router.post('/codes/voter/:id/replace', numericId, requireElection, requirePerm('manage_codes'), (req, res) => {
  const v = loadVoter(req);
  const e = req.election;
  const back = req.body.back === 'codes' ? '/admin/codes' : `/admin/voters/${v.id}`;
  if (v.ballot_id) { flash(res, 'error', 'This voter has already voted. A new voting entitlement cannot be issued.'); return res.redirect(303, back); }
  if (v.eligibility !== 'eligible') { flash(res, 'error', 'Only eligible voters can receive a voting code.'); return res.redirect(303, back); }
  if (['closed', 'results_review', 'published', 'archived'].includes(e.status)) { flash(res, 'error', 'Voting has closed.'); return res.redirect(303, back); }
  const reason = clean(req.body.reason, 300) || 'Replaced by administrator';
  const d = db.get();
  let newId;
  try {
    newId = d.transaction(() => {
      // Revoke the old unused code and issue a new one atomically; the unique index guarantees a single entitlement.
      const old = d.prepare("SELECT * FROM voting_codes WHERE voter_id = ? AND status IN ('active','used')").get(v.id);
      if (old && old.status === 'used') throw httpError(409, 'This voter has already voted.');
      if (old) d.prepare("UPDATE voting_codes SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ? AND status = 'active'").run(nowIso(), `Replaced: ${reason}`, old.id);
      return insertCode(d, e.id, v.id, req.admin.id, old ? old.id : null);
    }).immediate();
  } catch (err) {
    flash(res, 'error', 'The code could not be replaced: ' + (err.expose ? err.message : 'the voter may have just voted.'));
    return res.redirect(303, back);
  }
  audit.log(req, 'Code replaced', { category: 'codes', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})`, details: { reason } });
  const wa = require('../../lib/whatsapp');
  if (req.body.send_whatsapp && wa.voterPhone(v) && req.admin.perms.has('send_invitations')) {
    mailer.queueInvitation({ electionId: e.id, voter: v, codeId: newId, kind: 'resend', adminId: req.admin.id, channel: 'whatsapp' });
    audit.log(req, 'WhatsApp message resent', { category: 'invitations', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})`, details: { reason: 'New code after replacement' } });
    setImmediate(() => mailer.processQueue(10).catch(() => {}));
  }
  if (req.body.send_sms && require('../../lib/sms').voterPhone(v) && req.admin.perms.has('send_invitations')) {
    mailer.queueInvitation({ electionId: e.id, voter: v, codeId: newId, kind: 'resend', adminId: req.admin.id, channel: 'sms' });
    audit.log(req, 'SMS resent', { category: 'invitations', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})`, details: { reason: 'New code after replacement' } });
    setImmediate(() => mailer.processQueue(10).catch(() => {}));
  }
  if (req.body.send_invitation && v.email && mailer.isValidEmail(v.email) && req.admin.perms.has('send_invitations')) {
    mailer.queueInvitation({ electionId: e.id, voter: v, codeId: newId, kind: 'resend', adminId: req.admin.id });
    audit.log(req, 'Invitation resent', { category: 'invitations', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})`, details: { reason: 'New code after replacement' } });
    flash(res, 'success', `New code issued for ${v.full_name} and an invitation with the new code has been queued.`);
  } else {
    flash(res, 'success', `New code issued for ${v.full_name}. The old code no longer works.`);
  }
  res.redirect(303, back);
});

router.get('/codes/export.csv', requireElection, requirePerm('manage_codes'), (req, res) => {
  const e = req.election;
  const q = { eligibility: 'eligible', filter: req.query.filter, code: 'active' };
  const { rows } = voters.listVoters(e.id, q, { limit: 1000000 });
  const label = req.query.filter === 'no_email' ? 'voters without email' : 'all active codes';
  audit.log(req, 'Voting codes exported', { category: 'codes', entityType: 'election', entityId: e.id, entityLabel: e.name, details: { scope: label, count: rows.length } });
  sendCsv(res, `voting-codes-${req.query.filter === 'no_email' ? 'no-email-' : ''}${new Date().toISOString().slice(0, 10)}.csv`, [
    ['CONFIDENTIAL — Voting codes. Each code grants one vote. Store securely and destroy after use.'],
    ['Voter ID', 'Full name', 'Email', 'Mobile', 'WhatsApp', 'Batch', 'Voting code', 'Code status', 'Invitation status'],
    ...rows.map((r) => [r.voter_ref, r.full_name, r.email, r.mobile, r.whatsapp, r.batch, formatCode(r.code), r.code_status, r.inv_status || 'not sent']),
  ]);
});

// Audited reveal for copying a single code (used by the copy button).
router.post('/codes/voter/:id/reveal', numericId, requireElection, requirePerm('manage_codes'), (req, res) => {
  const v = loadVoter(req);
  if (v.code_status_raw !== 'active') return res.status(404).json({ error: 'No active code' });
  audit.log(req, 'Voting code viewed/copied', { category: 'codes', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})` });
  res.json({ code: formatCode(v.code) });
});

module.exports = router;
module.exports.generateMissing = generateMissing;
