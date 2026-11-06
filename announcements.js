/* public/js/announcements.js — admin broadcast notifications.
 *
 * The owner posts announcements from Admin → Notifications bar. Every logged-in
 * user gets a popup with three actions:
 *   • Don't show again  → permanently dismissed for that user (saved server-side)
 *   • Cancel            → closed for this session only, shown again next visit
 *   • Read more         → opens the admin's link, or the in-app /notifications
 *                         page when the announcement has no link
 *
 * Read + dismissed state is stored per user in the database (not just in this
 * browser), so it survives logout, a cleared cache and a brand new device.
 */
(function () {
  const T = () => { try { return localStorage.getItem('rsh_token') || ''; } catch (e) { return ''; } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SESSION_KEY = 'rsh_ann_snoozed';   // ids the user pressed "Cancel" on, this session only

  const snoozed = () => {
    try { return new Set(JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]')); } catch (e) { return new Set(); }
  };
  const snooze = id => {
    try {
      const s = snoozed(); s.add(String(id));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify([...s]));
    } catch (e) {}
  };

  let items = [];
  let queue = [];
  let openId = null;

  async function api(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T(), ...(opts.headers || {}) },
    });
    const raw = await r.text();
    let d = {};
    if (raw) { try { d = JSON.parse(raw); } catch (e) { d = {}; } }
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }

  const setState = (id, body) => api('/api/announcements/' + encodeURIComponent(id) + '/state', {
    method: 'POST', body: JSON.stringify(body),
  }).catch(() => {});

  const timeAgo = iso => {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
    return Math.floor(mins / 1440) + 'd ago';
  };

  /* ── Popup ─────────────────────────────────────────────────────────────── */
  function ensureModal() {
    let el = document.getElementById('rshAnnModal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'rshAnnModal';
    el.className = 'rshann-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'rshAnnModalTitle');
    el.hidden = true;
    el.innerHTML = `
      <div class="rshann-backdrop" data-rshann="cancel"></div>
      <div class="rshann-box">
        <div class="rshann-level" id="rshAnnModalLevel">Announcement</div>
        <img class="rshann-image" id="rshAnnModalImage" alt="" hidden/>
        <h3 class="rshann-title" id="rshAnnModalTitle"></h3>
        <div class="rshann-msg" id="rshAnnModalMsg"></div>
        <div class="rshann-actions">
          <button type="button" class="rshann-btn rshann-btn-primary" data-rshann="readmore" id="rshAnnReadMore">Read more</button>
          <button type="button" class="rshann-btn" data-rshann="cancel">Cancel</button>
          <button type="button" class="rshann-btn rshann-btn-ghost" data-rshann="never">Don't show again</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const act = e.target.closest('[data-rshann]')?.dataset.rshann;
      if (!act) return;
      if (act === 'cancel') { snooze(openId); close(); next(); }
      if (act === 'never') { const id = openId; setState(id, { dismissed: true }); markLocal(id, { read: true, dismissed: true }); close(); next(); }
      if (act === 'readmore') readMore();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !el.hidden) { snooze(openId); close(); }
    });
    return el;
  }

  function markLocal(id, patch) {
    const a = items.find(x => String(x.id) === String(id));
    if (a) Object.assign(a, patch);
    renderPage();
    paintBadge();
  }

  function readMore() {
    const a = items.find(x => String(x.id) === String(openId));
    // Analytics: "Read more" is the click we measure against views.
    setState(openId, { read: true, clicked: true });
    markLocal(openId, { read: true });
    close();
    if (a && a.link) {
      if (/^https?:\/\//i.test(a.link)) window.open(a.link, '_blank', 'noopener');
      else window.location.href = a.link;
      return;
    }
    // No link from the admin → take them straight to the notifications page.
    window.location.href = '/notifications';
  }

  function close() {
    const el = document.getElementById('rshAnnModal');
    if (el) el.hidden = true;
    document.body.classList.remove('rshann-open');
    openId = null;
  }

  function show(a) {
    const el = ensureModal();
    openId = a.id;
    el.querySelector('#rshAnnModalTitle').textContent = a.title;
    el.querySelector('#rshAnnModalMsg').textContent = a.message;
    const image = el.querySelector('#rshAnnModalImage');
    if (a.image) { image.src = a.image; image.alt = a.title || 'New item'; image.hidden = false; }
    else { image.removeAttribute('src'); image.hidden = true; }
    const lvl = el.querySelector('#rshAnnModalLevel');
    lvl.textContent = ({ info: 'Announcement', success: 'Good news', warning: 'Please note', urgent: 'Important' })[a.level] || 'Announcement';
    el.querySelector('.rshann-box').setAttribute('data-level', a.level || 'info');
    const btn = el.querySelector('#rshAnnReadMore');
    btn.textContent = a.linkLabel || 'Read more';
    el.hidden = false;
    document.body.classList.add('rshann-open');
    // Analytics: record that this user actually saw the announcement.
    setState(a.id, { viewed: true });
    setTimeout(() => { try { btn.focus({ preventScroll: true }); } catch (e) {} }, 60);
  }

  /** Another blocking overlay (e.g. the complete-your-profile gate) owns the screen. */
  function blocked() {
    const gate = document.getElementById('rshProfileGate');
    return !!(gate && gate.offsetParent !== null);
  }

  function next() {
    if (blocked()) { setTimeout(next, 4000); return; }   // wait until the user clears it
    const skip = snoozed();
    while (queue.length) {
      const a = queue.shift();
      if (!a || a.dismissed || a.read || skip.has(String(a.id))) continue;
      show(a);
      return;
    }
  }


  /* ── Notifications page list ───────────────────────────────────────────── */
  function pageHost() {
    const list = document.getElementById('notifPageList');
    if (!list) return null;
    let host = document.getElementById('rshAnnPageList');
    if (!host) {
      host = document.createElement('div');
      host.id = 'rshAnnPageList';
      host.className = 'rshann-page';
      list.parentNode.insertBefore(host, list);
    }
    return host;
  }

  function renderPage() {
    const host = pageHost();
    if (!host) return;
    if (!items.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="rshann-page-head">From Rado Social Hub <span class="rshann-page-count">${items.filter(a => !a.read).length} unread</span></div>`
      + items.map(a => `
      <article class="rshann-card ${a.read ? 'is-read' : 'is-unread'}" data-level="${esc(a.level || 'info')}" data-id="${esc(a.id)}">
        ${a.image ? `<img class="rshann-card-image" src="${esc(a.image)}" alt="${esc(a.title)}" loading="lazy">` : ''}
        <div class="rshann-card-top">
          <span class="rshann-dot" aria-hidden="true"></span>
          <h4 class="rshann-card-title">${esc(a.title)}</h4>
          <span class="rshann-card-state">${a.read ? 'Read' : 'New'}</span>
        </div>
        <p class="rshann-card-msg">${esc(a.message)}</p>
        <div class="rshann-card-foot">
          <span class="rshann-card-time">${esc(timeAgo(a.createdAt))}</span>
          ${a.link ? `<a class="rshann-card-link" href="${esc(a.link)}"${/^https?:\/\//i.test(a.link) ? ' target="_blank" rel="noopener"' : ''} data-read="${esc(a.id)}">${esc(a.linkLabel || 'Read more')}</a>` : ''}
          ${a.read ? '' : `<button type="button" class="rshann-card-btn" data-read="${esc(a.id)}">Mark as read</button>`}
        </div>
      </article>`).join('');
    host.querySelectorAll('[data-read]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.read;
        const isLink = el.classList.contains('rshann-card-link');
        setState(id, isLink ? { read: true, clicked: true } : { read: true });
        markLocal(id, { read: true });
      });
    });
  }

  async function paintBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    let unread = items.filter(a => !a.read).length;
    try {
      const all = await api('/api/user/notifications');
      unread = Number(all.count || unread);
    } catch (e) {}
    if (unread > 0) { badge.style.display = 'flex'; badge.textContent = unread > 9 ? '9+' : String(unread); }
    else badge.style.display = 'none';
  }

  async function load() {
    if (!T()) return;
    let d;
    try { d = await api('/api/announcements'); } catch (e) { return; }
    items = d.items || [];
    queue = items.filter(a => (d.popups || []).map(String).includes(String(a.id)));
    renderPage();
    paintBadge();
    if (!document.getElementById('rshAnnModal') || document.getElementById('rshAnnModal').hidden) next();
  }

  window.RSHAnnouncements = { reload: load, renderPage };

  const boot = () => setTimeout(load, 600);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
