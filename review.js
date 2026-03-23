// ===== AUTH (soft — page works without login) =====
let _session = null;
(async () => {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            _session = session;
        }
    } catch (e) { /* supabase not loaded or no session — that's fine */ }
    updateCost();
})();

// ===== ANIMATIONS =====
const animEls = document.querySelectorAll('.anim-fade,.anim-slide-up,.anim-scale');
const animObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); animObs.unobserve(e.target); }
    });
}, { threshold: 0.1 });
animEls.forEach(el => animObs.observe(el));

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

// ===== FORM ELEMENTS =====
const textarea = document.getElementById('co-text');
const wordCountEl = document.getElementById('word-count');
const estTierEl = document.getElementById('est-tier');
const estCostEl = document.getElementById('est-cost');
const totalEl = document.getElementById('total-amount');
const form = document.getElementById('checkout-form');

function updateCost() {
    const words = countWords(textarea ? textarea.value : '');
    if (wordCountEl) wordCountEl.textContent = words.toLocaleString();

    const tier = words > 0 ? getTier(words) : null;
    const total = tier ? tier.price : 0;

    if (estTierEl) estTierEl.textContent = words === 0 ? '--' : tier.name;
    if (estCostEl) estCostEl.textContent = words === 0 ? '--' : '$' + tier.price;
    if (totalEl) totalEl.textContent = words === 0 ? '--' : '$' + total;

    // Highlight active tier in sidebar
    document.querySelectorAll('.sidebar-tier').forEach(el => el.classList.remove('active'));
    if (tier) {
        const tiers = document.querySelectorAll('.sidebar-tier');
        const tierMap = { "Children's / Picture Book": 0, 'Chapter Book': 1, 'Middle Grade': 2, "Young Adult / Adult": 3 };
        const idx = tierMap[tier.name];
        if (tiers[idx]) tiers[idx].classList.add('active');
    }
}

if (textarea) textarea.addEventListener('input', updateCost);

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
        // Send PDF/DOCX to server for parsing
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch('/api/parse-file', { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Parse failed');
            textarea.value = data.text;
            fileNameEl.textContent = file.name + ' (' + data.wordCount.toLocaleString() + ' words extracted)';
            updateCost();
        } catch (err) {
            fileNameEl.textContent = 'Failed to parse file: ' + err.message;
            fileNameEl.style.color = '#ef4444';
        }
    }
}

// ===== SUBMIT =====
if (form) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = textarea.value.trim();

        if (!text) { alert('Paste your text or upload a file first.'); return; }

        const btn = document.getElementById('submit-btn');
        btn.textContent = 'Reviewing... this may take a minute';
        btn.disabled = true;
        btn.style.opacity = '.6';

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (_session) headers['Authorization'] = 'Bearer ' + _session.access_token;

            const res = await fetch('/api/review', {
                method: 'POST',
                headers,
                body: JSON.stringify({ text })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Review failed');
            showReviewScreen(data);
        } catch (err) {
            alert('Error: ' + err.message);
        } finally {
            btn.textContent = 'Submit for review';
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    });
}

// ===== REVIEW SCREEN =====
function showReviewScreen(data) {
    const screen = document.getElementById('review-screen');
    const costLabel = '$' + data.totalCost;
    document.getElementById('review-meta').textContent =
        `${data.tier} \u00B7 ${data.wordCount.toLocaleString()} words \u00B7 ${costLabel}`;
    document.getElementById('review-body').innerHTML = markdownToHtml(data.review);
    screen.classList.remove('hidden');
    window.scrollTo(0, 0);
    window._lastReview = data.review;
    updateCost();
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

document.getElementById('new-btn').addEventListener('click', () => {
    document.getElementById('review-screen').classList.add('hidden');
    textarea.value = '';
    updateCost();
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
