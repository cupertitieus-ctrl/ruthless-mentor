// ===== AUTH CHECK =====
let _session = null;
let _subscription = null;

(async () => {
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (session) {
            _session = session;
            // Check for subscription credits
            try {
                const subRes = await fetch('/api/subscription', {
                    headers: { 'Authorization': 'Bearer ' + session.access_token }
                });
                const subData = await subRes.json();
                if (subData.subscription && subData.subscription.credits_remaining > 0) {
                    _subscription = subData.subscription;
                    // Show credit badge
                    const creditBadge = document.getElementById('credit-badge');
                    if (creditBadge) {
                        creditBadge.textContent = `${_subscription.credits_remaining} credits remaining`;
                        creditBadge.classList.remove('hidden');
                    }
                }
            } catch (e) {}
        }
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

    // Use genre-selected price if available, otherwise fall back to word count tier
    const genreVal = genreSelect ? genreSelect.value : '';
    const genreInfo = GENRE_PRICES[genreVal];
    const tier = words > 0 ? getTier(words) : null;

    let basePrice = genreInfo ? genreInfo.price : (tier ? tier.price : 0);
    let tierName = genreInfo ? genreInfo.name : (tier ? tier.name : '--');
    let total = basePrice;

    if (appliedCoupon && total > 0) {
        if (appliedCoupon.type === 'percent') total = Math.max(0, total - (total * appliedCoupon.discount / 100));
        else if (appliedCoupon.type === 'fixed') total = Math.max(0, total - appliedCoupon.discount);
        else if (appliedCoupon.type === 'fixed_price') total = appliedCoupon.discount;
        else if (appliedCoupon.type === 'free') total = 0;
    }

    if (estTierEl) estTierEl.textContent = words === 0 && !genreInfo ? '--' : tierName;
    if (estCostEl) estCostEl.textContent = basePrice === 0 ? '--' : '$' + basePrice;
    if (totalEl) totalEl.textContent = basePrice === 0 ? '--' : (total === 0 ? 'FREE' : '$' + total.toFixed(0));
}

if (textarea) textarea.addEventListener('input', updateCost);

// ===== GENRE → SIDEBAR PRICE =====
const GENRE_PRICES = {
    'picture-book': { name: 'Picture Book', price: 15 },
    'early-reader': { name: 'Early Reader', price: 15 },
    'chapter-book': { name: 'Chapter Book', price: 15 },
    'middle-grade': { name: 'Middle Grade / Young Adult', price: 20 },
    'young-adult': { name: 'Middle Grade / Young Adult', price: 20 },
    'literary-fiction': { name: 'Adult', price: 25 },
    'genre-fiction': { name: 'Adult', price: 25 },
    'memoir': { name: 'Adult', price: 25 },
    'screenplay': { name: 'Screenplay', price: 25 },
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

// ===== GENRE-CONDITIONAL FIELDS =====
const bookNumberGroup = document.getElementById('book-number-group');
const povGroup = document.getElementById('pov-group');
const rhymingGroup = document.getElementById('rhyming-group');
const fictionGroup = document.getElementById('fiction-group');

function toggleGenreFields() {
    const val = genreSelect ? genreSelect.value : '';
    const isScreenplay = val === 'screenplay';
    const isPictureBook = val === 'picture-book';
    if (bookNumberGroup) bookNumberGroup.style.display = isScreenplay ? 'none' : '';
    if (povGroup) povGroup.style.display = isScreenplay ? 'none' : '';
    if (rhymingGroup) rhymingGroup.style.display = isPictureBook ? '' : 'none';
    if (fictionGroup) fictionGroup.style.display = '';
}

if (genreSelect) genreSelect.addEventListener('change', toggleGenreFields);

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

// ===== CHECK IF RETURNING FROM STRIPE =====
(async () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('paid') === 'true' && params.get('session_id')) {
        // Show thank you overlay immediately
        const tyOverlay = document.getElementById('thankyou-overlay');
        const tyFill = document.getElementById('thankyou-fill');
        const tyText = document.getElementById('thankyou-text');
        if (tyOverlay) tyOverlay.classList.remove('hidden');

        // Animate progress while waiting
        const tySteps = [
            'Verifying your payment...',
            'Payment confirmed! Thank you.',
            'Loading your manuscript...',
            'Reading through every page...',
            'Getting into the story...',
            'Evaluating the writing voice...',
            'Scanning for overused words...',
            'Checking the prose quality...',
            'Looking at your descriptions...',
            'Reviewing the characters...',
            'Checking the pacing and structure...',
            'Evaluating the dialogue...',
            'Looking for story issues...',
            'Pulling specific passages...',
            'Writing detailed notes...',
            'Finding what works well...',
            'Putting the report together...',
            'Writing the final verdict...',
            'Polishing the report...',
            'Adding the finishing touches...',
            'Almost there...',
            'Just a few more seconds...',
        ];
        // Force bar styling inline (CSS vars may not resolve in overlay)
        if (tyFill) {
            tyFill.style.background = '#c9a96e';
            tyFill.style.height = '100%';
            tyFill.style.borderRadius = '4px';
            tyFill.style.transition = 'width 0.5s ease';
            tyFill.style.width = '3%';
        }
        if (tyText) tyText.textContent = tySteps[0];
        let tyStep = 1;
        const tyInterval = setInterval(() => {
            if (tyStep < tySteps.length) {
                const pct = Math.min(95, Math.round((tyStep / tySteps.length) * 100));
                if (tyFill) tyFill.style.width = pct + '%';
                if (tyText) tyText.textContent = tySteps[tyStep];
                tyStep++;
            }
        }, 2500);

        try {
            const verifyRes = await fetch('/api/verify-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: params.get('session_id') })
            });
            const verifyData = await verifyRes.json();
            if (verifyData.paid) {
                window.history.replaceState({}, '', '/review.html');
                clearInterval(tyInterval);

                if (verifyData.autoReview && verifyData.review) {
                    if (tyFill) tyFill.style.width = '100%';
                    if (tyText) tyText.textContent = 'Your review is ready! Opening now...';
                    await new Promise(r => setTimeout(r, 1500));
                    // Server already ran the review — go straight to report
                    const meta = verifyData.metadata || {};
                    sessionStorage.setItem('rm_review', verifyData.review);
                    sessionStorage.setItem('rm_meta', JSON.stringify({
                        wordCount: verifyData.wordCount,
                        tier: verifyData.tier,
                        title: meta.title || '',
                        stage: meta.stage || '',
                        genre: meta.genre || '',
                        pov: meta.pov || '',
                        bookNumber: meta.bookNumber || ''
                    }));
                    sessionStorage.removeItem('rm_pending_text');
                    sessionStorage.removeItem('rm_pending_info');
                    window.location.href = '/report.html';
                    return;
                }

                if (verifyData.alreadyProcessed) {
                    alert('This review has already been processed. Check your dashboard for past reviews.');
                    return;
                }

                // Fallback: try sessionStorage
                const savedText = sessionStorage.getItem('rm_pending_text');
                const savedInfo = JSON.parse(sessionStorage.getItem('rm_pending_info') || '{}');
                if (savedText && textarea) {
                    textarea.value = savedText;
                    updateCost();
                    setTimeout(() => runReview(savedText, savedInfo), 500);
                } else {
                    alert('Payment confirmed! Thank you.\n\nPlease paste your text again and click Submit. You won\'t be charged again.');
                }
            }
        } catch (e) {
            console.error('[VERIFY ERROR]', e);
        }
    }
    if (params.get('cancelled') === 'true') {
        // Restore text from sessionStorage
        const savedText = sessionStorage.getItem('rm_pending_text');
        const savedInfo = JSON.parse(sessionStorage.getItem('rm_pending_info') || '{}');
        if (savedText && textarea) {
            textarea.value = savedText;
            if (savedInfo.title) { const t = document.getElementById('q-title'); if (t) t.value = savedInfo.title; }
            if (savedInfo.stage) { const s = document.getElementById('q-stage'); if (s) s.value = savedInfo.stage; }
            if (savedInfo.genre) { const g = document.getElementById('q-genre'); if (g) { g.value = savedInfo.genre; updateSidebarPrice(); } }
            if (savedInfo.pov) { const p = document.getElementById('q-pov'); if (p) p.value = savedInfo.pov; }
            if (savedInfo.bookNumber) { const b = document.getElementById('q-book-number'); if (b) b.value = savedInfo.bookNumber; }
            if (savedInfo.rhyming) { const r = document.getElementById('q-rhyming'); if (r) r.value = savedInfo.rhyming; }
            if (savedInfo.fiction) { const f = document.getElementById('q-fiction'); if (f) f.value = savedInfo.fiction; }
            toggleGenreFields();
            updateCost();
        }
        window.history.replaceState({}, '', '/review.html');
        alert('Payment was cancelled. Your text is still here — submit when ready.');
    }
})();

// ===== SUBMIT — payment then review =====
async function runReview(text, manuscriptInfo) {
    const btn = document.getElementById('submit-btn');
    const progressWrap = document.getElementById('progress-wrap');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');

    // Show thank you overlay for ALL reviews (free and paid)
    const tyOverlay = document.getElementById('thankyou-overlay');
    const tyFill = document.getElementById('thankyou-fill');
    const tyText = document.getElementById('thankyou-text');
    if (tyOverlay) tyOverlay.classList.remove('hidden');

    btn.disabled = true;
    btn.style.opacity = '.6';
    btn.textContent = 'Reviewing...';
    progressWrap.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });

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

    // Force thank you bar styling
    if (tyFill) {
        tyFill.style.background = '#c9a96e';
        tyFill.style.height = '100%';
        tyFill.style.borderRadius = '4px';
        tyFill.style.transition = 'width 0.5s ease';
        tyFill.style.width = '3%';
    }
    if (tyText) tyText.textContent = steps[0].text;

    let stepIdx = 0;
    const stepInterval = setInterval(() => {
        if (stepIdx < steps.length) {
            progressFill.style.width = steps[stepIdx].pct + '%';
            progressText.textContent = steps[stepIdx].text;
            progressText.className = 'progress-text pulsing';
            // Sync thank you overlay
            if (tyFill) tyFill.style.width = steps[stepIdx].pct + '%';
            if (tyText) tyText.textContent = steps[stepIdx].text;
            stepIdx++;
        }
    }, 3500);

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (_session) headers['Authorization'] = 'Bearer ' + _session.access_token;

        const pendingEmail = sessionStorage.getItem('rm_pending_email') || '';
        const reviewRes = await fetch('/api/review', { method: 'POST', headers, body: JSON.stringify({ text, manuscriptInfo, email: pendingEmail }) });
        const reviewText = await reviewRes.text();
        let reviewData;
        try { reviewData = JSON.parse(reviewText); } catch (e) {
            throw new Error('Server is updating. Please wait 30 seconds and try again.');
        }
        if (!reviewRes.ok) throw new Error(reviewData.error || 'Review failed');

        clearInterval(stepInterval);
        progressFill.style.width = '100%';
        progressText.textContent = 'Opening your report...';
        if (tyFill) tyFill.style.width = '100%';
        if (tyText) tyText.textContent = 'Your review is ready! Opening now...';

        sessionStorage.setItem('rm_review', reviewData.review);
        sessionStorage.setItem('rm_meta', JSON.stringify({
            wordCount: reviewData.wordCount,
            tier: reviewData.tier,
            title: manuscriptInfo.title,
            stage: manuscriptInfo.stage,
            genre: manuscriptInfo.genre,
            pov: manuscriptInfo.pov,
            bookNumber: manuscriptInfo.bookNumber
        }));

        // Clean up pending data
        sessionStorage.removeItem('rm_pending_text');
        sessionStorage.removeItem('rm_pending_info');

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
}

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

        const wc = countWords(text);
        if (wc > 150000) {
            alert(`Your manuscript is ${wc.toLocaleString()} words. We currently support up to 150,000 words per submission. For longer works, try submitting in two halves.`);
            return;
        }

        const email = document.getElementById('q-email') ? document.getElementById('q-email').value.trim() : '';
        if (!email) { alert('Please enter your email so we can send you the review.'); return; }

        const title = document.getElementById('q-title') ? document.getElementById('q-title').value.trim() : '';
        const stage = document.getElementById('q-stage') ? document.getElementById('q-stage').value : '';
        const genre = document.getElementById('q-genre') ? document.getElementById('q-genre').value : '';
        const pov = document.getElementById('q-pov') ? document.getElementById('q-pov').value : '';
        const bookNumber = document.getElementById('q-book-number') ? document.getElementById('q-book-number').value : '';
        const rhyming = document.getElementById('q-rhyming') ? document.getElementById('q-rhyming').value : '';
        const fiction = document.getElementById('q-fiction') ? document.getElementById('q-fiction').value : '';
        const manuscriptInfo = { title, stage, genre, pov, bookNumber, rhyming, fiction };

        // Save text and email to sessionStorage before redirecting to Stripe
        sessionStorage.setItem('rm_pending_text', text);
        sessionStorage.setItem('rm_pending_info', JSON.stringify(manuscriptInfo));
        sessionStorage.setItem('rm_pending_email', email);

        const btn = document.getElementById('submit-btn');
        btn.disabled = true;
        btn.style.opacity = '.6';
        btn.textContent = 'Setting up payment...';

        // Check if coupon makes it free
        const genreVal = genreSelect ? genreSelect.value : '';
        const genreInfo = GENRE_PRICES[genreVal];
        let finalPrice = genreInfo ? genreInfo.price : 5;

        if (appliedCoupon) {
            if (appliedCoupon.type === 'free') finalPrice = 0;
            else if (appliedCoupon.type === 'percent') finalPrice = Math.max(0, finalPrice - (finalPrice * appliedCoupon.discount / 100));
            else if (appliedCoupon.type === 'fixed') finalPrice = Math.max(0, finalPrice - appliedCoupon.discount);
            else if (appliedCoupon.type === 'fixed_price') finalPrice = appliedCoupon.discount;
        }

        // Use subscription credit if available
        if (_subscription && _subscription.credits_remaining > 0) {
            btn.textContent = 'Using 1 credit...';
            runReview(text, manuscriptInfo);
            // Update local credit count
            _subscription.credits_remaining--;
            const creditBadge = document.getElementById('credit-badge');
            if (creditBadge) creditBadge.textContent = `${_subscription.credits_remaining} credits remaining`;
            return;
        }

        if (finalPrice <= 0) {
            // Free — skip payment, go straight to review
            runReview(text, manuscriptInfo);
            return;
        }

        // Redirect to Stripe Checkout
        try {
            const res = await fetch('/api/create-checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ genre: genreVal, manuscriptInfo, couponCode: appliedCoupon ? couponInput.value.trim() : null, text, email })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Payment setup failed');
            window.location.href = data.url;
        } catch (err) {
            alert('Error: ' + err.message);
            btn.textContent = 'Submit for review';
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    });
}

// Old done screen / email / download code removed — report.html handles everything now
