const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, 'logo.png');
const hasLogo = fs.existsSync(LOGO_PATH);

// Colors
const C = {
  darkRed: [139, 0, 0],
  gold: [184, 134, 11],
  black: [26, 26, 26],
  gray: [100, 100, 100],
  lightGray: [200, 200, 200],
  white: [255, 255, 255],
  bg: [245, 245, 245],
  green: [46, 125, 50],
  greenLight: [232, 245, 233],
  red: [198, 40, 40],
  redLight: [252, 228, 236],
  yellow: [249, 168, 37],
  yellowLight: [255, 248, 225],
  blueLight: [227, 242, 253],
};

function scoreColor(score) {
  if (score <= 3) return C.red;
  if (score <= 6) return C.yellow;
  return C.green;
}

function gradeColor(grade) {
  const l = grade.charAt(0).toUpperCase();
  if (l === 'A') return C.green;
  if (l === 'B') return [85, 139, 47];
  if (l === 'C') return C.yellow;
  if (l === 'D') return [230, 81, 0];
  return C.red;
}

function depthColor(rating) {
  const map = { Shallow: C.red, Surface: [230, 81, 0], Adequate: C.yellow, Deep: C.green, Unflinching: C.green };
  return map[rating] || C.gray;
}

function pacingIcon(type) {
  return { bad: 'X', warn: '!', good: '+', neutral: '>' }[type] || '>';
}

function pacingColor(type) {
  return { bad: C.red, warn: C.yellow, good: C.green, neutral: C.gray }[type] || C.gray;
}

function resetFill(doc) {
  doc.fillColor(...C.black);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - 72) {
    doc.addPage();
  }
}

function drawFooter(doc, pageNum) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(...C.gray);
  doc.text(
    `RUTHLESS MENTOR REPORT  |  Page ${pageNum}`,
    0, doc.page.height - 40,
    { align: 'center', width: doc.page.width, lineBreak: false }
  );
  resetFill(doc);
}

function drawHeader(doc, data) {
  if (hasLogo) {
    doc.image(LOGO_PATH, doc.page.width / 2 - 30, 40, { width: 60 });
    doc.moveDown(4);
  }

  // Brand line — centered text with gold lines on each side
  const brandY = doc.y + 5;
  const brandText = 'RUTHLESS MENTOR';
  const brandFontSize = 9;
  const brandCharSpacing = 3;
  doc.fontSize(brandFontSize).font('Helvetica-Bold');
  const textW = doc.widthOfString(brandText, { characterSpacing: brandCharSpacing });
  const centerX = doc.page.width / 2;
  const lineGap = 10;
  const lineLen = 80;

  // Left line
  doc.strokeColor(...C.gold).lineWidth(1.5);
  doc.moveTo(centerX - textW / 2 - lineGap - lineLen, brandY).lineTo(centerX - textW / 2 - lineGap, brandY).stroke();
  // Right line
  doc.moveTo(centerX + textW / 2 + lineGap, brandY).lineTo(centerX + textW / 2 + lineGap + lineLen, brandY).stroke();
  // Text
  doc.fillColor(...C.black).text(brandText, 0, brandY - 5, { align: 'center', width: doc.page.width, characterSpacing: brandCharSpacing });
  doc.moveDown(1.5);

  // Title
  doc.fontSize(24).font('Helvetica-Bold').fillColor(...C.black);
  doc.text('Manuscript ', 72, doc.y, { continued: true });
  doc.fillColor(...C.gold).text('Review ', { continued: true });
  doc.fillColor(...C.black).text('Report');
  doc.moveDown(1);
}

function drawMeta(doc, data) {
  const fields = [
    ['Manuscript:', data.title || 'Untitled Manuscript'],
    ['Review Date:', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })],
    ['Status:', data.status || 'Complete'],
    ['Word Count:', data.wordCount || 'Unknown'],
    ['Target Age:', data.targetAge || 'Not specified'],
  ];

  const labelColWidth = 100;
  const valueColX = 72 + labelColWidth + 8;
  const valueColWidth = doc.page.width - 144 - labelColWidth - 8;

  fields.forEach(([label, value]) => {
    const rowY = doc.y;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(...C.black).text(label, 72, rowY, { width: labelColWidth });
    doc.font('Helvetica-Oblique').fillColor(...C.gray).text(value, valueColX, rowY, { width: valueColWidth });
    doc.y = Math.max(doc.y, rowY + 14);
  });
  doc.moveDown(1);
}

function sectionHeader(doc, title) {
  ensureSpace(doc, 50);
  doc.moveDown(0.5);
  doc.fontSize(14).font('Helvetica-Bold').fillColor(...C.darkRed).text(title, 72);
  const y = doc.y + 2;
  doc.strokeColor(...C.gold).lineWidth(2).moveTo(72, y).lineTo(280, y).stroke();
  doc.moveDown(0.8);
  resetFill(doc);
}

function bodyText(doc, text) {
  if (!text) return;
  const paragraphs = text.split('\n').filter(l => l.trim());
  paragraphs.forEach(p => {
    ensureSpace(doc, 30);
    doc.fontSize(10).font('Helvetica').fillColor(...C.black).text(p, 72, doc.y, { width: doc.page.width - 144 });
    doc.moveDown(0.4);
  });
}

function calloutBox(doc, text, bgColor, borderColor, icon, label) {
  ensureSpace(doc, 60);
  const x = 72;
  const w = doc.page.width - 144;
  const startY = doc.y;

  // Measure text height
  const textH = doc.fontSize(9).font('Helvetica').heightOfString(text, { width: w - 40 });
  const boxH = Math.max(textH + 30, 40);

  // Draw background rect
  doc.rect(x, startY, w, boxH).fill(...bgColor);
  resetFill(doc);

  // Draw left border
  doc.rect(x, startY, 4, boxH).fill(...borderColor);
  resetFill(doc);

  if (icon) {
    doc.fontSize(12).font('Helvetica-Bold').fillColor(...borderColor).text(icon, x + 12, startY + 8);
  }
  if (label) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(...borderColor).text(label, x + (icon ? 28 : 12), startY + 8, { continued: true });
    doc.font('Helvetica').fillColor(...C.black).text(' ' + text, { width: w - 44 });
  } else {
    doc.fontSize(9).font('Helvetica').fillColor(...C.black).text(text, x + (icon ? 28 : 12), startY + 10, { width: w - 44 });
  }

  doc.y = startY + boxH + 10;
  resetFill(doc);
}

function scoreBar(doc, score, label) {
  ensureSpace(doc, 40);
  const x = 72;
  const barW = 120;
  const barH = 22;
  const fillW = (score / 10) * barW;
  const color = scoreColor(score);
  const barY = doc.y;

  // Background bar
  doc.rect(x, barY, barW, barH).fill(...C.bg);
  resetFill(doc);

  // Colored fill bar
  doc.rect(x, barY, fillW, barH).fill(...color);
  resetFill(doc);

  // Score text on bar
  doc.fontSize(12).font('Helvetica-Bold').fillColor(...C.white).text(score + '/10', x + 6, barY + 4);

  // Label next to bar
  if (label) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor(...C.gray).text(label, x + barW + 12, barY + 4);
  }

  doc.y = barY + barH + 10;
  resetFill(doc);
}

function characterCard(doc, char) {
  ensureSpace(doc, 80);
  const x = 72;
  const w = doc.page.width - 144;
  const startY = doc.y;

  // Separator line above card
  doc.strokeColor(...C.lightGray).lineWidth(0.5);
  doc.moveTo(x, startY).lineTo(x + w, startY).stroke();
  doc.y = startY + 8;

  // Name
  doc.fontSize(11).font('Helvetica-Bold').fillColor(...C.black).text(char.name || 'Unnamed', x + 4, doc.y, { width: w - 60 });

  // Grade badge
  const gc = gradeColor(char.grade || 'C');
  const badgeX = x + w - 45;
  const badgeY = startY + 6;
  doc.rect(badgeX, badgeY, 35, 20).fill(...gc);
  resetFill(doc);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(...C.white).text(char.grade || '?', badgeX + 4, badgeY + 4, { width: 27, align: 'center' });
  resetFill(doc);

  doc.y = startY + 30;

  if (char.strengths) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(...C.black).text('Strengths: ', x + 10, doc.y, { continued: true, width: w - 20 });
    doc.font('Helvetica').text(char.strengths);
  }
  if (char.weaknesses) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(...C.black).text('Weaknesses: ', x + 10, doc.y, { continued: true, width: w - 20 });
    doc.font('Helvetica').text(char.weaknesses);
  }
  if (char.diagnosis) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(...C.black).text('Diagnosis: ', x + 10, doc.y, { continued: true, width: w - 20 });
    doc.font('Helvetica').text(char.diagnosis);
  }

  doc.y = doc.y + 10;
  resetFill(doc);
}

function quoteBlock(doc, location, quote, problem, fix, isGood, comment) {
  ensureSpace(doc, 70);
  const x = 72;
  const w = doc.page.width - 144;

  if (location) {
    doc.fontSize(8).font('Helvetica-Bold').fillColor(...C.gray).text(location.toUpperCase(), x);
  }

  // Quote
  const qBg = isGood ? C.greenLight : C.bg;
  const qBorder = isGood ? C.green : C.gold;
  const startY = doc.y;
  const qText = '"' + (quote || '') + '"';
  const qH = doc.fontSize(9).font('Helvetica-Oblique').heightOfString(qText, { width: w - 24 });
  const boxH = qH + 16;

  // Draw background
  doc.rect(x, startY, w, boxH).fill(...qBg);
  resetFill(doc);

  // Draw left border
  doc.rect(x, startY, 3, boxH).fill(...qBorder);
  resetFill(doc);

  doc.fontSize(9).font('Helvetica-Oblique').fillColor(68, 68, 68).text(qText, x + 12, startY + 8, { width: w - 24 });
  doc.y = startY + boxH + 6;

  if (isGood && comment) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(...C.green).text('Why it works: ', x, doc.y, { continued: true });
    doc.font('Helvetica').fillColor(...C.black).text(comment, { width: w });
  } else {
    if (problem) {
      doc.fontSize(9).font('Helvetica-Bold').fillColor(...C.black).text('Problem: ', x, doc.y, { continued: true });
      doc.font('Helvetica').text(problem, { width: w });
    }
    if (fix) {
      calloutBox(doc, fix, C.yellowLight, C.darkRed, null, 'RUTHLESS FIX:');
    }
  }
  doc.moveDown(0.5);
  resetFill(doc);
}

function repeatWordTable(doc, words) {
  if (!words || !words.length) {
    bodyText(doc, 'No significant repeat word issues found.');
    return;
  }

  ensureSpace(doc, 30 + words.length * 20);
  const x = 72;
  const w = doc.page.width - 144;

  // Header row background
  const headerY = doc.y;
  doc.rect(x, headerY, w, 18).fill(...C.bg);
  resetFill(doc);

  doc.fontSize(8).font('Helvetica-Bold').fillColor(...C.gray);
  doc.text('WORD', x + 6, headerY + 4, { width: 80 });
  doc.text('COUNT', x + 90, headerY + 4, { width: 50, align: 'center' });
  doc.text('CONTEXTS', x + 150, headerY + 4, { width: w - 156 });
  doc.y = headerY + 22;

  words.forEach(w2 => {
    ensureSpace(doc, 20);
    const rowY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor(...C.darkRed).text('"' + w2.word + '"', x + 6, rowY, { width: 80 });
    doc.font('Helvetica-Bold').fillColor(...C.black).text(w2.count + 'x', x + 90, rowY, { width: 50, align: 'center' });
    doc.font('Helvetica').fillColor(...C.gray).text(w2.contexts || '', x + 150, rowY, { width: w - 156 });
    doc.y = Math.max(doc.y, rowY + 14);
    // Divider
    doc.strokeColor(...C.lightGray).lineWidth(0.5).moveTo(x, doc.y).lineTo(x + w, doc.y).stroke();
    doc.y += 4;
  });
  doc.moveDown(0.5);
  resetFill(doc);
}

function pacingBreakdown(doc, items) {
  if (!items || !items.length) return;

  items.forEach(item => {
    ensureSpace(doc, 20);
    const icon = pacingIcon(item.type);
    const color = pacingColor(item.type);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(...color).text(icon + '  ', 80, doc.y, { continued: true });
    doc.font('Helvetica-Bold').fillColor(...C.black).text(item.label + ': ', { continued: true });
    doc.font('Helvetica').text(item.text, { width: doc.page.width - 180 });
    doc.moveDown(0.2);
  });
  doc.moveDown(0.5);
  resetFill(doc);
}

function compareTable(doc, examples) {
  if (!examples || !examples.length) return;

  examples.forEach(ex => {
    ensureSpace(doc, 50);
    const x = 72;
    const w = doc.page.width - 144;
    const isWeak = ex.type === 'weak';
    const bg = isWeak ? C.redLight : C.greenLight;
    const border = isWeak ? C.red : C.green;
    const label = isWeak ? 'TELLING:' : 'STRONGER:';

    const textH = doc.fontSize(9).font('Helvetica-Oblique').heightOfString('"' + ex.quote + '"', { width: w - 30 });
    const noteH = ex.note ? doc.fontSize(8).font('Helvetica').heightOfString(ex.note, { width: w - 30 }) : 0;
    const boxH = textH + noteH + 30;

    const boxY = doc.y;

    // Draw background
    doc.rect(x, boxY, w, boxH).fill(...bg);
    resetFill(doc);

    // Draw left border
    doc.rect(x, boxY, 4, boxH).fill(...border);
    resetFill(doc);

    doc.fontSize(8).font('Helvetica-Bold').fillColor(...border).text(label, x + 12, boxY + 6);
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(51, 51, 51).text('"' + ex.quote + '"', x + 12, doc.y + 2, { width: w - 30 });
    if (ex.note) {
      doc.fontSize(8).font('Helvetica').fillColor(119, 119, 119).text(ex.note, x + 12, doc.y + 2, { width: w - 30 });
    }
    doc.y = boxY + boxH + 6;
  });
  resetFill(doc);
}

async function generatePdf(reviewData) {
  return new Promise((resolve, reject) => {
    let pageCount = 1;

    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 40, bottom: 50, left: 72, right: 72 },
      bufferPages: false,
      info: {
        Title: 'Ruthless Mentor Review Report',
        Author: 'ruthlessmentor.com',
      }
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Footer on first page
    drawFooter(doc, 1);
    doc.y = doc.page.margins.top;

    // Add footer to every new page
    doc.on('pageAdded', () => {
      pageCount++;
      drawFooter(doc, pageCount);
      // Reset y to top margin for content
      doc.y = doc.page.margins.top;
    });

    const data = reviewData;

    // HEADER
    drawHeader(doc, data);
    drawMeta(doc, data);

    // 1. FIRST IMPRESSIONS
    sectionHeader(doc, '1. FIRST IMPRESSIONS');
    bodyText(doc, data.firstImpressions);
    if (data.strengths) {
      calloutBox(doc, data.strengths, C.greenLight, C.green, '+', "You've Got:");
    }

    // 2. STRUCTURE & PACING
    sectionHeader(doc, '2. STRUCTURE & PACING');
    bodyText(doc, data.pacingBody);
    if (data.pacingFix) {
      calloutBox(doc, data.pacingFix, C.yellowLight, C.darkRed, null, 'RUTHLESS FIX:');
    }
    if (data.pacingBreakdown) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(...C.black).text('Pacing Breakdown:', 72);
      doc.moveDown(0.3);
      pacingBreakdown(doc, data.pacingBreakdown);
    }

    // 3. AUTHOR'S VOICE
    sectionHeader(doc, "3. AUTHOR'S VOICE");
    scoreBar(doc, data.voiceScore || 5, data.voiceLabel);
    bodyText(doc, data.voiceBody);
    if (data.voiceExamples && data.voiceExamples.length) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(...C.black).text('Examples:', 72);
      doc.moveDown(0.3);
      compareTable(doc, data.voiceExamples);
    }

    // 4. PROSE QUALITY
    sectionHeader(doc, '4. PROSE QUALITY');
    scoreBar(doc, data.proseScore || 5, data.proseLabel);
    bodyText(doc, data.proseBody);

    // 5. REPEAT WORD REPORT
    sectionHeader(doc, '5. REPEAT WORD REPORT');
    repeatWordTable(doc, data.repeatWords);

    // 6. CHARACTER REPORT CARD
    sectionHeader(doc, '6. CHARACTER REPORT CARD');
    if (data.characters && data.characters.length) {
      data.characters.forEach(c => characterCard(doc, c));
    } else {
      bodyText(doc, 'No significant characters identified.');
    }

    // 7. DEPTH CHECK
    sectionHeader(doc, '7. DEPTH CHECK');
    if (data.depthRating) {
      ensureSpace(doc, 30);
      const dc = depthColor(data.depthRating);
      const x = 72;
      const badgeY = doc.y;
      doc.rect(x, badgeY, 100, 22).fill(...dc);
      resetFill(doc);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(...C.white).text(data.depthRating, x + 6, badgeY + 5, { width: 88, align: 'center' });
      resetFill(doc);
      doc.y = badgeY + 30;
    }
    bodyText(doc, data.depthBody);

    // 8. LINE-LEVEL CALLOUTS
    sectionHeader(doc, '8. LINE-LEVEL CALLOUTS');
    if (data.lineCallouts && data.lineCallouts.length) {
      data.lineCallouts.forEach(c => {
        quoteBlock(doc, c.location, c.quote, c.problem, c.fix, c.isGood, c.comment);
      });
    }

    // 9. WHERE THIS IS HEADING
    sectionHeader(doc, '9. WHERE THIS IS HEADING');
    bodyText(doc, data.trajectory);
    if (data.trajectoryFix) {
      calloutBox(doc, data.trajectoryFix, C.yellowLight, C.darkRed, null, 'RUTHLESS FIX:');
    }

    // 10. FINAL VERDICT
    sectionHeader(doc, '10. FINAL VERDICT');
    ensureSpace(doc, 80);
    // Verdict box with gold border
    const vx = 72;
    const vw = doc.page.width - 144;
    const vText = (data.verdict || '').replace(/\\n/g, '\n');
    const vH = doc.fontSize(10).font('Helvetica').heightOfString(vText, { width: vw - 30 }) + 30;
    doc.roundedRect(vx, doc.y, vw, vH, 6).lineWidth(1.5).strokeColor(...C.gold).stroke();
    const vy = doc.y;
    doc.fontSize(10).font('Helvetica').fillColor(...C.black).text(vText, vx + 15, vy + 15, { width: vw - 30 });
    doc.y = vy + vH + 10;

    doc.end();
  });
}

// ===== INSTANT PDF FROM MARKDOWN (no API call) =====
async function generatePdfFromMarkdown(markdown, wordCount, tier) {
  return new Promise((resolve, reject) => {
    let pageCount = 1;

    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 40, bottom: 50, left: 72, right: 72 },
      bufferPages: false,
      info: {
        Title: 'Ruthless Mentor Review Report',
        Author: 'ruthlessmentor.com',
      }
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawFooter(doc, 1);
    doc.y = doc.page.margins.top;

    doc.on('pageAdded', () => {
      pageCount++;
      drawFooter(doc, pageCount);
      doc.y = doc.page.margins.top;
    });

    // Header
    if (hasLogo) {
      doc.image(LOGO_PATH, doc.page.width / 2 - 30, 40, { width: 60 });
      doc.moveDown(4);
    }

    const brandY = doc.y + 5;
    doc.fontSize(9).font('Helvetica-Bold');
    const brandText = 'RUTHLESS MENTOR';
    const brandCharSpacing = 3;
    const textW = doc.widthOfString(brandText, { characterSpacing: brandCharSpacing });
    const centerX = doc.page.width / 2;
    const lineGap = 10;
    const lineLen = 80;
    doc.strokeColor(...C.gold).lineWidth(1.5);
    doc.moveTo(centerX - textW / 2 - lineGap - lineLen, brandY).lineTo(centerX - textW / 2 - lineGap, brandY).stroke();
    doc.moveTo(centerX + textW / 2 + lineGap, brandY).lineTo(centerX + textW / 2 + lineGap + lineLen, brandY).stroke();
    doc.fillColor(...C.black).text(brandText, 0, brandY - 5, { align: 'center', width: doc.page.width, characterSpacing: brandCharSpacing });
    doc.moveDown(1.5);

    // Title
    doc.fontSize(24).font('Helvetica-Bold').fillColor(...C.black);
    doc.text('Manuscript Review Report', 72, doc.y, { width: doc.page.width - 144 });
    doc.moveDown(0.5);

    // Meta
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const metaLines = [
      ['Review Date:', date],
      ['Word Count:', wordCount ? `~${Number(wordCount).toLocaleString()} words` : 'Unknown'],
      ['Tier:', tier || 'Unknown'],
    ];
    metaLines.forEach(([label, value]) => {
      const rowY = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').fillColor(...C.black).text(label, 72, rowY, { width: 100 });
      doc.font('Helvetica-Oblique').fillColor(...C.gray).text(value, 180, rowY, { width: 300 });
      doc.y = Math.max(doc.y, rowY + 14);
    });
    doc.moveDown(1);

    // Strip markdown formatting helper
    function clean(str) {
      return (str || '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').trim();
    }

    // Parse markdown into sections and render
    const lines = markdown.split('\n');
    const pw = doc.page.width - 144;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (!trimmed) {
        doc.moveDown(0.3);
        continue;
      }

      // Section headers
      const h3Match = trimmed.match(/^###\s*(\d+)\.\s*(.+)/);
      const h2Match = !h3Match && trimmed.match(/^##\s*(.+)/);
      const h1Match = !h3Match && !h2Match && trimmed.match(/^#\s*(.+)/);

      if (h3Match) {
        const num = h3Match[1];
        const rest = clean(h3Match[2]);
        sectionHeader(doc, `${num}. ${rest}`.toUpperCase());
        // Score in header
        const sm = rest.match(/(\d+)\/10/);
        if (sm) scoreBar(doc, parseInt(sm[1]), rest.replace(/.*\d+\/10\s*/, '').trim());
        continue;
      }
      if (h2Match) { sectionHeader(doc, clean(h2Match[1]).toUpperCase()); continue; }
      if (h1Match) {
        ensureSpace(doc, 40);
        doc.fontSize(18).font('Helvetica-Bold').fillColor(...C.darkRed).text(clean(h1Match[1]), 72, doc.y, { width: pw });
        resetFill(doc); doc.moveDown(0.5); continue;
      }

      // Quote blocks
      if (trimmed.startsWith('>')) {
        ensureSpace(doc, 40);
        const qt = clean(trimmed.replace(/^>\s*/, ''));
        const qY = doc.y;
        const qH = doc.fontSize(9).font('Helvetica-Oblique').heightOfString(qt, { width: pw - 24 }) + 16;
        doc.rect(72, qY, pw, qH).fill(...C.bg); resetFill(doc);
        doc.rect(72, qY, 3, qH).fill(...C.gold); resetFill(doc);
        doc.fontSize(9).font('Helvetica-Oblique').fillColor(68, 68, 68).text(qt, 84, qY + 8, { width: pw - 24 });
        doc.y = qY + qH + 6; resetFill(doc);
        continue;
      }

      // Bullet points — render as plain text with bullet character, NO continued
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        ensureSpace(doc, 20);
        const bt = clean(trimmed.replace(/^[-*]\s*/, ''));
        doc.fontSize(9).font('Helvetica').fillColor(...C.black).text('\u2022  ' + bt, 80, doc.y, { width: pw - 20 });
        doc.moveDown(0.15);
        continue;
      }

      // Bold-only line
      if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        ensureSpace(doc, 20);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(...C.black).text(clean(trimmed), 72, doc.y, { width: pw });
        doc.moveDown(0.3);
        continue;
      }

      // Regular text — strip markdown, render as single text call, NO continued
      ensureSpace(doc, 20);
      doc.fontSize(10).font('Helvetica').fillColor(...C.black).text(clean(trimmed), 72, doc.y, { width: pw });
      doc.moveDown(0.3);
    }

    doc.end();
  });
}

module.exports = { generatePdf, generatePdfFromMarkdown };
