'use strict';
const db = require('../db');
const { nowIso } = require('./time');

const STATUSES = {
  draft: { label: 'Draft', public: 'not_open', tone: 'neutral' },
  ready: { label: 'Ready', public: 'not_open', tone: 'info' },
  scheduled: { label: 'Scheduled', public: 'not_open', tone: 'info' },
  open: { label: 'Voting open', public: 'open', tone: 'success' },
  suspended: { label: 'Suspended', public: 'suspended', tone: 'warning' },
  closed: { label: 'Closed', public: 'closed', tone: 'neutral' },
  results_review: { label: 'Results review', public: 'closed', tone: 'info' },
  published: { label: 'Results published', public: 'published', tone: 'success' },
  archived: { label: 'Archived', public: 'closed', tone: 'neutral' },
};

const PUBLIC_STATUS_LABELS = {
  not_open: 'Not yet open',
  open: 'Open',
  suspended: 'Suspended',
  closed: 'Closed',
  published: 'Results published',
};

const EDITABLE_CONFIG_STATUSES = ['draft', 'ready'];

const DEFAULT_EMAIL = {
  email_subject: 'Your voting code for the {{election_name}}',
  email_intro: 'Voting for the {{election_name}} is now available.',
  email_instructions: 'Please select one candidate or choose to abstain for each contested position, review your choices and submit your ballot.\n\nYour voting code may only be used to submit one ballot.\n\nPlease keep your voting code private and do not forward this email.',
  email_closing: 'MANAGE Alumni Association',
  email_support: '{{support_details}}',
};

function currentElectionId() {
  const id = db.getSetting('current_election_id');
  if (id) return parseInt(id, 10);
  const row = db.get().prepare("SELECT id FROM elections WHERE status <> 'archived' ORDER BY id DESC LIMIT 1").get();
  return row ? row.id : null;
}

function getElection(id) {
  if (!id) return null;
  const e = db.get().prepare('SELECT * FROM elections WHERE id = ?').get(id);
  return e ? refreshStatus(e) : null;
}

function getCurrentElection() {
  return getElection(currentElectionId());
}

// Applies time-based transitions (scheduled → open, open → closed) and records them.
function refreshStatus(e) {
  const now = nowIso();
  const d = db.get();
  if (e.status === 'scheduled' && e.opens_at && now >= e.opens_at) {
    const changed = d.prepare("UPDATE elections SET status = 'open', opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ? AND status = 'scheduled'").run(e.opens_at, now, e.id).changes;
    if (changed) require('./audit').log(null, 'Election opened (scheduled opening time reached)', { electionId: e.id, category: 'election', actor: 'System' });
    e = d.prepare('SELECT * FROM elections WHERE id = ?').get(e.id);
  }
  if ((e.status === 'open' || e.status === 'suspended') && e.closes_at && now >= e.closes_at) {
    const changed = d.prepare("UPDATE elections SET status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ? AND status IN ('open','suspended')").run(e.closes_at, now, e.id).changes;
    if (changed) require('./audit').log(null, 'Election closed (closing time reached)', { electionId: e.id, category: 'election', actor: 'System' });
    e = d.prepare('SELECT * FROM elections WHERE id = ?').get(e.id);
  }
  return e;
}

function statusInfo(e) {
  const s = STATUSES[e.status] || STATUSES.draft;
  return { ...s, key: e.status, publicKey: s.public, publicLabel: PUBLIC_STATUS_LABELS[s.public] };
}

function isVotingOpen(e) {
  if (!e || e.status !== 'open') return false;
  const now = nowIso();
  if (e.closes_at && now >= e.closes_at) return false;
  return true;
}

function isConfigEditable(e) {
  return EDITABLE_CONFIG_STATUSES.includes(e.status) && !e.opened_at;
}

function hasEverOpened(e) {
  return !!e.opened_at;
}

function resultsAvailable(e) {
  return ['closed', 'results_review', 'published', 'archived'].includes(e.status);
}

function turnout(electionId) {
  const d = db.get();
  const eligible = d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'eligible'").get(electionId).n;
  const voted = d.prepare('SELECT COUNT(*) n FROM ballots WHERE election_id = ?').get(electionId).n;
  const pct = eligible ? (voted / eligible) * 100 : 0;
  return { eligible, voted, remaining: Math.max(eligible - voted, 0), pct, pctLabel: `${pct.toFixed(1)}%` };
}

function positionsWithCandidates(electionId, { approvedOnly = false } = {}) {
  const d = db.get();
  const positions = d.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY sort_order, id').all(electionId);
  const cands = d.prepare(`SELECT * FROM candidates WHERE election_id = ? ${approvedOnly ? "AND status = 'approved'" : ''} ORDER BY sort_order, id`).all(electionId);
  const byId = Object.fromEntries(d.prepare('SELECT * FROM candidates WHERE election_id = ?').all(electionId).map((c) => [c.id, c]));
  return positions.map((p) => ({
    ...p,
    candidates: cands.filter((c) => c.position_id === p.id),
    unopposedCandidate: p.unopposed_candidate_id ? byId[p.unopposed_candidate_id] || null : null,
  }));
}

// The ballot exactly as voters see it.
function ballotDefinition(electionId) {
  return positionsWithCandidates(electionId, { approvedOnly: true }).map((p) => ({
    ...p,
    contested: p.kind === 'contested',
  }));
}

function readinessChecklist(e) {
  const d = db.get();
  const items = [];
  let group = 'config';
  const add = (ok, label, { level = 'error', link = null } = {}) => items.push({ ok, label, level: ok ? 'ok' : level, link, group });

  add(!!e.name, 'Election name is set', { link: '/admin/election' });
  add(!!e.opens_at && !!e.closes_at, 'Opening and closing date/time are set', { link: '/admin/election' });
  if (e.opens_at && e.closes_at) add(e.closes_at > e.opens_at, 'Closing time is after opening time', { link: '/admin/election' });
  add(!!(e.support_email || e.support_phone), 'Support contact details are set', { level: 'warning', link: '/admin/election' });

  const positions = positionsWithCandidates(e.id, { approvedOnly: true });
  add(positions.length > 0, 'At least one position has been created', { link: '/admin/positions' });
  add(positions.some((p) => p.kind === 'contested'), 'At least one position is contested', { link: '/admin/positions' });
  for (const p of positions) {
    if (p.kind === 'contested') {
      add(p.candidates.length >= 1, `${p.title}: has approved candidates`, { link: '/admin/candidates' });
      if (p.candidates.length === 1) add(false, `${p.title}: only one approved candidate — consider declaring the post unopposed`, { level: 'warning', link: '/admin/positions' });
    } else {
      add(!!(p.unopposedCandidate && p.unopposedCandidate.status === 'approved'), `${p.title}: unopposed winner declared (approved candidate)`, { link: '/admin/positions' });
    }
  }

  group = 'voters';
  add(!!e.voter_list_approved_at, 'Final eligible voter list approved', { link: '/admin/voters' });
  const eligible = d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'eligible'").get(e.id).n;
  add(eligible > 0, 'There is at least one eligible voter', { link: '/admin/voters' });
  const pending = d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'pending'").get(e.id).n;
  add(pending === 0, pending ? `${pending} voter(s) awaiting eligibility review` : 'All voters reviewed', { level: 'warning', link: '/admin/voters?eligibility=pending' });
  const withoutCode = d.prepare(`SELECT COUNT(*) n FROM voters v WHERE v.election_id = ? AND v.eligibility = 'eligible'
    AND NOT EXISTS (SELECT 1 FROM voting_codes c WHERE c.voter_id = v.id AND c.status IN ('active','used'))`).get(e.id).n;
  add(eligible > 0 && withoutCode === 0, withoutCode ? `${withoutCode} eligible voter(s) do not have a voting code yet` : 'Every eligible voter has a voting code', { link: '/admin/codes' });
  const uninvited = d.prepare(`SELECT COUNT(*) n FROM voters v WHERE v.election_id = ? AND v.eligibility = 'eligible' AND v.email IS NOT NULL AND v.email <> ''
    AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.voter_id = v.id AND i.status IN ('sent','delivered'))`).get(e.id).n;
  add(uninvited === 0, uninvited ? `${uninvited} voter(s) with email have not yet received an invitation` : 'Invitations sent to all voters with email', { level: 'warning', link: '/admin/invitations' });
  const noEmail = d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'eligible' AND (email IS NULL OR email = '')").get(e.id).n;
  add(noEmail === 0, `${noEmail} eligible voter(s) have no email — deliver their codes externally`, { level: 'warning', link: '/admin/voters?filter=no_email' });

  const blocking = items.filter((i) => i.level === 'error');
  return { items, ok: blocking.length === 0, blocking, warnings: items.filter((i) => i.level === 'warning') };
}

// State machine. Each action: allowed source states, target, permission and pre-check.
const TRANSITIONS = {
  mark_ready: { from: ['draft'], to: 'ready', label: 'Mark as ready', perm: 'manage_election' },
  back_to_draft: { from: ['ready', 'scheduled'], to: 'draft', label: 'Return to draft (edit ballot)', perm: 'manage_election', guard: (e) => (e.opened_at ? 'This election has already been opened.' : null) },
  schedule: { from: ['ready'], to: 'scheduled', label: 'Schedule opening', perm: 'manage_election' },
  unschedule: { from: ['scheduled'], to: 'ready', label: 'Cancel schedule', perm: 'manage_election' },
  open_now: { from: ['ready', 'scheduled'], to: 'open', label: 'Open voting now', perm: 'manage_election' },
  suspend: { from: ['open'], to: 'suspended', label: 'Suspend voting', perm: 'manage_election' },
  resume: { from: ['suspended'], to: 'open', label: 'Resume voting', perm: 'manage_election' },
  close: { from: ['open', 'suspended'], to: 'closed', label: 'Close election', perm: 'manage_election' },
  start_review: { from: ['closed'], to: 'results_review', label: 'Begin results review', perm: 'view_results' },
  publish: { from: ['closed', 'results_review'], to: 'published', label: 'Publish results', perm: 'publish_results' },
  unpublish: { from: ['published'], to: 'results_review', label: 'Withdraw publication', perm: 'publish_results' },
  archive: { from: ['published'], to: 'archived', label: 'Archive election', perm: 'manage_election' },
};

function checkTransition(e, action) {
  const t = TRANSITIONS[action];
  if (!t) return 'Unknown action.';
  if (!t.from.includes(e.status)) return `This action is not available while the election is "${STATUSES[e.status].label}".`;
  if (t.guard) {
    const g = t.guard(e);
    if (g) return g;
  }
  const now = nowIso();
  if (['mark_ready', 'schedule', 'open_now'].includes(action)) {
    const r = readinessChecklist(e);
    const blocking = action === 'mark_ready'
      ? r.blocking.filter((i) => i.group === 'config')
      : r.blocking;
    if (blocking.length) return 'Resolve the readiness checklist first: ' + blocking.map((i) => i.label).join('; ');
  }
  if (action === 'schedule') {
    if (!e.opens_at || e.opens_at <= now) return 'Set an opening time in the future before scheduling.';
  }
  if (action === 'open_now' || action === 'resume') {
    if (e.closes_at && e.closes_at <= now) return 'The closing time has passed. Update the closing time before opening voting.';
  }
  if (action === 'publish' && e.status === 'closed') {
    // allowed, review is recommended but not mandatory
  }
  return null;
}

function applyTransition(e, action, adminId) {
  const t = TRANSITIONS[action];
  const now = nowIso();
  const d = db.get();
  const sets = ['status = @to', 'updated_at = @now'];
  if (t.to === 'open') {
    sets.push('opened_at = COALESCE(opened_at, @now)');
    if (action === 'open_now' && (!e.opens_at || e.opens_at > now)) sets.push('opens_at = @now');
  }
  if (t.to === 'closed') sets.push('closed_at = @now');
  if (action === 'publish') sets.push('published_at = @now', 'published_by = @adminId');
  if (action === 'unpublish') sets.push('published_at = NULL');
  const res = d.prepare(`UPDATE elections SET ${sets.join(', ')} WHERE id = @id AND status = @from`).run({ to: t.to, now, adminId, id: e.id, from: e.status });
  return res.changes === 1;
}

module.exports = {
  STATUSES, PUBLIC_STATUS_LABELS, TRANSITIONS, DEFAULT_EMAIL,
  currentElectionId, getElection, getCurrentElection, refreshStatus, statusInfo,
  isVotingOpen, isConfigEditable, hasEverOpened, resultsAvailable, turnout,
  positionsWithCandidates, ballotDefinition, readinessChecklist, checkTransition, applyTransition,
};
