'use strict';
const db = require('../db');
const election = require('./election');

function computeResults(electionId) {
  const d = db.get();
  const t = election.turnout(electionId);
  const ballots = d.prepare('SELECT COUNT(*) n FROM ballots WHERE election_id = ?').get(electionId).n;
  const positions = election.positionsWithCandidates(electionId);
  const out = [];
  const warnings = [];

  for (const p of positions) {
    if (p.kind === 'unopposed') {
      out.push({ ...p, unopposed: true });
      continue;
    }
    const counts = d.prepare(`SELECT bc.candidate_id, COUNT(*) n FROM ballot_choices bc JOIN ballots b ON b.id = bc.ballot_id
      WHERE b.election_id = ? AND bc.position_id = ? GROUP BY bc.candidate_id`).all(electionId, p.id);
    const map = new Map(counts.map((r) => [r.candidate_id, r.n]));
    const abstain = map.get(null) || 0;
    // Include every candidate that was on the ballot (approved) plus any that received votes.
    const rows = p.candidates
      .filter((c) => c.status === 'approved' || map.has(c.id))
      .map((c) => ({ id: c.id, name: c.full_name, batch: c.batch, photo_path: c.photo_path, status: c.status, votes: map.get(c.id) || 0 }));
    const unknown = counts.filter((r) => r.candidate_id !== null && !rows.some((x) => x.id === r.candidate_id));
    for (const u of unknown) rows.push({ id: u.candidate_id, name: `Unknown candidate #${u.candidate_id}`, votes: u.n });
    rows.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const candidateTotal = rows.reduce((s, r) => s + r.votes, 0);
    const total = candidateTotal + abstain;
    const reconciled = total === ballots;
    if (!reconciled) warnings.push(`${p.title}: candidate votes (${candidateTotal}) + abstentions (${abstain}) = ${total}, but ${ballots} ballots were accepted.`);
    const top = rows.length ? rows[0].votes : 0;
    const leaders = rows.filter((r) => r.votes === top && top > 0);
    const tie = leaders.length > 1;
    for (const r of rows) r.pct = total ? (r.votes / total) * 100 : 0;
    out.push({
      ...p, unopposed: false, rows, abstain, abstainPct: total ? (abstain / total) * 100 : 0,
      candidateTotal, total, reconciled, tie, leaders, winner: !tie && leaders.length === 1 ? leaders[0] : null,
    });
  }
  return { turnout: t, ballots, positions: out, warnings, reconciled: warnings.length === 0 };
}

module.exports = { computeResults };
