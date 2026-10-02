'use strict';
const db = require('../db');
const config = require('../config');
const { randomToken } = require('./security');
const { parsePermissions } = require('./permissions');

const ADMIN_COOKIE = 'maa_admin';
const VOTER_COOKIE = 'maa_voter';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

function setCookie(res, name, value, { maxAgeSec, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (config.secureCookies) parts.push('Secure');
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAgeSec: 0 });
}

function createSession(res, kind, { adminId = null, data = {} } = {}) {
  const id = randomToken(32);
  const now = new Date();
  const ttlMs = kind === 'admin' ? config.adminSessionHours * 3600e3 : config.voterSessionMinutes * 60e3;
  const expires = new Date(now.getTime() + ttlMs);
  db.get().prepare('INSERT INTO sessions (id, kind, admin_id, data, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, adminId, JSON.stringify(data), randomToken(24), now.toISOString(), expires.toISOString());
  setCookie(res, kind === 'admin' ? ADMIN_COOKIE : VOTER_COOKIE, id, { maxAgeSec: Math.floor(ttlMs / 1000) });
  return id;
}

function loadSession(id, kind) {
  if (!id) return null;
  const s = db.get().prepare('SELECT * FROM sessions WHERE id = ? AND kind = ?').get(id, kind);
  if (!s) return null;
  if (s.expires_at < new Date().toISOString()) {
    db.get().prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  s.data = JSON.parse(s.data || '{}');
  return s;
}

function saveSessionData(session) {
  db.get().prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(session.data || {}), session.id);
}

function destroySession(res, session, kind) {
  if (session) db.get().prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  clearCookie(res, kind === 'admin' ? ADMIN_COOKIE : VOTER_COOKIE);
}

function middleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  // CSRF: double-submit token cookie, compared against form field / header on every POST.
  let csrf = req.cookies.maa_csrf;
  if (!csrf || csrf.length < 20) {
    csrf = randomToken(24);
    setCookie(res, 'maa_csrf', csrf, { maxAgeSec: 60 * 60 * 24 });
  }
  req.csrfToken = csrf;
  res.locals.csrfToken = csrf;

  const adminSession = loadSession(req.cookies[ADMIN_COOKIE], 'admin');
  if (adminSession) {
    const admin = db.get().prepare('SELECT * FROM admin_users WHERE id = ? AND active = 1').get(adminSession.admin_id);
    if (admin) {
      admin.perms = new Set(parsePermissions(admin.permissions));
      req.admin = admin;
      req.adminSession = adminSession;
    } else {
      destroySession(res, adminSession, 'admin');
    }
  }
  req.voterSession = loadSession(req.cookies[VOTER_COOKIE], 'voter');
  next();
}

function purgeExpired() {
  db.get().prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

module.exports = { middleware, createSession, loadSession, saveSessionData, destroySession, purgeExpired, parseCookies };
