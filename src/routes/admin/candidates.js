'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../../config');
const db = require('../../db');
const election = require('../../lib/election');
const audit = require('../../lib/audit');
const { flash, clean, asInt, httpError } = require('../../lib/http');
const { verifyCsrf } = require('../../lib/csrf');
const { requirePerm, requireElection } = require('./guards');
const { lockedGuard } = require('./election');

const router = express.Router();

const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, !!PHOTO_TYPES[file.mimetype]),
});

// Verify the file really is an image by checking magic bytes, then store it under a random name.
function savePhoto(file) {
  if (!file || !file.buffer || !file.buffer.length) return null;
  const b = file.buffer;
  const isJpeg = b[0] === 0xff && b[1] === 0xd8;
  const isPng = b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP';
  if (!(isJpeg || isPng || isWebp)) return null;
  const ext = isJpeg ? '.jpg' : isPng ? '.png' : '.webp';
  const name = `candidate-${crypto.randomBytes(12).toString('hex')}${ext}`;
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadsDir, name), b);
  return name;
}

function photoUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      flash(res, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'The photo is too large (maximum 4 MB).' : 'The photo could not be uploaded.');
      return res.redirect(303, req.originalUrl.replace(/\/(edit)?$/, '') || '/admin/candidates');
    }
    verifyCsrf(req, res, next);
  });
}

router.get('/candidates', requireElection, (req, res) => {
  const positions = election.positionsWithCandidates(req.election.id);
  res.render('admin/candidates', { title: 'Candidates', positions, editable: election.isConfigEditable(req.election) });
});

router.get('/candidates/new', requireElection, requirePerm('manage_candidates'), (req, res) => {
  const positions = election.positionsWithCandidates(req.election.id);
  res.render('admin/candidate-form', { title: 'Add candidate', candidate: { position_id: asInt(req.query.position), status: 'draft' }, positions, editable: election.isConfigEditable(req.election) });
});

router.post('/candidates', requireElection, requirePerm('manage_candidates'), photoUpload, (req, res) => {
  if (lockedGuard(req, res)) return;
  const e = req.election;
  const d = db.get();
  const name = clean(req.body.full_name, 150);
  const pos = d.prepare('SELECT * FROM positions WHERE id = ? AND election_id = ?').get(asInt(req.body.position_id), e.id);
  if (!name || !pos) {
    flash(res, 'error', 'Full name and position are required.');
    return res.redirect(303, '/admin/candidates/new');
  }
  const photo = req.file ? savePhoto(req.file) : null;
  if (req.file && !photo) flash(res, 'error', 'The uploaded file is not a valid JPEG, PNG or WebP image; the candidate was saved without a photo.');
  const status = ['draft', 'approved'].includes(req.body.status) ? req.body.status : 'draft';
  const max = d.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM candidates WHERE position_id = ?').get(pos.id).m;
  const id = d.prepare('INSERT INTO candidates (election_id, position_id, full_name, batch, photo_path, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(e.id, pos.id, name, clean(req.body.batch, 60), photo, status, max + 1).lastInsertRowid;
  audit.log(req, 'Candidate added', { category: 'ballot', entityType: 'candidate', entityId: id, entityLabel: `${name} (${pos.title})`, details: { status } });
  if (status === 'approved') audit.log(req, 'Candidate approved', { category: 'ballot', entityType: 'candidate', entityId: id, entityLabel: `${name} (${pos.title})` });
  flash(res, 'success', `Candidate ${name} added to ${pos.title}.`);
  res.redirect(303, '/admin/candidates');
});

function loadCandidate(req) {
  const c = db.get().prepare('SELECT c.*, p.title AS position_title FROM candidates c JOIN positions p ON p.id = c.position_id WHERE c.id = ? AND c.election_id = ?').get(asInt(req.params.id), req.election.id);
  if (!c) throw httpError(404, 'Candidate not found.');
  return c;
}

function declaredUnopposed(c) {
  return db.get().prepare('SELECT * FROM positions WHERE unopposed_candidate_id = ?').get(c.id);
}

router.get('/candidates/:id/edit', requireElection, requirePerm('manage_candidates'), (req, res) => {
  const c = loadCandidate(req);
  res.render('admin/candidate-form', { title: `Edit ${c.full_name}`, candidate: c, positions: election.positionsWithCandidates(req.election.id), editable: election.isConfigEditable(req.election) });
});

router.post('/candidates/:id', requireElection, requirePerm('manage_candidates'), photoUpload, (req, res) => {
  if (lockedGuard(req, res)) return;
  const c = loadCandidate(req);
  const d = db.get();
  const name = clean(req.body.full_name, 150) || c.full_name;
  const pos = d.prepare('SELECT * FROM positions WHERE id = ? AND election_id = ?').get(asInt(req.body.position_id), req.election.id) || { id: c.position_id, title: c.position_title };
  const unopp = declaredUnopposed(c);
  if (unopp && pos.id !== c.position_id) {
    flash(res, 'error', `${c.full_name} is declared elected unopposed for ${unopp.title}. Change that position to contested before moving the candidate.`);
    return res.redirect(303, `/admin/candidates/${c.id}/edit`);
  }
  let photo = c.photo_path;
  if (req.file) {
    const saved = savePhoto(req.file);
    if (saved) photo = saved; else flash(res, 'error', 'The uploaded file is not a valid JPEG, PNG or WebP image; the previous photo was kept.');
  }
  if (req.body.remove_photo) photo = null;
  d.prepare('UPDATE candidates SET full_name = ?, batch = ?, position_id = ?, photo_path = ? WHERE id = ?').run(name, clean(req.body.batch, 60), pos.id, photo, c.id);
  const details = {};
  if (name !== c.full_name) details.full_name = { from: c.full_name, to: name };
  if (pos.id !== c.position_id) details.position = { from: c.position_title, to: pos.title };
  if (photo !== c.photo_path) details.photo = photo ? 'changed' : 'removed';
  audit.log(req, photo !== c.photo_path && Object.keys(details).length === 1 ? 'Candidate photo changed' : 'Candidate edited', { category: 'ballot', entityType: 'candidate', entityId: c.id, entityLabel: `${name} (${pos.title})`, details });
  flash(res, 'success', `Candidate ${name} saved.`);
  res.redirect(303, '/admin/candidates');
});

router.post('/candidates/:id/status', requireElection, requirePerm('manage_candidates'), (req, res) => {
  if (lockedGuard(req, res)) return;
  const c = loadCandidate(req);
  const status = req.body.status;
  if (!['draft', 'approved', 'withdrawn'].includes(status)) throw httpError(400, 'Invalid status.');
  const unopp = declaredUnopposed(c);
  if (unopp && status !== 'approved') {
    flash(res, 'error', `${c.full_name} is declared elected unopposed for ${unopp.title}. Change that position to contested first.`);
    return res.redirect(303, '/admin/candidates');
  }
  db.get().prepare('UPDATE candidates SET status = ? WHERE id = ?').run(status, c.id);
  const action = { approved: 'Candidate approved', withdrawn: 'Candidate withdrawn', draft: 'Candidate returned to draft' }[status];
  audit.log(req, action, { category: 'ballot', entityType: 'candidate', entityId: c.id, entityLabel: `${c.full_name} (${c.position_title})`, details: { from: c.status, to: status } });
  flash(res, 'success', `${action}: ${c.full_name}.`);
  res.redirect(303, '/admin/candidates');
});

router.post('/candidates/:id/move', requireElection, requirePerm('manage_candidates'), (req, res) => {
  if (lockedGuard(req, res)) return;
  const c = loadCandidate(req);
  const d = db.get();
  const all = d.prepare('SELECT id FROM candidates WHERE position_id = ? ORDER BY sort_order, id').all(c.position_id).map((r) => r.id);
  const i = all.indexOf(c.id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < all.length) {
    [all[i], all[j]] = [all[j], all[i]];
    const upd = d.prepare('UPDATE candidates SET sort_order = ? WHERE id = ?');
    d.transaction(() => all.forEach((id, k) => upd.run(k + 1, id)))();
    audit.log(req, 'Candidate order changed', { category: 'ballot', entityType: 'candidate', entityId: c.id, entityLabel: `${c.full_name} (${c.position_title})` });
  }
  res.redirect(303, '/admin/candidates');
});

router.post('/candidates/:id/delete', requireElection, requirePerm('manage_candidates'), (req, res) => {
  if (lockedGuard(req, res)) return;
  const c = loadCandidate(req);
  const d = db.get();
  if (declaredUnopposed(c)) {
    flash(res, 'error', `${c.full_name} is declared elected unopposed. Change the position to contested before deleting.`);
    return res.redirect(303, '/admin/candidates');
  }
  if (d.prepare('SELECT 1 FROM ballot_choices WHERE candidate_id = ?').get(c.id)) {
    flash(res, 'error', 'This candidate appears on submitted ballots and cannot be deleted.');
    return res.redirect(303, '/admin/candidates');
  }
  d.prepare('DELETE FROM candidates WHERE id = ?').run(c.id);
  audit.log(req, 'Candidate deleted', { category: 'ballot', entityType: 'candidate', entityId: c.id, entityLabel: `${c.full_name} (${c.position_title})` });
  flash(res, 'success', `Candidate ${c.full_name} deleted.`);
  res.redirect(303, '/admin/candidates');
});

module.exports = router;
