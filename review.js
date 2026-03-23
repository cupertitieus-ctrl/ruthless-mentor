// ===== AUTH CHECK =====
let _session = null;
const authGate = document.getElementById('auth-gate');
const reviewPage = document.querySelector('.review-page');

(async () => {
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (session) {
            _session = session;
            authGate.classList.add('hidden');
        } else {
            authGate.classList.remove('hidden');
        }
    } catch (e) {
        authGate.classList.remove('hidden');
    }
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
    if (words <= 50000) return { name: 'Middle Grade', price: 15 };
    return { name: 'Young Adult / Adult', price: 15 };
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

// ===== FILE DROP =====
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileNameEl = document.getElementById('file-name');

if (dropZone) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleFile(fileInput.files[0]);
    });
}

async function handleFile(file) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!['.pdf', '.docx', '.txt'].includes(ext)) {
        fileNameEl.textContent = 'Unsupported format. Use PDF, DOCX, or TXT.';
        fileNameEl.style.color = '#ef4444';
        return;
    }
    fileNameEl.style.color = '';
    fileNameEl.textContent = file.name + ' — extracting text...';

    if (ext === '.txt') {
        const reader = new FileReader();
        reader.onload = (e) => {
            textarea.value = e.target.result;
            fileNameEl.textContent = file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)';
            updateCost();
        };
        reader.readAsText(file);
    } else {
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch('/api/parse-file', { method: 'POST', body: formData });
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch (e) {
                throw new Error('Server error. Try pasting your text instead.');
            }
            if (!res.ok) throw new Error(data.error || 'Parse failed');
            textarea.value = data.text;
            fileNameEl.textContent = file.name + ' (' + data.wordCount.toLocaleString() + ' words extracted)';
            updateCost();
        } catch (err) {
            fileNameEl.textContent = err.message;
            fileNameEl.style.color = '#ef4444';
        }
    }
}

// ===== SUBMIT — generates review + auto-downloads PDF =====
let _lastPdfBlob = null;

if (form) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Require auth
        if (!_session) {
            authGate.classList.remove('hidden');
            return;
        }

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
            { pct: 10, text: 'Uploading your work...' },
            { pct: 25, text: 'Reading through it...' },
            { pct: 40, text: 'Checking prose quality...' },
            { pct: 55, text: 'Counting repeat words...' },
            { pct: 65, text: 'Grading characters...' },
            { pct: 75, text: 'Evaluating story mechanics...' },
            { pct: 85, text: 'Writing line-level notes...' },
            { pct: 92, text: 'Preparing your verdict...' },
        ];

        let stepIdx = 0;
        const stepInterval = setInterval(() => {
            if (stepIdx < steps.length) {
                progressFill.style.width = steps[stepIdx].pct + '%';
                progressText.textContent = steps[stepIdx].text;
                progressText.className = 'progress-text pulsing';
                stepIdx++;
            }
        }, 3000);

        try {
            const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _session.access_token };

            // Step 1: Get the text review
            const reviewRes = await fetch('/api/review', { method: 'POST', headers, body: JSON.stringify({ text, manuscriptInfo }) });
            const reviewData = await reviewRes.json();
            if (!reviewRes.ok) throw new Error(reviewData.error || 'Review failed');

            progressFill.style.width = '95%';
            progressText.textContent = 'Generating your PDF...';

            // Step 2: Generate PDF from the review
            const pdfRes = await fetch('/api/generate-pdf', {
                method: 'POST', headers,
                body: JSON.stringify({
                    reviewMarkdown: reviewData.review,
                    wordCount: reviewData.wordCount,
                    tier: reviewData.tier
                })
            });

            if (!pdfRes.ok) {
                const err = await pdfRes.json().catch(() => ({ error: 'PDF failed' }));
                throw new Error(err.error || 'PDF generation failed');
            }

            // Auto-download PDF
            _lastPdfBlob = await pdfRes.blob();
            downloadBlob(_lastPdfBlob, 'ruthless-mentor-review.pdf');

            clearInterval(stepInterval);
            progressFill.style.width = '100%';
            progressText.textContent = 'Done!';
            progressText.className = 'progress-text';

            // Show done screen
            const wordCount = reviewData.wordCount;
            const tier = reviewData.tier;
            document.getElementById('done-meta').textContent = `${tier} \u00B7 ${wordCount.toLocaleString()} words`;
            document.getElementById('done-screen').classList.remove('hidden');
            window.scrollTo(0, 0);

            // Save for re-download and email
            window._lastSubmittedText = text;
            window._lastReview = reviewData.review;
            window._lastWordCount = wordCount;
            window._lastTier = tier;

        } catch (err) {
            clearInterval(stepInterval);
            progressText.textContent = 'Error: ' + err.message;
            progressText.className = 'progress-text';
            alert('Error: ' + err.message);
        } finally {
            btn.textContent = 'Submit for review';
            btn.disabled = false;
            btn.style.opacity = '1';
            setTimeout(() => progressWrap.classList.add('hidden'), 3000);
        }
    });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ===== DONE SCREEN BUTTONS =====
document.getElementById('download-again-btn').addEventListener('click', () => {
    if (_lastPdfBlob) {
        downloadBlob(_lastPdfBlob, 'ruthless-mentor-review.pdf');
    } else {
        alert('No PDF available. Submit a review first.');
    }
});

document.getElementById('new-btn').addEventListener('click', () => {
    document.getElementById('done-screen').classList.add('hidden');
    textarea.value = '';
    _lastPdfBlob = null;
    updateCost();
});

// ===== EMAIL PDF =====
const emailModal = document.getElementById('email-modal');
const emailInput = document.getElementById('email-pdf-input');
const emailStatus = document.getElementById('email-status');

document.getElementById('email-pdf-btn').addEventListener('click', () => {
    emailModal.classList.remove('hidden');
    emailInput.focus();
    if (_session && _session.user && _session.user.email) {
        emailInput.value = _session.user.email;
    }
});

document.getElementById('email-cancel-btn').addEventListener('click', () => {
    emailModal.classList.add('hidden');
    emailStatus.className = 'email-status hidden';
});

document.getElementById('email-send-btn').addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) { emailInput.focus(); return; }

    const btn = document.getElementById('email-send-btn');
    btn.textContent = 'Sending...';
    btn.disabled = true;
    emailStatus.className = 'email-status hidden';

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (_session) headers['Authorization'] = 'Bearer ' + _session.access_token;

        const res = await fetch('/api/email-pdf', {
            method: 'POST', headers,
            body: JSON.stringify({ text: window._lastSubmittedText, email })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send');

        emailStatus.textContent = 'PDF sent to ' + email + '!';
        emailStatus.className = 'email-status success';
        setTimeout(() => emailModal.classList.add('hidden'), 2000);
    } catch (err) {
        emailStatus.textContent = err.message;
        emailStatus.className = 'email-status error';
    } finally {
        btn.textContent = 'Send';
        btn.disabled = false;
    }
});
