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
   One canonical top bar.

   The four preview pages had each hand-rolled their own nav, so the
   links and their order differed on every page. This rebuilds the
   centre links and the right-hand cluster from a single definition,
   marks the current page, and creates anything a page is missing
   (theme toggle, CTA) so the bar is identical everywhere.
   ------------------------------------------------------------------ */
(function () {
  var TOOLS = [
    {href:'/rmreview', name:'Manuscript Review', desc:'Full 8-part report &middot; 1 credit'},
    {href:'/rmeditor', name:'Advanced Editor',   desc:'Write with the notes beside you'},
    {href:'/rmrework#pricing', name:'Cover Check', desc:'Instant score, no account needed', free:true},
    {href:'/rmrework#pricing', name:'Description Maker', desc:'A ready-to-paste blurb from your book'}
  ];
  var LINKS = [
    {href:'/rmreview',        label:'New review'},
    {href:'/rmeditor',        label:'Editor'},
    {href:'/rmdash',          label:'Dashboard'},
    {href:'/rmrework#pricing',label:'Pricing'},
    {href:'/rmrework#story',  label:'About'}
  ];

  function build() {
    var nav = document.querySelector('nav');
    if (!nav) return;
    var mid = nav.querySelector('.nav-mid');
    var right = nav.querySelector('.nav-right');
    if (!mid || !right) return;

    var here = location.pathname.replace(/\/$/, '') || '/rmrework';

    /* ---- centre ---- */
    var tools = '<div class="dd" id="dd"><button aria-expanded="false" aria-haspopup="true">Tools' +
      '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">' +
      '<path d="M2 4l4 4 4-4"/></svg></button><div class="dd-panel">';
    TOOLS.forEach(function (t) {
      tools += '<a href="' + t.href + '"><span class="t">' + t.name +
        (t.free ? ' <i class="free-tag">FREE</i>' : '') + '</span>' +
        '<span class="d">' + t.desc + '</span></a>';
    });
    tools += '</div></div>';

    var links = '';
    LINKS.forEach(function (l) {
      var path = l.href.split('#')[0];
      // anchor links point back at the homepage, so they'd all match there —
      // only a whole-page link counts as the current page
      var on = (path === here && l.href.indexOf('#') === -1) ? ' class="on"' : '';
      links += '<a href="' + l.href + '"' + on + '>' + l.label + '</a>';
    });
    mid.innerHTML = tools + links;

    /* ---- right: theme, CTA, account, burger (burger added later) ---- */
    var toggle = right.querySelector('.theme-toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.className = 'theme-toggle';
      toggle.type = 'button';
      toggle.innerHTML =
        '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
        '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    }
    var cta = right.querySelector('.btn');
    if (!cta) {
      cta = document.createElement('a');
      cta.className = 'btn btn-primary btn-sm';
      cta.href = '/rmrework#pricing';
      cta.textContent = 'Get a plan';
    }
    var avatar = right.querySelector('.avatar');
    if (!avatar) {
      avatar = document.createElement('a');
      avatar.className = 'avatar';
      avatar.href = '/rmdash';
      avatar.title = 'Account';
      avatar.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    }
    right.appendChild(toggle);
    right.appendChild(cta);
    right.appendChild(avatar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
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
