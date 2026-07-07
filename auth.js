// ===== CLERK AUTH PAGE =====
const params = new URLSearchParams(window.location.search);
const redirectTo = params.get('redirect') || '/dashboard.html';
const isSignUp = params.get('tab') === 'signup';

(async () => {
    const mountEl = document.getElementById('clerk-auth');
    try {
        const clerk = await window.clerkReady;

        // Already signed in — go straight through
        if (clerk.user) {
            window.location.href = redirectTo;
            return;
        }

        const opts = {
            appearance: CLERK_APPEARANCE,
            forceRedirectUrl: redirectTo,
            signInForceRedirectUrl: redirectTo,
            signUpForceRedirectUrl: redirectTo,
            signInUrl: '/auth.html?redirect=' + encodeURIComponent(redirectTo),
            signUpUrl: '/auth.html?tab=signup&redirect=' + encodeURIComponent(redirectTo),
        };

        if (isSignUp) {
            document.querySelector('.auth-card h1').textContent = 'Create your account.';
            document.querySelector('.auth-sub').textContent = 'No password needed — we email you a code.';
            clerk.mountSignUp(mountEl, opts);
        } else {
            clerk.mountSignIn(mountEl, { ...opts, withSignUp: true });
        }
    } catch (e) {
        console.error('[AUTH] Clerk failed to load:', e);
        mountEl.innerHTML = '<p style="color:#e05c5c">Sign-in is temporarily unavailable. Please refresh the page.</p>';
    }
})();
