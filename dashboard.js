// ===== AUTH GATE =====
let _session = null;

(async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        window.location.href = '/auth.html?redirect=/dashboard.html';
        return;
    }
    _session = session;
    loadReviews();
    loadSubscription();
})();

// ===== SIGN OUT =====
document.getElementById('signout-btn').addEventListener('click', async (e) => {
    e.preventDefault();
    await sb.auth.signOut();
    window.location.href = '/';
});

// ===== LOAD SUBSCRIPTION =====
async function loadSubscription() {
    const subInfoEl = document.getElementById('sub-info');
    if (!subInfoEl) return;

    try {
        const res = await fetch('/api/subscription', {
            headers: { 'Authorization': 'Bearer ' + _session.access_token }
        });
        const { subscription } = await res.json();

        if (subscription) {
            const nextBill = subscription.current_period_end
                ? new Date(subscription.current_period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : 'N/A';
            subInfoEl.innerHTML = `
                <div class="sub-card">
                    <div class="sub-plan">${subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1)} Plan</div>
                    <div class="sub-credits">${subscription.credits_remaining} reviews remaining</div>
                    <div class="sub-next">Next billing: ${nextBill}</div>
                    <button class="btn-outline" id="manage-sub-btn">Manage subscription</button>
                </div>
            `;
            document.getElementById('manage-sub-btn').addEventListener('click', async () => {
                const portalRes = await fetch('/api/customer-portal', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + _session.access_token, 'Content-Type': 'application/json' }
                });
                const { url } = await portalRes.json();
                if (url) window.location.href = url;
            });
        }
    } catch (e) {}
}

// ===== LOAD REVIEWS =====
async function loadReviews() {
    const subEl = document.getElementById('dash-sub');
    const listEl = document.getElementById('dash-list');
    const emptyEl = document.getElementById('dash-empty');

    try {
        const res = await fetch('/api/reviews', {
            headers: { 'Authorization': 'Bearer ' + _session.access_token }
        });
        const { reviews } = await res.json();

        if (!reviews || reviews.length === 0) {
            subEl.textContent = 'You haven\'t submitted anything yet.';
            emptyEl.classList.remove('hidden');
            return;
        }

        subEl.textContent = reviews.length + ' review' + (reviews.length === 1 ? '' : 's');

        listEl.innerHTML = reviews.map(r => {
            const date = new Date(r.created_at);
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const costStr = r.price === 0 ? 'Free' : '$' + r.price;
            return `
                <div class="dash-card" data-id="${r.id}">
                    <div class="dash-card-info">
                        <span class="dash-date">${dateStr}</span>
                        <span class="dash-tier">${r.tier}</span>
                        <span class="dash-words">${r.word_count.toLocaleString()} words</span>
                        <span class="dash-cost">${costStr}</span>
                    </div>
                    <button class="btn-outline dash-view-btn">View</button>
                </div>
            `;
        }).join('');

        // Click handlers — open branded report page
        listEl.querySelectorAll('.dash-card').forEach((card, i) => {
            card.querySelector('.dash-view-btn').addEventListener('click', () => {
                openReport(reviews[i]);
            });
        });

    } catch (err) {
        subEl.textContent = 'Failed to load reviews.';
    }
}

// ===== OPEN REPORT PAGE =====
function openReport(r) {
    sessionStorage.setItem('rm_review', r.review_markdown);
    sessionStorage.setItem('rm_meta', JSON.stringify({
        wordCount: r.word_count,
        tier: r.tier,
        stage: '',
        genre: '',
        pov: '',
        date: r.created_at
    }));
    window.location.href = '/report.html';
}
