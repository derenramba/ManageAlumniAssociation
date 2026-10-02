'use strict';
const express = require('express');
const db = require('../../db');
const sessions = require('../../lib/sessions');
const audit = require('../../lib/audit');
const { verifyPassword, createRateLimiter } = require('../../lib/security');
const { nowIso } = require('../../lib/time');
const { httpError } = require('../../lib/http');

const router = express.Router();
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.locals.layout = 'admin';
  next();
});

router.get('/login', (req, res) => {
  if (req.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Administrator sign in', error: null, username: '' });
});

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const fail = (msg) => res.status(401).render('admin/login', { title: 'Administrator sign in', error: msg, username });
  if (!loginLimiter.hit(`${req.ip}|${username.toLowerCase()}`)) return fail('Too many sign-in attempts. Please wait 15 minutes and try again.');
  const user = db.get().prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) return fail('Incorrect username or password.');
  if (!user.active) return fail('This administrator account has been disabled.');
  if (req.adminSession) sessions.destroySession(res, req.adminSession, 'admin');
  sessions.createSession(res, 'admin', { adminId: user.id });
  db.get().prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  audit.log({ admin: user, ip: req.ip, election: req.election }, 'Administrator signed in', { category: 'access', entityType: 'admin', entityId: user.id, entityLabel: user.username });
  res.redirect(303, '/admin');
});

router.post('/logout', (req, res) => {
  if (req.adminSession) sessions.destroySession(res, req.adminSession, 'admin');
  res.redirect(303, '/admin/login');
});

// Everything below requires an authenticated administrator.
router.use((req, res, next) => {
  if (!req.admin) return res.redirect(`/admin/login`);
  next();
});

router.use('/', require('./dashboard'));
router.use('/', require('./election'));
router.use('/', require('./users'));
router.use('/', require('./candidates'));
router.use('/', require('./voters'));
router.use('/', require('./codes'));
router.use('/', require('./invitations'));
router.use('/', require('./results'));

router.use((req, res, next) => next(httpError(404, 'Page not found.')));

module.exports = router;
