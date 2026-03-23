// ===== TAB SWITCHING =====
const tabs = document.querySelectorAll('.auth-tab');
const signinForm = document.getElementById('signin-form');
const signupForm = document.getElementById('signup-form');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        hideMsg();
        if (tab.dataset.tab === 'signin') {
            signinForm.classList.remove('hidden');
            signupForm.classList.add('hidden');
        } else {
            signinForm.classList.add('hidden');
            signupForm.classList.remove('hidden');
        }
    });
});

// ===== MESSAGES =====
const msgEl = document.getElementById('auth-msg');

function showMsg(text, isError) {
    msgEl.textContent = text;
    msgEl.className = 'auth-msg' + (isError ? ' error' : ' success');
}

function hideMsg() {
    msgEl.className = 'auth-msg hidden';
}

// ===== REDIRECT =====
const params = new URLSearchParams(window.location.search);
const redirectTo = params.get('redirect') || '/dashboard.html';

// ===== CHECK IF ALREADY LOGGED IN =====
(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) window.location.href = redirectTo;
})();

// ===== SIGN IN WITH PASSWORD =====
signinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('si-email').value.trim();
    const password = document.getElementById('si-password').value;
    hideMsg();

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        showMsg(error.message, true);
    } else {
        window.location.href = redirectTo;
    }
});

// ===== SIGN UP WITH PASSWORD =====
signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('su-email').value.trim();
    const password = document.getElementById('su-password').value;
    hideMsg();

    if (!email || !password) { showMsg('Enter email and password.', true); return; }
    if (password.length < 6) { showMsg('Password must be at least 6 characters.', true); return; }

    try {
        const { data, error } = await supabase.auth.signUp({ email, password });
        console.log('[SIGNUP]', { data, error });

        if (error) {
            showMsg(error.message, true);
            return;
        }

        // If session exists, redirect immediately
        if (data.session) {
            window.location.href = redirectTo;
            return;
        }

        // If user exists but no session, try signing in immediately
        if (data.user) {
            const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
            if (signInError) {
                showMsg('Account created! Now sign in with your credentials.', false);
            } else {
                window.location.href = redirectTo;
            }
            return;
        }

        showMsg('Account created! Switch to Sign In and log in.', false);
    } catch (err) {
        console.error('[SIGNUP ERROR]', err);
        showMsg('Something went wrong. Try again.', true);
    }
});

// ===== MAGIC LINK =====
async function sendMagicLink(emailInputId) {
    const email = document.getElementById(emailInputId).value.trim();
    if (!email) { showMsg('Enter your email first.', true); return; }
    hideMsg();

    const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + redirectTo }
    });
    if (error) {
        showMsg(error.message, true);
    } else {
        showMsg('Magic link sent! Check your inbox.', false);
    }
}

document.getElementById('si-magic').addEventListener('click', () => sendMagicLink('si-email'));
document.getElementById('su-magic').addEventListener('click', () => sendMagicLink('su-email'));

// ===== LISTEN FOR AUTH STATE (magic link callback) =====
supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) {
        window.location.href = redirectTo;
    }
});
