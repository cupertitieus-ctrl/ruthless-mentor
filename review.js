// ===== AUTH CHECK (silent — no gate) =====
let _session = null;

(async () => {
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (session) _session = session;
    } catch (e) {}
    updateCost();
})();

// ===== ANIMATIONS =====
document.querySelectorAll('.anim-fade,.anim-slide-up,.anim-scale').forEach(el => {
    new IntersectionObserver((entries, obs) => {
        entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); } });
    }, { threshold: 0.1 }).observe(el);
});

// ===== PRICING =====
function getTier(words) {
    if (words <= 5000) return { name: "Children's / Picture Book", price: 5 };
    if (words <= 25000) return { name: 'Chapter Book', price: 10 };
    if (words <= 100000) return { name: 'Middle Grade / Young Adult', price: 15 };
    return { name: 'Adult', price: 20 };
}

function countWords(text) {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
}

// ===== FORM =====
const textarea = document.getElementById('co-text');
const wordCountEl = document.getElementById('word-count');
const estTierEl = document.getElementById('est-tier');
const estCostEl = document.getElementById('est-cost');
const totalEl = document.getElementById('total-amount');
const form = document.getElementById('checkout-form');

let appliedCoupon = null;

function updateCost() {
    const words = countWords(textarea ? textarea.value : '');
    if (wordCountEl) wordCountEl.textContent = words.toLocaleString();

    const tier = words > 0 ? getTier(words) : null;
    let total = tier ? tier.price : 0;

    if (appliedCoupon && total > 0) {
        if (appliedCoupon.type === 'percent') total = Math.max(0, total - (total * appliedCoupon.discount / 100));
        else if (appliedCoupon.type === 'fixed') total = Math.max(0, total - appliedCoupon.discount);
        else if (appliedCoupon.type === 'free') total = 0;
    }

    if (estTierEl) estTierEl.textContent = words === 0 ? '--' : tier.name;
    if (estCostEl) estCostEl.textContent = words === 0 ? '--' : '$' + tier.price;
    if (totalEl) totalEl.textContent = words === 0 ? '--' : (total === 0 ? 'FREE' : '$' + total.toFixed(0));

    document.querySelectorAll('.sidebar-tier').forEach(el => el.classList.remove('active'));
    if (tier) {
        const tiers = document.querySelectorAll('.sidebar-tier');
        const idx = { "Children's / Picture Book": 0, 'Chapter Book': 1, 'Middle Grade': 2, "Young Adult / Adult": 3 }[tier.name];
        if (tiers[idx]) tiers[idx].classList.add('active');
    }
}

if (textarea) textarea.addEventListener('input', updateCost);

// ===== GENRE → SIDEBAR PRICE =====
const GENRE_PRICES = {
    'picture-book': { name: 'Picture Book', price: 5 },
    'early-reader': { name: 'Early Reader', price: 5 },
    'chapter-book': { name: 'Chapter Book', price: 10 },
    'middle-grade': { name: 'Middle Grade / Young Adult', price: 15 },
    'young-adult': { name: 'Middle Grade / Young Adult', price: 15 },
    'literary-fiction': { name: 'Adult', price: 20 },
    'genre-fiction': { name: 'Adult', price: 20 },
    'memoir': { name: 'Adult', price: 20 },
};

const genreSelect = document.getElementById('q-genre');
const sidebarGenreName = document.getElementById('sidebar-genre-name');
const sidebarPriceAmount = document.getElementById('sidebar-price-amount');

function updateSidebarPrice() {
    const val = genreSelect ? genreSelect.value : '';
    const info = GENRE_PRICES[val];
    if (info && sidebarGenreName && sidebarPriceAmount) {
        sidebarGenreName.textContent = info.name;
        sidebarPriceAmount.textContent = '$' + info.price;
    } else if (sidebarGenreName && sidebarPriceAmount) {
        sidebarGenreName.textContent = 'Select a genre';
        sidebarPriceAmount.textContent = '--';
    }
}

if (genreSelect) genreSelect.addEventListener('change', updateSidebarPrice);

// ===== COUPON =====
const couponBtn = document.getElementById('apply-coupon');
const couponInput = document.getElementById('coupon-input');
const couponMsg = document.getElementById('coupon-msg');

if (couponBtn) {
    couponBtn.addEventListener('click', async () => {
        const code = couponInput.value.trim();
        if (!code) return;
        try {
            const res = await fetch('/api/coupon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            appliedCoupon = data;
            couponMsg.textContent = data.message;
            couponMsg.className = 'coupon-msg success';
            couponInput.disabled = true;
            couponBtn.textContent = 'Applied';
            couponBtn.disabled = true;
            updateCost();
        } catch (err) {
            appliedCoupon = null;
            couponMsg.textContent = err.message || 'Invalid coupon';
            couponMsg.className = 'coupon-msg error';
        }
    });
}

// File upload removed — paste only

// ===== SUBMIT — generates review + opens report page =====
if (form) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const disclaimerCb = document.getElementById('disclaimer-cb');
        if (disclaimerCb && !disclaimerCb.checked) {
            alert('Please check the content review disclaimer before submitting.');
            return;
        }

        const text = textarea.value.trim();
        if (!text) { alert('Paste your text or upload a file first.'); return; }

        // Collect manuscript info
        const stage = document.getElementById('q-stage') ? document.getElementById('q-stage').value : '';
        const genre = document.getElementById('q-genre') ? document.getElementById('q-genre').value : '';
        const pov = document.getElementById('q-pov') ? document.getElementById('q-pov').value : '';
        const manuscriptInfo = { stage, genre, pov };

        const btn = document.getElementById('submit-btn');
        const progressWrap = document.getElementById('progress-wrap');
        const progressFill = document.getElementById('progress-fill');
        const progressText = document.getElementById('progress-text');

        btn.disabled = true;
        btn.style.opacity = '.6';
        btn.textContent = 'Reviewing...';
        progressWrap.classList.remove('hidden');
        progressFill.style.width = '0%';

        const steps = [
            { pct: 5, text: 'Uploading your work...' },
            { pct: 10, text: 'Reading through every page...' },
            { pct: 16, text: 'Getting into the story...' },
            { pct: 22, text: 'Evaluating the writing voice...' },
            { pct: 28, text: 'Scanning for overused words...' },
            { pct: 34, text: 'Checking the prose...' },
            { pct: 40, text: 'Looking at your descriptions...' },
            { pct: 46, text: 'Reviewing the characters...' },
            { pct: 52, text: 'Checking the pacing...' },
            { pct: 58, text: 'Evaluating the dialogue...' },
            { pct: 63, text: 'Looking for story issues...' },
            { pct: 68, text: 'Pulling specific passages...' },
            { pct: 73, text: 'Writing detailed notes...' },
            { pct: 78, text: 'Finding what works well...' },
            { pct: 83, text: 'Putting the report together...' },
            { pct: 87, text: 'Writing the final verdict...' },
            { pct: 91, text: 'Polishing the report...' },
            { pct: 94, text: 'Adding the finishing touches...' },
            { pct: 96, text: 'Almost there...' },
            { pct: 98, text: 'Just a few more seconds...' },
        ];

        let stepIdx = 0;
        const stepInterval = setInterval(() => {
            if (stepIdx < steps.length) {
                progressFill.style.width = steps[stepIdx].pct + '%';
                progressText.textContent = steps[stepIdx].text;
                progressText.className = 'progress-text pulsing';
                stepIdx++;
            }
        }, 3500);

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (_session) headers['Authorization'] = 'Bearer ' + _session.access_token;

            const reviewRes = await fetch('/api/review', { method: 'POST', headers, body: JSON.stringify({ text, manuscriptInfo }) });
            const reviewText = await reviewRes.text();
            let reviewData;
            try { reviewData = JSON.parse(reviewText); } catch (e) {
                throw new Error('Server is updating. Please wait 30 seconds and try again.');
            }
            if (!reviewRes.ok) throw new Error(reviewData.error || 'Review failed');

            clearInterval(stepInterval);
            progressFill.style.width = '100%';
            progressText.textContent = 'Opening your report...';

            // Store review in sessionStorage and redirect to report page
            sessionStorage.setItem('rm_review', reviewData.review);
            sessionStorage.setItem('rm_meta', JSON.stringify({
                wordCount: reviewData.wordCount,
                tier: reviewData.tier,
                stage: manuscriptInfo.stage,
                genre: manuscriptInfo.genre,
                pov: manuscriptInfo.pov
            }));

            window.location.href = '/report.html';

        } catch (err) {
            clearInterval(stepInterval);
            progressText.textContent = 'Error: ' + err.message;
            progressText.className = 'progress-text';
            alert('Error: ' + err.message);
            btn.textContent = 'Submit for review';
            btn.disabled = false;
            btn.style.opacity = '1';
            setTimeout(() => progressWrap.classList.add('hidden'), 3000);
        }
    });
}

// Old done screen / email / download code removed — report.html handles everything now
