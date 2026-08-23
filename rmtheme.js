/* Shared light/dark toggle for the rework previews.
   Runs before paint (the pages load it in <head>) so there's no flash of
   the wrong theme on load. */
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
