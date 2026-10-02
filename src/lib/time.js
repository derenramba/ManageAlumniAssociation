'use strict';
const config = require('../config');

const nowIso = () => new Date().toISOString();

// Admin forms use <input type="datetime-local"> values, interpreted in election time (IST).
function parseLocalInput(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${config.timezoneOffset}`);
  return isNaN(d) ? null : d.toISOString();
}

function partsInTz(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

function toLocalInput(iso) {
  if (!iso) return '';
  const p = partsInTz(iso);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// "8 October 2026, 6:00 PM IST"
function formatDateTime(iso, { withTz = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${date}, ${time}${withTz ? ' ' + config.timezoneLabel : ''}`;
}

// "8 Oct 2026, 14:42:05" (compact, for tables / logs)
function formatShort(iso) {
  if (!iso) return '—';
  const p = partsInTz(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parseInt(p.day, 10)} ${months[parseInt(p.month, 10) - 1]} ${p.year}, ${p.hour}:${p.minute}:${p.second}`;
}

module.exports = { nowIso, parseLocalInput, toLocalInput, formatDateTime, formatShort };
