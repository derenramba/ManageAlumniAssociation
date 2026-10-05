'use strict';
const express = require('express');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const db = require('../../db');
const election = require('../../lib/election');
const audit = require('../../lib/audit');
const voters = require('../../lib/voters');
const voting = require('../../lib/voting');
const { isValidEmail } = require('../../lib/mailer');
const { nowIso } = require('../../lib/time');
const { flash, clean, asInt, httpError } = require('../../lib/http');
const { verifyCsrf } = require('../../lib/csrf');
const { requirePerm, requireElection } = require('./guards');

const router = express.Router();
router.use(requireElection);

const PER_PAGE = 50;
const numericId = (req, res, next) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

router.get('/voters', requirePerm('manage_voters', 'view_turnout', 'manage_codes', 'send_invitations'), (req, res) => {
  const e = req.election;
  const q = {
    q: clean(req.query.q, 100), eligibility: req.query.eligibility, vote: req.query.vote,
    code: req.query.code, invitation: req.query.invitation, filter: req.query.filter,
  };
  const page = Math.max(1, asInt(req.query.page) || 1);
  const { total, rows } = voters.listVoters(e.id, q, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
  const d = db.get();
  const counts = Object.fromEntries(d.prepare('SELECT eligibility, COUNT(*) n FROM voters WHERE election_id = ? GROUP BY eligibility').all(e.id).map((r) => [r.eligibility, r.n]));
  const noEmail = d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'eligible' AND (email IS NULL OR email = '')").get(e.id).n;
  res.render('admin/voters', {
    title: 'Voter register', rows, total, page, pages: Math.max(1, Math.ceil(total / PER_PAGE)), q,
    counts: { pending: counts.pending || 0, eligible: counts.eligible || 0, ineligible: counts.ineligible || 0 },
    noEmail, listApproved: !!e.voter_list_approved_at, everOpened: election.hasEverOpened(e),
  });
});

router.get('/voters/quality', requirePerm('manage_voters'), (req, res) => {
  res.render('admin/voters-quality', { title: 'Duplicate & incomplete records', report: voters.qualityReport(req.election.id) });
});

router.get('/voters/new', requirePerm('manage_voters'), (req, res) => {
  res.render('admin/voter-form', { title: 'Add voter', voter: { eligibility: 'pending' }, isNew: true, listApproved: !!req.election.voter_list_approved_at });
});

function amendmentReason(req, res, back) {
  // After the voter list has been approved, any change to the electorate needs an explicit, recorded reason.
  if (!req.election.voter_list_approved_at) return { ok: true, reason: null };
  const reason = clean(req.body.amend_reason, 500);
  if (!reason) {
    flash(res, 'error', 'The final voter list has been approved. Changing the electorate requires a reason for the amendment.');
    res.redirect(303, back);
    return { ok: false };
  }
  return { ok: true, reason };
}

function validateVoterInput(body) {
  const v = {
    voter_ref: clean(body.voter_ref, 60),
    full_name: clean(body.full_name, 150),
    email: clean(body.email, 200),
    mobile: clean(body.mobile, 40),
    whatsapp: clean(body.whatsapp, 40),
    batch: clean(body.batch, 60),
    notes: clean(body.notes, 1000),
  };
  const errors = [];
  if (!v.full_name) errors.push('Full name is required.');
  if (v.email && !isValidEmail(v.email)) errors.push('The email address does not look valid.');
  return { v, errors };
}

router.post('/voters', requirePerm('manage_voters'), (req, res) => {
  const e = req.election;
  const { v, errors } = validateVoterInput(req.body);
  if (errors.length) {
    errors.forEach((m) => flash(res, 'error', m));
    return res.redirect(303, '/admin/voters/new');
  }
  const eligibility = ['pending', 'eligible', 'ineligible'].includes(req.body.eligibility) ? req.body.eligibility : 'pending';
  const amend = eligibility === 'eligible' ? amendmentReason(req, res, '/admin/voters/new') : { ok: true };
  if (!amend.ok) return;
  const d = db.get();
  if (v.voter_ref && d.prepare('SELECT 1 FROM voters WHERE election_id = ? AND voter_ref = ?').get(e.id, v.voter_ref)) {
    flash(res, 'error', `Voter ID ${v.voter_ref} already exists. Each person must have only one voter record.`);
    return res.redirect(303, '/admin/voters/new');
  }
  const ref = v.voter_ref || voters.nextVoterRef(e.id)(1);
  const now = nowIso();
  const id = d.prepare('INSERT INTO voters (election_id, voter_ref, full_name, email, mobile, whatsapp, batch, eligibility, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.id, ref, v.full_name, v.email || null, v.mobile || null, v.whatsapp || null, v.batch || null, eligibility, v.notes || null, now, now).lastInsertRowid;
  audit.log(req, 'Voter added', { category: 'voters', entityType: 'voter', entityId: id, entityLabel: `${v.full_name} (${ref})`, details: { eligibility } });
  if (amend.reason) audit.log(req, 'Electorate amended (voter added after list approval)', { category: 'voters', entityType: 'voter', entityId: id, entityLabel: `${v.full_name} (${ref})`, details: { reason: amend.reason } });
  const dupes = d.prepare('SELECT full_name FROM voters WHERE election_id = ? AND id <> ? AND ((email IS NOT NULL AND lower(email) = lower(?)) OR (mobile IS NOT NULL AND mobile = ?))').all(e.id, id, v.email || '', v.mobile || '');
  if (dupes.length) flash(res, 'warning', `Possible duplicate: shares contact details with ${dupes.map((x) => x.full_name).join(', ')}. Please review.`);
  flash(res, 'success', `Voter ${v.full_name} added.`);
  res.redirect(303, `/admin/voters/${id}`);
});

function loadVoter(req) {
  const v = voters.getVoterRow(req.election.id, asInt(req.params.id));
  if (!v) throw httpError(404, 'Voter not found.');
  return v;
}

router.get('/voters/:id', numericId, requirePerm('manage_voters', 'view_turnout', 'manage_codes', 'send_invitations'), (req, res) => {
  const v = loadVoter(req);
  const d = db.get();
  const codeHistory = d.prepare('SELECT * FROM voting_codes WHERE voter_id = ? ORDER BY id DESC').all(v.id);
  const invitations = d.prepare('SELECT i.*, a.full_name AS admin_name FROM invitations i LEFT JOIN admin_users a ON a.id = i.requested_by WHERE i.voter_id = ? ORDER BY i.id DESC').all(v.id);
  const history = d.prepare("SELECT * FROM audit_log WHERE entity_type = 'voter' AND entity_id = ? ORDER BY id DESC LIMIT 50").all(v.id);
  const wa = require('../../lib/whatsapp');
  res.render('admin/voter', { title: v.full_name, v, codeHistory, invitations, history, listApproved: !!req.election.voter_list_approved_at, waPhone: wa.display(wa.voterPhone(v)), smsPhone: wa.display(require('../../lib/sms').voterPhone(v)) });
});

router.get('/voters/:id/edit', numericId, requirePerm('manage_voters'), (req, res) => {
  const v = loadVoter(req);
  res.render('admin/voter-form', { title: `Edit ${v.full_name}`, voter: v, isNew: false, listApproved: !!req.election.voter_list_approved_at });
});

router.post('/voters/:id', numericId, requirePerm('manage_voters'), (req, res) => {
  const cur = loadVoter(req);
  const { v, errors } = validateVoterInput({ ...req.body, full_name: cur.ballot_id ? cur.full_name : req.body.full_name });
  if (errors.length) {
    errors.forEach((m) => flash(res, 'error', m));
    return res.redirect(303, `/admin/voters/${cur.id}/edit`);
  }
  const d = db.get();
  const voted = !!cur.ballot_id;
  if (!voted && v.voter_ref && v.voter_ref !== cur.voter_ref && d.prepare('SELECT 1 FROM voters WHERE election_id = ? AND voter_ref = ? AND id <> ?').get(req.election.id, v.voter_ref, cur.id)) {
    flash(res, 'error', `Voter ID ${v.voter_ref} is already used by another voter.`);
    return res.redirect(303, `/admin/voters/${cur.id}/edit`);
  }
  const now = nowIso();
  if (voted) {
    // Ballot already submitted: only harmless contact details may be corrected.
    d.prepare('UPDATE voters SET email = ?, mobile = ?, whatsapp = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(v.email || null, v.mobile || null, v.whatsapp || null, v.notes || null, now, cur.id);
  } else {
    d.prepare('UPDATE voters SET voter_ref = ?, full_name = ?, email = ?, mobile = ?, whatsapp = ?, batch = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(v.voter_ref || cur.voter_ref, v.full_name, v.email || null, v.mobile || null, v.whatsapp || null, v.batch || null, v.notes || null, now, cur.id);
  }
  const details = {};
  for (const k of ['voter_ref', 'full_name', 'email', 'mobile', 'whatsapp', 'batch']) {
    if (voted && !['email', 'mobile', 'whatsapp'].includes(k)) continue;
    if ((v[k] || '') !== (cur[k] || '') && !(k === 'voter_ref' && !v[k])) details[k] = { from: cur[k], to: v[k] };
  }
  if (Object.keys(details).length) audit.log(req, voted ? 'Voter contact details corrected (already voted)' : 'Voter edited', { category: 'voters', entityType: 'voter', entityId: cur.id, entityLabel: `${cur.full_name} (${cur.voter_ref})`, details });
  flash(res, 'success', 'Voter details saved.' + (voted ? ' (Ballot already submitted — only contact details can be changed.)' : ''));
  res.redirect(303, `/admin/voters/${cur.id}`);
});

function setEligibility(req, voterRow, eligibility, reason) {
  const d = db.get();
  if (voterRow.ballot_id) return { ok: false, message: `${voterRow.full_name} has already voted; eligibility is locked.` };
  if (voterRow.eligibility === eligibility) return { ok: true, unchanged: true };
  d.transaction(() => {
    d.prepare('UPDATE voters SET eligibility = ?, updated_at = ? WHERE id = ?').run(eligibility, nowIso(), voterRow.id);
    if (eligibility !== 'eligible') {
      // Remove any unused voting entitlement so an ineligible person can never vote.
      const revoked = d.prepare("UPDATE voting_codes SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE voter_id = ? AND status = 'active'")
        .run(nowIso(), 'Voter no longer eligible', voterRow.id).changes;
      if (revoked) audit.log(req, 'Code revoked', { category: 'codes', entityType: 'voter', entityId: voterRow.id, entityLabel: `${voterRow.full_name} (${voterRow.voter_ref})`, details: { reason: 'Voter no longer eligible' } });
    }
  })();
  audit.log(req, 'Eligibility changed', { category: 'voters', entityType: 'voter', entityId: voterRow.id, entityLabel: `${voterRow.full_name} (${voterRow.voter_ref})`, details: { from: voterRow.eligibility, to: eligibility, ...(reason ? { amendment_reason: reason } : {}) } });
  return { ok: true };
}

router.post('/voters/:id/eligibility', numericId, requirePerm('manage_voters'), (req, res) => {
  const v = loadVoter(req);
  const eligibility = req.body.eligibility;
  if (!['pending', 'eligible', 'ineligible'].includes(eligibility)) throw httpError(400, 'Invalid eligibility.');
  const amend = amendmentReason(req, res, `/admin/voters/${v.id}`);
  if (!amend.ok) return;
  const r = setEligibility(req, v, eligibility, amend.reason);
  flash(res, r.ok ? 'success' : 'error', r.ok ? `Eligibility for ${v.full_name} set to ${eligibility}.` : r.message);
  res.redirect(303, `/admin/voters/${v.id}`);
});

router.post('/voters/bulk', requirePerm('manage_voters'), (req, res) => {
  const ids = [].concat(req.body.ids || []).map(asInt).filter(Boolean);
  const action = req.body.bulk_action;
  const back = '/admin/voters' + (req.body.back_qs && String(req.body.back_qs).startsWith('?') ? String(req.body.back_qs) : '');
  if (!['eligible', 'ineligible', 'pending'].includes(action)) {
    flash(res, 'error', 'Choose an action.');
    return res.redirect(303, back);
  }
  let targets;
  if (req.body.scope === 'all_pending') {
    targets = db.get().prepare("SELECT id FROM voters WHERE election_id = ? AND eligibility = 'pending'").all(req.election.id).map((r) => r.id);
  } else targets = ids;
  if (!targets.length) {
    flash(res, 'error', 'Select at least one voter.');
    return res.redirect(303, back);
  }
  const amend = amendmentReason(req, res, back);
  if (!amend.ok) return;
  let ok = 0;
  const failed = [];
  for (const id of targets) {
    const v = voters.getVoterRow(req.election.id, id);
    if (!v) continue;
    const r = setEligibility(req, v, action, amend.reason);
    if (r.ok) ok++; else failed.push(v.full_name);
  }
  flash(res, 'success', `${ok} voter(s) set to ${action}.`);
  if (failed.length) flash(res, 'error', `Not changed (already voted): ${failed.join(', ')}`);
  res.redirect(303, back);
});

router.post('/voters/:id/delete', numericId, requirePerm('manage_voters'), (req, res) => {
  const v = loadVoter(req);
  const d = db.get();
  if (election.hasEverOpened(req.election) || req.election.voter_list_approved_at) {
    flash(res, 'error', 'Voter records cannot be deleted once the voter list is approved. Mark the voter as ineligible instead.');
    return res.redirect(303, `/admin/voters/${v.id}`);
  }
  if (d.prepare('SELECT 1 FROM voting_codes WHERE voter_id = ?').get(v.id) || d.prepare('SELECT 1 FROM invitations WHERE voter_id = ?').get(v.id)) {
    flash(res, 'error', 'This voter already has voting code history. Mark the voter as ineligible instead of deleting.');
    return res.redirect(303, `/admin/voters/${v.id}`);
  }
  d.prepare('DELETE FROM voters WHERE id = ?').run(v.id);
  audit.log(req, 'Voter deleted', { category: 'voters', entityType: 'voter', entityId: v.id, entityLabel: `${v.full_name} (${v.voter_ref})` });
  flash(res, 'success', `Voter ${v.full_name} deleted.`);
  res.redirect(303, '/admin/voters');
});

// ---------- Final voter list approval ----------
router.post('/voters/approve-list', requirePerm('manage_voters'), (req, res) => {
  const e = req.election;
  const d = db.get();
  const pending = d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'pending'").get(e.id).n;
  const eligible = d.prepare("SELECT COUNT(*) n FROM voters WHERE election_id = ? AND eligibility = 'eligible'").get(e.id).n;
  if (req.body.confirm !== 'yes') {
    flash(res, 'error', 'Please tick the confirmation box to approve the final voter list.');
    return res.redirect(303, '/admin/voters');
  }
  if (pending > 0) {
    flash(res, 'error', `${pending} voter(s) are still awaiting eligibility review. Mark each as eligible or ineligible first.`);
    return res.redirect(303, '/admin/voters?eligibility=pending');
  }
  if (!eligible) {
    flash(res, 'error', 'There are no eligible voters to approve.');
    return res.redirect(303, '/admin/voters');
  }
  d.prepare('UPDATE elections SET voter_list_approved_at = ?, voter_list_approved_by = ?, updated_at = ? WHERE id = ?').run(nowIso(), req.admin.id, nowIso(), e.id);
  audit.log(req, 'Voter list approved', { category: 'voters', entityType: 'election', entityId: e.id, entityLabel: e.name, details: { eligible } });
  flash(res, 'success', `Final voter list approved: ${eligible} eligible voters. Next step: generate voting codes.`);
  res.redirect(303, '/admin/codes');
});

router.post('/voters/unlock-list', requirePerm('manage_voters'), (req, res) => {
  const e = req.election;
  if (election.hasEverOpened(e)) {
    flash(res, 'error', 'Voting has started. The electorate can only be changed through individual, recorded amendments.');
    return res.redirect(303, '/admin/voters');
  }
  db.get().prepare('UPDATE elections SET voter_list_approved_at = NULL, voter_list_approved_by = NULL, updated_at = ? WHERE id = ?').run(nowIso(), e.id);
  audit.log(req, 'Voter list approval withdrawn for editing', { category: 'voters', entityType: 'election', entityId: e.id, entityLabel: e.name });
  flash(res, 'success', 'The voter list is open for editing again. Remember to re-approve it before voting opens.');
  res.redirect(303, '/admin/voters');
});

// ---------- Import ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

router.get('/import', requirePerm('manage_voters'), (req, res) => {
  const d = db.get();
  const imp = req.query.id ? d.prepare('SELECT * FROM voter_imports WHERE id = ? AND election_id = ? AND applied_at IS NULL').get(asInt(req.query.id), req.election.id) : null;
  const history = d.prepare('SELECT i.*, a.full_name admin_name FROM voter_imports i LEFT JOIN admin_users a ON a.id = i.created_by WHERE election_id = ? AND applied_at IS NOT NULL ORDER BY id DESC LIMIT 10').all(req.election.id);
  let preview = null;
  if (imp) {
    const rows = JSON.parse(imp.rows_json);
    preview = {
      id: imp.id, filename: imp.filename, rows,
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      skip: rows.filter((r) => r.action === 'skip').length,
      warnings: rows.filter((r) => r.warnings.length).length,
    };
  }
  res.render('admin/import', { title: 'Import voters', preview, history, listApproved: !!req.election.voter_list_approved_at });
});

async function readTable(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const out = [];
    const cellText = (v) => {
      if (v == null) return '';
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v !== 'object') return String(v);
      if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
      if (v.text !== undefined) return cellText(v.text);
      if (v.result !== undefined) return cellText(v.result);
      if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, '');
      return '';
    };
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let i = 1; i <= ws.columnCount; i++) vals.push(cellText(row.getCell(i).value).trim());
      out.push(vals);
    });
    return out;
  }
  let text = file.buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  return parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: true, trim: true });
}

router.post('/import', requirePerm('manage_voters'), (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      flash(res, 'error', 'The file could not be uploaded (maximum 10 MB).');
      return res.redirect(303, '/admin/import');
    }
    verifyCsrf(req, res, async (csrfErr) => {
      if (csrfErr) return next(csrfErr);
      try {
        if (!req.file) {
          flash(res, 'error', 'Choose a CSV or Excel (.xlsx) file to import.');
          return res.redirect(303, '/admin/import');
        }
        let table;
        try {
          table = await readTable(req.file);
        } catch (e) {
          flash(res, 'error', 'The file could not be read. Please upload a CSV (comma separated) or Excel .xlsx file with a header row.');
          return res.redirect(303, '/admin/import');
        }
        const analysis = voters.analyseImport(req.election.id, table);
        if (analysis.fatal.length) {
          analysis.fatal.forEach((m) => flash(res, 'error', m));
          return res.redirect(303, '/admin/import');
        }
        if (!analysis.rows.length) {
          flash(res, 'error', 'No voter rows were found in the file.');
          return res.redirect(303, '/admin/import');
        }
        const id = db.get().prepare('INSERT INTO voter_imports (election_id, filename, rows_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(req.election.id, clean(req.file.originalname, 200), JSON.stringify(analysis.rows), req.admin.id, nowIso()).lastInsertRowid;
        res.redirect(303, `/admin/import?id=${id}`);
      } catch (e) {
        next(e);
      }
    });
  });
});

router.post('/import/:id/apply', numericId, requirePerm('manage_voters'), (req, res) => {
  const d = db.get();
  const imp = d.prepare('SELECT * FROM voter_imports WHERE id = ? AND election_id = ? AND applied_at IS NULL').get(asInt(req.params.id), req.election.id);
  if (!imp) {
    flash(res, 'error', 'This import has already been applied or no longer exists.');
    return res.redirect(303, '/admin/import');
  }
  const eligibility = req.body.eligibility === 'eligible' ? 'eligible' : 'pending';
  const amend = amendmentReason(req, res, `/admin/import?id=${imp.id}`);
  if (!amend.ok) return;
  // Re-analyse at apply time so the result reflects the current register (prevents stale previews creating duplicates).
  const rows = JSON.parse(imp.rows_json);
  const table = [['voter id', 'name', 'email', 'mobile', 'whatsapp', 'batch'], ...rows.map((r) => [r.voter_ref, r.full_name, r.email, r.mobile, r.whatsapp, r.batch])];
  const fresh = voters.analyseImport(req.election.id, table).rows;
  // Keep the extra details (other emails/phones, location) found in the original file.
  fresh.forEach((r, i) => { if (rows[i] && rows[i].notes) r.notes = rows[i].notes; });
  const claimed = d.prepare('UPDATE voter_imports SET applied_at = ? WHERE id = ? AND applied_at IS NULL').run(nowIso(), imp.id).changes;
  if (!claimed) return res.redirect(303, '/admin/import');
  const stats = voters.applyImport(req.election.id, fresh, { eligibility });
  audit.log(req, 'Voters imported', { category: 'voters', entityType: 'import', entityId: imp.id, entityLabel: imp.filename, details: { ...stats, eligibility, ...(amend.reason ? { amendment_reason: amend.reason } : {}) } });
  flash(res, 'success', `Import complete: ${stats.created} new voter(s), ${stats.updated} existing record(s) updated, ${stats.skipped} row(s) skipped.`);
  res.redirect(303, '/admin/voters');
});

router.get('/import/template.csv', requirePerm('manage_voters'), (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="voter-import-template.csv"');
  res.send('﻿Voter ID,Full Name,Email,Mobile,WhatsApp,Batch\nMAA10001,Dr. Example Name,example@example.org,+91 98765 43210,+91 98765 43210,PGDAEM 2012\n');
});

module.exports = router;
