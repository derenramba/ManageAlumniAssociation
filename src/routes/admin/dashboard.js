'use strict';
const express = require('express');
const db = require('../../db');
const election = require('../../lib/election');
const mailer = require('../../lib/mailer');
const { requireElection, requirePerm } = require('./guards');

const router = express.Router();

function invitationSummary(electionId, channel = 'email') {
  // Latest invitation per voter on this channel
  const rows = db.get().prepare(`SELECT i.status, COUNT(*) n FROM invitations i
    WHERE i.election_id = ? AND i.channel = ? AND i.id = (SELECT MAX(id) FROM invitations WHERE voter_id = i.voter_id AND channel = i.channel)
    GROUP BY i.status`).all(electionId, channel);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const sentEver = db.get().prepare("SELECT COUNT(DISTINCT voter_id) n FROM invitations WHERE election_id = ? AND channel = ? AND status IN ('sent','delivered')").get(electionId, channel).n;
  return { queued: (by.queued || 0) + (by.sending || 0), sent: (by.sent || 0) + (by.delivered || 0), failed: by.failed || 0, sentEver };
}

router.get('/', (req, res) => {
  const e = req.election;
  if (!e) return res.redirect('/admin/elections');
  const t = election.turnout(e.id);
  const d = db.get();
  const counts = {
    voters: d.prepare('SELECT COUNT(*) n FROM voters WHERE election_id = ?').get(e.id).n,
    pending: d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'pending'").get(e.id).n,
    positions: d.prepare('SELECT COUNT(*) n FROM positions WHERE election_id = ?').get(e.id).n,
    candidates: d.prepare("SELECT COUNT(*) n FROM candidates WHERE election_id = ? AND status = 'approved'").get(e.id).n,
    activeCodes: d.prepare("SELECT COUNT(*) n FROM voting_codes WHERE election_id = ? AND status = 'active'").get(e.id).n,
  };
  const readiness = election.readinessChecklist(e);
  const issues = readiness.items.filter((i) => i.level !== 'ok');
  const inv = invitationSummary(e.id);
  const wa = invitationSummary(e.id, 'whatsapp');
  if (inv.failed) issues.push({ level: 'warning', label: `${inv.failed} invitation(s) failed to send`, link: '/admin/invitations?status=failed' });
  if (wa.failed) issues.push({ level: 'warning', label: `${wa.failed} WhatsApp message(s) failed to send`, link: '/admin/invitations?wa=failed#whatsapp' });
  const recent = d.prepare(`SELECT v.full_name, b.submitted_at FROM ballots b JOIN voters v ON v.id = b.voter_id WHERE b.election_id = ? ORDER BY b.id DESC LIMIT 8`).all(e.id);
  res.render('admin/dashboard', { title: 'Dashboard', t, counts, issues, inv, wa, readiness, mailMode: mailer.mode(), recent, transitions: election.TRANSITIONS });
});

router.get('/turnout', requireElection, requirePerm('view_turnout'), (req, res) => {
  const e = req.election;
  const t = election.turnout(e.id);
  const d = db.get();
  const byBatch = d.prepare(`SELECT COALESCE(NULLIF(v.batch,''),'Not specified') batch, COUNT(*) eligible,
      SUM(CASE WHEN b.id IS NOT NULL THEN 1 ELSE 0 END) voted
    FROM voters v LEFT JOIN ballots b ON b.voter_id = v.id
    WHERE v.election_id = ? AND v.eligibility = 'eligible' GROUP BY 1 ORDER BY 1`).all(e.id);
  const byDay = d.prepare(`SELECT substr(datetime(submitted_at, '+330 minutes'), 1, 13) hour, COUNT(*) n FROM ballots WHERE election_id = ? GROUP BY 1 ORDER BY 1`).all(e.id);
  const filter = ['voted', 'not_voted'].includes(req.query.filter) ? req.query.filter : 'all';
  const q = String(req.query.q || '').trim();
  let where = "v.election_id = @eid AND v.eligibility = 'eligible'";
  if (filter === 'voted') where += ' AND b.id IS NOT NULL';
  if (filter === 'not_voted') where += ' AND b.id IS NULL';
  if (q) where += " AND (v.full_name LIKE @q OR v.email LIKE @q OR v.voter_ref LIKE @q OR v.batch LIKE @q)";
  const voters = d.prepare(`SELECT v.*, b.submitted_at FROM voters v LEFT JOIN ballots b ON b.voter_id = v.id WHERE ${where} ORDER BY v.full_name LIMIT 500`).all({ eid: e.id, q: `%${q}%` });
  res.render('admin/turnout', { title: 'Turnout', t, byBatch, byDay, voters, filter, q });
});

router.get('/audit', requireElection, requirePerm('view_audit_log'), (req, res) => {
  const e = req.election;
  const category = String(req.query.category || '');
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const per = 100;
  let where = '(a.election_id = @eid OR a.election_id IS NULL)';
  if (category) where += ' AND a.category = @category';
  if (q) where += ' AND (a.action LIKE @q OR a.entity_label LIKE @q OR a.admin_name LIKE @q OR a.details LIKE @q)';
  const params = { eid: e.id, category, q: `%${q}%` };
  const total = db.get().prepare(`SELECT COUNT(*) n FROM audit_log a WHERE ${where}`).get(params).n;
  const rows = db.get().prepare(`SELECT * FROM audit_log a WHERE ${where} ORDER BY a.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).all(params);
  const categories = db.get().prepare('SELECT DISTINCT category FROM audit_log ORDER BY category').all().map((r) => r.category);
  res.render('admin/audit', { title: 'Audit log', rows, category, categories, q, page, pages: Math.max(1, Math.ceil(total / per)), total });
});

module.exports = router;
module.exports.invitationSummary = invitationSummary;
