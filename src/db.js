'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'admin' | 'voter'
  admin_id INTEGER REFERENCES admin_users(id),
  data TEXT NOT NULL DEFAULT '{}',
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS elections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  term TEXT,
  description TEXT,
  opens_at TEXT,
  closes_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  support_name TEXT,
  support_email TEXT,
  support_phone TEXT,
  show_turnout_publicly INTEGER NOT NULL DEFAULT 1,
  public_results_show_totals INTEGER NOT NULL DEFAULT 1,
  voter_list_approved_at TEXT,
  voter_list_approved_by INTEGER REFERENCES admin_users(id),
  opened_at TEXT,
  closed_at TEXT,
  published_at TEXT,
  published_by INTEGER REFERENCES admin_users(id),
  email_subject TEXT,
  email_intro TEXT,
  email_instructions TEXT,
  email_closing TEXT,
  email_support TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'contested' CHECK (kind IN ('contested','unopposed')),
  unopposed_candidate_id INTEGER REFERENCES candidates(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  position_id INTEGER NOT NULL REFERENCES positions(id),
  full_name TEXT NOT NULL,
  batch TEXT,
  photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','withdrawn')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS voters (
  id INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  voter_ref TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  mobile TEXT,
  whatsapp TEXT,
  batch TEXT,
  eligibility TEXT NOT NULL DEFAULT 'pending' CHECK (eligibility IN ('pending','eligible','ineligible')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (election_id, voter_ref)
);
CREATE INDEX IF NOT EXISTS idx_voters_email ON voters(election_id, email);

CREATE TABLE IF NOT EXISTS voting_codes (
  id INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  voter_id INTEGER NOT NULL REFERENCES voters(id),
  code TEXT NOT NULL UNIQUE,      -- normalised: 16 chars, no separators
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','revoked')),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES admin_users(id),
  used_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  replaces_code_id INTEGER REFERENCES voting_codes(id)
);
-- One voter = one voting entitlement: at most one active-or-used code per voter.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_entitlement_per_voter
  ON voting_codes(voter_id) WHERE status IN ('active','used');

CREATE TABLE IF NOT EXISTS ballots (
  id INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  voter_id INTEGER NOT NULL UNIQUE REFERENCES voters(id),
  code_id INTEGER NOT NULL UNIQUE REFERENCES voting_codes(id),
  submission_token TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  receipt TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS ballot_choices (
  id INTEGER PRIMARY KEY,
  ballot_id INTEGER NOT NULL REFERENCES ballots(id),
  position_id INTEGER NOT NULL REFERENCES positions(id),
  candidate_id INTEGER REFERENCES candidates(id),   -- NULL = abstain
  UNIQUE (ballot_id, position_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  voter_id INTEGER NOT NULL REFERENCES voters(id),
  code_id INTEGER NOT NULL REFERENCES voting_codes(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial','resend','retry')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','failed','cancelled')),
  to_email TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  requested_by INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  last_attempt_at TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_voter ON invitations(voter_id, id);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY,
  invitation_id INTEGER REFERENCES invitations(id),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voter_imports (
  id INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  filename TEXT,
  rows_json TEXT NOT NULL,
  created_by INTEGER REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  election_id INTEGER,
  admin_id INTEGER,
  admin_name TEXT,
  action TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  entity_type TEXT,
  entity_id INTEGER,
  entity_label TEXT,
  details TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- ===== Integrity guards enforced by the database itself =====

-- Accepted ballots are immutable.
CREATE TRIGGER IF NOT EXISTS trg_ballots_no_update BEFORE UPDATE ON ballots
BEGIN SELECT RAISE(ABORT, 'Submitted ballots are locked and cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_ballots_no_delete BEFORE DELETE ON ballots
WHEN (SELECT value FROM app_settings WHERE key = 'allow_demo_purge') IS NOT 'yes'
BEGIN SELECT RAISE(ABORT, 'Submitted ballots are locked and cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_choices_no_update BEFORE UPDATE ON ballot_choices
BEGIN SELECT RAISE(ABORT, 'Submitted ballots are locked and cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_choices_no_delete BEFORE DELETE ON ballot_choices
WHEN (SELECT value FROM app_settings WHERE key = 'allow_demo_purge') IS NOT 'yes'
BEGIN SELECT RAISE(ABORT, 'Submitted ballots are locked and cannot be deleted'); END;
-- Choices can only be added while the ballot row is being created (same transaction, code still active).
CREATE TRIGGER IF NOT EXISTS trg_choices_only_on_new_ballot BEFORE INSERT ON ballot_choices
WHEN (SELECT vc.status FROM ballots b JOIN voting_codes vc ON vc.id = b.code_id WHERE b.id = NEW.ballot_id) IS NOT 'active'
BEGIN SELECT RAISE(ABORT, 'Choices cannot be added to an already accepted ballot'); END;

-- A used code can never become active/revoked again (no resetting a voter to "Not voted").
CREATE TRIGGER IF NOT EXISTS trg_used_code_final BEFORE UPDATE OF status ON voting_codes
WHEN OLD.status = 'used'
BEGIN SELECT RAISE(ABORT, 'A used voting code is final'); END;
CREATE TRIGGER IF NOT EXISTS trg_revoked_code_final BEFORE UPDATE OF status ON voting_codes
WHEN OLD.status = 'revoked'
BEGIN SELECT RAISE(ABORT, 'A revoked voting code cannot be reactivated'); END;
-- A code can only be marked used when its ballot exists.
CREATE TRIGGER IF NOT EXISTS trg_code_used_requires_ballot BEFORE UPDATE OF status ON voting_codes
WHEN NEW.status = 'used' AND NOT EXISTS (SELECT 1 FROM ballots WHERE code_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'A code can only be used by an accepted ballot'); END;
-- No new entitlement for a voter who has already voted.
CREATE TRIGGER IF NOT EXISTS trg_no_code_after_vote BEFORE INSERT ON voting_codes
WHEN EXISTS (SELECT 1 FROM ballots WHERE voter_id = NEW.voter_id)
BEGIN SELECT RAISE(ABORT, 'This voter has already voted; no new voting entitlement may be issued'); END;
-- Voters who have voted cannot be deleted.
CREATE TRIGGER IF NOT EXISTS trg_voter_no_delete_after_vote BEFORE DELETE ON voters
WHEN EXISTS (SELECT 1 FROM ballots WHERE voter_id = OLD.id)
  AND (SELECT value FROM app_settings WHERE key = 'allow_demo_purge') IS NOT 'yes'
BEGIN SELECT RAISE(ABORT, 'A voter who has voted cannot be deleted'); END;
-- A voter who has voted keeps eligibility.
CREATE TRIGGER IF NOT EXISTS trg_voter_eligibility_locked BEFORE UPDATE OF eligibility ON voters
WHEN OLD.eligibility <> NEW.eligibility AND EXISTS (SELECT 1 FROM ballots WHERE voter_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Eligibility is locked once a ballot has been submitted'); END;

-- Audit log is append-only.
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log
WHEN (SELECT value FROM app_settings WHERE key = 'allow_demo_purge') IS NOT 'yes'
BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
`;

let db;

function open(file = config.dbFile) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  d.pragma('synchronous = FULL');
  d.exec(SCHEMA);
  migrate(d);
  return d;
}

// Idempotent data fixes applied at start-up.
function migrate(d) {
  // Batch ranges are displayed as "2012-14" (earlier imports stored "2012 to 2014").
  for (const table of ['voters', 'candidates']) {
    const rows = d.prepare(`SELECT id, batch FROM ${table} WHERE batch LIKE '____ to ____'`).all();
    const upd = d.prepare(`UPDATE ${table} SET batch = ? WHERE id = ?`);
    for (const r of rows) {
      const m = r.batch.match(/^(\d{4}) to (\d{4})$/);
      if (m) upd.run(`${m[1]}-${m[2].slice(2)}`, r.id);
    }
  }
}

function get() {
  if (!db) db = open();
  return db;
}

function setDb(d) {
  db = d;
}

function getSetting(key, fallback = null) {
  const row = get().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  get().prepare('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));
}

module.exports = { open, get, setDb, getSetting, setSetting };
