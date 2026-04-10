// ===== AUTH-AWARE NAV =====
(async () => {
    const { data: { session } } = await sb.auth.getSession();
    const signinEl = document.getElementById('nav-signin');
    const ctaOutEl = document.getElementById('nav-cta-out');
    const dashEl = document.getElementById('nav-dash');
    const ctaInEl = document.getElementById('nav-cta-in');
    const signoutEl = document.getElementById('nav-signout');
    const accountMenuEl = document.getElementById('nav-account-menu');
    const accountEmailEl = document.getElementById('account-email');
    const accountPlanEl = document.getElementById('account-plan');

    if (session) {
        // Logged in
        if (signinEl) signinEl.classList.add('hidden');
        if (ctaOutEl) ctaOutEl.classList.add('hidden');
        if (dashEl) dashEl.classList.add('hidden'); // hide separate dashboard link, it's in the menu now
        if (ctaInEl) ctaInEl.classList.remove('hidden');
        if (accountMenuEl) {
            accountMenuEl.classList.remove('hidden');
            accountMenuEl.style.display = 'inline-block';
        }
        if (accountEmailEl) accountEmailEl.textContent = session.user.email;

        // Fetch subscription info for plan display
        try {
            const subRes = await fetch('/api/subscription', {
                headers: { 'Authorization': 'Bearer ' + session.access_token }
            });
            const { subscription } = await subRes.json();
            if (subscription && accountPlanEl) {
                accountPlanEl.textContent = subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1) + ' Plan · ' + subscription.credits_remaining + ' left';
            } else if (accountPlanEl) {
                accountPlanEl.textContent = 'No active subscription';
            }
        } catch (e) {}
    }

    // Account menu toggle
    const accountBtn = document.getElementById('account-menu-btn');
    const accountDD = document.getElementById('account-dropdown');
    if (accountBtn) {
        accountBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            accountDD.style.display = accountDD.style.display === 'block' ? 'none' : 'block';
        });
        document.addEventListener('click', (e) => {
            if (!accountBtn.contains(e.target) && !accountDD.contains(e.target)) {
                accountDD.style.display = 'none';
            }
        });
    }

    if (signoutEl) {
        signoutEl.addEventListener('click', async (e) => {
            e.preventDefault();
            await sb.auth.signOut();
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

// ===== SAMPLE MODAL =====
const sampleBtn = document.getElementById('sample-btn');
const sampleModal = document.getElementById('sample-modal');
const sampleClose = document.getElementById('sample-close');

if (sampleBtn && sampleModal) {
    sampleBtn.addEventListener('click', () => sampleModal.classList.remove('hidden'));
    sampleClose.addEventListener('click', () => sampleModal.classList.add('hidden'));
    sampleModal.addEventListener('click', (e) => {
        if (e.target === sampleModal) sampleModal.classList.add('hidden');
    });
}
