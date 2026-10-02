'use strict';
const { safeEqual } = require('./security');

function verifyCsrf(req, res, next) {
  const token = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (!safeEqual(String(token || ''), (req.cookies && req.cookies.maa_csrf) || '')) {
    const err = new Error('Your session has expired or the page was out of date. Please go back, refresh the page and try again.');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  next();
}

module.exports = { verifyCsrf };
