'use strict';
const express = require('express');
const db = require('../../db');
const audit = require('../../lib/audit');
const { hashPassword, verifyPassword } = require('../../lib/security');
const { PERMISSIONS, ROLES, parsePermissions } = require('../../lib/permissions');
const { flash, clean, asInt, httpError } = require('../../lib/http');
const { requirePerm } = require('./guards');

const router = express.Router();
const numericId = (req, res, next) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function passwordProblem(pw) {
  if (!pw || pw.length < 10) return 'Password must be at least 10 characters long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

function activeMainAdmins(excludeId) {
  return db.get().prepare("SELECT COUNT(*) n FROM admin_users WHERE active = 1 AND permissions LIKE '%manage_admins%' AND id <> ?").get(excludeId || 0).n;
}

router.get('/users', requirePerm('manage_admins'), (req, res) => {
  const users = db.get().prepare('SELECT * FROM admin_users ORDER BY active DESC, full_name').all()
    .map((u) => ({ ...u, perms: parsePermissions(u.permissions) }));
  res.render('admin/users', { title: 'Admin users', users });
});

router.post('/users', requirePerm('manage_admins'), (req, res) => {
  const username = clean(req.body.username, 60).toLowerCase();
  const fullName = clean(req.body.full_name, 120);
  const role = ROLES[req.body.role] ? req.body.role : 'auditor';
  const pw = String(req.body.password || '');
  const err = !/^[a-z0-9._-]{3,60}$/.test(username) ? 'Username must be 3–60 characters: letters, numbers, dot, dash or underscore.'
    : !fullName ? 'Full name is required.' : passwordProblem(pw);
  if (err) { flash(res, 'error', err); return res.redirect(303, '/admin/users'); }
  if (db.get().prepare('SELECT 1 FROM admin_users WHERE username = ?').get(username)) { flash(res, 'error', 'That username is already taken.'); return res.redirect(303, '/admin/users'); }
  const perms = ROLES[role].permissions;
  const id = db.get().prepare('INSERT INTO admin_users (username, full_name, email, password_hash, role, permissions) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, fullName, clean(req.body.email, 200) || null, hashPassword(pw), role, JSON.stringify(perms)).lastInsertRowid;
  audit.log(req, 'Admin user added', { category: 'admins', entityType: 'admin', entityId: id, entityLabel: `${fullName} (${username})`, details: { role } });
  flash(res, 'success', `Administrator ${fullName} added as ${ROLES[role].label}.`);
  res.redirect(303, '/admin/users');
});

router.post('/users/:id', numericId, requirePerm('manage_admins'), (req, res) => {
  const u = db.get().prepare('SELECT * FROM admin_users WHERE id = ?').get(asInt(req.params.id));
  if (!u) throw httpError(404, 'User not found.');
  const role = ROLES[req.body.role] ? req.body.role : u.role;
  let perms = [].concat(req.body.perms || []).filter((p) => PERMISSIONS[p]);
  if (req.body.apply_role_defaults === 'yes') perms = ROLES[role].permissions;
  const active = req.body.active === '1' ? 1 : 0;
  if (u.id === req.admin.id && (!active || !perms.includes('manage_admins'))) {
    flash(res, 'error', 'You cannot disable your own account or remove your own admin-management permission.');
    return res.redirect(303, '/admin/users');
  }
  if ((!active || !perms.includes('manage_admins')) && parsePermissions(u.permissions).includes('manage_admins') && activeMainAdmins(u.id) === 0) {
    flash(res, 'error', 'At least one active administrator must keep the "Manage admin users" permission.');
    return res.redirect(303, '/admin/users');
  }
  const before = parsePermissions(u.permissions);
  db.get().prepare('UPDATE admin_users SET full_name = ?, email = ?, role = ?, permissions = ?, active = ? WHERE id = ?')
    .run(clean(req.body.full_name, 120) || u.full_name, clean(req.body.email, 200) || null, role, JSON.stringify(perms), active, u.id);
  const added = perms.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !perms.includes(p));
  if (active !== u.active) audit.log(req, active ? 'Admin user enabled' : 'Admin user disabled', { category: 'admins', entityType: 'admin', entityId: u.id, entityLabel: u.username });
  if (role !== u.role) audit.log(req, 'Admin role changed', { category: 'admins', entityType: 'admin', entityId: u.id, entityLabel: u.username, details: { from: u.role, to: role } });
  if (added.length || removed.length) audit.log(req, 'Admin permissions changed', { category: 'admins', entityType: 'admin', entityId: u.id, entityLabel: u.username, details: { added, removed } });
  if (!active) db.get().prepare('DELETE FROM sessions WHERE admin_id = ?').run(u.id);
  flash(res, 'success', `Administrator ${u.username} updated.`);
  res.redirect(303, '/admin/users');
});

router.post('/users/:id/password', numericId, requirePerm('manage_admins'), (req, res) => {
  const u = db.get().prepare('SELECT * FROM admin_users WHERE id = ?').get(asInt(req.params.id));
  if (!u) throw httpError(404, 'User not found.');
  const pw = String(req.body.password || '');
  const err = passwordProblem(pw);
  if (err) { flash(res, 'error', err); return res.redirect(303, '/admin/users'); }
  db.get().prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), u.id);
  db.get().prepare('DELETE FROM sessions WHERE admin_id = ? AND id <> ?').run(u.id, req.adminSession.id);
  audit.log(req, 'Admin password reset', { category: 'admins', entityType: 'admin', entityId: u.id, entityLabel: u.username });
  flash(res, 'success', `Password reset for ${u.username}.`);
  res.redirect(303, '/admin/users');
});

router.get('/account', (req, res) => {
  res.render('admin/account', { title: 'My account' });
});

router.post('/account/password', (req, res) => {
  if (!verifyPassword(String(req.body.current || ''), req.admin.password_hash)) {
    flash(res, 'error', 'Your current password is incorrect.');
    return res.redirect(303, '/admin/account');
  }
  const pw = String(req.body.password || '');
  const err = passwordProblem(pw) || (pw !== req.body.confirm ? 'The new passwords do not match.' : null);
  if (err) { flash(res, 'error', err); return res.redirect(303, '/admin/account'); }
  db.get().prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), req.admin.id);
  db.get().prepare('DELETE FROM sessions WHERE admin_id = ? AND id <> ?').run(req.admin.id, req.adminSession.id);
  audit.log(req, 'Admin changed own password', { category: 'admins', entityType: 'admin', entityId: req.admin.id, entityLabel: req.admin.username });
  flash(res, 'success', 'Your password has been changed.');
  res.redirect(303, '/admin/account');
});

module.exports = router;
