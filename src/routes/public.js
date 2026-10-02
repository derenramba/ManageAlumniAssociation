'use strict';
const express = require('express');
const db = require('../db');
const election = require('../lib/election');
const voting = require('../lib/voting');
const results = require('../lib/results');
const sessions = require('../lib/sessions');
const { createRateLimiter, randomToken } = require('../lib/security');

const router = express.Router();
const codeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

const MESSAGES = {
  invalid: 'The voting code you entered is not valid. Please check the code and try again.',
  revoked: 'This voting code is no longer active. Please contact election support for assistance.',
  used: 'A ballot has already been submitted using this code.',
  not_open: 'Voting is not open at the moment.',
  suspended: 'Voting has been temporarily suspended. Please try again later.',
  closed: 'Voting has closed. Ballots can no longer be submitted.',
  rate: 'Too many attempts. Please wait a few minutes and try again.',
  failure: 'We could not record your ballot because of a temporary problem. Your vote has NOT been counted yet. Please try submitting again.',
  expired: 'Your voting session has expired. Please enter your voting code again.',
};

function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function closedReason(e) {
  if (!e) return 'not_open';
  const s = election.statusInfo(e).publicKey;
  if (s === 'suspended') return 'suspended';
  if (s === 'closed' || s === 'published') return 'closed';
  return 'not_open';
}

function notOpenMessage(e) {
  const reason = closedReason(e);
  if (reason === 'not_open' && e && e.opens_at) {
    return `Voting has not opened yet. It opens on ${require('../lib/time').formatDateTime(e.opens_at)}.`;
  }
  return MESSAGES[reason];
}

function publicTurnout(e) {
  if (!e || !e.show_turnout_publicly) return null;
  if (!['open', 'suspended', 'closed', 'results_review', 'published', 'archived'].includes(e.status)) return null;
  return election.turnout(e.id);
}

// ---------- Landing page ----------
router.get('/', noStore, (req, res) => {
  const e = req.election;
  if (!e) return res.render('public/no-election', { title: 'Election' });
  const unopposed = election.ballotDefinition(e.id).filter((p) => !p.contested && p.unopposedCandidate);
  res.render('public/welcome', {
    title: e.name,
    turnout: publicTurnout(e),
    votingOpen: election.isVotingOpen(e),
    notOpenMessage: notOpenMessage(e),
    error: null,
    errorKind: null,
    codeValue: '',
    unopposed,
  });
});

// ---------- Code entry ----------
router.post('/vote', noStore, (req, res) => {
  const e = req.election;
  if (!e) return res.redirect('/');
  const render = (errorKind, status = 200) => res.status(status).render('public/welcome', {
    title: e.name,
    turnout: publicTurnout(e),
    votingOpen: election.isVotingOpen(e),
    notOpenMessage: notOpenMessage(e),
    error: errorKind === 'not_open' ? notOpenMessage(e) : MESSAGES[errorKind],
    errorKind,
    codeValue: errorKind === 'invalid' ? String(req.body.code || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().slice(0, 40) : '',
    unopposed: election.ballotDefinition(e.id).filter((p) => !p.contested && p.unopposedCandidate),
  });

  if (!codeLimiter.hit(req.ip)) return render('rate', 429);
  if (!election.isVotingOpen(e)) return render('not_open');

  const result = voting.checkCode(e.id, req.body.code);
  if (result.state === 'used') {
    if (req.voterSession) sessions.destroySession(res, req.voterSession, 'voter');
    return res.render('public/already-voted', { title: 'Already submitted', turnout: publicTurnout(e) });
  }
  if (result.state !== 'valid') return render(result.state);

  if (req.voterSession) sessions.destroySession(res, req.voterSession, 'voter');
  sessions.createSession(res, 'voter', { data: { electionId: e.id, codeId: result.code.id, selections: {}, submissionToken: randomToken(18) } });
  res.redirect(303, '/ballot');
});

// ---------- Ballot helpers ----------
function requireVoter(req, res, next) {
  const e = req.election;
  const s = req.voterSession;
  if (!e || !s || s.data.electionId !== e.id) {
    return res.status(401).render('public/message', { title: 'Session expired', heading: 'Please enter your voting code', message: MESSAGES.expired, tone: 'info', action: { href: '/', label: 'Enter voting code' } });
  }
  const code = db.get().prepare('SELECT c.*, v.eligibility FROM voting_codes c JOIN voters v ON v.id = c.voter_id WHERE c.id = ?').get(s.data.codeId);
  if (!code) return res.redirect('/');
  if (code.status === 'used') {
    const ballot = db.get().prepare('SELECT * FROM ballots WHERE code_id = ?').get(code.id);
    if (ballot && ballot.submission_token === s.data.submissionToken) return res.redirect(303, '/thank-you');
    sessions.destroySession(res, s, 'voter');
    return res.render('public/already-voted', { title: 'Already submitted', turnout: publicTurnout(e) });
  }
  if (code.status === 'revoked' || code.eligibility !== 'eligible') {
    sessions.destroySession(res, s, 'voter');
    return res.render('public/message', { title: 'Code not active', heading: 'Voting code not active', message: MESSAGES.revoked, tone: 'error', action: { href: '/', label: 'Back to start' } });
  }
  if (!election.isVotingOpen(e)) {
    return res.render('public/message', { title: 'Voting not open', heading: 'Voting is not open', message: notOpenMessage(e), tone: 'warning', action: { href: '/', label: 'Back to start' } });
  }
  req.voterCode = code;
  next();
}

function ballotView(e) {
  const def = election.ballotDefinition(e.id);
  return { positions: def, contested: def.filter((p) => p.contested), unopposed: def.filter((p) => !p.contested) };
}

function pickSelections(body, contested) {
  const out = {};
  for (const p of contested) {
    const v = body ? body[`pos_${p.id}`] : undefined;
    if (v === 'abstain') out[p.id] = 'abstain';
    else if (v && p.candidates.some((c) => String(c.id) === String(v))) out[p.id] = String(v);
  }
  return out;
}

// ---------- Ballot ----------
router.get('/ballot', noStore, requireVoter, (req, res) => {
  const e = req.election;
  const v = ballotView(e);
  res.render('public/ballot', { title: 'Your ballot', ...v, selections: req.voterSession.data.selections || {}, errors: {} });
});

router.post('/ballot', noStore, requireVoter, (req, res) => {
  const e = req.election;
  const v = ballotView(e);
  const selections = pickSelections(req.body, v.contested);
  req.voterSession.data.selections = selections;
  sessions.saveSessionData(req.voterSession);
  const check = voting.validateSelections(e.id, selections);
  if (!check.ok) {
    const errors = Object.fromEntries(check.errors.map((x) => [x.positionId, x.message]));
    return res.status(422).render('public/ballot', { title: 'Your ballot', ...v, selections, errors, incomplete: true });
  }
  res.redirect(303, '/ballot/review');
});

router.get('/ballot/review', noStore, requireVoter, (req, res) => {
  const e = req.election;
  const v = ballotView(e);
  const selections = req.voterSession.data.selections || {};
  const check = voting.validateSelections(e.id, selections);
  if (!check.ok) return res.redirect(303, '/ballot');
  res.render('public/review', { title: 'Review your choices', ...v, selections, submissionToken: req.voterSession.data.submissionToken, error: null });
});

router.post('/ballot/submit', noStore, (req, res, next) => {
  const e = req.election;
  const s = req.voterSession;
  if (!e || !s || s.data.electionId !== e.id) {
    return res.status(401).render('public/message', { title: 'Session expired', heading: 'Please enter your voting code', message: MESSAGES.expired + ' If you already submitted, entering the code again will confirm whether your ballot was recorded.', tone: 'info', action: { href: '/', label: 'Enter voting code' } });
  }
  const token = String(req.body.submission_token || '');
  try {
    voting.submitBallot({ electionId: e.id, codeId: s.data.codeId, selections: s.data.selections, submissionToken: token === s.data.submissionToken ? token : null });
    s.data.submitted = true;
    sessions.saveSessionData(s);
    return res.redirect(303, '/thank-you');
  } catch (err) {
    if (!(err instanceof voting.SubmissionError)) return next(err);
    const v = ballotView(e);
    switch (err.reason) {
      case 'used':
        sessions.destroySession(res, s, 'voter');
        return res.status(409).render('public/already-voted', { title: 'Already submitted', turnout: publicTurnout(e) });
      case 'revoked':
      case 'invalid':
        sessions.destroySession(res, s, 'voter');
        return res.status(403).render('public/message', { title: 'Code not active', heading: 'Voting code not active', message: MESSAGES.revoked, tone: 'error' });
      case 'not_open':
        return res.status(403).render('public/message', { title: 'Voting not open', heading: 'Your ballot was not recorded', message: notOpenMessage(e), tone: 'warning', action: { href: '/', label: 'Back to start' } });
      case 'incomplete':
        return res.redirect(303, '/ballot');
      default:
        console.error('Ballot submission failure', err.message);
        return res.status(503).render('public/review', { title: 'Review your choices', ...v, selections: s.data.selections || {}, submissionToken: s.data.submissionToken, error: MESSAGES.failure });
    }
  }
});

// ---------- Confirmation ----------
router.get('/thank-you', noStore, (req, res) => {
  const e = req.election;
  const s = req.voterSession;
  if (!e || !s || !s.data.codeId) return res.redirect('/');
  const ballot = db.get().prepare('SELECT * FROM ballots WHERE code_id = ?').get(s.data.codeId);
  // Only show success if the ballot is actually recorded for this session's submission.
  if (!ballot || ballot.submission_token !== s.data.submissionToken) return res.redirect('/ballot');
  res.render('public/thank-you', { title: 'Thank you for voting', ballot, turnout: election.turnout(e.id), showTurnout: !!e.show_turnout_publicly });
});

router.post('/exit', (req, res) => {
  if (req.voterSession) sessions.destroySession(res, req.voterSession, 'voter');
  res.redirect(303, '/');
});

// ---------- Turnout API (aggregate only) ----------
router.get('/api/turnout', noStore, (req, res) => {
  const e = req.election;
  const t = publicTurnout(e);
  if (!t) return res.json({ available: false });
  res.json({ available: true, eligible: t.eligible, voted: t.voted, pct: Number(t.pct.toFixed(1)), status: election.statusInfo(e).publicLabel });
});

// ---------- Public results (only after deliberate publication) ----------
router.get('/results', noStore, (req, res) => {
  const e = req.election;
  if (!e || e.status !== 'published') {
    return res.render('public/message', { title: 'Results', heading: 'Results not yet published', message: 'Official results will appear here once they have been reviewed and published by the election administrators.', tone: 'info', action: { href: '/', label: 'Back to election page' } });
  }
  res.render('public/results', { title: 'Official results', r: results.computeResults(e.id) });
});

router.get('/healthz', (req, res) => res.json({ ok: true }));

module.exports = router;
