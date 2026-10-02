(function () {
  'use strict';

  // ----- Ballot progress, selected state and guided scrolling -----
  var form = document.getElementById('ballot-form');
  if (form) {
    var positions = Array.prototype.slice.call(form.querySelectorAll('[data-position]'));
    var label = document.getElementById('progress-label');
    var bar = document.getElementById('progress-bar');
    var total = positions.length;
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var update = function () {
      var done = 0;
      positions.forEach(function (p) {
        var checked = p.querySelector('input[type=radio]:checked');
        if (checked) { done++; p.classList.remove('has-error'); }
        p.classList.toggle('answered', !!checked);
        var hint = p.querySelector('[data-hint]');
        if (hint) {
          if (!checked) hint.textContent = 'Select one candidate, or abstain';
          else if (checked.value === 'abstain') hint.textContent = 'You chose to abstain';
          else hint.textContent = 'Your choice: ' + checked.closest('label').querySelector('.name').textContent;
        }
        p.querySelectorAll('.choice').forEach(function (c) {
          var input = c.querySelector('input');
          c.classList.toggle('is-checked', !!(input && input.checked));
        });
      });
      if (label) label.innerHTML = '<strong>' + done + ' of ' + total + '</strong> posts completed';
      if (bar) bar.style.width = (total ? (done / total) * 100 : 0) + '%';
      var btn = document.getElementById('review-btn');
      if (btn) btn.textContent = done === total ? 'Review my choices →' : 'Review my choices (' + done + '/' + total + ')';
      return done;
    };
    form.addEventListener('change', function (ev) {
      var pos = ev.target.closest('[data-position]');
      var wasAnswered = pos && pos.dataset.seen === '1';
      if (pos) pos.dataset.seen = '1';
      update();
      // After the first answer for a post, bring the next unanswered post into view.
      if (pos && !wasAnswered) {
        var next = positions.filter(function (p) { return !p.querySelector('input[type=radio]:checked'); })[0];
        var target = next || document.getElementById('review-btn');
        if (target) setTimeout(function () { target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: next ? 'start' : 'center' }); }, 250);
      }
    });
    positions.forEach(function (p) { if (p.querySelector('input[type=radio]:checked')) p.dataset.seen = '1'; });
    update();
    form.addEventListener('submit', function (ev) {
      var firstMissing = null;
      positions.forEach(function (p) {
        if (!p.querySelector('input[type=radio]:checked')) {
          p.classList.add('has-error');
          if (!firstMissing) firstMissing = p;
        }
      });
      if (firstMissing) {
        ev.preventDefault();
        var msg = document.getElementById('incomplete-msg');
        if (msg) msg.hidden = false;
        firstMissing.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        var r = firstMissing.querySelector('input[type=radio]');
        if (r) r.focus({ preventScroll: true });
      }
    });
  }

  // ----- Prevent double submission (server is also idempotent) -----
  document.querySelectorAll('form[data-once]').forEach(function (f) {
    f.addEventListener('submit', function (ev) {
      if (f.dataset.submitting === '1') { ev.preventDefault(); return; }
      f.dataset.submitting = '1';
      f.querySelectorAll('button[type=submit]').forEach(function (b) {
        b.disabled = true;
        if (b.dataset.busy) b.textContent = b.dataset.busy;
      });
    });
  });
  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted) {
      document.querySelectorAll('form[data-once]').forEach(function (f) {
        f.dataset.submitting = '';
        f.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; });
      });
    }
  });

  // ----- Voting code input: tidy formatting while typing / pasting -----
  var code = document.getElementById('code');
  if (code) {
    code.addEventListener('input', function () {
      var raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
      var grouped = raw.match(/.{1,4}/g);
      var next = grouped ? grouped.join(' ') : '';
      if (next !== code.value) code.value = next;
    });
  }

  // ----- Live turnout -----
  var t = document.querySelector('[data-live-turnout]');
  if (t && window.fetch) {
    var refresh = function () {
      fetch('/api/turnout', { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.available) return;
          var v = t.querySelector('[data-voted]'); if (v) v.textContent = d.voted.toLocaleString('en-IN');
          var e = t.querySelector('[data-eligible]'); if (e) e.textContent = d.eligible.toLocaleString('en-IN');
          var p = t.querySelector('[data-pct]'); if (p) p.textContent = d.pct.toFixed(1) + '%';
          var b = t.querySelector('[data-bar]'); if (b) b.style.width = Math.min(100, d.pct) + '%';
          var pr = t.querySelector('[role=progressbar]'); if (pr) pr.setAttribute('aria-valuenow', d.pct.toFixed(1));
        })
        .catch(function () { /* offline: keep last figures */ });
    };
    setInterval(refresh, 30000);
  }
})();
