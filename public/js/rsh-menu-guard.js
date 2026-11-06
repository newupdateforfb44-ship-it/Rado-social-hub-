/* Rado Social Hub — menu guard: the hamburger drawer must never be open while a page loads/leaves */
(function () {
  'use strict';
  var de = document.documentElement;

  function closeMenuProperly() {
    // Use the real close button first so app-shell.js resets its own scroll-lock state.
    var closeBtn = document.querySelector('#rshDrawer .rsh-drawer-close');
    var drawer = document.getElementById('rshDrawer');
    if (closeBtn && drawer && drawer.classList.contains('open')) { try { closeBtn.click(); } catch (e) {} }
  }

  function reset() {
    closeMenuProperly();
    var d = document.getElementById('rshDrawer');
    var b = document.getElementById('rshMenuBackdrop');
    var t = document.getElementById('rshMenuTrigger');
    if (d) d.classList.remove('open');
    if (b) b.classList.remove('open');
    if (t) t.setAttribute('aria-expanded', 'false');
    if (document.body) {
      document.body.classList.remove('rsh-menu-open');
      var s = document.body.style;
      if (s.position === 'fixed') { s.position = ''; s.top = ''; s.left = ''; s.right = ''; s.width = ''; }
    }
    de.classList.remove('rsh-locked', 'rsh-leaving');
  }

  function ready() { requestAnimationFrame(function () { de.classList.add('rsh-ready'); }); }

  document.addEventListener('DOMContentLoaded', function () { reset(); setTimeout(ready, 60); });
  window.addEventListener('load', function () { reset(); ready(); });
  // Back/forward cache restore: page comes back exactly as it was left (possibly with the menu open).
  window.addEventListener('pageshow', function () { reset(); ready(); });
  window.addEventListener('pagehide', function () { de.classList.add('rsh-leaving'); });

  // Tapping a menu link: hide the drawer instantly (no slide) while the next page loads.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('#rshDrawer a[href]') : null;
    if (!a) return;
    de.classList.add('rsh-leaving');
    // If the link did not actually leave the page (same-page link, new tab), undo.
    setTimeout(function () { de.classList.remove('rsh-leaving'); }, 1800);
  }, true);
})();
