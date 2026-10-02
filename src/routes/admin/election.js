'use strict';
const express = require('express');
const db = require('../../db');
const election = require('../../lib/election');
const audit = require('../../lib/audit');
const { nowIso, parseLocalInput, formatDateTime } = require('../../lib/time');
const { flash, clean, asInt, httpError } = require('../../lib/http');
const { requirePerm, requireElection } = require('./guards');

const router = express.Router();

// ---------- Elections list / create / switch ----------
router.get('/elections', (req, res) => {
  const rows = db.get().prepare(`SELECT e.*, (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id AND v.eligibility='eligible') eligible,
    (SELECT COUNT(*) FROM ballots b WHERE b.election_id = e.id) ballots FROM elections e ORDER BY e.id DESC`).all();
  res.render('admin/elections', { title: 'Elections', rows, currentId: election.currentElectionId() });
});

router.post('/elections', requirePerm('manage_election'), (req, res) => {
  const name = clean(req.body.name, 200);
  if (!name) {
    flash(res, 'error', 'Please enter an election name.');
    return res.redirect(303, '/admin/elections');
  }
  const d = db.get();
  const copyFrom = asInt(req.body.copy_positions_from);
  const id = d.transaction(() => {
    const newId = d.prepare(`INSERT INTO elections (name, term, description, support_name, support_email, support_phone, status,
      email_subject, email_intro, email_instructions, email_closing, email_support) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`).run(
      name, clean(req.body.term, 100),
      'Help choose the next team for our alumni association. Enter your personal voting code to vote for the contested positions. Posts already declared elected unopposed are shown for information. Please review your choices before submitting, as your ballot can be submitted only once.',
      'MANAGE Alumni Association Election Committee', '', '',
      election.DEFAULT_EMAIL.email_subject, election.DEFAULT_EMAIL.email_intro, election.DEFAULT_EMAIL.email_instructions,
      election.DEFAULT_EMAIL.email_closing, election.DEFAULT_EMAIL.email_support).lastInsertRowid;
    if (copyFrom) {
      const src = d.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY sort_order, id').all(copyFrom);
      const ins = d.prepare("INSERT INTO positions (election_id, title, description, sort_order, kind) VALUES (?, ?, ?, ?, 'contested')");
      src.forEach((p, i) => ins.run(newId, p.title, p.description, i + 1));
    } else {
      const ins = d.prepare("INSERT INTO positions (election_id, title, sort_order, kind) VALUES (?, ?, ?, 'contested')");
      ['President', 'Vice President', 'General Secretary', 'Joint Secretary', 'Treasurer'].forEach((t, i) => ins.run(newId, t, i + 1));
    }
    return newId;
  })();
  db.setSetting('current_election_id', id);
  audit.log(req, 'Election created', { electionId: id, category: 'election', entityType: 'election', entityId: id, entityLabel: name });
  flash(res, 'success', `Election "${name}" created and selected. Configure its settings, positions and candidates.`);
  res.redirect(303, '/admin/election');
});

router.post('/elections/:id/select', (req, res) => {
  const e = election.getElection(asInt(req.params.id));
  if (!e) throw httpError(404, 'Election not found.');
  if (!req.admin.perms.has('manage_election')) throw httpError(403, 'You do not have permission to change the current election.');
  db.setSetting('current_election_id', e.id);
  audit.log(req, 'Current election changed', { electionId: e.id, category: 'election', entityType: 'election', entityId: e.id, entityLabel: e.name });
  flash(res, 'success', `"${e.name}" is now the current election shown on the voting website.`);
  res.redirect(303, '/admin');
});

// ---------- Settings ----------
router.get('/election', requireElection, (req, res) => {
  const e = req.election;
  res.render('admin/election', {
    title: 'Election settings',
    readiness: election.readinessChecklist(e),
    transitions: election.TRANSITIONS,
    configEditable: election.isConfigEditable(e),
  });
});

router.post('/election', requireElection, requirePerm('manage_election'), (req, res) => {
  const e = req.election;
  const errors = [];
  const name = clean(req.body.name, 200);
  if (!name) errors.push('Election name is required.');
  const opensAt = election.hasEverOpened(e) ? e.opens_at : parseLocalInput(req.body.opens_at);
  const closesAt = parseLocalInput(req.body.closes_at);
  if (req.body.opens_at && !opensAt && !election.hasEverOpened(e)) errors.push('Opening date/time is not valid.');
  if (req.body.closes_at && !closesAt) errors.push('Closing date/time is not valid.');
  if (opensAt && closesAt && closesAt <= opensAt) errors.push('Closing time must be after the opening time.');
  if (['closed', 'results_review', 'published', 'archived'].includes(e.status) && closesAt !== e.closes_at) errors.push('The closing time cannot be changed after the election has closed.');
  if (['open', 'suspended'].includes(e.status) && closesAt && closesAt <= nowIso()) errors.push('While voting is open, the closing time must be in the future. Use "Close election" to close now.');
  if (e.status === 'scheduled' && opensAt !== e.opens_at) errors.push('Cancel the schedule before changing the opening time.');
  const supportEmail = clean(req.body.support_email, 200);
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) errors.push('Support email is not valid.');
  if (errors.length) {
    errors.forEach((m) => flash(res, 'error', m));
    return res.redirect(303, '/admin/election');
  }
  const next = {
    name, term: clean(req.body.term, 100), description: clean(req.body.description, 3000),
    opens_at: opensAt, closes_at: closesAt,
    support_name: clean(req.body.support_name, 200), support_email: supportEmail, support_phone: clean(req.body.support_phone, 50),
    show_turnout_publicly: req.body.show_turnout_publicly ? 1 : 0,
    public_results_show_totals: req.body.public_results_show_totals ? 1 : 0,
  };
  const changed = Object.keys(next).filter((k) => String(next[k] ?? '') !== String(e[k] ?? ''));
  db.get().prepare(`UPDATE elections SET name=@name, term=@term, description=@description, opens_at=@opens_at, closes_at=@closes_at,
    support_name=@support_name, support_email=@support_email, support_phone=@support_phone, show_turnout_publicly=@show_turnout_publicly,
    public_results_show_totals=@public_results_show_totals, updated_at=@now WHERE id=@id`).run({ ...next, now: nowIso(), id: e.id });
  if (changed.length) {
    const details = {};
    for (const k of changed) details[k] = { from: e[k], to: next[k] };
    audit.log(req, 'Election edited', { category: 'election', entityType: 'election', entityId: e.id, entityLabel: name, details });
    if (changed.includes('closes_at') && ['open', 'suspended'].includes(e.status)) {
      audit.log(req, `Closing time changed during voting to ${formatDateTime(closesAt)}`, { category: 'election', entityType: 'election', entityId: e.id, entityLabel: name });
    }
  }
  flash(res, 'success', 'Election settings saved.');
  res.redirect(303, '/admin/election');
});

const TRANSITION_AUDIT = {
  mark_ready: 'Election marked ready', back_to_draft: 'Election returned to draft', schedule: 'Election opening scheduled',
  unschedule: 'Election schedule cancelled', open_now: 'Election opened', suspend: 'Election suspended', resume: 'Election resumed',
  close: 'Election closed', start_review: 'Results review started', publish: 'Results published', unpublish: 'Results publication withdrawn',
  archive: 'Election archived',
};

router.post('/election/transition', requireElection, (req, res) => {
  const e = req.election;
  const action = String(req.body.action || '');
  const t = election.TRANSITIONS[action];
  if (!t) throw httpError(400, 'Unknown action.');
  if (!req.admin.perms.has(t.perm)) throw httpError(403, 'You do not have permission to perform this action.');
  const back = req.body.back && String(req.body.back).startsWith('/admin') ? String(req.body.back) : '/admin/election';
  if (['close', 'publish', 'open_now', 'suspend', 'unpublish'].includes(action) && req.body.confirm !== 'yes') {
    flash(res, 'error', 'Please tick the confirmation box to proceed.');
    return res.redirect(303, back);
  }
  const problem = election.checkTransition(e, action);
  if (problem) {
    flash(res, 'error', problem);
    return res.redirect(303, back);
  }
  if (!election.applyTransition(e, action, req.admin.id)) {
    flash(res, 'error', 'The election status changed in the meantime. Please review and try again.');
    return res.redirect(303, back);
  }
  const reason = clean(req.body.reason, 500);
  audit.log(req, TRANSITION_AUDIT[action], { category: action === 'publish' || action === 'unpublish' ? 'results' : 'election', entityType: 'election', entityId: e.id, entityLabel: e.name, details: reason ? { reason } : { from: e.status, to: t.to } });
  flash(res, 'success', `${TRANSITION_AUDIT[action]}.`);
  res.redirect(303, back);
});

// ---------- Positions ----------
function lockedGuard(req, res) {
  if (!election.isConfigEditable(req.election)) {
    flash(res, 'error', 'The ballot is locked. Positions and candidates can only be changed while the election is in Draft or Ready status and has never been opened.');
    res.redirect(303, req.get('Referer') && req.get('Referer').includes('/admin/') ? new URL(req.get('Referer')).pathname : '/admin/positions');
    return true;
  }
  return false;
}

router.get('/positions', requireElection, (req, res) => {
  const positions = election.positionsWithCandidates(req.election.id);
  res.render('admin/positions', { title: 'Positions', positions, editable: election.isConfigEditable(req.election) });
});

router.post('/positions', requireElection, requirePerm('manage_positions'), (req, res) => {
  if (lockedGuard(req, res)) return;
  const title = clean(req.body.title, 120);
  if (!title) {
    flash(res, 'error', 'Position title is required.');
    return res.redirect(303, '/admin/positions');
  }
  const d = db.get();
  const max = d.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM positions WHERE election_id = ?').get(req.election.id).m;
  const id = d.prepare("INSERT INTO positions (election_id, title, description, sort_order, kind) VALUES (?, ?, ?, ?, 'contested')")
    .run(req.election.id, title, clean(req.body.description, 500), max + 1).lastInsertRowid;
  audit.log(req, 'Position added', { category: 'ballot', entityType: 'position', entityId: id, entityLabel: title });
  flash(res, 'success', `Position "${title}" added.`);
  res.redirect(303, '/admin/positions');
});

function loadPosition(req) {
  const p = db.get().prepare('SELECT * FROM positions WHERE id = ? AND election_id = ?').get(asInt(req.params.id), req.election.id);
  if (!p) throw httpError(404, 'Position not found.');
  return p;
}

router.post('/positions/:id', requireElection, requirePerm('manage_positions'), (req, res) => {
  if (lockedGuard(req, res)) return;
  const p = loadPosition(req);
  const title = clean(req.body.title, 120) || p.title;
  const kind = req.body.kind === 'unopposed' ? 'unopposed' : 'contested';
  let unopposedId = null;
  const d = db.get();
  if (kind === 'unopposed') {
    unopposedId = asInt(req.body.unopposed_candidate_id);
    const c = unopposedId && d.prepare("SELECT * FROM candidates WHERE id = ? AND position_id = ?").get(unopposedId, p.id);
    if (!c) {
      flash(res, 'error', `To mark "${title}" as unopposed, choose the candidate declared elected unopposed (add the candidate first if needed).`);
      return res.redirect(303, '/admin/positions');
    }
    if (c.status !== 'approved') {
      flash(res, 'error', `${c.full_name} must be an approved candidate before being declared elected unopposed.`);
      return res.redirect(303, '/admin/positions');
    }
  }
  d.prepare('UPDATE positions SET title = ?, description = ?, kind = ?, unopposed_candidate_id = ? WHERE id = ?')
    .run(title, clean(req.body.description, 500), kind, unopposedId, p.id);
  const changes = {};
  if (title !== p.title) changes.title = { from: p.title, to: title };
  if (kind !== p.kind) changes.kind = { from: p.kind, to: kind };
  if (unopposedId !== p.unopposed_candidate_id) changes.unopposed_candidate_id = { from: p.unopposed_candidate_id, to: unopposedId };
  audit.log(req, kind === 'unopposed' && p.kind !== 'unopposed' ? 'Position declared unopposed' : 'Position changed', { category: 'ballot', entityType: 'position', entityId: p.id, entityLabel: title, details: changes });
  flash(res, 'success', `Position "${title}" saved.`);
  res.redirect(303, '/admin/positions');
});

router.post('/positions/:id/move', requireElection, requirePerm('manage_positions'), (req, res) => {
  if (lockedGuard(req, res)) return;
  const p = loadPosition(req);
  const d = db.get();
  const all = d.prepare('SELECT id FROM positions WHERE election_id = ? ORDER BY sort_order, id').all(req.election.id).map((r) => r.id);
  const i = all.indexOf(p.id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < all.length) {
    [all[i], all[j]] = [all[j], all[i]];
    const upd = d.prepare('UPDATE positions SET sort_order = ? WHERE id = ?');
    d.transaction(() => all.forEach((id, k) => upd.run(k + 1, id)))();
    audit.log(req, 'Positions reordered', { category: 'ballot', entityType: 'position', entityId: p.id, entityLabel: p.title });
  }
  res.redirect(303, '/admin/positions');
});

router.post('/positions/:id/delete', requireElection, requirePerm('manage_positions'), (req, res) => {
  if (lockedGuard(req, res)) return;
  const p = loadPosition(req);
  const d = db.get();
  const n = d.prepare('SELECT COUNT(*) n FROM candidates WHERE position_id = ?').get(p.id).n;
  if (n > 0) {
    flash(res, 'error', `Remove or reassign the ${n} candidate(s) for "${p.title}" before deleting the position.`);
    return res.redirect(303, '/admin/positions');
  }
  d.prepare('DELETE FROM positions WHERE id = ?').run(p.id);
  audit.log(req, 'Position removed', { category: 'ballot', entityType: 'position', entityId: p.id, entityLabel: p.title });
  flash(res, 'success', `Position "${p.title}" removed.`);
  res.redirect(303, '/admin/positions');
});

module.exports = router;
module.exports.lockedGuard = lockedGuard;
