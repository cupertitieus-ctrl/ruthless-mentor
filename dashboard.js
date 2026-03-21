// ===== AUTH GATE =====
let _session = null;

(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        window.location.href = '/auth.html?redirect=/dashboard.html';
        return;
    }
    _session = session;
    loadReviews();
})();

// ===== SIGN OUT =====
document.getElementById('signout-btn').addEventListener('click', async (e) => {
    e.preventDefault();
    await supabase.auth.signOut();
    window.location.href = '/';
});

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

        // Click handlers
        listEl.querySelectorAll('.dash-card').forEach((card, i) => {
            card.querySelector('.dash-view-btn').addEventListener('click', () => {
                showReview(reviews[i]);
            });
        });

    } catch (err) {
        subEl.textContent = 'Failed to load reviews.';
    }
}

// ===== SHOW FULL REVIEW =====
function showReview(r) {
    const screen = document.getElementById('review-screen');
    const date = new Date(r.created_at);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const costStr = r.price === 0 ? 'Free' : '$' + r.price;

    document.getElementById('review-meta').textContent =
        `${r.tier} \u00B7 ${r.word_count.toLocaleString()} words \u00B7 ${costStr} \u00B7 ${dateStr}`;
    document.getElementById('review-body').innerHTML = markdownToHtml(r.review_markdown);
    screen.classList.remove('hidden');
    window.scrollTo(0, 0);
    window._lastReview = r.review_markdown;
}

document.getElementById('back-btn').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('review-screen').classList.add('hidden');
});

document.getElementById('copy-btn').addEventListener('click', () => {
    if (window._lastReview) {
        navigator.clipboard.writeText(window._lastReview);
        const btn = document.getElementById('copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy review', 1500);
    }
});

// ===== MARKDOWN TO HTML =====
function markdownToHtml(md) {
    return md
        .replace(/### (\d+)\. (.+)/g, '<h3><span class="review-num">$1.</span> $2</h3>')
        .replace(/### (.+)/g, '<h3>$1</h3>')
        .replace(/## (.+)/g, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/> (.+)/g, '<blockquote>$1</blockquote>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/^(?!<)(.*\S.*)$/gm, '<p>$1</p>')
        .replace(/<p><h/g, '<h')
        .replace(/<\/h[23]><\/p>/g, (m) => m.replace('<\/p>', ''))
        .replace(/<p><ul>/g, '<ul>')
        .replace(/<\/ul><\/p>/g, '</ul>')
        .replace(/<p><blockquote>/g, '<blockquote>')
        .replace(/<\/blockquote><\/p>/g, '</blockquote>');
}
