'use strict';
const db = require('../db');
const { isValidEmail } = require('./mailer');
const { nowIso } = require('./time');

const normEmail = (e) => String(e || '').trim().toLowerCase();
const normMobile = (m) => {
  const s = String(m || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  return digits ? (plus ? '+' : '') + digits : '';
};
const normName = (n) => String(n || '').toLowerCase().replace(/^(dr|mr|mrs|ms|prof|shri|smt)\.?\s+/, '').replace(/[^a-z]/g, '');

function nextVoterRef(electionId) {
  const rows = db.get().prepare("SELECT voter_ref FROM voters WHERE election_id = ? AND voter_ref LIKE 'MAA%'").all(electionId);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.voter_ref.replace(/^MAA\D*/, ''), 10);
    if (n > max) max = n;
  }
  return (n = 1) => `MAA${String(max + n).padStart(5, '0')}`;
}

const VOTER_LIST_SQL = `SELECT v.*,
    c.id AS code_id, c.code, c.status AS code_status_raw,
    CASE WHEN c.status IS NOT NULL THEN c.status
         WHEN EXISTS (SELECT 1 FROM voting_codes r WHERE r.voter_id = v.id AND r.status = 'revoked') THEN 'revoked'
         ELSE 'none' END AS code_status,
    b.id AS ballot_id, b.submitted_at,
    i.status AS inv_status, i.kind AS inv_kind, i.last_attempt_at AS inv_at, i.error AS inv_error,
    (SELECT COUNT(*) FROM invitations x WHERE x.voter_id = v.id) AS inv_count
  FROM voters v
  LEFT JOIN voting_codes c ON c.voter_id = v.id AND c.status IN ('active','used')
  LEFT JOIN ballots b ON b.voter_id = v.id
  LEFT JOIN invitations i ON i.id = (SELECT MAX(id) FROM invitations WHERE voter_id = v.id)`;

function buildFilter(electionId, q) {
  const where = ['v.election_id = @eid'];
  const params = { eid: electionId };
  if (q.q) {
    where.push('(v.full_name LIKE @q OR v.email LIKE @q OR v.mobile LIKE @q OR v.voter_ref LIKE @q OR v.batch LIKE @q)');
    params.q = `%${q.q}%`;
  }
  if (['pending', 'eligible', 'ineligible'].includes(q.eligibility)) {
    where.push('v.eligibility = @elig');
    params.elig = q.eligibility;
  }
  if (q.vote === 'voted') where.push('b.id IS NOT NULL');
  if (q.vote === 'not_voted') where.push('b.id IS NULL');
  if (q.code === 'none') where.push("c.id IS NULL AND NOT EXISTS (SELECT 1 FROM voting_codes r WHERE r.voter_id = v.id AND r.status = 'revoked')");
  if (q.code === 'active') where.push("c.status = 'active'");
  if (q.code === 'used') where.push("c.status = 'used'");
  if (q.code === 'revoked') where.push("c.id IS NULL AND EXISTS (SELECT 1 FROM voting_codes r WHERE r.voter_id = v.id AND r.status = 'revoked')");
  if (q.invitation === 'not_sent') where.push('i.id IS NULL');
  if (['queued', 'sent', 'delivered', 'failed'].includes(q.invitation)) {
    where.push(q.invitation === 'queued' ? "i.status IN ('queued','sending')" : 'i.status = @inv');
    params.inv = q.invitation;
  }
  if (q.filter === 'no_email') where.push("(v.email IS NULL OR v.email = '')");
  if (q.filter === 'no_mobile') where.push("(v.mobile IS NULL OR v.mobile = '')");
  return { where: where.join(' AND '), params };
}

function listVoters(electionId, q, { limit = 50, offset = 0, order = 'v.full_name COLLATE NOCASE' } = {}) {
  const { where, params } = buildFilter(electionId, q);
  const total = db.get().prepare(`SELECT COUNT(*) n FROM (${VOTER_LIST_SQL} WHERE ${where})`).get(params).n;
  const rows = db.get().prepare(`${VOTER_LIST_SQL} WHERE ${where} ORDER BY ${order} LIMIT ${limit | 0} OFFSET ${offset | 0}`).all(params);
  return { total, rows };
}

function getVoterRow(electionId, voterId) {
  return db.get().prepare(`${VOTER_LIST_SQL} WHERE v.election_id = ? AND v.id = ?`).get(electionId, voterId);
}

function qualityReport(electionId) {
  const d = db.get();
  const voters = d.prepare('SELECT * FROM voters WHERE election_id = ? ORDER BY full_name').all(electionId);
  const group = (keyFn) => {
    const m = new Map();
    for (const v of voters) {
      const k = keyFn(v);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(v);
    }
    return [...m.entries()].filter(([, arr]) => arr.length > 1).map(([key, arr]) => ({ key, voters: arr }));
  };
  return {
    duplicateEmail: group((v) => normEmail(v.email)),
    duplicateMobile: group((v) => normMobile(v.mobile)),
    duplicateName: group((v) => (normName(v.full_name) ? `${normName(v.full_name)}|${String(v.batch || '').trim()}` : '')),
    missingEmail: voters.filter((v) => !v.email),
    invalidEmail: voters.filter((v) => v.email && !isValidEmail(v.email)),
    missingMobile: voters.filter((v) => !v.mobile),
    total: voters.length,
  };
}

// ---------- Import ----------

const EMPTY_VALUES = /^(n\/?a|na|nil|none|not applicable|not available|null|[-–—.?x]+)$/i;
const EMAIL_RE = /[^\s@,;:<>()\[\]"']+@[^\s@,;:<>()\[\]"']+\.[A-Za-z]{2,}/g;

/** Splits a cell that may hold several emails: returns { primary, others, raw }. */
function splitEmails(raw) {
  const s = String(raw || '').trim();
  if (!s || EMPTY_VALUES.test(s)) return { primary: '', others: [], raw: '' };
  const found = [...new Set((s.match(EMAIL_RE) || []).map((e) => e.replace(/[.,;]+$/, '')))];
  if (!found.length) return { primary: '', others: [], raw: s };
  return { primary: found[0], others: found.slice(1), raw: s };
}

/** Splits a cell that may hold several phone numbers. */
function splitPhones(raw) {
  const s = String(raw || '').trim();
  if (!s || EMPTY_VALUES.test(s)) return { primary: '', others: [] };
  const parts = s.split(/\s*[,;\/|]\s*|\s{3,}|\s+(?:or|and)\s+/i)
    .map((p) => p.replace(/[^\d+()\s-]/g, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => (p.match(/\d/g) || []).length >= 6);
  const uniq = [...new Set(parts)];
  return { primary: uniq[0] || '', others: uniq.slice(1) };
}

/** "1996-98", "1996 – 1998", "1996/98", "1996 to 1998" → "1996-98". */
function normaliseBatch(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4})\s*(?:[-‐‑‒–—―−\/]|to)\s*(\d{2}|\d{4})$/i);
  if (!m) return s;
  return `${m[1]}-${m[2].slice(-2)}`;
}


const HEADER_ALIASES = {
  voter_ref: ['voter id', 'voterid', 'voter_id', 'id', 'member id', 'membership id', 'membership no', 'membership number', 'member no', 'alumni id', 'reg no', 'registration no'],
  full_name: ['name', 'full name', 'fullname', 'full_name', 'voter name', 'member name', 'alumni name'],
  first_name: ['first name', 'firstname', 'given name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address', 'email id', 'mail', 'e mail'],
  mobile: ['mobile', 'phone', 'mobile number', 'phone number', 'mobile no', 'contact', 'contact number', 'cell', 'telephone'],
  whatsapp: ['whatsapp', 'whatsapp number', 'whatsapp no', 'whats app'],
  batch: ['batch', 'year', 'batch/year', 'batch year', 'graduation year', 'passing year', 'pgdaem batch', 'course batch'],
  location: ['location', 'city', 'place', 'state', 'address', 'country'],
};

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase().replace(/[.:#*]/g, '').replace(/\s+/g, ' ').trim();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && (aliases.includes(key) || key === field || aliases.includes(key.replace(/ (id|no|number)$/, '')))) map[field] = i;
    }
  });
  return map;
}

/** rows: array of arrays (first = header). Returns analysed import rows. */
function analyseImport(electionId, table) {
  const [headers, ...data] = table;
  const map = mapHeaders(headers || []);
  const fatal = [];
  if (map.full_name === undefined && map.first_name === undefined) fatal.push('The file needs a "Name" (or "First name"/"Last name") column.');
  if (fatal.length) return { fatal, rows: [], map };

  const d = db.get();
  const existing = d.prepare('SELECT v.*, (SELECT 1 FROM ballots b WHERE b.voter_id = v.id) voted FROM voters v WHERE election_id = ?').all(electionId);
  const byRef = new Map(existing.map((v) => [v.voter_ref.toLowerCase(), v]));
  const byEmail = new Map();
  const byMobile = new Map();
  for (const v of existing) {
    if (v.email) byEmail.set(normEmail(v.email), [...(byEmail.get(normEmail(v.email)) || []), v]);
    if (v.mobile) byMobile.set(normMobile(v.mobile), [...(byMobile.get(normMobile(v.mobile)) || []), v]);
  }
  const seenRef = new Map();
  const seenEmail = new Map();
  const seenMobile = new Map();
  const seenMatch = new Set();
  const cell = (r, f) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());

  const rows = [];
  data.forEach((r, idx) => {
    if (!r || r.every((x) => String(x ?? '').trim() === '')) return;
    const rowNo = idx + 2;
    let fullName = cell(r, 'full_name');
    if (!fullName) fullName = [cell(r, 'first_name'), cell(r, 'last_name')].filter(Boolean).join(' ');
    const em = splitEmails(cell(r, 'email'));
    const ph = splitPhones(cell(r, 'mobile'));
    const wa = splitPhones(cell(r, 'whatsapp'));
    const location = cell(r, 'location');
    const extra = [];
    if (em.others.length) extra.push(`Other emails: ${em.others.join(', ')}`);
    if (ph.others.length) extra.push(`Other phones: ${ph.others.join(', ')}`);
    if (location && !EMPTY_VALUES.test(location)) extra.push(`Location: ${location}`);
    const item = {
      row: rowNo,
      voter_ref: cell(r, 'voter_ref').slice(0, 60),
      full_name: fullName.replace(/\s+/g, ' ').slice(0, 150),
      email: (em.primary || '').slice(0, 200),
      mobile: ph.primary.slice(0, 40),
      whatsapp: wa.primary.slice(0, 40),
      batch: normaliseBatch(cell(r, 'batch')).slice(0, 60),
      notes: extra.join(' | ').slice(0, 1000),
      errors: [], warnings: [], action: 'create', matchId: null,
    };
    if (!item.full_name) item.errors.push('Missing name');
    if (!em.raw) item.warnings.push('Missing email');
    else if (!em.primary) item.warnings.push(`Invalid email: "${em.raw.slice(0, 60)}"`);
    if (em.others.length) item.warnings.push(`Several emails: invitation goes to ${em.primary}`);
    if (!item.mobile) item.warnings.push('Missing phone');
    if (ph.others.length) item.warnings.push('Several phone numbers: first one used');

    // Match to an existing voter record (stable identity) so repeat imports never duplicate entitlements.
    let match = null;
    if (item.voter_ref) match = byRef.get(item.voter_ref.toLowerCase()) || null;
    if (!match && item.email) {
      const cands = (byEmail.get(normEmail(item.email)) || []).filter((v) => normName(v.full_name) === normName(item.full_name));
      if (cands.length === 1) match = cands[0];
    }
    if (!match && !item.email && item.mobile) {
      const cands = (byMobile.get(normMobile(item.mobile)) || []).filter((v) => normName(v.full_name) === normName(item.full_name));
      if (cands.length === 1) match = cands[0];
    }
    if (match) {
      if (seenMatch.has(match.id)) item.errors.push(`Same person appears earlier in this file (${match.voter_ref})`);
      seenMatch.add(match.id);
      item.action = 'update';
      item.matchId = match.id;
      item.matchRef = match.voter_ref;
      if (match.voted) item.warnings.push('Already voted — only contact details will be updated');
    } else {
      if (item.email) {
        const others = byEmail.get(normEmail(item.email)) || [];
        if (others.length) item.warnings.push(`Email also used by existing voter ${others.map((o) => o.full_name).join(', ')}`);
      }
      if (item.mobile) {
        const others = byMobile.get(normMobile(item.mobile)) || [];
        if (others.length) item.warnings.push(`Mobile also used by existing voter ${others.map((o) => o.full_name).join(', ')}`);
      }
    }
    if (item.voter_ref) {
      const k = item.voter_ref.toLowerCase();
      if (seenRef.has(k)) item.errors.push(`Duplicate Voter ID in file (row ${seenRef.get(k)})`);
      else seenRef.set(k, rowNo);
    }
    if (item.email) {
      const k = normEmail(item.email);
      if (seenEmail.has(k)) item.warnings.push(`Possible duplicate: same email as row ${seenEmail.get(k)}`);
      else seenEmail.set(k, rowNo);
    }
    if (item.mobile) {
      const k = normMobile(item.mobile);
      if (seenMobile.has(k)) item.warnings.push(`Possible duplicate: same mobile as row ${seenMobile.get(k)}`);
      else seenMobile.set(k, rowNo);
    }
    if (item.errors.length) item.action = 'skip';
    rows.push(item);
  });
  return { fatal, rows, map };
}

function applyImport(electionId, rows, { eligibility = 'pending' } = {}) {
  const d = db.get();
  const nextRef = nextVoterRef(electionId);
  let refCounter = 0;
  const now = nowIso();
  const stats = { created: 0, updated: 0, skipped: 0 };
  d.transaction(() => {
    for (const r of rows) {
      if (r.action === 'skip') { stats.skipped++; continue; }
      if (r.action === 'update' && r.matchId) {
        const v = d.prepare('SELECT v.*, (SELECT 1 FROM ballots b WHERE b.voter_id = v.id) voted FROM voters v WHERE id = ? AND election_id = ?').get(r.matchId, electionId);
        if (!v) { stats.skipped++; continue; }
        if (v.voted) {
          d.prepare('UPDATE voters SET email = COALESCE(NULLIF(?, \'\'), email), mobile = COALESCE(NULLIF(?, \'\'), mobile), whatsapp = COALESCE(NULLIF(?, \'\'), whatsapp), updated_at = ? WHERE id = ?')
            .run(r.email, r.mobile, r.whatsapp, now, v.id);
        } else {
          d.prepare(`UPDATE voters SET full_name = ?, email = COALESCE(NULLIF(?, ''), email), mobile = COALESCE(NULLIF(?, ''), mobile),
            whatsapp = COALESCE(NULLIF(?, ''), whatsapp), batch = COALESCE(NULLIF(?, ''), batch), notes = COALESCE(NULLIF(?, ''), notes), updated_at = ? WHERE id = ?`)
            .run(r.full_name, r.email, r.mobile, r.whatsapp, r.batch, r.notes || '', now, v.id);
        }
        stats.updated++;
        continue;
      }
      let ref = r.voter_ref;
      if (!ref || d.prepare('SELECT 1 FROM voters WHERE election_id = ? AND voter_ref = ?').get(electionId, ref)) ref = nextRef(++refCounter);
      d.prepare('INSERT INTO voters (election_id, voter_ref, full_name, email, mobile, whatsapp, batch, eligibility, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(electionId, ref, r.full_name, r.email || null, r.mobile || null, r.whatsapp || null, r.batch || null, eligibility, r.notes || null, now, now);
      stats.created++;
    }
  })();
  return stats;
}

module.exports = {
  normEmail, normMobile, normName, splitEmails, splitPhones, normaliseBatch, nextVoterRef, listVoters, getVoterRow, qualityReport, analyseImport, applyImport, mapHeaders, VOTER_LIST_SQL,
};
