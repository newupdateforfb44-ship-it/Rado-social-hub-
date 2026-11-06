/* Control room (owner only): maintenance, payment tools, daily summary, backup + error log.
   Talks to /api/admin/ops/* (lib/ops.js). Uses the admin page's own login (adminPass). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var hdr = function (json) {
    var h = { 'x-admin-passcode': (typeof adminPass !== 'undefined' ? adminPass : '') };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  };
  function api(method, path, body) {
    return fetch(path, { method: method, headers: hdr(!!body), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Error ' + r.status)); return d; }); });
  }
  function say(id, msg, ok) { var el = $(id); if (!el) return; el.textContent = msg; el.style.color = ok === false ? '#e5484d' : '#2fbf71'; el.style.display = 'block'; }
  var S = null; // settings

  function render() {
    var m = S.maintenance, l = S.limits, d = S.daily;
    $('opsMaintSite').checked = !!m.site; $('opsMaintDep').checked = !!m.deposits;
    $('opsMaintOrd').checked = !!m.orders; $('opsMaintNum').checked = !!m.numbers;
    $('opsMaintMsg').value = m.message || '';
    $('opsLimPlMin').value = l.paymentlink.min || ''; $('opsLimPlMax').value = l.paymentlink.max || '';
    $('opsLimBtMin').value = l.banktransfer.min || ''; $('opsLimBtMax').value = l.banktransfer.max || '';
    $('opsDailyOn').checked = !!d.enabled; $('opsDailyEmail').value = d.email || ''; $('opsDailyEmail').placeholder = S.defaultEmail || 'you@example.com';
    $('opsDailyHour').value = d.hourWat;
    $('opsDailyNote').textContent = S.emailReady ? '' : 'Email is not set up yet: add RESEND_API_KEY on the server for this to send.';
  }

  window.opsLoad = function () {
    api('GET', '/api/admin/ops/settings').then(function (s) { S = s; render(); opsLoadBackup(); opsLoadErrors(); })
      .catch(function (e) { say('opsMaintFb', 'Could not load: ' + e.message, false); });
  };

  window.opsSaveMaint = function () {
    api('PUT', '/api/admin/ops/maintenance', { site: $('opsMaintSite').checked, deposits: $('opsMaintDep').checked, orders: $('opsMaintOrd').checked, numbers: $('opsMaintNum').checked, message: $('opsMaintMsg').value })
      .then(function () { var m = ['opsMaintSite', 'opsMaintDep', 'opsMaintOrd', 'opsMaintNum'].some(function (i) { return $(i).checked; }); say('opsMaintFb', m ? 'Saved. Maintenance is ON for the parts you ticked.' : 'Saved. Everything is open.'); })
      .catch(function (e) { say('opsMaintFb', e.message, false); });
  };
  window.opsSaveLimits = function () {
    api('PUT', '/api/admin/ops/limits', { paymentlink: { min: $('opsLimPlMin').value, max: $('opsLimPlMax').value }, banktransfer: { min: $('opsLimBtMin').value, max: $('opsLimBtMax').value } })
      .then(function () { say('opsLimFb', 'Limits saved. Leave a box empty for no limit.'); }).catch(function (e) { say('opsLimFb', e.message, false); });
  };
  window.opsTestGw = function (g) {
    var out = $('opsGw_' + g); out.textContent = 'Testing...'; out.style.color = '';
    api('POST', '/api/admin/ops/test-gateway', { gateway: g }).then(function (r) {
      out.textContent = (r.ok ? 'OK - ' : 'Failed - ') + r.message + (r.ms ? ' (' + r.ms + 'ms)' : ''); out.style.color = r.ok ? '#2fbf71' : '#e5484d';
    }).catch(function (e) { out.textContent = e.message; out.style.color = '#e5484d'; });
  };
  window.opsSaveDaily = function () {
    api('PUT', '/api/admin/ops/daily', { enabled: $('opsDailyOn').checked, email: $('opsDailyEmail').value, hourWat: $('opsDailyHour').value })
      .then(function () { say('opsDailyFb', 'Saved.'); }).catch(function (e) { say('opsDailyFb', e.message, false); });
  };
  window.opsSendNow = function () {
    say('opsDailyFb', 'Sending...');
    api('POST', '/api/admin/ops/daily/send-now', {}).then(function (r) {
      $('opsDailyPreview').textContent = r.preview || '';
      say('opsDailyFb', r.sent ? 'Sent. Check your inbox.' : ('Not sent: ' + (r.reason || 'unknown reason')), !!r.sent);
    }).catch(function (e) { say('opsDailyFb', e.message, false); });
  };
  window.opsPreviewDaily = function () {
    api('GET', '/api/admin/ops/daily/preview').then(function (r) { $('opsDailyPreview').textContent = r.text || ''; }).catch(function (e) { say('opsDailyFb', e.message, false); });
  };

  // ── Backup + errors ──
  function opsLoadBackup() {
    api('GET', '/api/admin/ops/backup-info').then(function (rows) {
      var total = rows.reduce(function (a, r) { return a + r.count; }, 0);
      $('opsBackupInfo').textContent = rows.length + ' collections, about ' + total.toLocaleString() + ' records. Passwords and secret keys are left out of the file.';
    }).catch(function () { $('opsBackupInfo').textContent = ''; });
  }
  window.opsDownloadBackup = function () {
    say('opsBackupFb', 'Preparing the backup. This can take a minute...');
    fetch('/api/admin/ops/backup', { headers: hdr(false) }).then(function (r) {
      if (!r.ok) throw new Error('Error ' + r.status); return r.blob();
    }).then(function (b) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'backup-' + new Date().toISOString().slice(0, 10) + '.jsonl';
      document.body.appendChild(a); a.click(); a.remove(); say('opsBackupFb', 'Backup downloaded. Keep it somewhere safe and private.');
    }).catch(function (e) { say('opsBackupFb', 'Backup failed: ' + e.message, false); });
  };
  function opsLoadErrors() {
    api('GET', '/api/admin/system-errors').then(function (rows) {
      rows = (rows || []).slice(0, 40);
      $('opsErrors').innerHTML = rows.length ? rows.map(function (e) {
        return '<tr style="opacity:' + (e.resolved ? '.5' : '1') + '"><td>' + new Date(e.createdAt).toLocaleString() + '</td><td>' + esc(e.source || '') + '</td><td>' + esc(String(e.message || e.title || '').slice(0, 220)) + '</td><td>'
          + (e.resolved ? 'Resolved' : '<button class="btn-gold" onclick="opsResolveErr(\'' + esc(e._id) + '\')">Resolve</button>') + '</td></tr>';
      }).join('') : '<tr><td colspan="4" style="color:var(--t2)">No errors recorded. 🎉</td></tr>';
    }).catch(function (e) { $('opsErrors').innerHTML = '<tr><td colspan="4">' + esc(e.message) + '</td></tr>'; });
  }
  window.opsResolveErr = function (id) { api('PUT', '/api/admin/system-errors/' + id + '/resolve', {}).then(opsLoadErrors); };
  window.opsLoadErrors = opsLoadErrors;
})();
