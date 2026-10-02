'use strict';
const db = require('../db');
const { nowIso } = require('./time');

/**
 * Append an entry to the audit log.
 * @param {object} req  - express request (for admin + ip), may be null for system actions
 * @param {string} action - human-readable action, e.g. "Candidate approved"
 * @param {object} opts - { electionId, category, entityType, entityId, entityLabel, details }
 */
function log(req, action, opts = {}) {
  const admin = req && req.admin;
  db.get().prepare(`INSERT INTO audit_log (at, election_id, admin_id, admin_name, action, category, entity_type, entity_id, entity_label, details, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    nowIso(),
    opts.electionId ?? (req && req.election ? req.election.id : null),
    admin ? admin.id : null,
    admin ? admin.full_name : (opts.actor || 'System'),
    action,
    opts.category || 'general',
    opts.entityType || null,
    opts.entityId ?? null,
    opts.entityLabel || null,
    opts.details == null ? null : (typeof opts.details === 'string' ? opts.details : JSON.stringify(opts.details)),
    req ? (req.ip || null) : null,
  );
}

module.exports = { log };
