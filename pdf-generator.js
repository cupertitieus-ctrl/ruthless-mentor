const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'report-template.html');

function getScoreColor(score) {
  if (score <= 3) return 'red';
  if (score <= 6) return 'yellow';
  return 'green';
}

function getDepthColor(rating) {
  const map = { 'Shallow': 'red', 'Surface': 'yellow', 'Adequate': 'yellow', 'Deep': 'green', 'Unflinching': 'green' };
  return `grade-${rating === 'Shallow' || rating === 'Surface' ? 'f' : rating === 'Adequate' ? 'c' : 'a'}`;
}

function getGradeClass(grade) {
  const letter = grade.charAt(0).toUpperCase();
  if (letter === 'A') return 'grade-a';
  if (letter === 'B') return 'grade-b';
  if (letter === 'C') return 'grade-c';
  if (letter === 'D') return 'grade-d';
  return 'grade-f';
}

function pacingIcon(type) {
  const icons = { 'bad': '\u274C', 'warn': '\u26A0\uFE0F', 'good': '\u2705', 'neutral': '\u27A1\uFE0F' };
  return icons[type] || icons.neutral;
}

function buildCharacterCards(characters) {
  if (!characters || !characters.length) return '<p>No significant characters identified.</p>';
  return characters.map(c => `
    <div class="char-card">
      <div class="char-header">
        <span class="char-name">${esc(c.name)}</span>
        <span class="char-grade ${getGradeClass(c.grade)}">${esc(c.grade)}</span>
      </div>
      <div class="char-body">
        <p><strong>Strengths:</strong> ${esc(c.strengths)}</p>
        <p><strong>Weaknesses:</strong> ${esc(c.weaknesses)}</p>
        <p><strong>Diagnosis:</strong> ${esc(c.diagnosis)}</p>
      </div>
    </div>
  `).join('');
}

function buildPacingBreakdown(items) {
  if (!items || !items.length) return '';
  return items.map(item => `
    <li>
      <span class="pacing-icon">${pacingIcon(item.type)}</span>
      <span><span class="pacing-label">${esc(item.label)}:</span> ${esc(item.text)}</span>
    </li>
  `).join('');
}

function buildVoiceExamples(examples) {
  if (!examples || !examples.length) return '';
  return examples.map(ex => `
    <tr>
      <td>
        <div class="compare-label ${ex.type === 'weak' ? 'red' : 'green'}">${ex.type === 'weak' ? 'TELLING' : 'STRONGER'}:</div>
        <div class="compare-quote">"${esc(ex.quote)}"</div>
        <div class="compare-note">${esc(ex.note)}</div>
      </td>
    </tr>
  `).join('');
}

function buildLineCallouts(callouts) {
  if (!callouts || !callouts.length) return '<p>No specific callouts.</p>';
  return callouts.map(c => {
    if (c.isGood) {
      return `
        <div class="callout callout-green">
          <span class="callout-icon">\u2705</span>
          <div class="callout-text">
            <div class="quote-ref">${esc(c.location)}</div>
            <div class="compare-quote">"${esc(c.quote)}"</div>
            <p style="margin-top:6px"><strong>Why it works:</strong> ${esc(c.comment)}</p>
          </div>
        </div>`;
    }
    return `
      <div class="quote-block">
        <div class="quote-ref">${esc(c.location)}</div>
        "${esc(c.quote)}"
      </div>
      <p><strong>Problem:</strong> ${esc(c.problem)}</p>
      ${c.fix ? `<div class="fix-box"><div class="fix-box-header">\u23F0 RUTHLESS FIX:</div><p>${esc(c.fix)}</p></div>` : ''}
    `;
  }).join('');
}

function buildRepeatWords(words) {
  if (!words || !words.length) return '<p>No significant repeat word issues found.</p>';
  return `<table style="width:100%;border-collapse:collapse;margin:10px 0">
    <tr style="background:#f5f5f5;font-weight:700;font-size:9pt;text-transform:uppercase;letter-spacing:1px">
      <td style="padding:8px 12px;border-bottom:2px solid #ddd">Word</td>
      <td style="padding:8px 12px;border-bottom:2px solid #ddd;text-align:center">Count</td>
      <td style="padding:8px 12px;border-bottom:2px solid #ddd">Contexts</td>
    </tr>
    ${words.map(w => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:700;color:#8b0000">"${esc(w.word)}"</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-weight:700">${w.count}x</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:10pt;color:#555">${esc(w.contexts)}</td>
      </tr>
    `).join('')}
  </table>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paragraphs(text) {
  if (!text) return '';
  return text.split('\n').filter(l => l.trim()).map(l => `<p>${esc(l)}</p>`).join('');
}

function buildHtml(data) {
  let template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  const logoPath = path.join(__dirname, 'logo.png');
  let logoBase64 = '';
  if (fs.existsSync(logoPath)) {
    const logoBuffer = fs.readFileSync(logoPath);
    logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
  }
  template = template.replace('logo.png', logoBase64);

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const replacements = {
    '{{title}}': esc(data.title || 'Untitled Manuscript'),
    '{{date}}': date,
    '{{status}}': esc(data.status || 'Complete'),
    '{{wordCount}}': esc(data.wordCount || 'Unknown'),
    '{{targetAge}}': esc(data.targetAge || 'Not specified'),
    '{{firstImpressions}}': paragraphs(data.firstImpressions),
    '{{strengths}}': esc(data.strengths || ''),
    '{{pacingBody}}': paragraphs(data.pacingBody),
    '{{pacingFix}}': esc(data.pacingFix || ''),
    '{{pacingBreakdown}}': buildPacingBreakdown(data.pacingBreakdown),
    '{{voiceScore}}': data.voiceScore || '?',
    '{{voiceScoreColor}}': getScoreColor(data.voiceScore || 5),
    '{{voiceLabel}}': esc(data.voiceLabel || ''),
    '{{voiceBody}}': paragraphs(data.voiceBody),
    '{{voiceExamples}}': buildVoiceExamples(data.voiceExamples),
    '{{proseScore}}': data.proseScore || '?',
    '{{proseScoreColor}}': getScoreColor(data.proseScore || 5),
    '{{proseLabel}}': esc(data.proseLabel || ''),
    '{{proseBody}}': paragraphs(data.proseBody),
    '{{repeatWords}}': buildRepeatWords(data.repeatWords),
    '{{characters}}': buildCharacterCards(data.characters),
    '{{depthRating}}': esc(data.depthRating || 'Adequate'),
    '{{depthColor}}': getDepthColor(data.depthRating || 'Adequate'),
    '{{depthBody}}': paragraphs(data.depthBody),
    '{{lineCallouts}}': buildLineCallouts(data.lineCallouts),
    '{{trajectory}}': paragraphs(data.trajectory),
    '{{trajectoryFix}}': esc(data.trajectoryFix || ''),
    '{{verdict}}': paragraphs(data.verdict),
  };

  // Handle {{#if ...}} blocks
  const conditionals = ['strengths', 'pacingFix', 'pacingBreakdown', 'voiceExamples', 'trajectoryFix'];
  for (const key of conditionals) {
    const val = data[key];
    const hasValue = Array.isArray(val) ? val.length > 0 : !!val;
    const ifRegex = new RegExp(`\\{\\{#if ${key}\\}\\}([\\s\\S]*?)\\{\\{/if\\}\\}`, 'g');
    template = template.replace(ifRegex, hasValue ? '$1' : '');
  }

  for (const [placeholder, value] of Object.entries(replacements)) {
    template = template.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }

  return template;
}

async function generatePdf(reviewData) {
  const html = buildHtml(reviewData);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdfBuffer = await page.pdf({
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.3in', bottom: '0.5in', left: '0in', right: '0in' },
    displayHeaderFooter: true,
    footerTemplate: `
      <div style="width:100%;text-align:center;font-size:8pt;color:#888;font-family:Inter,sans-serif;letter-spacing:1px;text-transform:uppercase;font-weight:600">
        RUTHLESS MENTOR REPORT &nbsp;|&nbsp; Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>`,
    headerTemplate: '<div></div>'
  });

  await browser.close();
  return pdfBuffer;
}

module.exports = { generatePdf, buildHtml };
