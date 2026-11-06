/* Join-WhatsApp-channel popup. Settings (on/off, text, link, how often, where) come from
   Admin → Join-WhatsApp popup. Shown on logged-in customer pages only. Text is plain text. */
(function () {
  if (window.RSHWelcomePopup) return;
  var SEEN_KEY = 'rsh_wp_seen', SESSION_KEY = 'rsh_wp_session';
  var DAY = 86400000, FREQ = { '7d': 7 * DAY, '15d': 15 * DAY, '30d': 30 * DAY };
  var NEVER = /^\/(login|signin|register|signup|admin|reset)/i;

  function store(kind) { try { return kind === 's' ? sessionStorage : localStorage; } catch (e) { return null; } }
  function get(kind, k) { var s = store(kind); try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function set(kind, k, v) { var s = store(kind); try { if (s) s.setItem(k, v); } catch (e) { /* private mode: popup may repeat, harmless */ } }
  function del(kind, k) { var s = store(kind); try { if (s) s.removeItem(k); } catch (e) {} }

  function pageAllowed(pages) {
    var p = (location.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    if (NEVER.test(p) || p === '/') return false;
    pages = pages && pages.length ? pages : ['all'];
    if (pages.indexOf('all') > -1) return true;
    if (pages.indexOf('dashboard') > -1 && p === '/dashboard') return true;
    if (pages.indexOf('marketplace') > -1 && p === '/products') return true;
    return false;
  }
  function frequencyAllows(freq) {
    var seen = Number(get('l', SEEN_KEY) || 0);
    if (freq === 'every') return !get('s', SESSION_KEY);
    if (FREQ[freq]) return !seen || Date.now() - seen > FREQ[freq];
    return !seen; // "first"
  }
  function validUrl(u) {
    try { var x = new URL(u); return x.protocol === 'https:' && /(^|\.)whatsapp\.com$/i.test(x.hostname); } catch (e) { return false; }
  }

  function el(tag, css, text) { var n = document.createElement(tag); if (css) n.style.cssText = css; if (text != null) n.textContent = text; return n; }

  function render(cfg, isPreview) {
    if (document.getElementById('rsh-wp')) return;
    var overlay = el('div', 'position:fixed;inset:0;z-index:99999;background:rgba(17,24,39,.6);display:flex;align-items:center;justify-content:center;padding:18px;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
    overlay.id = 'rsh-wp';
    var box = el('div', 'background:#fff;color:#1f2937;border-radius:16px;max-width:420px;width:100%;max-height:92vh;overflow:auto;padding:26px 22px;box-shadow:0 12px 40px rgba(0,0,0,.35);text-align:center');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.appendChild(el('div', 'font-size:42px;line-height:1;margin-bottom:8px', '💬'));
    box.appendChild(el('h2', 'margin:0 0 6px;font-size:22px;font-weight:700', cfg.heading || ''));
    if (cfg.subtitle) box.appendChild(el('p', 'margin:0 0 12px;color:#0f6fb0;font-weight:600', cfg.subtitle));
    if (cfg.description) box.appendChild(el('p', 'margin:0 0 10px;line-height:1.5;color:#374151;white-space:pre-line', cfg.description));
    if (cfg.additionalMessage) box.appendChild(el('p', 'margin:0 0 18px;line-height:1.5;color:#64748b;font-size:14px;white-space:pre-line', cfg.additionalMessage));
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    var join;
    if (validUrl(cfg.channelUrl)) {
      join = el('a', 'display:block;background:#25d366;color:#fff;text-decoration:none;font-weight:700;padding:13px 16px;border-radius:10px;margin-bottom:10px', cfg.whatsappButtonText || 'Join');
      join.href = cfg.channelUrl; join.target = '_blank'; join.rel = 'noopener noreferrer';
      join.addEventListener('click', function () { setTimeout(close, 150); });
    } else {
      join = el('button', 'display:block;width:100%;background:#cbd5e1;color:#64748b;font-weight:700;padding:13px 16px;border:0;border-radius:10px;margin-bottom:10px;cursor:not-allowed', cfg.whatsappButtonText || 'Join');
      join.disabled = true;
      box.appendChild(join); box.appendChild(el('p', 'margin:-4px 0 10px;font-size:12px;color:#94a3b8', 'The channel link is not set up yet.')); join = null;
    }
    if (join) box.appendChild(join);
    var later = el('button', 'display:block;width:100%;background:none;border:0;color:#64748b;padding:10px;font-size:15px;cursor:pointer;font-family:inherit', cfg.dismissButtonText || 'Maybe Later');
    later.addEventListener('click', close);
    box.appendChild(later);
    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    if (!isPreview) { set('l', SEEN_KEY, String(Date.now())); set('s', SESSION_KEY, '1'); }
  }

  async function start() {
    try {
      var r = await fetch('/api/welcome-popup', { cache: 'no-store' });
      var cfg = await r.json();
      if (!cfg || !cfg.enabled || !pageAllowed(cfg.eligiblePages) || !frequencyAllows(cfg.displayFrequency)) return;
      setTimeout(function () { render(cfg, false); }, Number(cfg.displayDelay) || 0);
    } catch (e) { /* the popup is optional: never break the page */ }
  }

  window.RSHWelcomePopup = {
    preview: function (cfg) { render(cfg || {}, true); },
    clearBrowserMemory: function () { del('l', SEEN_KEY); del('s', SESSION_KEY); }
  };
  if (!window.RSH_NO_WELCOME_AUTOSTART) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
})();
