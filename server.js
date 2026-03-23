require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// Anthropic client
const client = new Anthropic();

// Supabase (optional — gracefully degrade if not configured)
let supabaseAdmin = null;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (supabaseUrl && supabaseKey) {
  const { createClient } = require('@supabase/supabase-js');
  supabaseAdmin = createClient(supabaseUrl, supabaseKey);
  console.log('[OK] Supabase connected');
} else {
  console.warn('[WARN] Supabase not configured — auth/storage disabled, reviews still work');
}

// ===== AUTH MIDDLEWARE (soft — allows unauthenticated if Supabase is down) =====
async function optionalAuth(req, res, next) {
  req.user = null;
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || !supabaseAdmin) {
    return next();
  }
  try {
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && user) req.user = user;
  } catch (e) { /* ignore auth errors */ }
  next();
}

async function requireAuth(req, res, next) {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth not configured' });
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Auth failed' });
  }
}

// ===== TIERS =====
const TIERS = [
  { name: "Children's / Picture Book", max: 5000, price: 5 },
  { name: 'Chapter Book', max: 25000, price: 10 },
  { name: 'Middle Grade', max: 50000, price: 15 },
  { name: 'Young Adult / Adult', max: Infinity, price: 15 },
];

function getTier(wordCount) {
  return TIERS.find(t => wordCount <= t.max);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ===== REVIEW PROMPTS =====
const REVIEW_PROMPT = `You are Ruthless Mentor — a veteran writing professor with 30 years of experience and zero patience for lazy prose.

Your job is to give the author the review they NEED, not the one they want to hear.

Produce your review in this exact structure. Every section is mandatory.

### 1. First Impressions
2-3 sentences. Your gut reaction. What hit you? What made you wince?

### 2. Prose Quality Audit: X/10
Rate overall prose quality. Scan for: Repetitive Word Abuse (COUNT instances), Placeholder Phrases, Broken Metaphors, Purple Prose, Telling Not Showing, Repetitive Sentence Structures, Lack of Specificity, Dead-Weight Modifiers. Quote specific passages for every problem.

### 3. Repeat Word Report
List every overused word with exact count and every context.

### 4. Shallow Content Check
Themes handled with oven mitts? Convenient psychology? Emotional flinching?
Rate: Shallow / Surface / Adequate / Deep / Unflinching

### 5. Character Report Card
For each character: Name, Grade (A-F), Strengths (with quotes), Weaknesses (with quotes), Diagnosis.

### 6. Story Mechanics
Pacing, plot holes, world-building, stakes, show vs tell, dialogue, theme, prose style.

### 7. Line-Level Callouts
At least 5-10 passages. Quote, explain problem, suggest fix. Also call out GOOD passages.

### 8. Where This Is Heading
If unfinished: trajectory warnings, structural concerns, what to fix now. If complete: note it.

### 9. Final Verdict
2-4 paragraphs. Ready for readers? Biggest fix? Strongest element? Would you keep reading?

Be direct, specific, fair. Dry wit over cruelty. NEVER fabricate quotes.`;

// Structured JSON prompt for PDF generation
const PDF_REVIEW_PROMPT = `You are Ruthless Mentor — a veteran writing professor with 30 years of experience.

Analyze the manuscript and return a JSON object with this EXACT structure. Return ONLY valid JSON, no markdown, no code fences.

{
  "title": "best guess at manuscript title or 'Untitled Manuscript'",
  "status": "Complete or Partial (X of Y chapters submitted)",
  "targetAge": "age range and genre, e.g. '9-12 (Middle Grade Fantasy)'",
  "firstImpressions": "2-3 paragraphs of gut reaction. Separate paragraphs with \\n",
  "strengths": "pipe-separated list of top strengths, e.g. 'A vivid setting | A strong main character | Sharp dialogue'",
  "pacingBody": "1-2 paragraphs on the core pacing issue. Use \\n between paragraphs",
  "pacingFix": "one clear, actionable fix for the biggest pacing problem",
  "pacingBreakdown": [
    {"type": "bad", "label": "Ch. 1-2", "text": "description of pacing issue"},
    {"type": "warn", "label": "Ch. 3-6", "text": "description"},
    {"type": "good", "label": "Ch. 7-12", "text": "description"},
    {"type": "neutral", "label": "Overall", "text": "summary"}
  ],
  "voiceScore": 7,
  "voiceLabel": "Short label like 'Strong Voice, Inconsistent POV'",
  "voiceBody": "1-2 paragraphs analyzing the author's voice. Use \\n between paragraphs",
  "voiceExamples": [
    {"type": "weak", "quote": "exact quote from text showing telling", "note": "why it's weak"},
    {"type": "strong", "quote": "rewritten version or existing strong example", "note": "why it works"}
  ],
  "proseScore": 6,
  "proseLabel": "Short label like 'Needs Polish' or 'Clean and Confident'",
  "proseBody": "1-2 paragraphs on prose quality issues. Use \\n between paragraphs",
  "repeatWords": [
    {"word": "sharp", "count": 14, "contexts": "used for voices, glances, pain, ideas, weather"},
    {"word": "just", "count": 23, "contexts": "filler word throughout dialogue and narration"}
  ],
  "characters": [
    {
      "name": "Character Name",
      "grade": "B+",
      "strengths": "what works, with brief quote references",
      "weaknesses": "what's broken, with brief quote references",
      "diagnosis": "real person or cardboard cutout? why?"
    }
  ],
  "depthRating": "one of: Shallow, Surface, Adequate, Deep, Unflinching",
  "depthBody": "1-2 paragraphs on content depth. Use \\n between paragraphs",
  "lineCallouts": [
    {
      "location": "Chapter 1, Paragraph 3",
      "quote": "exact quote from the text",
      "problem": "what's wrong with it",
      "fix": "specific rewrite suggestion",
      "isGood": false
    },
    {
      "location": "Chapter 2, Paragraph 8",
      "quote": "exact quote that works well",
      "comment": "why this passage is effective",
      "isGood": true
    }
  ],
  "trajectory": "1-2 paragraphs on where the story is headed if unfinished, or 'Complete manuscript.' if finished. Use \\n between paragraphs",
  "trajectoryFix": "most important thing to fix before continuing, or empty string if complete",
  "verdict": "2-4 paragraphs. Final verdict. Is it ready? Biggest fix? Strongest element? Would you keep reading? End with genuine encouragement if earned. Use \\n between paragraphs"
}

CRITICAL RULES:
- Return ONLY the JSON object. No markdown. No code fences. No explanation before or after.
- NEVER fabricate quotes. Only use text that actually appears in the manuscript.
- All string values must be valid JSON (escape quotes with \\", use \\n for newlines).
- Be brutally honest. Direct. Specific. Fair.
- Adjust expectations to genre — don't critique a kids book for not being literary fiction.
- For unfinished work, don't penalize missing resolution. Focus on what's on the page.
- voiceExamples should have at least one weak and one strong example.
- lineCallouts should have at least 5 entries, mix of good (isGood:true) and bad (isGood:false).
- repeatWords should list every word used more than 5 times abnormally.
- pacingBreakdown types: "bad" (red X), "warn" (yellow warning), "good" (green check), "neutral" (arrow).`;

const { generatePdf } = require('./pdf-generator');

// ===== GET USER INFO =====
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { count, error } = await supabaseAdmin
      .from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Failed to load user info' });
    res.json({ email: req.user.email, reviewCount: count, isFirstFree: count === 0 });
  } catch (e) {
    res.json({ email: req.user.email, reviewCount: 0, isFirstFree: true });
  }
});

// ===== GET PAST REVIEWS =====
app.get('/api/reviews', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .select('id, word_count, tier, price, review_markdown, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load reviews' });
    res.json({ reviews: data || [] });
  } catch (e) {
    res.json({ reviews: [] });
  }
});

// ===== SUBMIT REVIEW =====
app.post('/api/review', optionalAuth, async (req, res) => {
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const wordCount = countWords(text);
  const tier = getTier(wordCount);

  const totalCost = tier.price;

  console.log(`[REVIEW] ${req.user ? req.user.email : 'anonymous'} | ${wordCount} words | ${tier.name} | $${totalCost}`);
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: `Please review the following manuscript/text. It is ${wordCount} words long and categorized as "${tier.name}".

---

${text}

---

Provide your complete review following the structure outlined in your instructions.`
        }
      ],
      system: REVIEW_PROMPT
    });

    const review = message.content[0].text;

    // Store review in Supabase (if available and user is authenticated)
    if (supabaseAdmin && req.user) {
      try {
        await supabaseAdmin.from('reviews').insert({
          user_id: req.user.id,
          word_count: wordCount,
          tier: tier.name,
          price: totalCost,
          review_markdown: review,
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        });
      } catch (e) {
        console.error('[DB ERROR]', e.message);
      }
    }

    res.json({
      review,
      wordCount,
      tier: tier.name,
      price: tier.price,
      totalCost,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens
      }
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: 'Review failed. Please try again.' });
  }
});

// ===== PDF REVIEW =====
app.post('/api/review-pdf', optionalAuth, async (req, res) => {
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const wordCount = countWords(text);
  const tier = getTier(wordCount);

  console.log(`[PDF REVIEW] ${req.user ? req.user.email : 'anonymous'} | ${wordCount} words | ${tier.name}`);

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: `Review this manuscript (${wordCount} words, "${tier.name}" category):\n\n---\n\n${text}\n\n---\n\nReturn ONLY a valid JSON object following the exact structure in your instructions.`
        }
      ],
      system: PDF_REVIEW_PROMPT
    });

    let reviewText = message.content[0].text.trim();
    // Strip any markdown code fences
    reviewText = reviewText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

    let reviewData;
    try {
      reviewData = JSON.parse(reviewText);
    } catch (parseErr) {
      console.error('[JSON PARSE ERROR]', parseErr.message);
      console.error('[RAW RESPONSE]', reviewText.substring(0, 500));
      return res.status(500).json({ error: 'Failed to parse review data. Please try again.' });
    }

    reviewData.wordCount = `~${wordCount.toLocaleString()} words`;

    // Generate PDF
    const pdfBuffer = await generatePdf(reviewData);

    // Store in Supabase if authenticated
    if (supabaseAdmin && req.user) {
      try {
        await supabaseAdmin.from('reviews').insert({
          user_id: req.user.id,
          word_count: wordCount,
          tier: tier.name,
          price: tier.price,
          review_markdown: JSON.stringify(reviewData),
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        });
      } catch (e) {
        console.error('[DB ERROR]', e.message);
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ruthless-mentor-review-${Date.now()}.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    console.error('[PDF ERROR]', err.message);
    res.status(500).json({ error: 'PDF review failed. Please try again.' });
  }
});

// ===== FILE UPLOAD & TEXT EXTRACTION =====
app.post('/api/parse-file', (req, res) => {
  upload.single('file')(req, res, async (multerErr) => {
    if (multerErr) {
      console.error('[MULTER ERROR]', multerErr.message);
      return res.status(400).json({ error: 'File upload failed: ' + multerErr.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let text = '';

    try {
      if (ext === '.txt') {
        text = req.file.buffer.toString('utf-8');
      } else if (ext === '.pdf') {
        try {
          const data = await pdfParse(req.file.buffer);
          text = data.text;
          if (!text || !text.trim()) {
            return res.status(400).json({ error: 'Could not extract text from this PDF. It may be image-based or scanned. Try copying the text and pasting it instead.' });
          }
        } catch (pdfErr) {
          console.error('[PDF PARSE ERROR]', pdfErr.message);
          return res.status(400).json({ error: 'Could not read this PDF. Try saving it as a DOCX or pasting the text directly.' });
        }
      } else if (ext === '.docx') {
        try {
          const result = await mammoth.extractRawText({ buffer: req.file.buffer });
          text = result.value;
          if (!text || !text.trim()) {
            return res.status(400).json({ error: 'Could not extract text from this DOCX. The file may be empty or corrupted.' });
          }
        } catch (docxErr) {
          console.error('[DOCX PARSE ERROR]', docxErr.message);
          return res.status(400).json({ error: 'Could not read this DOCX file. Try pasting the text directly.' });
        }
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Use PDF, DOCX, or TXT.' });
      }

      const wordCount = countWords(text);
      const tier = getTier(wordCount);
      res.json({ text, wordCount, tier: tier.name, price: tier.price });
    } catch (err) {
      console.error('[PARSE ERROR]', err.message, err.stack);
      res.status(500).json({ error: 'Failed to parse file. Try pasting text instead.' });
    }
  });
});

// ===== GENERATE PDF FROM EXISTING REVIEW (zero API calls — instant) =====
app.post('/api/generate-pdf', async (req, res) => {
  const { reviewMarkdown, wordCount, tier } = req.body;
  if (!reviewMarkdown) return res.status(400).json({ error: 'No review data provided' });

  try {
    const { generatePdfFromMarkdown } = require('./pdf-generator');
    const pdfBuffer = await generatePdfFromMarkdown(reviewMarkdown, wordCount, tier);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ruthless-mentor-review.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[PDF GEN ERROR]', err.message);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// ===== EMAIL PDF =====
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.post('/api/email-pdf', optionalAuth, async (req, res) => {
  const { text, email } = req.body;
  if (!text || !email) return res.status(400).json({ error: 'Text and email required' });
  if (!resend) return res.status(503).json({ error: 'Email service not configured' });

  const wordCount = countWords(text);
  const tier = getTier(wordCount);

  console.log(`[EMAIL PDF] Generating for ${email} | ${wordCount} words`);

  try {
    // Generate structured review
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: `Review this manuscript (${wordCount} words, "${tier.name}" category):\n\n---\n\n${text}\n\n---\n\nReturn ONLY a valid JSON object following the exact structure in your instructions.`
      }],
      system: PDF_REVIEW_PROMPT
    });

    let reviewText = message.content[0].text.trim();
    reviewText = reviewText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    const reviewData = JSON.parse(reviewText);
    reviewData.wordCount = `~${wordCount.toLocaleString()} words`;

    // Generate PDF
    const pdfBuffer = await generatePdf(reviewData);

    // Send email
    const { error } = await resend.emails.send({
      from: 'Ruthless Mentor <reviews@ruthlessmentor.com>',
      to: email,
      subject: 'Your Ruthless Mentor Review — ' + (reviewData.title || 'Manuscript'),
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#8b0000">Your review is attached.</h2>
        <p>We reviewed your ${tier.name} manuscript (~${wordCount.toLocaleString()} words).</p>
        <p>Open the PDF for the full branded report with scores, character grades, line-level fixes, and your final verdict.</p>
        <p style="color:#888;font-size:12px;margin-top:30px">— Ruthless Mentor | ruthlessmentor.com</p>
      </div>`,
      attachments: [{
        filename: 'ruthless-mentor-review.pdf',
        content: pdfBuffer.toString('base64'),
      }]
    });

    if (error) {
      console.error('[RESEND ERROR]', error);
      return res.status(500).json({ error: 'Failed to send email. Try downloading the PDF instead.' });
    }

    res.json({ success: true, message: 'PDF sent to ' + email });
  } catch (err) {
    console.error('[EMAIL PDF ERROR]', err.message);
    res.status(500).json({ error: 'Failed to generate and send PDF. Try downloading instead.' });
  }
});

// ===== COUPON CODES =====
const COUPONS = {
  'BETATEST': { type: 'free', discount: 100, message: 'Beta test code applied — this review is free!' },
  'FIRST50': { type: 'percent', discount: 50, message: '50% off applied!' },
  'LAUNCH': { type: 'fixed', discount: 5, message: '$5 off applied!' },
};

app.post('/api/coupon', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const coupon = COUPONS[code.trim().toUpperCase()];
  if (!coupon) return res.status(400).json({ error: 'Invalid coupon code' });

  res.json(coupon);
});

// Word count + tier endpoint (no auth needed)
app.post('/api/tier', (req, res) => {
  const { text } = req.body;
  const wordCount = countWords(text || '');
  const tier = getTier(wordCount);
  res.json({ wordCount, tier: tier.name, price: tier.price });
});

// Catch-all: serve index.html for any non-API route
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && req.method === 'GET') {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    next();
  }
});

// Global error handler — always return JSON for API routes
app.use((err, req, res, next) => {
  console.error('[UNHANDLED ERROR]', err.message, err.stack);
  if (req.path.startsWith('/api')) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  } else {
    next(err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ruthless Mentor server running on http://localhost:${PORT}`);
});
