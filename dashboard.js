// ===== AUTH GATE =====
let _session = null;

(async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        window.location.href = '/auth.html?redirect=/dashboard.html';
        return;
    }
    _session = session;
    // Populate account menu
    const emailEl = document.getElementById('account-email');
    if (emailEl) emailEl.textContent = session.user.email;
    loadReviews();
    loadSubscription();
})();

// Account menu toggle
document.getElementById('account-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('account-dropdown');
    dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
});
document.addEventListener('click', (e) => {
    const dd = document.getElementById('account-dropdown');
    const btn = document.getElementById('account-menu-btn');
    if (dd && btn && !btn.contains(e.target) && !dd.contains(e.target)) {
        dd.style.display = 'none';
    }
});

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
            const total = subscription.credits_per_month || 10;
            const remaining = subscription.credits_remaining || 0;
            const used = total - remaining;
            const pct = total > 0 ? (remaining / total) * 100 : 0;
            // Populate account dropdown plan
            const planEl = document.getElementById('account-plan');
            if (planEl) planEl.textContent = subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1) + ' Plan · ' + remaining + ' left';
            subInfoEl.innerHTML = `
                <div class="sub-card" style="background: linear-gradient(135deg, #1a1816 0%, #0d0b09 100%); border: 1px solid #c9a96e; border-radius: 10px; padding: 24px 28px; margin-bottom: 32px;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap;">
                        <div style="flex: 1; min-width: 240px;">
                            <div style="color: #c9a96e; font-size: 1.15rem; font-weight: 700; margin-bottom: 4px;">${subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1)} Plan</div>
                            <div style="color: #999; font-size: 0.85rem;">Next billing: ${nextBill}</div>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px; align-items: stretch;">
                            <button class="btn-outline" id="manage-sub-btn" style="background: transparent; color: #c9a96e; border: 1px solid #c9a96e; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.85rem;">Manage subscription</button>
                            <a href="/review.html" style="background: #c9a96e; color: #0d0b09; padding: 10px 20px; border-radius: 6px; font-weight: 700; text-decoration: none; font-size: 0.85rem; display: inline-block; text-align: center;">+ Submit Review</a>
                        </div>
                    </div>
                    <div style="margin-top: 18px;">
                        <div style="display: flex; justify-content: space-between; color: #ccc; font-size: 0.9rem; margin-bottom: 8px;">
                            <span><strong style="color:#fff">${used}</strong> used</span>
                            <span><strong style="color:#c9a96e">${remaining}</strong> of ${total} reviews left</span>
                        </div>
                        <div style="background: #2a2622; border-radius: 999px; height: 10px; overflow: hidden;">
                            <div style="background: #c9a96e; height: 100%; width: ${pct}%; border-radius: 999px; transition: width 0.3s;"></div>
                        </div>
                    </div>
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
        } else {
            // No subscription — show subscribe prompt
            const promptEl = document.getElementById('subscribe-prompt');
            if (promptEl) {
                promptEl.style.display = 'flex';
                document.getElementById('subscribe-btn').addEventListener('click', async () => {
                    const btn = document.getElementById('subscribe-btn');
                    btn.textContent = 'Loading...';
                    btn.disabled = true;
                    try {
                        const subRes = await fetch('/api/subscribe', {
                            method: 'POST',
                            headers: {
                                'Authorization': 'Bearer ' + _session.access_token,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ plan: 'basic' })
                        });
                        const { url } = await subRes.json();
                        if (url) window.location.href = url;
                        else {
                            btn.textContent = 'Subscribe Now';
                            btn.disabled = false;
                            alert('Could not start subscription. Please try again.');
                        }
                    } catch (err) {
                        btn.textContent = 'Subscribe Now';
                        btn.disabled = false;
                        alert('Error starting subscription: ' + err.message);
                    }
                });
            }
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
