/* Rado Social Hub — customer extras (additive; loaded by app-shell.js on every page)
 *  1. Low-balance pop-up with a one-tap "Top up" button
 *  2. "Price changed" pop-up (nothing was charged)
 *  3. Notification bell (code received, order done/failed, refunds)
 *  4. Quick panel: search every service, favourite pages, recently visited pages
 */
(function () {
  'use strict';
  if (window.__rshExtras) return;
  window.__rshExtras = true;

  var path = location.pathname.toLowerCase();
  if (/\/(admin|login|register)(\.html)?$/.test(path)) return;

  function token() { try { return localStorage.getItem('rsh_token'); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ngn(v) { return '\u20A6' + (Number(v) || 0).toLocaleString('en-NG'); }
  function get(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
  function api(url) {
    return fetch(url, { headers: { Authorization: 'Bearer ' + token() } }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
    });
  }

  /* ── styles ─────────────────────────────────────────────── */
  var css = document.createElement('style');
  css.textContent =
    '.mx-fab{position:fixed;right:14px;z-index:9990;width:46px;height:46px;border-radius:50%;border:0;cursor:pointer;font-size:20px;line-height:46px;text-align:center;' +
    'background:#0b1b33;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.35);padding:0}' +
    '.mx-badge{position:absolute;top:-3px;right:-3px;min-width:18px;height:18px;border-radius:9px;background:#ef4444;color:#fff;font-size:11px;font-weight:800;line-height:18px;padding:0 4px}' +
    '.mx-ov{position:fixed;inset:0;z-index:9995;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}' +
    '.mx-sheet{width:100%;max-width:520px;max-height:82vh;overflow:auto;background:#fff;color:#0f172a;border-radius:18px 18px 0 0;padding:18px 16px 24px;box-shadow:0 -10px 40px rgba(0,0,0,.35);font-family:inherit}' +
    '.mx-modal{align-items:center}.mx-modal .mx-sheet{border-radius:18px;max-width:380px;margin:16px;text-align:center}' +
    '.mx-sheet h3{margin:0 0 10px;font-size:17px}.mx-sheet p{margin:6px 0 14px;font-size:14px;line-height:1.5;color:#334155}' +
    '.mx-btn{display:inline-block;border:0;border-radius:12px;padding:11px 18px;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;margin:3px}' +
    '.mx-pri{background:#0a84ff;color:#fff}.mx-sec{background:#e2e8f0;color:#0f172a}' +
    '.mx-in{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:12px;font-size:15px;margin-bottom:10px}' +
    '.mx-row{display:block;text-decoration:none;color:inherit;padding:10px 4px;border-top:1px solid #e2e8f0;font-size:14px;text-align:left}' +
    '.mx-row small{display:block;color:#64748b;font-size:12px;margin-top:2px}' +
    '.mx-h{margin:14px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;text-align:left}' +
    '.mx-new{background:#eff6ff}.mx-x{float:right;border:0;background:none;font-size:22px;cursor:pointer;color:#64748b}';
  document.head.appendChild(css);

  function overlay(html, modal, onClose) {
    var o = document.createElement('div');
    o.className = 'mx-ov' + (modal ? ' mx-modal' : '');
    o.innerHTML = '<div class="mx-sheet" role="dialog" aria-modal="true">' + html + '</div>';
    function close() { o.remove(); if (onClose) onClose(); }
    o.addEventListener('click', function (ev) { if (ev.target === o) close(); });
    o.querySelectorAll('[data-mx-close]').forEach(function (b) { b.addEventListener('click', close); });
    document.body.appendChild(o);
    return { el: o, close: close };
  }

  /* ── 1 + 2. Smart error pop-ups (wraps fetch; never changes the response) ── */
  var shown = 0;
  function onProblem(d) {
    if (!d || Date.now() - shown < 4000) return;
    var msg = String(d.error || d.message || '');
    if (d.code === 'PRICE_CHANGED') {
      shown = Date.now();
      var np = Number(d.newPrice);
      overlay('<h3>Price updated</h3><p>' + esc(msg || 'The price changed while you were looking.') + '</p>' +
        (np > 0 ? '<p><b>New price: ' + ngn(np) + '</b></p>' : '') +
        '<p style="font-size:13px">You have <b>not</b> been charged.</p><button class="mx-btn mx-pri" data-mx-close>OK, review price</button>', true);
    } else if (/insufficient/i.test(msg)) {
      shown = Date.now();
      var need = (msg.match(/\u20A6\s*([\d,]+)/) || [])[1];
      need = need ? Number(need.replace(/,/g, '')) : 0;
      var render = function (bal) {
        var gap = need && bal != null ? Math.max(0, need - bal) : 0;
        var o = overlay('<h3>Your wallet needs a top-up</h3><p>' + esc(msg) + '</p>' +
          (bal != null ? '<p>Wallet balance: <b>' + ngn(bal) + '</b>' + (gap ? '<br>You need <b>' + ngn(gap) + '</b> more.' : '') + '</p>' : '') +
          '<a class="mx-btn mx-pri" href="/deposit.html' + (gap ? '?amount=' + Math.ceil(gap) : '') + '">' + (gap ? 'Top up ' + ngn(Math.ceil(gap)) : 'Top up wallet') + '</a>' +
          '<button class="mx-btn mx-sec" data-mx-close>Not now</button>', true);
        return o;
      };
      api('/api/user/wallet').then(function (w) { var b = w && w.balance && Number(w.balance.ngn); render(isFinite(b) ? b : null); }).catch(function () { render(null); });
    }
  }
  if (window.fetch && !window.__rshFetchWrapped) {
    window.__rshFetchWrapped = true;
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method !== 'GET') {
          p.then(function (res) {
            if (res && !res.ok && [400, 402, 409].indexOf(res.status) > -1) res.clone().json().then(onProblem).catch(function () {});
          }).catch(function () {});
        }
      } catch (e) { /* never interfere */ }
      return p;
    };
  }

  if (!token()) return; // everything below is for logged-in customers

  /* ── recent pages ───────────────────────────────────────── */
  var SERVICE_PAGE = /(marketplace|tools|giveaway|groups|active-number)/;
  var title = (document.title || '').replace(/\s*[\u2014|\-]\s*Rado Social Hub.*$/i, '').trim();
  if (SERVICE_PAGE.test(path) && title) {
    var rec = get('rsh_recent', []).filter(function (r) { return r.p !== location.pathname; });
    rec.unshift({ p: location.pathname, t: title });
    set('rsh_recent', rec.slice(0, 8));
  }

  /* ── floating buttons ───────────────────────────────────── */
  function fab(icon, bottom, label) {
    var b = document.createElement('button');
    b.className = 'mx-fab'; b.type = 'button'; b.style.bottom = bottom + 'px';
    b.setAttribute('aria-label', label); b.innerHTML = icon;
    document.body.appendChild(b);
    return b;
  }

  /* ── 3. notification bell ───────────────────────────────── */
  var bell = fab('\uD83D\uDD14<span class="mx-badge" style="display:none"></span>', 218, 'Notifications');
  var badge = bell.querySelector('.mx-badge');
  var items = [];
  function unreadCount() { var seen = get('rsh_notif_seen', 0); return items.filter(function (i) { return new Date(i.at).getTime() > seen; }).length; }
  function paintBadge() { var n = unreadCount(); badge.textContent = n > 9 ? '9+' : n; badge.style.display = n ? 'block' : 'none'; }
  function loadNotifs() { api('/api/extras/notifications').then(function (d) { items = d.items || []; paintBadge(); }).catch(function () {}); }
  bell.addEventListener('click', function () {
    var seen = get('rsh_notif_seen', 0);
    var html = '<button class="mx-x" data-mx-close aria-label="Close">\u00D7</button><h3>Notifications</h3>' +
      (items.length ? items.map(function (i) {
        return '<a class="mx-row ' + (new Date(i.at).getTime() > seen ? 'mx-new' : '') + '" href="' + esc(i.href || '#') + '"><b>' + esc(i.title) + '</b> ' + esc(i.text) + '<small>' + esc(new Date(i.at).toLocaleString('en-NG')) + '</small></a>';
      }).join('') : '<p>Nothing new in the last 3 days.</p>');
    overlay(html, false);
    set('rsh_notif_seen', Date.now()); badge.style.display = 'none';
  });
  setTimeout(loadNotifs, 2500);
  setInterval(function () { if (!document.hidden) loadNotifs(); }, 60000);

  /* ── 4. quick panel: search, favourites, recent ─────────── */
  var quick = fab('\uD83D\uDD0D', 160, 'Search and favourites');
  quick.addEventListener('click', function () {
    var favs = get('rsh_favpages', []), rec = get('rsh_recent', []);
    var here = favs.some(function (f) { return f.p === location.pathname; });
    var html = '<button class="mx-x" data-mx-close aria-label="Close">\u00D7</button><h3>Search everything</h3>' +
      '<input id="mxQ" class="mx-in" type="search" placeholder="e.g. Instagram followers, Facebook log" autocomplete="off"/><div id="mxRes"></div>' +
      (SERVICE_PAGE.test(path) ? '<button class="mx-btn mx-sec" id="mxFav" type="button">' + (here ? '\u2605 Remove this page from favourites' : '\u2606 Add this page to favourites') + '</button>' : '') +
      '<div class="mx-h">Favourites</div>' + (favs.length ? favs.map(function (f) { return '<a class="mx-row" href="' + esc(f.p) + '">\u2605 ' + esc(f.t) + '</a>'; }).join('') : '<p style="font-size:13px">Open a service page and tap \u201CAdd this page to favourites\u201D.</p>') +
      '<div class="mx-h">Recently visited</div>' + (rec.length ? rec.map(function (r) { return '<a class="mx-row" href="' + esc(r.p) + '">' + esc(r.t) + '</a>'; }).join('') : '<p style="font-size:13px">Pages you use will show up here.</p>');
    var o = overlay(html, false);
    var q = o.el.querySelector('#mxQ'), res = o.el.querySelector('#mxRes'), timer = null, seq = 0;
    var fb = o.el.querySelector('#mxFav');
    if (fb) fb.addEventListener('click', function () {
      var list = get('rsh_favpages', []);
      if (here) list = list.filter(function (f) { return f.p !== location.pathname; });
      else list.unshift({ p: location.pathname, t: title || location.pathname });
      set('rsh_favpages', list.slice(0, 12)); o.close();
    });
    q.addEventListener('input', function () {
      clearTimeout(timer);
      var term = q.value.trim();
      if (term.length < 2) { res.innerHTML = ''; return; }
      timer = setTimeout(function () {
        var my = ++seq;
        res.innerHTML = '<p style="font-size:13px">Searching\u2026</p>';
        api('/api/extras/search?q=' + encodeURIComponent(term)).then(function (d) {
          if (my !== seq) return;
          var rows = (d.results || []).map(function (r) {
            return '<a class="mx-row" href="' + esc(r.href) + '"><b>' + esc(r.name) + '</b>' + (r.price ? ' \u00B7 ' + ngn(r.price) : '') + '<small>' + esc(r.line) + (r.category ? ' \u00B7 ' + esc(r.category) : '') + '</small></a>';
          }).join('');
          if (d.numbers) rows += '<a class="mx-row" href="' + esc(d.numbers.href) + '"><b>' + esc(d.numbers.label) + '</b><small>Virtual numbers</small></a>';
          res.innerHTML = rows || '<p style="font-size:13px">No matching services.</p>';
        }).catch(function (e) { if (my === seq) res.innerHTML = '<p style="font-size:13px">' + esc(e.message) + '</p>'; });
      }, 300);
    });
    setTimeout(function () { try { q.focus(); } catch (e) { /* ignore */ } }, 80);
  });
})();
