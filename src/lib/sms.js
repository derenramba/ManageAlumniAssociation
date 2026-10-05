'use strict';
/**
 * SMS delivery through Twilio (Programmable Messaging).
 * Uses TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN and sends from TWILIO_FROM, which may be a
 * Twilio phone number (+1…) or a Messaging Service SID (MG…).
 */
const crypto = require('crypto');
const config = require('../config');
const { formatCode } = require('./codes');
const { formatDateTime } = require('./time');
const { cleanText } = require('./nodash');
const whatsapp = require('./whatsapp'); // shared phone-number normalisation

const cfg = () => config.twilio;
const configured = () => !!(cfg().accountSid && cfg().authToken && cfg().from);
const mode = () => (configured() ? 'api' : 'outbox');

/** SMS goes to the mobile number, falling back to the WhatsApp number. */
function voterPhone(voter) {
  return whatsapp.normalizePhone(voter.mobile) || whatsapp.normalizePhone(voter.whatsapp);
}

/** Plain ASCII text (GSM friendly), kept short: name, code, link, closing time. */
function renderText(e, voter, code) {
  const first = String(voter.full_name || '').trim().replace(/^(dr|mr|mrs|ms|prof|shri|smt)\.?\s+/i, '').split(/\s+/)[0] || 'Voter';
  const text = `${e.name}: Dear ${first}, your personal voting code is ${formatCode(code)}. Vote at ${config.publicBaseUrl}/ before ${formatDateTime(e.closes_at)}. One ballot per code. Please keep it private.`;
  return cleanText(text).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function callbackUrl() {
  return /^https:\/\//.test(config.publicBaseUrl) ? `${config.publicBaseUrl}/webhooks/twilio` : null;
}

/** Sends one SMS. Resolves with the Twilio message SID; throws a readable error. */
async function send(text, toDigits) {
  const c = cfg();
  const form = new URLSearchParams({ To: `+${toDigits}`, Body: text });
  if (/^MG[0-9a-f]{32}$/i.test(c.from)) form.set('MessagingServiceSid', c.from); else form.set('From', c.from);
  const cb = callbackUrl();
  if (cb) form.set('StatusCallback', cb);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non JSON reply */ }
  if (!res.ok || !data.sid) {
    throw new Error(`Twilio rejected the SMS: ${data.message || `HTTP ${res.status}`}${data.code ? ` [code ${data.code}]` : ''}`);
  }
  return data.sid;
}

/** Twilio request signature check (X-Twilio-Signature). */
function validSignature(signature, url, params) {
  const token = cfg().authToken;
  if (!token || !signature) return false;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configured, mode, voterPhone, renderText, send, validSignature, callbackUrl, display: whatsapp.display };
