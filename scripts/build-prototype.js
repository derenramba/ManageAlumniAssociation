'use strict';
/**
 * Builds a static, front-end-only PROTOTYPE of the platform into ./prototype
 * (deployable on Vercel or any static host). It runs the real app against
 * dummy demo data, saves each page as HTML, and adds prototype.js so buttons
 * and forms click through without a backend. Nothing is saved.
 *
 *   npm run build:prototype
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'prototype');

if (!process.env.PROTO_PHASE) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const phase of ['open', 'published']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-proto-'));
    const env = { ...process.env, PROTO_PHASE: phase, DATA_DIR: dir, PUBLIC_BASE_URL: 'https://example.vercel.app' };
    delete env.SMTP_HOST;
    const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed-demo.js'), ...(phase === 'published' ? ['--closed'] : [])], { env, encoding: 'utf8' });
    if (seed.status !== 0) { console.error(seed.stderr); process.exit(1); }
    const r = spawnSync(process.execPath, [__filename], { env, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.cpSync(path.join(ROOT, 'public'), path.join(OUT, 'static'), { recursive: true });
  console.log(`Prototype written to ${path.relative(ROOT, OUT)}/`);
  process.exit(0);
}

// ---------------- crawl phase (runs in a child process) ----------------
const db = require('../src/db');
const { createApp } = require('../src/app');

const phase = process.env.PROTO_PHASE;
const BANNER = '<div class="proto-banner" role="note">PROTOTYPE: front end preview with dummy data. Nothing you enter is saved.</div>';

function save(urlPath, html) {
  let file = urlPath.split('?')[0].replace(/\/+$/, '');
  if (file === '') file = '/index';
  if (file === '/admin') file = '/admin/index';
  const target = path.join(OUT, `${file}.html`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  html = html
    .replace(/<script src="\/static\/js\/(voter|admin)\.js" defer><\/script>/, (m) => `${m}\n<script src="/static/js/prototype.js" defer></script>`)
    .replace(/<body>/, `<body>\n${BANNER}`)
    .replace(/<meta name="csrf-token" content="[^"]*">/, '')
    .replace(/name="_csrf" value="[^"]*"/g, 'name="_csrf" value=""');
  fs.writeFileSync(target, html);
}

class Client {
  constructor(base) { this.base = base; this.cookies = {}; }
  async req(method, url, body) {
    const headers = { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload;
    if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams({ ...body, _csrf: decodeURIComponent(this.cookies.maa_csrf || '') }).toString();
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      if (/Max-Age=0/.test(c)) delete this.cookies[pair.slice(0, i)]; else this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return { status: res.status, text: await res.text() };
  }
  get(url) { return this.req('GET', url); }
  post(url, body) { return this.req('POST', url, body); }
}

(async () => {
  db.get();
  const app = createApp();
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const one = (sql, ...a) => db.get().prepare(sql).get(...a);
  const all = (sql, ...a) => db.get().prepare(sql).all(...a);
  const grab = async (c, url, as = url) => {
    const r = await c.get(url);
    if (r.status !== 200) throw new Error(`${url} -> ${r.status}`);
    save(as, r.text);
  };

  const admin = new Client(base);
  await admin.get('/admin/login');
  if (phase === 'open') await grab(admin, '/admin/login');
  await admin.post('/admin/login', { username: 'demo.admin', password: 'DemoAdmin2026' });

  if (phase === 'open') {
    // ----- Voter journey -----
    const voter = new Client(base);
    await grab(voter, '/');
    let r = await voter.post('/vote', { code: 'AAAA BBBB CCCC DDDD' });
    save('/vote-invalid', r.text);
    const used = one("SELECT code FROM voting_codes WHERE status = 'used' LIMIT 1").code;
    r = await voter.post('/vote', { code: used });
    save('/already-voted', r.text);
    const unused = one("SELECT c.code FROM voting_codes c JOIN voters v ON v.id = c.voter_id WHERE c.status = 'active' AND v.email IS NOT NULL LIMIT 1").code;
    await voter.post('/vote', { code: unused });
    await grab(voter, '/ballot');
    const contested = all("SELECT p.id FROM positions p JOIN elections e ON e.id = p.election_id WHERE p.kind = 'contested' ORDER BY p.sort_order");
    const choice = {};
    contested.forEach((p, i) => {
      const c = one("SELECT id FROM candidates WHERE position_id = ? AND status = 'approved' ORDER BY sort_order", p.id);
      choice[`pos_${p.id}`] = i === 1 ? 'abstain' : String(c.id);
    });
    await voter.post('/ballot', choice);
    r = await voter.get('/ballot/review');
    save('/ballot/review', r.text);
    const token = r.text.match(/name="submission_token" value="([^"]+)"/)[1];
    await voter.post('/ballot/submit', { submission_token: token });
    await grab(voter, '/thank-you');

    // ----- Admin pages -----
    const pages = ['/admin', '/admin/election', '/admin/elections', '/admin/positions', '/admin/candidates', '/admin/candidates/new',
      '/admin/voters', '/admin/voters/quality', '/admin/voters/new', '/admin/import', '/admin/codes', '/admin/invitations',
      '/admin/invitations/confirm', '/admin/invitations/outbox', '/admin/turnout', '/admin/records', '/admin/users', '/admin/account'];
    for (const p of pages) await grab(admin, p);
    const prev = await admin.get('/admin/invitations/preview');
    save('/admin/invitations/preview', prev.text);
    for (const v of all('SELECT id FROM voters')) {
      await grab(admin, `/admin/voters/${v.id}`);
      await grab(admin, `/admin/voters/${v.id}/edit`);
    }
    for (const c of all('SELECT id FROM candidates')) await grab(admin, `/admin/candidates/${c.id}/edit`);
    for (const b of all('SELECT voter_id FROM ballots')) await grab(admin, `/admin/records/${b.voter_id}`);
    await grab(admin, '/admin/audit'); // last, so it includes the ballot views above
  } else {
    // Closed election → review & publish screens, then published public results.
    await grab(admin, '/admin/results');
    await grab(admin, '/admin/results/publish');
    await admin.post('/admin/election/transition', { action: 'publish', confirm: 'yes' });
    await grab(new Client(base), '/results');
  }
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
