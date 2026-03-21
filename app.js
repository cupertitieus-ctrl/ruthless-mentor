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

// ===== PRICING LOGIC =====
function getTier(words) {
    if (words <= 1000) return { name: 'Picture Book', price: 5 };
    if (words <= 15000) return { name: 'Chapter Book', price: 7 };
    if (words <= 50000) return { name: 'Middle Grade', price: 10 };
    return { name: 'Young Adult', price: 12 };
}

function countWords(text) {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
}

// ===== CHECKOUT =====
const textarea = document.getElementById('co-text');
const wordCountEl = document.getElementById('word-count');
const estCostEl = document.getElementById('est-cost');
const totalEl = document.getElementById('total-amount');
const pdfCheckbox = document.getElementById('pdf-addon-checkout');
const checkoutForm = document.getElementById('checkout-form');

function updateCost() {
    const words = countWords(textarea ? textarea.value : '');
    if (wordCountEl) wordCountEl.textContent = words.toLocaleString();

    const tier = words > 0 ? getTier(words) : null;
    const baseCost = tier ? tier.price : 0;
    const pdfCost = pdfCheckbox && pdfCheckbox.checked ? 2 : 0;
    const total = baseCost + pdfCost;

    if (estCostEl) estCostEl.textContent = words === 0 ? 'Free (1st review)' : tier.name + ' — $' + baseCost;
    if (totalEl) totalEl.textContent = words === 0 ? 'Free' : '$' + total;
}

if (textarea) textarea.addEventListener('input', updateCost);
if (pdfCheckbox) pdfCheckbox.addEventListener('change', updateCost);

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

function handleFile(file) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!['.pdf', '.docx', '.txt'].includes(ext)) {
        fileNameEl.textContent = 'Unsupported format. Use PDF, DOCX, or TXT.';
        fileNameEl.style.color = '#ef4444';
        return;
    }
    fileNameEl.style.color = '';
    fileNameEl.textContent = file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)';

    if (ext === '.txt') {
        const reader = new FileReader();
        reader.onload = (e) => {
            textarea.value = e.target.result;
            updateCost();
        };
        reader.readAsText(file);
    }
}

// ===== SUBMIT REVIEW =====
if (checkoutForm) {
    checkoutForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const text = textarea.value.trim();
        const email = document.getElementById('co-email').value.trim();
        const wantPdf = pdfCheckbox && pdfCheckbox.checked;

        if (!text) {
            alert('Paste your text or upload a file first.');
            return;
        }

        const btn = checkoutForm.querySelector('button[type="submit"]');
        const originalText = btn.textContent;
        btn.textContent = 'Reviewing... this may take a minute';
        btn.disabled = true;
        btn.style.opacity = '.6';

        try {
            const res = await fetch('/api/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, email, wantPdf })
            });

            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Review failed');

            // Show review on separate screen
            showReviewScreen(data);

        } catch (err) {
            alert('Error: ' + err.message);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    });
}

// ===== REVIEW SCREEN =====
function showReviewScreen(data) {
    const screen = document.getElementById('review-screen');
    const meta = document.getElementById('review-meta');
    const body = document.getElementById('review-body');

    meta.textContent = `${data.tier} \u00B7 ${data.wordCount.toLocaleString()} words \u00B7 $${data.totalCost}`;
    body.innerHTML = markdownToHtml(data.review);

    screen.classList.remove('hidden');
    window.scrollTo(0, 0);

    window._lastReview = data.review;
}

// Back button
const backBtn = document.getElementById('back-btn');
if (backBtn) {
    backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('review-screen').classList.add('hidden');
    });
}

// Copy button
const copyBtn = document.getElementById('copy-btn');
if (copyBtn) {
    copyBtn.addEventListener('click', () => {
        if (window._lastReview) {
            navigator.clipboard.writeText(window._lastReview);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => copyBtn.textContent = 'Copy review', 1500);
        }
    });
}

// New review button
const newBtn = document.getElementById('new-btn');
if (newBtn) {
    newBtn.addEventListener('click', () => {
        document.getElementById('review-screen').classList.add('hidden');
        document.getElementById('checkout').scrollIntoView({ behavior: 'smooth' });
    });
}

// Simple markdown to HTML
function markdownToHtml(md) {
    return md
        .replace(/### (\d+)\. (.+)/g, '<h3><span class="review-num">$1.</span> $2</h3>')
        .replace(/### (.+)/g, '<h3>$1</h3>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/> (.+)/g, '<blockquote>$1</blockquote>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/^(.+)$/gm, (match) => {
            if (match.startsWith('<')) return match;
            return match;
        })
        .replace(/^(?!<)(.*\S.*)$/gm, '<p>$1</p>')
        .replace(/<p><h3>/g, '<h3>')
        .replace(/<\/h3><\/p>/g, '</h3>')
        .replace(/<p><ul>/g, '<ul>')
        .replace(/<\/ul><\/p>/g, '</ul>')
        .replace(/<p><blockquote>/g, '<blockquote>')
        .replace(/<\/blockquote><\/p>/g, '</blockquote>');
}
