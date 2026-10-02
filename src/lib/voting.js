'use strict';
const crypto = require('crypto');
const db = require('../db');
const { nowIso } = require('./time');
const { normalizeCode, looksValid } = require('./codes');
const election = require('./election');

/**
 * Looks up a voting code entered by a voter.
 * Returns { state: 'valid'|'invalid'|'revoked'|'used'|'ineligible', code, voter }
 */
function checkCode(electionId, input) {
  const code = normalizeCode(input);
  if (!looksValid(code)) return { state: 'invalid' };
  const row = db.get().prepare(`SELECT c.*, v.eligibility, v.full_name, v.id AS v_id
    FROM voting_codes c JOIN voters v ON v.id = c.voter_id
    WHERE c.code = ? AND c.election_id = ?`).get(code, electionId);
  if (!row) return { state: 'invalid' };
  if (row.status === 'used') return { state: 'used', code: row };
  if (row.status === 'revoked') return { state: 'revoked', code: row };
  if (row.eligibility !== 'eligible') return { state: 'revoked', code: row };
  return { state: 'valid', code: row };
}

/**
 * Validates that `selections` ({positionId: candidateId|'abstain'}) is a complete ballot.
 * Returns { ok, errors, choices: [{positionId, candidateId|null}] }
 */
function validateSelections(electionId, selections) {
  const def = election.ballotDefinition(electionId).filter((p) => p.contested);
  const errors = [];
  const choices = [];
  for (const p of def) {
    const raw = selections ? selections[p.id] ?? selections[String(p.id)] : undefined;
    if (raw === undefined || raw === null || raw === '') {
      errors.push({ positionId: p.id, message: `Please select a candidate or choose to abstain for ${p.title}.` });
      continue;
    }
    if (raw === 'abstain') {
      choices.push({ positionId: p.id, candidateId: null });
      continue;
    }
    const cid = parseInt(raw, 10);
    if (!p.candidates.some((c) => c.id === cid)) {
      errors.push({ positionId: p.id, message: `The selection for ${p.title} is no longer valid. Please choose again.` });
      continue;
    }
    choices.push({ positionId: p.id, candidateId: cid });
  }
  return { ok: errors.length === 0, errors, choices, contestedCount: def.length };
}

class SubmissionError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

/**
 * Records a complete ballot atomically. Guarantees at most one accepted ballot per code/voter:
 *  - the whole operation runs inside a single IMMEDIATE (write-locked) transaction,
 *  - the code is re-checked inside the transaction,
 *  - UNIQUE constraints on ballots.voter_id / ballots.code_id and DB triggers form a final backstop.
 * If the same submission token is replayed after success (double click, refresh, lost response),
 * the existing ballot is returned as an idempotent success.
 */
function submitBallot({ electionId, codeId, selections, submissionToken }) {
  const d = db.get();
  const txn = d.transaction(() => {
    const e = election.getElection(electionId);
    const code = d.prepare('SELECT c.*, v.eligibility FROM voting_codes c JOIN voters v ON v.id = c.voter_id WHERE c.id = ? AND c.election_id = ?').get(codeId, electionId);
    if (!code) throw new SubmissionError('invalid');

    const existing = d.prepare('SELECT * FROM ballots WHERE code_id = ? OR voter_id = ?').get(code.id, code.voter_id);
    if (existing) {
      if (submissionToken && existing.submission_token === submissionToken) return { ballot: existing, replay: true };
      throw new SubmissionError('used');
    }
    if (code.status === 'used') throw new SubmissionError('used');
    if (code.status === 'revoked' || code.eligibility !== 'eligible') throw new SubmissionError('revoked');
    if (!election.isVotingOpen(e)) throw new SubmissionError('not_open');

    const v = validateSelections(electionId, selections);
    if (!v.ok) throw new SubmissionError('incomplete', v.errors.map((x) => x.message).join(' '));
    if (v.contestedCount === 0) throw new SubmissionError('incomplete', 'There are no contested positions on this ballot.');

    const now = nowIso();
    const receipt = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join(' ');
    const info = d.prepare('INSERT INTO ballots (election_id, voter_id, code_id, submission_token, submitted_at, receipt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(electionId, code.voter_id, code.id, submissionToken || crypto.randomUUID(), now, receipt);
    const ballotId = info.lastInsertRowid;
    const ins = d.prepare('INSERT INTO ballot_choices (ballot_id, position_id, candidate_id) VALUES (?, ?, ?)');
    for (const c of v.choices) ins.run(ballotId, c.positionId, c.candidateId);
    const upd = d.prepare("UPDATE voting_codes SET status = 'used', used_at = ? WHERE id = ? AND status = 'active'").run(now, code.id);
    if (upd.changes !== 1) throw new SubmissionError('used');
    return { ballot: d.prepare('SELECT * FROM ballots WHERE id = ?').get(ballotId), replay: false };
  });
  try {
    return txn.immediate();
  } catch (err) {
    if (err instanceof SubmissionError) throw err;
    if (err && /UNIQUE|locked|already/i.test(err.message)) {
      // A concurrent submission won the race. Check whether it was this same submission.
      const existing = d.prepare('SELECT * FROM ballots WHERE code_id = ?').get(codeId);
      if (existing && submissionToken && existing.submission_token === submissionToken) return { ballot: existing, replay: true };
      if (existing) throw new SubmissionError('used');
    }
    throw new SubmissionError('failure', err.message);
  }
}

function ballotForVoter(voterId) {
  const d = db.get();
  const ballot = d.prepare('SELECT * FROM ballots WHERE voter_id = ?').get(voterId);
  if (!ballot) return null;
  const choices = d.prepare(`SELECT bc.*, p.title AS position_title, p.sort_order, c.full_name AS candidate_name, c.batch AS candidate_batch
    FROM ballot_choices bc JOIN positions p ON p.id = bc.position_id LEFT JOIN candidates c ON c.id = bc.candidate_id
    WHERE bc.ballot_id = ? ORDER BY p.sort_order, p.id`).all(ballot.id);
  return { ...ballot, choices };
}

module.exports = { checkCode, validateSelections, submitBallot, ballotForVoter, SubmissionError };
