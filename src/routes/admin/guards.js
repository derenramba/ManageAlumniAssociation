'use strict';
const { httpError } = require('../../lib/http');

function requirePerm(...perms) {
  return (req, res, next) => {
    if (!req.admin) return res.redirect('/admin/login');
    if (perms.some((p) => req.admin.perms.has(p))) return next();
    next(httpError(403, 'You do not have permission to access this page. Ask the Main Administrator if you need access.'));
  };
}

function requireElection(req, res, next) {
  if (!req.election) {
    return res.redirect('/admin/elections');
  }
  next();
}

module.exports = { requirePerm, requireElection };
