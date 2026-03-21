// ===== AUTH-AWARE NAV =====
(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const signinEl = document.getElementById('nav-signin');
    const ctaOutEl = document.getElementById('nav-cta-out');
    const dashEl = document.getElementById('nav-dash');
    const ctaInEl = document.getElementById('nav-cta-in');
    const signoutEl = document.getElementById('nav-signout');

    if (session) {
        // Logged in
        if (signinEl) signinEl.classList.add('hidden');
        if (ctaOutEl) ctaOutEl.classList.add('hidden');
        if (dashEl) dashEl.classList.remove('hidden');
        if (ctaInEl) ctaInEl.classList.remove('hidden');
        if (signoutEl) signoutEl.classList.remove('hidden');
    }

    if (signoutEl) {
        signoutEl.addEventListener('click', async (e) => {
            e.preventDefault();
            await supabase.auth.signOut();
            window.location.reload();
        });
    }
})();

// ===== SCROLL ANIMATIONS =====
const animEls = document.querySelectorAll('.anim-fade,.anim-slide-up,.anim-scale');
const animObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
        if (e.isIntersecting) {
            e.target.classList.add('visible');
            if (e.target.querySelector('.tag-pill.pop')) {
                e.target.querySelectorAll('.tag-pill.pop').forEach(t => t.classList.add('animate'));
            }
            animObs.unobserve(e.target);
        }
    });
}, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
animEls.forEach(el => animObs.observe(el));

// ===== MOBILE NAV =====
const toggle = document.getElementById('mobile-toggle');
const navLinks = document.getElementById('nav-links');
if (toggle) {
    toggle.addEventListener('click', () => {
        toggle.classList.toggle('active');
        navLinks.classList.toggle('open');
    });
    navLinks.querySelectorAll('a').forEach(a =>
        a.addEventListener('click', () => {
            toggle.classList.remove('active');
            navLinks.classList.remove('open');
        })
    );
}
