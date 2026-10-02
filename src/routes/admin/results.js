'use strict';
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../../db');
const election = require('../../lib/election');
const audit = require('../../lib/audit');
const voters = require('../../lib/voters');
const voting = require('../../lib/voting');
const { computeResults } = require('../../lib/results');
const { formatDateTime, formatShort } = require('../../lib/time');
const { sendCsv } = require('../../lib/csv');
const { flash, clean, asInt, httpError } = require('../../lib/http');
const { requirePerm, requireElection } = require('./guards');

const router = express.Router();
const numericId = (req, res, next) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function requireResultsAvailable(req, res, next) {
  if (!election.resultsAvailable(req.election)) {
    return res.render('admin/results-unavailable', { title: 'Results' });
  }
  next();
}

// ---------- Aggregate results ----------
router.get('/results', requireElection, requirePerm('view_results'), requireResultsAvailable, (req, res) => {
  const r = computeResults(req.election.id);
  audit.log(req, 'Results accessed', { category: 'results', entityType: 'election', entityId: req.election.id, entityLabel: req.election.name });
  res.render('admin/results', { title: 'Results', r });
});

router.get('/results/publish', requireElection, requirePerm('publish_results'), requireResultsAvailable, (req, res) => {
  res.render('admin/publish', { title: 'Publish results', r: computeResults(req.election.id), transitions: election.TRANSITIONS });
});

function aggregateRows(e, r) {
  const rows = [
    ['MANAGE Alumni Association — Aggregate election results'],
    ['Election', e.name],
    ['Term', e.term || ''],
    ['Voting opened', formatDateTime(e.opened_at || e.opens_at)],
    ['Voting closed', formatDateTime(e.closed_at || e.closes_at)],
    ['Status', election.STATUSES[e.status].label],
    ['Eligible voters', r.turnout.eligible],
    ['Accepted ballots', r.ballots],
    ['Turnout', `${r.turnout.pct.toFixed(1)}%`],
    ['Reconciliation', r.reconciled ? 'All positions reconcile (candidate votes + abstentions = accepted ballots)' : 'WARNING: ' + r.warnings.join(' ')],
    ['Exported at', formatDateTime(new Date().toISOString())],
    [],
    ['Position', 'Type', 'Candidate', 'Batch', 'Votes', 'Share of position total', 'Outcome'],
  ];
  for (const p of r.positions) {
    if (p.unopposed) {
      rows.push([p.title, 'Unopposed', p.unopposedCandidate ? p.unopposedCandidate.full_name : '', p.unopposedCandidate ? p.unopposedCandidate.batch || '' : '', '', '', 'Elected unopposed']);
      continue;
    }
    for (const c of p.rows) {
      const outcome = p.tie && p.leaders.some((l) => l.id === c.id) ? 'Tie — administrator review required' : p.winner && p.winner.id === c.id ? 'Highest total' : '';
      rows.push([p.title, 'Contested', c.name, c.batch || '', c.votes, `${c.pct.toFixed(1)}%`, outcome]);
    }
    rows.push([p.title, 'Contested', 'Abstain', '', p.abstain, `${p.abstainPct.toFixed(1)}%`, '']);
    rows.push([p.title, 'Contested', 'TOTAL', '', p.total, '', p.reconciled ? 'Reconciled' : 'RECONCILIATION WARNING']);
  }
  return rows;
}

async function sendXlsx(res, filename, sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MANAGE Alumni Association Voting Platform';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r) => ws.addRow(r));
    if (s.boldRows) s.boldRows.forEach((i) => { ws.getRow(i).font = { bold: true }; });
    ws.columns.forEach((c) => { c.width = 22; });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  await wb.xlsx.write(res);
  res.end();
}

const slug = (s) => String(s || 'election').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

router.get('/results/export.:fmt', requireElection, requirePerm('export_results'), requireResultsAvailable, async (req, res, next) => {
  try {
    const e = req.election;
    const r = computeResults(e.id);
    const rows = aggregateRows(e, r);
    audit.log(req, 'Results exported', { category: 'results', entityType: 'election', entityId: e.id, entityLabel: e.name, details: { format: req.params.fmt, type: 'aggregate' } });
    const name = `${slug(e.name)}-aggregate-results`;
    if (req.params.fmt === 'xlsx') return await sendXlsx(res, `${name}.xlsx`, [{ name: 'Results', rows, boldRows: [1, 13] }]);
    sendCsv(res, `${name}.csv`, rows);
  } catch (err) { next(err); }
});

// ---------- Individual voting records (confidential) ----------
function detailedRows(e) {
  const d = db.get();
  const positions = d.prepare("SELECT * FROM positions WHERE election_id = ? AND kind = 'contested' ORDER BY sort_order, id").all(e.id);
  const ballots = d.prepare(`SELECT b.*, v.voter_ref, v.full_name, v.email, v.batch FROM ballots b JOIN voters v ON v.id = b.voter_id
    WHERE b.election_id = ? ORDER BY b.submitted_at`).all(e.id);
  const choices = d.prepare(`SELECT bc.ballot_id, bc.position_id, c.full_name FROM ballot_choices bc JOIN ballots b ON b.id = bc.ballot_id
    LEFT JOIN candidates c ON c.id = bc.candidate_id WHERE b.election_id = ?`).all(e.id);
  const map = new Map();
  for (const c of choices) map.set(`${c.ballot_id}:${c.position_id}`, c.full_name || 'Abstain');
  const rows = [
    ['CONFIDENTIAL — INDIVIDUAL VOTING RECORDS'],
    ['Election', e.name],
    ['Exported at', formatDateTime(new Date().toISOString())],
    ['This file links named voters to their ballot choices. Do not share or publish.'],
    [],
    ['Voter ID', 'Voter name', 'Email', 'Batch/year', 'Submitted at (IST)', 'Ballot receipt', ...positions.map((p) => p.title), 'Abstentions'],
  ];
  for (const b of ballots) {
    const sel = positions.map((p) => map.get(`${b.id}:${p.id}`) || '');
    rows.push([b.voter_ref, b.full_name, b.email, b.batch, formatShort(b.submitted_at), b.receipt, ...sel, sel.filter((s) => s === 'Abstain').length]);
  }
  return rows;
}

router.get('/records/export.:fmt', requireElection, requirePerm('export_individual_votes'), async (req, res, next) => {
  try {
    const e = req.election;
    const rows = detailedRows(e);
    audit.log(req, 'Individual voting records exported', { category: 'ballot_access', entityType: 'election', entityId: e.id, entityLabel: e.name, details: { format: req.params.fmt, ballots: rows.length - 6 } });
    const name = `CONFIDENTIAL-individual-voting-records-${slug(e.name)}`;
    if (req.params.fmt === 'xlsx') return await sendXlsx(res, `${name}.xlsx`, [{ name: 'Confidential records', rows, boldRows: [1, 6] }]);
    sendCsv(res, `${name}.csv`, rows);
  } catch (err) { next(err); }
});

router.get('/records', requireElection, requirePerm('view_individual_votes', 'view_turnout'), (req, res) => {
  const e = req.election;
  const q = { q: clean(req.query.q, 100), vote: ['voted', 'not_voted'].includes(req.query.vote) ? req.query.vote : '', eligibility: 'eligible' };
  const page = Math.max(1, asInt(req.query.page) || 1);
  const { total, rows } = voters.listVoters(e.id, q, { limit: 50, offset: (page - 1) * 50, order: 'b.submitted_at IS NULL, b.submitted_at DESC, v.full_name' });
  res.render('admin/records', { title: 'Voting records', rows, total, page, pages: Math.max(1, Math.ceil(total / 50)), q, t: election.turnout(e.id) });
});

router.get('/records/:id', numericId, requireElection, requirePerm('view_individual_votes'), (req, res) => {
  const e = req.election;
  const v = voters.getVoterRow(e.id, asInt(req.params.id));
  if (!v) throw httpError(404, 'Voter not found.');
  const ballot = voting.ballotForVoter(v.id);
  if (ballot) {
    // Every view of an individual ballot is recorded in the append-only audit log.
    audit.log(req, `${req.admin.full_name} viewed submitted ballot for ${v.full_name}`, { category: 'ballot_access', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})` });
  }
  const unopposed = election.positionsWithCandidates(e.id).filter((p) => p.kind === 'unopposed');
  const accessHistory = db.get().prepare("SELECT * FROM audit_log WHERE category = 'ballot_access' AND entity_type = 'voter' AND entity_id = ? ORDER BY id DESC LIMIT 20").all(v.id);
  res.render('admin/vote', { title: `Ballot — ${v.full_name}`, v, ballot, unopposed, accessHistory });
});

module.exports = router;
