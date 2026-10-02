'use strict';
const express = require('express');
const db = require('../../db');
const audit = require('../../lib/audit');
const mailer = require('../../lib/mailer');
const voters = require('../../lib/voters');
const election = require('../../lib/election');
const { nowIso } = require('../../lib/time');
const { flash, clean, asInt, httpError } = require('../../lib/http');
const { requirePerm, requireElection } = require('./guards');
const { invitationSummary } = require('./dashboard');

const router = express.Router();
const numericId = (req, res, next) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

// Voters who can receive an invitation right now: eligible, valid email, active code, not already queued.
const SENDABLE = `v.election_id = @eid AND v.eligibility = 'eligible' AND v.email IS NOT NULL AND v.email <> ''
  AND c.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM invitations q WHERE q.voter_id = v.id AND q.status IN ('queued','sending'))`;

function recipients(electionId, mode, ids = []) {
  const d = db.get();
  const base = `SELECT v.*, c.id AS code_id,
      (SELECT COUNT(*) FROM invitations x WHERE x.voter_id = v.id AND x.status IN ('sent','delivered')) AS sent_count,
      (SELECT status FROM invitations y WHERE y.id = (SELECT MAX(id) FROM invitations WHERE voter_id = v.id)) AS last_status
    FROM voters v JOIN voting_codes c ON c.voter_id = v.id AND c.status = 'active' WHERE ${SENDABLE}`;
  let rows;
  if (mode === 'unsent') {
    // Standard first invitation for the voter's current code (never duplicated).
    rows = d.prepare(`${base} AND NOT EXISTS (SELECT 1 FROM invitations s WHERE s.voter_id = v.id AND s.code_id = c.id AND s.status IN ('sent','delivered'))
      AND NOT EXISTS (SELECT 1 FROM invitations f WHERE f.id = (SELECT MAX(id) FROM invitations WHERE voter_id = v.id) AND f.status = 'failed')`).all({ eid: electionId });
  } else if (mode === 'failed') {
    rows = d.prepare(`${base} AND EXISTS (SELECT 1 FROM invitations f WHERE f.id = (SELECT MAX(id) FROM invitations WHERE voter_id = v.id) AND f.status = 'failed')`).all({ eid: electionId });
  } else if (mode === 'selected') {
    if (!ids.length) return [];
    rows = d.prepare(`${base} AND v.id IN (${ids.map(() => '?').join(',')})`.replace(/@eid/g, '?')).all(electionId, ...ids);
  } else {
    rows = [];
  }
  return rows.filter((r) => mailer.isValidEmail(r.email));
}

router.get('/invitations', requireElection, requirePerm('send_invitations'), (req, res) => {
  const e = req.election;
  const d = db.get();
  const summary = invitationSummary(e.id);
  const counts = {
    unsent: recipients(e.id, 'unsent').length,
    failed: recipients(e.id, 'failed').length,
    noEmail: d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'eligible' AND (email IS NULL OR email = '')").get(e.id).n,
    invalidEmail: d.prepare("SELECT email FROM voters WHERE election_id = ? AND eligibility = 'eligible' AND email IS NOT NULL AND email <> ''").all(e.id).filter((r) => !mailer.isValidEmail(r.email)).length,
    noCode: d.prepare(`SELECT COUNT(*) n FROM voters v WHERE v.election_id = ? AND v.eligibility = 'eligible' AND NOT EXISTS (SELECT 1 FROM voting_codes c WHERE c.voter_id = v.id AND c.status IN ('active','used'))`).get(e.id).n,
  };
  const status = ['queued', 'sent', 'failed', 'not_sent'].includes(req.query.status) ? req.query.status : '';
  const page = Math.max(1, asInt(req.query.page) || 1);
  const list = voters.listVoters(e.id, { eligibility: 'eligible', invitation: status, q: clean(req.query.q, 100) }, { limit: 50, offset: (page - 1) * 50, order: 'COALESCE(i.last_attempt_at, i.created_at) DESC, v.full_name' });
  res.render('admin/invitations', {
    title: 'Invitations', summary, counts, tpl: mailer.template(e), variables: mailer.VARIABLES, mode: mailer.mode(),
    rows: list.rows, total: list.total, page, pages: Math.max(1, Math.ceil(list.total / 50)), status,
  });
});

router.post('/invitations/template', requireElection, requirePerm('send_invitations'), (req, res) => {
  const e = req.election;
  const fields = ['email_subject', 'email_intro', 'email_instructions', 'email_closing', 'email_support'];
  const vals = {};
  for (const f of fields) vals[f] = clean(req.body[f], f === 'email_subject' ? 200 : 4000) || election.DEFAULT_EMAIL[f];
  if (req.body.reset === 'yes') Object.assign(vals, election.DEFAULT_EMAIL);
  db.get().prepare(`UPDATE elections SET ${fields.map((f) => `${f} = @${f}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...vals, now: nowIso(), id: e.id });
  audit.log(req, req.body.reset === 'yes' ? 'Invitation template reset to default' : 'Invitation template edited', { category: 'invitations', entityType: 'election', entityId: e.id, entityLabel: e.name });
  flash(res, 'success', 'Invitation template saved. Check the preview before sending.');
  res.redirect(303, '/admin/invitations#template');
});

// Rendered email preview (shown in an iframe). Uses a real voter's name but never a real code.
router.post('/invitations/test', requireElection, requirePerm('send_invitations'), async (req, res, next) => {
  try {
    const to = clean(req.body.to, 200);
    if (!mailer.isValidEmail(to)) {
      flash(res, 'error', 'Enter a valid email address for the test.');
      return res.redirect(303, '/admin/invitations#test');
    }
    const r = await mailer.sendTestEmail(req.election, to, req.admin.full_name);
    audit.log(req, 'Test invitation email sent', { category: 'invitations', entityType: 'election', entityId: req.election.id, entityLabel: req.election.name, details: { to, ok: r.ok } });
    flash(res, r.ok ? 'success' : 'error', r.ok ? `Test email sent to ${to}. It contains a sample code, not a real one. Check the inbox and the spam folder.` : r.reason);
    res.redirect(303, '/admin/invitations#test');
  } catch (err) { next(err); }
});

router.get('/invitations/preview', requireElection, requirePerm('send_invitations'), (req, res) => {
  const e = req.election;
  const d = db.get();
  const voter = d.prepare("SELECT * FROM voters WHERE election_id = ? AND eligibility = 'eligible' ORDER BY id LIMIT 1").get(e.id)
    || { full_name: 'Dr. Sample Voter', email: 'sample.voter@example.org' };
  const msg = mailer.renderInvitation(e, voter, 'SAMPLECODEXXXXXX'.replace(/X/g, '2'));
  if (req.query.format === 'text') {
    res.type('text/plain').send(`To: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}`);
    return;
  }
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(msg.html);
});

const MODE_LABELS = {
  unsent: { title: 'Send invitations', verb: 'send voting invitations to', kind: 'initial' },
  failed: { title: 'Retry failed invitations', verb: 'retry voting invitations for', kind: 'retry' },
  selected: { title: 'Resend selected invitations', verb: 'send voting invitations to', kind: 'resend' },
};

function confirmPage(req, res, mode, ids) {
  const e = req.election;
  const list = recipients(e.id, mode, ids);
  const resends = list.filter((r) => r.sent_count > 0).length;
  const subject = mailer.renderInvitation(e, { full_name: 'X' }, '2222222222222222').subject;
  res.render('admin/invitations-confirm', { title: MODE_LABELS[mode].title, mode, ids, list, resends, subject, labels: MODE_LABELS[mode], mailMode: mailer.mode() });
}

router.get('/invitations/confirm', requireElection, requirePerm('send_invitations'), (req, res) => {
  const mode = ['unsent', 'failed'].includes(req.query.mode) ? req.query.mode : 'unsent';
  confirmPage(req, res, mode, []);
});

router.post('/invitations/confirm', requireElection, requirePerm('send_invitations'), (req, res) => {
  const ids = [].concat(req.body.ids || []).map(asInt).filter(Boolean);
  if (!ids.length) {
    flash(res, 'error', 'Select at least one voter.');
    return res.redirect(303, '/admin/invitations');
  }
  confirmPage(req, res, 'selected', ids);
});

router.post('/invitations/send', requireElection, requirePerm('send_invitations'), (req, res) => {
  const e = req.election;
  const mode = MODE_LABELS[req.body.mode] ? req.body.mode : null;
  if (!mode) throw httpError(400, 'Invalid request.');
  if (req.body.confirm !== 'yes') {
    flash(res, 'error', 'Sending was cancelled — confirmation was not given.');
    return res.redirect(303, '/admin/invitations');
  }
  if (['closed', 'results_review', 'published', 'archived'].includes(e.status)) {
    flash(res, 'error', 'Voting has closed. Invitations can no longer be sent.');
    return res.redirect(303, '/admin/invitations');
  }
  const ids = [].concat(req.body.ids || []).map(asInt).filter(Boolean);
  const d = db.get();
  const queued = d.transaction(() => {
    const list = recipients(e.id, mode, ids); // re-evaluated inside the transaction
    for (const v of list) {
      const kind = mode === 'failed' ? 'retry' : v.sent_count > 0 ? 'resend' : 'initial';
      mailer.queueInvitation({ electionId: e.id, voter: v, codeId: v.code_id, kind, adminId: req.admin.id });
    }
    return list;
  }).immediate();
  const resends = queued.filter((v) => v.sent_count > 0).length;
  const action = mode === 'failed' ? 'Failed invitations retried' : mode === 'selected' ? 'Invitations resent (selected voters)' : 'Invitations sent';
  audit.log(req, action, { category: 'invitations', entityType: 'election', entityId: e.id, entityLabel: e.name, details: { queued: queued.length, resends, first_invitations: queued.length - resends } });
  setImmediate(() => mailer.processQueue(50).catch((err) => console.error(err)));
  flash(res, 'success', `${queued.length} invitation(s) queued for sending${resends ? ` (${resends} resend(s))` : ''}. Status updates appear below as messages are sent.`);
  res.redirect(303, '/admin/invitations');
});

// Single voter send / resend (from voter page)
router.post('/invitations/voter/:id/send', numericId, requireElection, requirePerm('send_invitations'), (req, res) => {
  const e = req.election;
  const v = voters.getVoterRow(e.id, asInt(req.params.id));
  if (!v) throw httpError(404, 'Voter not found.');
  const back = `/admin/voters/${v.id}`;
  const list = recipients(e.id, 'selected', [v.id]);
  if (!list.length) {
    let why = 'This voter cannot receive an invitation right now.';
    if (v.ballot_id) why = 'This voter has already voted.';
    else if (v.eligibility !== 'eligible') why = 'This voter is not eligible.';
    else if (!v.email) why = 'This voter has no email address. Add an email or deliver the code externally.';
    else if (!mailer.isValidEmail(v.email)) why = 'The email address is not valid. Correct it first.';
    else if (v.code_status_raw !== 'active') why = 'This voter has no active voting code.';
    else if (['queued', 'sending'].includes(v.inv_status)) why = 'An invitation is already queued for this voter.';
    flash(res, 'error', why);
    return res.redirect(303, back);
  }
  if (['closed', 'results_review', 'published', 'archived'].includes(e.status)) {
    flash(res, 'error', 'Voting has closed.');
    return res.redirect(303, back);
  }
  const r = list[0];
  if (r.sent_count > 0 && req.body.confirm !== 'yes') {
    flash(res, 'error', 'This voter has already been sent an invitation. Tick the confirmation box to resend it.');
    return res.redirect(303, back);
  }
  const kind = r.last_status === 'failed' ? 'retry' : r.sent_count > 0 ? 'resend' : 'initial';
  mailer.queueInvitation({ electionId: e.id, voter: r, codeId: r.code_id, kind, adminId: req.admin.id });
  audit.log(req, kind === 'initial' ? 'Invitation sent' : 'Invitation resent', { category: 'invitations', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})`, details: { kind, to: v.email } });
  setImmediate(() => mailer.processQueue(10).catch((err) => console.error(err)));
  flash(res, 'success', `Invitation ${kind === 'initial' ? 'queued' : 're-queued'} for ${v.full_name} (same voting code — no new entitlement created).`);
  res.redirect(303, back);
});

// ---------- Outbox (development mode without SMTP) ----------
router.get('/invitations/outbox', requireElection, requirePerm('send_invitations'), requirePerm('manage_codes'), (req, res) => {
  const rows = db.get().prepare(`SELECT o.id, o.to_email, o.subject, o.created_at FROM email_outbox o JOIN invitations i ON i.id = o.invitation_id
    WHERE i.election_id = ? ORDER BY o.id DESC LIMIT 200`).all(req.election.id);
  res.render('admin/outbox', { title: 'Email outbox', rows, mode: mailer.mode() });
});

router.get('/invitations/outbox/:id', numericId, requireElection, requirePerm('send_invitations'), requirePerm('manage_codes'), (req, res) => {
  const row = db.get().prepare('SELECT o.* FROM email_outbox o JOIN invitations i ON i.id = o.invitation_id WHERE o.id = ? AND i.election_id = ?').get(asInt(req.params.id), req.election.id);
  if (!row) throw httpError(404, 'Message not found.');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(row.body_html);
});

module.exports = router;
