'use strict';

const PERMISSIONS = {
  manage_election: 'Manage election settings and status',
  manage_positions: 'Manage positions',
  manage_candidates: 'Manage candidates',
  manage_voters: 'Manage voters',
  manage_codes: 'Manage voting codes',
  send_invitations: 'Send invitations',
  view_turnout: 'View turnout',
  view_results: 'View aggregate results',
  view_individual_votes: 'View individual votes',
  export_results: 'Export aggregate results',
  export_individual_votes: 'Export individual votes',
  publish_results: 'Publish results',
  view_audit_log: 'View audit log',
  manage_admins: 'Manage admin users',
};

const ROLES = {
  main_admin: {
    label: 'Main Administrator',
    description: 'Full election access.',
    permissions: Object.keys(PERMISSIONS),
  },
  election_admin: {
    label: 'Election Administrator',
    description: 'Manages the election, candidates, voters and invitations.',
    permissions: ['manage_election', 'manage_positions', 'manage_candidates', 'manage_voters', 'manage_codes',
      'send_invitations', 'view_turnout', 'view_results', 'export_results', 'view_audit_log'],
  },
  election_officer: {
    label: 'Election Officer',
    description: 'Accesses results and voting records if authorised.',
    permissions: ['view_turnout', 'view_results', 'export_results'],
  },
  auditor: {
    label: 'Read-only Auditor',
    description: 'Read-only access according to permissions.',
    permissions: ['view_turnout', 'view_results', 'view_audit_log'],
  },
};

function parsePermissions(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return arr.filter((p) => PERMISSIONS[p]);
  } catch {
    return [];
  }
}

module.exports = { PERMISSIONS, ROLES, parsePermissions };
