'use strict';
const config = require('./src/config');
const db = require('./src/db');
const { createApp } = require('./src/app');
const mailer = require('./src/lib/mailer');
const sessions = require('./src/lib/sessions');
const { ensureInitialAdmin } = require('./scripts/create-admin');

db.get();
ensureInitialAdmin();

const app = createApp();
mailer.startWorker();
setInterval(() => sessions.purgeExpired(), 15 * 60 * 1000).unref();

app.listen(config.port, config.host, () => {
  console.log(`MANAGE Alumni Association voting platform running at http://localhost:${config.port}`);
  console.log(`  Voter portal:        ${config.publicBaseUrl}/`);
  console.log(`  Admin dashboard:     ${config.publicBaseUrl}/admin`);
  console.log(`  Email delivery mode: ${mailer.mode() === 'smtp' ? `SMTP (${config.smtp.host})` : 'OUTBOX (no SMTP configured — emails are stored in the admin Email outbox, not sent)'}`);
});
