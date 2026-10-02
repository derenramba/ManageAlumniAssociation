'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets an isolated data directory / database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-test-'));
process.env.DATA_DIR = dir;
process.env.PUBLIC_BASE_URL = 'http://vote.test';
delete process.env.SMTP_HOST;

const db = require('../src/db');
const { createApp } = require('../src/app');
const { createAdmin } = require('../scripts/create-admin');

async function startServer() {
  db.get();
  const app = createApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

class Client {
  constructor(base) { this.base = base; this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i); const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
  }
  async req(method, url, body, { follow = false, headers = {} } = {}) {
    const opts = { method, redirect: 'manual', headers: { cookie: this.cookieHeader(), ...headers } };
    if (body) {
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k, x)); else if (v !== undefined) p.append(k, v);
      }
      if (!('_csrf' in body)) p.append('_csrf', this.csrf());
      opts.body = p.toString();
    }
    const res = await fetch(this.base + url, opts);
    this.store(res);
    const text = await res.text();
    if (follow && res.status >= 300 && res.status < 400) return this.req('GET', new URL(res.headers.get('location'), this.base).pathname + new URL(res.headers.get('location'), this.base).search, null, { follow });
    return { status: res.status, text, location: res.headers.get('location'), headers: res.headers };
  }
  csrf() { return decodeURIComponent(this.cookies.maa_csrf || ''); }
  get(url, o) { return this.req('GET', url, null, o); }
  post(url, body, o) { return this.req('POST', url, body || {}, o); }
  async init() { await this.get('/'); return this; }
}

async function loginAdmin(base, username, password) {
  const c = await new Client(base).init();
  const r = await c.post('/admin/login', { username, password });
  if (r.status !== 303) throw new Error('login failed: ' + r.status);
  return c;
}

module.exports = { db, startServer, Client, loginAdmin, createAdmin, dir };
