/* Shared light/dark toggle for the rework previews.
   Runs before paint (the pages load it in <head>) so there's no flash of
   the wrong theme on load. */
/* Signals that JS is running, so the reveal animations may hide content.
   Without this class the fail-safe in rmtheme.css keeps everything visible. */
document.documentElement.classList.add('rm-anim');

/* Belt-and-braces reveal: runs alongside each page's IntersectionObserver
   and catches anything the observer misses (throttled tab, resize, a hash
   jump that lands mid-page). Idempotent — .in is only ever added. */
(function () {
  function revealInView() {
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var pending = document.querySelectorAll('.rv:not(.in)');
    for (var i = 0; i < pending.length; i++) {
      var r = pending[i].getBoundingClientRect();
      if (r.top < vh * 0.98 && r.bottom > 0) pending[i].classList.add('in');
    }
  }
  function start() {
    revealInView();
    window.addEventListener('scroll', revealInView, { passive: true });
    window.addEventListener('resize', revealInView);
    window.addEventListener('hashchange', function () { setTimeout(revealInView, 60); });
    document.addEventListener('visibilitychange', revealInView);
    window.addEventListener('load', revealInView);
    setTimeout(revealInView, 1200);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

(function () {
  var KEY = 'rm-theme';
  var root = document.documentElement;

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  // No stored choice: leave the attribute off so prefers-color-scheme decides.

  function current() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }
    var btn = document.querySelector('.theme-toggle');
    if (btn) btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  }

  function wire() {
    var btn = document.querySelector('.theme-toggle');
    if (!btn) return;
    btn.setAttribute('aria-label', current() === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    btn.addEventListener('click', function () {
      apply(current() === 'light' ? 'dark' : 'light');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // Expose for the pages' own scripts if they ever need it.
  window.rmTheme = { current: current, set: apply };
})();

/* ------------------------------------------------------------------
   Mobile navigation.

   Built here rather than in each page's markup so all three previews
   behave identically. Any static .nav-burger in the page is reused;
   pages without one get a burger created for them.
   ------------------------------------------------------------------ */
(function () {
  function build() {
    var nav = document.querySelector('nav');
    if (!nav) return;
    var mid = nav.querySelector('.nav-mid');
    var right = nav.querySelector('.nav-right');
    if (!mid || !right) return;

    // Reuse a burger the page already has, otherwise make one.
    var burger = nav.querySelector('.nav-burger');
    if (!burger) {
      burger = document.createElement('button');
      burger.className = 'nav-burger';
      burger.type = 'button';
      burger.innerHTML = '<span></span><span></span><span></span>';
    }
    burger.setAttribute('aria-label', 'Menu');
    burger.setAttribute('aria-expanded', 'false');
    // Sit inside .nav-right so it shares the grid's end track.
    right.appendChild(burger);

    // Panel mirrors the centre links, flattening the Tools dropdown.
    var panel = document.createElement('div');
    panel.className = 'mobile-panel';

    Array.prototype.forEach.call(mid.children, function (node) {
      if (node.classList.contains('dd')) {
        var sub = document.createElement('div');
        sub.className = 'mp-sub';
        sub.textContent = 'Tools';
        panel.appendChild(sub);
        Array.prototype.forEach.call(node.querySelectorAll('.dd-panel a'), function (a) {
          var link = document.createElement('a');
          link.href = a.getAttribute('href');
          // .t holds the tool name; .d is the description we don't need here
          var t = a.querySelector('.t');
          if (t) { link.innerHTML = t.innerHTML; } else { link.textContent = a.textContent.trim(); }
          panel.appendChild(link);
        });
      } else if (node.tagName === 'A') {
        var copy = document.createElement('a');
        copy.href = node.getAttribute('href');
        copy.textContent = node.textContent.trim();
        panel.appendChild(copy);
      }
    });

    // The bar's CTA is hidden on mobile, so give it a home in the panel.
    var cta = right.querySelector('.btn');
    if (cta) {
      var ctaLink = document.createElement('a');
      ctaLink.href = cta.getAttribute('href') || '#';
      ctaLink.className = 'mp-cta';
      ctaLink.textContent = cta.textContent.trim();
      panel.appendChild(ctaLink);
    }

    nav.appendChild(panel);

    function close() {
      panel.classList.remove('open');
      burger.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
    }
    function toggle(e) {
      e.stopPropagation();
      var open = panel.classList.toggle('open');
      burger.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    burger.addEventListener('click', toggle);
    panel.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') close(); else e.stopPropagation();
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', function () { if (window.innerWidth > 880) close(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
