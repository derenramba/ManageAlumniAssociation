'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const sessions = require('./lib/sessions');
const { verifyCsrf } = require('./lib/csrf');
const { cleanHtml } = require('./lib/nodash');
const time = require('./lib/time');
const codes = require('./lib/codes');
const election = require('./lib/election');
const { PERMISSIONS, ROLES } = require('./lib/permissions');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use('/uploads', express.static(config.uploadsDir, {
    maxAge: '1h',
    setHeaders: (res) => res.setHeader('Content-Disposition', 'inline'),
  }));

  app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 20000 }));
  app.use(express.json({ limit: '1mb' }));
  app.use(sessions.middleware);

  // No dashes anywhere in visible text (client requirement).
  app.use((req, res, next) => {
    const send = res.send.bind(res);
    res.send = (body) => {
      const type = String(res.get('Content-Type') || '');
      if (typeof body === 'string' && (type.includes('text/html') || (!type && /^\s*<!doctype html/i.test(body)))) body = cleanHtml(body);
      return send(body);
    };
    next();
  });

  // Shared view helpers
  app.use((req, res, next) => {
    req.election = election.getCurrentElection();
    Object.assign(res.locals, {
      election: req.election,
      admin: req.admin || null,
      fmt: time.formatDateTime,
      fmtShort: time.formatShort,
      toLocalInput: time.toLocalInput,
      formatCode: codes.formatCode,
      statusInfo: election.statusInfo,
      STATUSES: election.STATUSES,
      PERMISSIONS, ROLES,
      can: (perm) => !!(req.admin && req.admin.perms.has(perm)),
      path: req.path,
      query: req.query,
      tz: config.timezoneLabel,
      flash: consumeFlash(req, res),
      qs: (overrides) => {
        const p = new URLSearchParams({ ...req.query, ...overrides });
        for (const [k, v] of [...p.entries()]) if (v === '' || v === 'undefined') p.delete(k);
        const s = p.toString();
        return s ? `?${s}` : '';
      },
    });
    next();
  });

  // CSRF protection for all state-changing requests (multipart routes verify after parsing).
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) return next();
    return verifyCsrf(req, res, next);
  });

  app.use('/', require('./routes/public'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('public/message', { title: 'Page not found', heading: 'Page not found', message: 'The page you requested does not exist.', tone: 'info' });
  });

  // Never show technical errors to users.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (!err.status || err.status >= 500) console.error(err);
    if (res.headersSent) return;
    if (res.locals.election === undefined) res.locals.election = null;
    if (res.locals.path === undefined) res.locals.path = req.path;
    const status = err.status || 500;
    const message = err.expose ? err.message : 'Something went wrong while processing your request. Please try again. If the problem continues, contact election support.';
    res.status(status).render('public/message', { title: 'Error', heading: status === 403 ? 'Not permitted' : 'Something went wrong', message, tone: 'error' });
  });

  return app;
}

// Flash messages are carried in a short-lived cookie.
function consumeFlash(req, res) {
  const raw = req.cookies.maa_flash;
  if (!raw) return [];
  res.append('Set-Cookie', `maa_flash=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${config.secureCookies ? '; Secure' : ''}`);
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return [];
  }
}

module.exports = { createApp };
