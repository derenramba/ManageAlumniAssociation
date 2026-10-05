'use strict';
const path = require('path');
const fs = require('fs');

// Minimal .env loader (no external dependency). Existing environment variables win.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  port: parseInt(env.PORT || '3000', 10),
  host: env.HOST || '0.0.0.0',
  dataDir,
  dbFile: env.DB_FILE || path.join(dataDir, 'election.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
  // Public URL used in invitation emails, e.g. https://vote.managealumni.org
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
  // Set to "true" when served over HTTPS so cookies are marked Secure.
  secureCookies: env.SECURE_COOKIES === 'true',
  trustProxy: env.TRUST_PROXY === 'true',
  timezone: 'Asia/Kolkata',
  timezoneLabel: 'IST',
  timezoneOffset: '+05:30',
  smtp: {
    host: env.SMTP_HOST || '',
    port: parseInt(env.SMTP_PORT || '587', 10),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'MANAGE Alumni Association Elections <elections@example.org>',
    replyTo: env.SMTP_REPLY_TO || '',
  },
  // WhatsApp Business Platform (Meta Cloud API). Leave the token empty to use outbox (test) mode.
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    templateName: env.WHATSAPP_TEMPLATE_NAME || 'voting_code',
    templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
    defaultCountryCode: (env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, ''),
    apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
  },
  // Messages per minute the background mailer will send (protects SMTP quotas).
  mailRatePerMinute: parseInt(env.MAIL_RATE_PER_MINUTE || '120', 10),
  adminSessionHours: parseInt(env.ADMIN_SESSION_HOURS || '8', 10),
  voterSessionMinutes: parseInt(env.VOTER_SESSION_MINUTES || '60', 10),
};
