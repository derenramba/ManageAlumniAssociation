(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name=csrf-token]') || {}).content || '';

  // Mobile navigation
  var toggle = document.querySelector('.menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('.menu-toggle')) {
        document.body.classList.remove('nav-open');
      }
    });
  }

  // Confirmation prompts for sensitive actions
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = (e.submitter && e.submitter.getAttribute('data-confirm')) || f.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    if (f.hasAttribute('data-once')) {
      if (f.dataset.submitting === '1') { e.preventDefault(); return; }
      f.dataset.submitting = '1';
      f.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = true; });
    }
  }, true);

  // Select-all checkboxes
  document.querySelectorAll('[data-select-all]').forEach(function (box) {
    box.addEventListener('change', function () {
      var name = box.getAttribute('data-select-all');
      document.querySelectorAll('input[type=checkbox][name="' + name + '"]').forEach(function (c) { c.checked = box.checked; });
      updateSelCount();
    });
  });
  function updateSelCount() {
    var el = document.querySelector('[data-selected-count]');
    if (!el) return;
    el.textContent = document.querySelectorAll('input[type=checkbox][name="ids"]:checked').length;
  }
  document.addEventListener('change', function (e) { if (e.target.name === 'ids') updateSelCount(); });

  // Reveal / copy a voting code (audited server-side)
  document.querySelectorAll('[data-reveal-code]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('data-target'));
      fetch(btn.getAttribute('data-reveal-code'), { method: 'POST', headers: { 'x-csrf-token': csrf, Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
        .then(function (d) {
          if (target) target.textContent = d.code;
          var done = function () { btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = 'Copy'; }, 2000); };
          if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(d.code).then(done, function () { btn.textContent = 'Shown'; });
          else btn.textContent = 'Shown';
        })
        .catch(function () { btn.textContent = 'Unavailable'; });
    });
  });

  // Toggle "amendment reason" visibility helpers / show-hide by select
  document.querySelectorAll('[data-show-when]').forEach(function (el) {
    var spec = el.getAttribute('data-show-when').split('=');
    var scope = el.closest('form') || document;
    var srcs = scope.querySelectorAll('[name="' + spec[0] + '"]');
    if (!srcs.length) return;
    var sync = function () {
      var val = srcs[0].type === 'radio' ? (scope.querySelector('[name="' + spec[0] + '"]:checked') || {}).value : srcs[0].value;
      el.hidden = val !== spec[1];
    };
    srcs.forEach(function (s) { s.addEventListener('change', sync); });
    sync();
  });

  // Auto-refresh pages that show live status (e.g. invitation queue)
  var auto = document.querySelector('[data-autorefresh]');
  if (auto) setTimeout(function () { if (!document.querySelector('input:focus, textarea:focus, select:focus')) location.reload(); }, parseInt(auto.getAttribute('data-autorefresh'), 10) * 1000);
})();
