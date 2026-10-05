'use strict';
/**
 * WhatsApp delivery through Meta's WhatsApp Business Platform (Cloud API).
 *
 * Business-initiated WhatsApp messages must use a template approved by Meta. The template
 * registered in WhatsApp Manager must have exactly these five body variables, in this order:
 *   {{1}} first name, {{2}} election name, {{3}} voting code, {{4}} voting link, {{5}} closing date
 * (see TEMPLATE_BODY below for the recommended wording).
 */
const config = require('../config');
const { formatCode } = require('./codes');
const { formatDateTime } = require('./time');
const { cleanText } = require('./nodash');

const TEMPLATE_BODY = 'Dear {{1}}, voting for the {{2}} is now open. Your personal voting code is {{3}}. Vote here: {{4}} . Voting closes on {{5}}. Your code can be used for one ballot only. Please keep it private and do not forward this message.';

const cfg = () => config.whatsapp;
const configured = () => !!(cfg().token && cfg().phoneNumberId);
const mode = () => (configured() ? 'api' : 'outbox');

/**
 * Converts a stored phone number to the international digits WhatsApp expects (e.g. 919876543210).
 * 10 digit numbers without a country code get the default country code (India, 91).
 * Returns '' when the number cannot be used.
 */
function normalizePhone(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const plus = /^\s*\(?\s*(\+|00)/.test(s);
  let digits = s.replace(/\D/g, '');
  if (/^\s*\(?\s*00/.test(s)) digits = digits.replace(/^00/, '');
  if (!plus) {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) digits = cfg().defaultCountryCode + digits;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

/** The number a voter's WhatsApp message goes to: their WhatsApp number, else their mobile. */
function voterPhone(voter) {
  return normalizePhone(voter.whatsapp) || normalizePhone(voter.mobile);
}

const display = (digits) => (digits ? `+${digits}` : '');

function firstName(full) {
  const name = String(full || '').trim().replace(/^(dr|mr|mrs|ms|prof|shri|smt)\.?\s+/i, '');
  return name.split(/\s+/)[0] || String(full || '');
}

function parameters(e, voter, code) {
  return [
    firstName(voter.full_name),
    e.name,
    formatCode(code),
    `${config.publicBaseUrl}/`,
    formatDateTime(e.closes_at),
  ].map((p) => cleanText(String(p || '')).replace(/\s{4,}/g, '   ').slice(0, 900));
}

/** The message text as the voter will read it (used for previews and the test outbox). */
function renderText(e, voter, code) {
  const p = parameters(e, voter, code);
  return TEMPLATE_BODY.replace(/\{\{(\d)\}\}/g, (m, i) => p[Number(i) - 1] ?? m);
}

/** Sends the approved template. Resolves with the WhatsApp message id; throws a readable error. */
async function send(e, voter, code, toDigits) {
  const c = cfg();
  const body = {
    messaging_product: 'whatsapp',
    to: toDigits,
    type: 'template',
    template: {
      name: c.templateName,
      language: { code: c.templateLang },
      components: [{ type: 'body', parameters: parameters(e, voter, code).map((text) => ({ type: 'text', text })) }],
    },
  };
  const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${encodeURIComponent(c.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non JSON reply */ }
  if (!res.ok || !data.messages || !data.messages[0]) {
    const err = (data && data.error) || {};
    const detail = err.error_data && err.error_data.details ? ` (${err.error_data.details})` : '';
    throw new Error(`WhatsApp rejected the message: ${err.message || `HTTP ${res.status}`}${detail}${err.code ? ` [code ${err.code}]` : ''}`);
  }
  return data.messages[0].id;
}

module.exports = { TEMPLATE_BODY, configured, mode, normalizePhone, voterPhone, display, renderText, send, parameters };
