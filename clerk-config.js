// Clerk auth — loads ClerkJS and exposes small helpers used across pages.
// Publishable keys are safe to expose in frontend code.
// Production key on the real domain, development key everywhere else (localhost, previews).
const CLERK_PUBLISHABLE_KEY = /(^|\.)ruthlessmentor\.com$/.test(location.hostname)
    ? 'pk_live_Y2xlcmsucnV0aGxlc3NtZW50b3IuY29tJA'
    : 'pk_test_YW11c2VkLWhhZ2Zpc2gtOTMuY2xlcmsuYWNjb3VudHMuZGV2JA';

window.clerkReady = new Promise((resolve, reject) => {
    // Frontend API domain is encoded in the publishable key
    const fapi = atob(CLERK_PUBLISHABLE_KEY.split('_')[2]).replace(/\$$/, '');
    const script = document.createElement('script');
    script.src = 'https://' + fapi + '/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-clerk-publishable-key', CLERK_PUBLISHABLE_KEY);
    script.onload = async () => {
        try {
            await window.Clerk.load();
            resolve(window.Clerk);
        } catch (e) { reject(e); }
    };
    script.onerror = () => reject(new Error('Failed to load Clerk'));
    document.head.appendChild(script);
});

// Returns { email } if signed in, otherwise null
async function authSession() {
    try {
        const clerk = await window.clerkReady;
        if (!clerk.user || !clerk.session) return null;
        return { email: clerk.user.primaryEmailAddress?.emailAddress || clerk.user.emailAddresses[0]?.emailAddress || '' };
    } catch (e) { return null; }
}

// Fresh short-lived API token — call per request, never cache
async function authToken() {
    try {
        const clerk = await window.clerkReady;
        if (!clerk.session) return null;
        return await clerk.session.getToken();
    } catch (e) { return null; }
}

// Authorization headers for fetch() — empty object if signed out
async function authHeaders() {
    const token = await authToken();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
}

async function authSignOut() {
    const clerk = await window.clerkReady;
    await clerk.signOut();
}

// Shared appearance for mounted Clerk components (matches site dark theme)
const CLERK_APPEARANCE = {
    variables: {
        colorPrimary: '#c9a96e',
        colorBackground: '#171310',
        colorText: '#f5efe6',
        colorTextSecondary: '#b5a795',
        colorInputBackground: '#211c17',
        colorInputText: '#f5efe6',
        colorDanger: '#e05c5c',
        borderRadius: '8px',
        fontFamily: "'Inter', sans-serif",
    },
    elements: {
        card: { boxShadow: 'none', border: '1px solid #2e2822' },
        footer: { display: 'none' },
    },
};
