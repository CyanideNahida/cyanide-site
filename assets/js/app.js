/* CYANIDE — 交互脚本 */
(function () {
  'use strict';

  var boot = document.getElementById('boot');
  var bar = document.getElementById('bar');
  var pct = document.getElementById('pct');
  var phase = document.getElementById('phase');
  var skip = document.getElementById('skip');
  var noBoot = /[?&]noload\b/.test(location.search);
  var pauseAt = (location.search.match(/[?&]pauseboot=(\d+)/) || [])[1];

  var steps = [
    ['Initializing', 6],
    ['Loading Assets', 38],
    ['Ready', 68],
    ['Launching', 91],
    ['Welcome', 100]
  ];

  var finished = false;

  function setBar(v) {
    if (pct) pct.textContent = v + '%';
    if (!bar) return;
    var edge = Math.max(0, Math.min(100, v));
    bar.style.background = 'linear-gradient(90deg, #4e9d80 0%, #7fe0b8 ' + edge +
      '%, rgba(255,255,255,.09) ' + edge + '%, rgba(255,255,255,.09) 100%)';
    bar.style.boxShadow = edge > 0 ? '0 0 14px rgba(127,224,184,.45)' : 'none';
  }

  function finish() {
    if (finished) return;
    finished = true;
    document.body.classList.remove('locked');
    if (!boot) return;
    boot.classList.add('done');
    window.setTimeout(function () {
      if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
    }, 1300);
  }

  if (noBoot) {
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
    document.body.classList.remove('locked');
  } else if (pauseAt) {
    /* 仅用于截静态图：?pauseboot=55 */
    var v = Math.max(0, Math.min(100, parseInt(pauseAt, 10) || 0));
    setBar(v);
    if (phase) phase.textContent = steps[Math.min(steps.length - 1, Math.floor(v / 22))][0];
  } else if (boot) {
    document.body.classList.add('locked');
    var i = 0;
    (function step() {
      if (finished) return;
      var s = steps[i];
      setBar(s[1]);
      if (phase) phase.textContent = s[0];
      i++;
      if (i < steps.length) {
        window.setTimeout(step, 460 + Math.random() * 190);
      } else {
        window.setTimeout(finish, 420);
      }
    })();

    if (skip) skip.addEventListener('click', finish);
    boot.addEventListener('click', function (e) {
      if (e.target === boot) finish();
    });
    document.addEventListener('keydown', finish, { once: true });
    /* 兜底：3 秒后无论如何放行 */
    window.setTimeout(finish, 3200);
  }

  /* 滚动进场 */
  var items = document.querySelectorAll('.post, .card, .list-note');
  if ('IntersectionObserver' in window && items.length) {
    items.forEach(function (el) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(18px)';
      el.style.transition = 'opacity .7s cubic-bezier(.2,.7,.2,1), transform .7s cubic-bezier(.2,.7,.2,1)';
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.style.opacity = '1';
          en.target.style.transform = 'none';
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }
})();
