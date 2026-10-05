'use strict';
/**
 * Delivery status callbacks from the WhatsApp Business Platform.
 * Configure in Meta: Callback URL = <PUBLIC_BASE_URL>/webhooks/whatsapp, Verify token = WHATSAPP_VERIFY_TOKEN,
 * subscribe to the "messages" field. Requests are accepted only with a valid signature (WHATSAPP_APP_SECRET).
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const { safeEqual } = require('../lib/security');

const router = express.Router();

router.get('/whatsapp', (req, res) => {
  const c = config.whatsapp;
  if (c.verifyToken && req.query['hub.mode'] === 'subscribe' && safeEqual(String(req.query['hub.verify_token'] || ''), c.verifyToken)) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});

router.post('/whatsapp', (req, res) => {
  const secret = config.whatsapp.appSecret;
  const sig = String(req.headers['x-hub-signature-256'] || '');
  if (!secret || !req.rawBody) return res.sendStatus(403);
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
  if (!safeEqual(sig, expected)) return res.sendStatus(403);

  const d = db.get();
  const delivered = d.prepare("UPDATE invitations SET status = 'delivered' WHERE channel = 'whatsapp' AND provider_message_id = ? AND status IN ('sent','sending')");
  const failed = d.prepare("UPDATE invitations SET status = 'failed', error = ? WHERE channel = 'whatsapp' AND provider_message_id = ? AND status <> 'failed'");
  try {
    for (const entry of (req.body && req.body.entry) || []) {
      for (const change of entry.changes || []) {
        for (const st of (change.value && change.value.statuses) || []) {
          if (!st.id) continue;
          if (st.status === 'delivered' || st.status === 'read') delivered.run(st.id);
          if (st.status === 'failed') {
            const e = (st.errors && st.errors[0]) || {};
            const detail = (e.error_data && e.error_data.details) || e.message || e.title || 'Not delivered';
            failed.run(`WhatsApp could not deliver: ${String(detail).slice(0, 250)}${e.code ? ` [code ${e.code}]` : ''}`, st.id);
          }
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error', err);
  }
  res.sendStatus(200);
});

// Twilio SMS and WhatsApp status callbacks (StatusCallback is set automatically on each message when the site uses https).
router.post('/twilio', (req, res) => {
  const sms = require('../lib/sms');
  const url = sms.callbackUrl();
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  if (!url || !sms.validSignature(req.headers['x-twilio-signature'], url, params)) return res.sendStatus(403);
  const sid = String(params.MessageSid || params.SmsSid || '');
  const status = String(params.MessageStatus || params.SmsStatus || '');
  const d = db.get();
  if (sid && status === 'delivered') {
    d.prepare("UPDATE invitations SET status = 'delivered' WHERE channel IN ('sms','whatsapp') AND provider_message_id = ? AND status IN ('sent','sending')").run(sid);
  } else if (sid && (status === 'failed' || status === 'undelivered')) {
    const code = params.ErrorCode ? ` [code ${String(params.ErrorCode).slice(0, 10)}]` : '';
    const inv = d.prepare("SELECT channel FROM invitations WHERE provider_message_id = ?").get(sid);
    const label = inv && inv.channel === 'whatsapp' ? 'WhatsApp message' : 'SMS';
    d.prepare("UPDATE invitations SET status = 'failed', error = ? WHERE channel IN ('sms','whatsapp') AND provider_message_id = ? AND status <> 'failed'")
      .run(`${label} ${status === 'undelivered' ? 'could not be delivered by the mobile network' : 'failed'}${code}`, sid);
  }
  res.type('text/xml').send('<Response></Response>');
});

module.exports = router;
