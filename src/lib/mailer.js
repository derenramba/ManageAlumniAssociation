'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');
const { nowIso, formatDateTime } = require('./time');
const { formatCode } = require('./codes');
const election = require('./election');
const { cleanText, cleanHtml } = require('./nodash');
const whatsapp = require('./whatsapp');
const sms = require('./sms');

let transport = null;
function smtpConfigured() {
  return !!config.smtp.host;
}
function getTransport() {
  if (!smtpConfigured()) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      pool: true,
      maxConnections: 2,
    });
  }
  return transport;
}
function setTransport(t) {
  transport = t;
}
function mode() {
  return smtpConfigured() ? 'smtp' : 'outbox';
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function supportDetails(e) {
  const parts = [];
  if (e.support_name) parts.push(e.support_name);
  if (e.support_email) parts.push(`Email: ${e.support_email}`);
  if (e.support_phone) parts.push(`Phone: ${e.support_phone}`);
  return parts.join('\n') || 'MANAGE Alumni Association election support';
}

function variablesFor(e, voter, code) {
  const first = (voter.full_name || '').trim().replace(/^(dr|mr|mrs|ms|prof|shri|smt)\.?\s+/i, '').split(/\s+/)[0] || voter.full_name;
  return {
    first_name: first,
    full_name: voter.full_name,
    voting_code: formatCode(code),
    voting_link: `${config.publicBaseUrl}/`,
    opening_date: formatDateTime(e.opens_at),
    closing_date: formatDateTime(e.closes_at),
    election_name: e.name,
    support_details: supportDetails(e),
  };
}

const VARIABLES = ['first_name', 'full_name', 'voting_code', 'voting_link', 'opening_date', 'closing_date', 'election_name', 'support_details'];

function fill(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function template(e) {
  const t = {};
  for (const [k, v] of Object.entries(election.DEFAULT_EMAIL)) t[k] = e[k] || v;
  return t;
}

/** Builds the personalised invitation email for one voter. */
function renderInvitation(e, voter, code) {
  const t = template(e);
  const vars = variablesFor(e, voter, code);
  const subject = fill(t.email_subject, vars);
  const intro = fill(t.email_intro, vars);
  const instructions = fill(t.email_instructions, vars);
  const support = fill(t.email_support, vars);
  const closing = fill(t.email_closing, vars);

  const text = [
    `Dear ${vars.first_name},`,
    '',
    intro,
    '',
    'You can vote using the following link:',
    vars.voting_link,
    '',
    'Your personal voting code is:',
    vars.voting_code,
    '',
    'Voting is open from:',
    vars.opening_date,
    '',
    'until:',
    vars.closing_date,
    '',
    instructions,
    '',
    'If you require assistance, please contact:',
    support,
    '',
    closing,
  ].join('\n');

  const para = (s) => String(s).split(/\n{2,}/).map((x) => `<p style="margin:0 0 16px">${escapeHtml(x).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f7fa;font-family:'Times New Roman',Times,serif;color:#17212b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;border:1px solid #dfe5e2">
<tr><td style="background:#ffffff;padding:20px 28px;border-radius:8px 8px 0 0;border-bottom:4px solid #6aad3d" align="center">
<img src="${escapeHtml(config.publicBaseUrl)}/static/img/logo.png" width="96" height="96" alt="MANAGE Alumni Association" style="display:block;margin:0 auto 8px">
<div style="font-size:20px;font-weight:bold;color:#0b5ea8">${escapeHtml(e.name)}</div></td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.55">
<p style="margin:0 0 16px">Dear ${escapeHtml(vars.first_name)},</p>
${para(intro)}
<p style="margin:0 0 8px">You can vote using the following link:</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(vars.voting_link)}" style="display:inline-block;background:#0b5ea8;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold">Go to the voting website</a><br><span style="font-size:13px;color:#4b5b54">${escapeHtml(vars.voting_link)}</span></p>
<p style="margin:0 0 8px">Your personal voting code is:</p>
<p style="margin:0 0 20px;font-family:'Times New Roman',Times,serif;font-size:24px;font-weight:bold;letter-spacing:.08em;background:#eaf3fb;border:1px dashed #0b5ea8;padding:14px;text-align:center">${escapeHtml(vars.voting_code)}</p>
<p style="margin:0 0 4px">Voting is open from:</p><p style="margin:0 0 12px"><strong>${escapeHtml(vars.opening_date)}</strong></p>
<p style="margin:0 0 4px">until:</p><p style="margin:0 0 20px"><strong>${escapeHtml(vars.closing_date)}</strong></p>
${para(instructions)}
<p style="margin:0 0 8px">If you require assistance, please contact:</p>
${para(support)}
${para(closing)}
</td></tr></table></td></tr></table></body></html>`;
  return { to: voter.email, subject: cleanText(subject), text: cleanText(text.split('\n').map(cleanText).join('\n')), html: cleanHtml(html) };
}

// ---------- Queue ----------

function queueInvitation({ electionId, voter, codeId, kind, adminId, channel = 'email' }) {
  const to = channel === 'whatsapp' ? whatsapp.display(whatsapp.voterPhone(voter))
    : channel === 'sms' ? sms.display(sms.voterPhone(voter)) : voter.email;
  return db.get().prepare(`INSERT INTO invitations (election_id, voter_id, code_id, kind, status, to_email, requested_by, created_at, channel)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(electionId, voter.id, codeId, kind, to || '', adminId || null, nowIso(), channel).lastInsertRowid;
}

async function deliverSms(d, inv, e, voter, code) {
  const to = sms.voterPhone(voter);
  if (!to) throw new Error('Voter has no valid mobile number');
  const text = sms.renderText(e, voter, code.code);
  let messageId = null;
  if (sms.mode() === 'api') {
    messageId = await sms.send(text, to);
  } else {
    d.prepare("INSERT INTO email_outbox (invitation_id, to_email, subject, body_text, body_html, created_at, channel) VALUES (?, ?, ?, ?, ?, ?, 'sms')")
      .run(inv.id, sms.display(to), 'SMS', text, `<pre style="white-space:pre-wrap;font:16px/1.5 Georgia,serif;padding:16px">${escapeHtml(text)}</pre>`, nowIso());
  }
  return { to: sms.display(to), messageId };
}

async function deliverWhatsApp(d, inv, e, voter, code) {
  const to = whatsapp.voterPhone(voter);
  if (!to) throw Object.assign(new Error('Voter has no valid mobile or WhatsApp number'), { final: true });
  const text = whatsapp.renderText(e, voter, code.code);
  let messageId = null;
  if (whatsapp.mode() === 'api') {
    messageId = await whatsapp.send(e, voter, code.code, to);
  } else {
    d.prepare("INSERT INTO email_outbox (invitation_id, to_email, subject, body_text, body_html, created_at, channel) VALUES (?, ?, ?, ?, ?, ?, 'whatsapp')")
      .run(inv.id, whatsapp.display(to), 'WhatsApp message', text, `<pre style="white-space:pre-wrap;font:16px/1.5 Georgia,serif;padding:16px">${escapeHtml(text)}</pre>`, nowIso());
  }
  return { to: whatsapp.display(to), messageId };
}

async function deliver(message) {
  if (mode() === 'smtp') {
    const info = await getTransport().sendMail({
      from: config.smtp.from,
      replyTo: config.smtp.replyTo || undefined,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return info.messageId || null;
  }
  return null; // outbox mode: stored by caller
}

/** Sends a sample invitation (with a fake code) to check email delivery before inviting voters. */
async function sendTestEmail(e, to, adminName) {
  const msg = renderInvitation(e, { full_name: adminName || 'Test Recipient', email: to }, '2222222222222222');
  msg.subject = `[TEST] ${msg.subject}`;
  if (mode() !== 'smtp') return { ok: false, reason: 'No email service (SMTP) is configured yet, so nothing can be sent.' };
  try {
    await deliver(msg);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `The email service rejected the message: ${String(err && err.message ? err.message : err).slice(0, 200)}` };
  }
}

let running = false;
async function processQueue(limit = 25) {
  if (running) return 0;
  running = true;
  let processed = 0;
  try {
    const d = db.get();
    const batch = d.prepare("SELECT * FROM invitations WHERE status = 'queued' ORDER BY id LIMIT ?").all(limit);
    for (const inv of batch) {
      const claimed = d.prepare("UPDATE invitations SET status = 'sending', attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND status = 'queued'").run(nowIso(), inv.id).changes;
      if (!claimed) continue;
      processed++;
      const fail = (msg) => d.prepare("UPDATE invitations SET status = 'failed', error = ? WHERE id = ?").run(msg, inv.id);
      try {
        const voter = d.prepare('SELECT * FROM voters WHERE id = ?').get(inv.voter_id);
        const code = d.prepare('SELECT * FROM voting_codes WHERE id = ?').get(inv.code_id);
        const e = d.prepare('SELECT * FROM elections WHERE id = ?').get(inv.election_id);
        // Safety checks: the code must still be the voter's own active entitlement.
        if (!voter || !code || code.voter_id !== voter.id) { fail('Voting code does not belong to this voter'); continue; }
        if (code.status !== 'active') { fail(code.status === 'used' ? 'Voter has already voted' : 'Voting code is no longer active'); continue; }
        if (voter.eligibility !== 'eligible') { fail('Voter is not eligible'); continue; }
        if (inv.channel === 'whatsapp' || inv.channel === 'sms') {
          try {
            const r = inv.channel === 'sms' ? await deliverSms(d, inv, e, voter, code) : await deliverWhatsApp(d, inv, e, voter, code);
            d.prepare("UPDATE invitations SET status = 'sent', sent_at = ?, error = NULL, to_email = ?, provider_message_id = ? WHERE id = ?")
              .run(nowIso(), r.to, r.messageId, inv.id);
          } catch (err) {
            fail(String(err && err.message ? err.message : err).slice(0, 300));
          }
          continue;
        }
        if (!voter.email || !isValidEmail(voter.email)) { fail('Voter has no valid email address'); continue; }
        const msg = renderInvitation(e, { ...voter }, code.code);
        const messageId = await deliver(msg);
        if (mode() === 'outbox') {
          d.prepare('INSERT INTO email_outbox (invitation_id, to_email, subject, body_text, body_html, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(inv.id, msg.to, msg.subject, msg.text, msg.html, nowIso());
        }
        d.prepare("UPDATE invitations SET status = 'sent', sent_at = ?, error = NULL, to_email = ?, provider_message_id = ? WHERE id = ?")
          .run(nowIso(), voter.email, messageId, inv.id);
      } catch (err) {
        fail(`Delivery failed: ${String(err && err.message ? err.message : err).slice(0, 300)}`);
      }
    }
  } finally {
    running = false;
  }
  return processed;
}

function startWorker() {
  // Recover anything left mid-send by a previous crash.
  db.get().prepare("UPDATE invitations SET status = 'queued' WHERE status = 'sending'").run();
  const perTick = Math.max(1, Math.round(config.mailRatePerMinute / 12));
  const timer = setInterval(() => { processQueue(perTick).catch((e) => console.error('Mail worker error', e)); }, 5000);
  timer.unref();
  return timer;
}

function isValidEmail(email) {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[A-Za-z]{2,}$/.test(String(email || '').trim());
}

module.exports = {
  mode, smtpConfigured, setTransport, renderInvitation, template, VARIABLES, fill, variablesFor,
  queueInvitation, processQueue, sendTestEmail, startWorker, isValidEmail, supportDetails,
};
