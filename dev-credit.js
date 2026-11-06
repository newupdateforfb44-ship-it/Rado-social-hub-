/* Site credits and owner contact strip */
(function () {
  'use strict';
  if (window.__rshDevCredit) return;
  window.__rshDevCredit = true;
  var OWNER_WHATSAPP = '#';
  function mount() {
    if (document.querySelector('.rsh-devbar')) return;
    var bar = document.createElement('div');
    bar.className = 'rsh-devbar';
    bar.innerHTML =
      '<div class="rsh-devbar-inner">' +
        '<div class="rsh-devbar-main">' +
          '<span class="rsh-devbar-dot" aria-hidden="true"></span>' +
          '<span class="rsh-devbar-txt">Designed and engineered by developer <strong>Rado</strong></span>' +
        '</div>' +
        '<div class="rsh-devbar-buy">' +
          'Want to buy this website? <a href="' + OWNER_WHATSAPP + '" target="_blank" rel="noopener noreferrer" class="rsh-devbar-cta">Contact the admin / owner on WhatsApp: +234 812 835 8120</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
