'use strict';
const config = require('../config');

function flash(res, type, message) {
  const prev = res.locals._pendingFlash || [];
  prev.push({ type, message });
  res.locals._pendingFlash = prev;
  const value = Buffer.from(JSON.stringify(prev)).toString('base64url');
  const existing = [].concat(res.getHeader('Set-Cookie') || []).filter((c) => !String(c).startsWith('maa_flash='));
  existing.push(`maa_flash=${value}; Path=/; Max-Age=60; SameSite=Lax; HttpOnly${config.secureCookies ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', existing);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

const asInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const clean = (v, max = 500) => {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
};

module.exports = { flash, httpError, asInt, clean };
