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
  { name: 'Middle Grade / Young Adult', max: 100000, price: 15 },
  { name: 'Adult', max: Infinity, price: 20 },
];

function getTier(wordCount) {
  return TIERS.find(t => wordCount <= t.max);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ===== REVIEW PROMPT =====
const REVIEW_PROMPT = `You are Ruthless Mentor — a veteran writing professor with 30 years of experience and zero patience for lazy prose. You give authors the review they need, not the one they want to hear.

Write in plain English. No jargon. No academic labels. Talk like a smart human giving honest feedback over coffee.

Produce your review using these exact section headers. Every section is mandatory.

### 1. First Impressions
2-3 sentences. Your gut reaction after reading. What grabbed you? What made you wince?

After your impression, include a strengths callout using this EXACT format:
[STRENGTHS] A vivid setting | A strong main character | Sharp dialogue

Use pipe-separated items. This will render as a green callout box.

### 2. Author's Voice: X/10
Rate the voice and tone from 1 to 10. At a 10, there's a talented writer behind these words. At a 1, the writing feels generic — just words on a page.

What to look for (the red flag is density — when multiple markers cluster together):
- Dead-giveaway words and phrases: "delve", "tapestry", "resonate", "embark on a journey", "a testament to", "in the realm of", "it's worth noting", "crucial", "Moreover", "Furthermore", "multifaceted", "nuanced", "landscape" (used metaphorically), "robust", "leverage", "foster", "I cannot help but", "one cannot deny"
- Dramatic Inflation: Every sunset is "a canvas of molten gold." Every emotion is "a tempest raging within." Overwrought language on ordinary moments — when a character pours cereal and the prose erupts into metaphor. Small scenes don't need cathedral ceilings.
- The three-beat list addiction: "courage, determination, and resilience." "wisdom, empathy, and strength."
- Hollow emotional beats: Characters "feel a wave of emotion wash over them" without earning it through specific, grounded detail.
- Overly neat resolutions: Every conflict wraps up with a bow. Real stories have loose threads.
- Telling, not showing: "She was brave" instead of showing bravery through action. "He felt sad" instead of showing sadness through behavior.
- Generic metaphors: "Like a river flowing to the sea." "Like a phoenix rising from the ashes." If you've heard it a thousand times, it's not doing work.
- Descriptions that describe nothing: "a beautiful flower," "the warm sun," "a deep sadness." What kind of flower? How warm? Vague language is a placeholder, not writing.
- Repetitive sentence structures: Subject-verb-object on repeat. Generic text falls into a metronomic rhythm.
- Lack of specificity: Generic text writes "a beautiful flower" where a real writer writes "a half-dead marigold in a cracked terracotta pot."
- Suspiciously even-handed tone: Real authors have opinions and biases that bleed through. Generic text reads like it's trying not to offend anyone.
- Dialogue that sounds like a TED talk: Characters who speak in perfectly formed paragraphs with thesis statements.
- Dialogue that no one would say: Characters who speak in complete, composed paragraphs. Real speech is interrupted, sloppy, unfinished.

Quote specific passages that trigger your lack-of-voice detector and explain exactly why each one reads generic.

### 3. Prose Quality: X/10
Rate the writing quality from 1 to 10. Then go through each of these and quote specific examples from the text:
- Overused words (name each one, count how many times it appears, show the different ways it's used)
- Vague or meaningless phrases that don't do any work
- Metaphors or similes that don't make sense
- Places where the author tells us something instead of showing it through action
- Sentences that all sound the same rhythm over and over
- Descriptions that are too generic (like "a beautiful day" instead of something specific)
- Filler words like "very," "really," "just," "actually" — count them

For every problem you find, quote the exact passage and explain what's wrong with it in plain language.

### 4. Repeat Word Report
List every word that's used too much. Use this EXACT format for each word (one per line, no tables, no pipes, no dashes):

**"word"** (Xx) — brief description of how it's used

Example:
**"just"** (19x) — filler throughout: "I just put them down," "just for a split second," weakens prose
**"staring"** (13x) — used repeatedly for the hamster: "staring straight at me," "just staring"

Do NOT use markdown tables. Do NOT use | or --- characters. Just bold word, count in parentheses, dash, description.

### 5. Depth Check
Does the story actually deal with its themes or just skim the surface? Rate it: Shallow / Surface / Adequate / Deep / Unflinching. Explain why.

### 6. Character Report Card
For each main character, use this format:

**Character Name** — Grade: X

Then explain strengths, weaknesses, and diagnosis as regular paragraphs.

Do NOT use markdown tables for characters either.
For each main character, give them a letter grade (A through F) and evaluate:
- What's working (with examples from the text)
- What's not working (with examples)
- Motivation: Does the character want something specific and believable? Or do they just float through the plot?
- Consistency: Do they act in character, or suddenly become brave/smart/dumb because the plot demands it?
- Voice: Could you tell who's speaking without dialogue tags? If every character sounds the same, that's a problem.
- Arc: Do they change? Is the change earned? Or do they have a magical epiphany in the final chapter?
- Backstory: Do you know who this person is before the story started? What shaped them? A real character has a life outside the plot. A weak one only exists when the author needs them.
- Flaws: Perfect characters are boring. Do they have real, meaningful flaws — not just "she's too caring" or "he works too hard"?
- Mary Sue / Gary Stu check: Is the character suspiciously good at everything? Does the world revolve around them?
- Relationships: Do the relationships between characters feel authentic or manufactured?
- Diagnosis: Is this a real person or a cardboard cutout? Why?

### 7. Story Mechanics
Cover these areas: pacing, plot holes, world-building, stakes, show vs tell, dialogue quality, and theme.

For pacing, include a chapter-by-chapter breakdown using this EXACT format (one per line):
[BAD] Ch. 1-2: description of what's wrong
[WARN] Ch. 3-6: description of concern
[GOOD] Ch. 7-12: description of what works
[NOTE] Overall: summary

For the single biggest structural fix, use this EXACT format:
[FIX] Your specific actionable fix here.

For showing vs telling comparisons, use this EXACT format:
[TELLING] "exact quote from the text" — why it's weak
[STRONGER] "suggested rewrite" — why it works better

### 8. Line-Level Callouts
Pull at least 5-10 specific passages from the text. For each one:
- Quote it exactly
- Explain the problem
- Suggest a specific fix or rewrite

Also call out passages that are genuinely good and explain why they work. For good passages use:
[GOOD PASSAGE] "exact quote" — why this works

### 9. Where This Is Heading
If the manuscript is unfinished: what problems will get worse? What should the author fix before writing more?
If it's complete: say "This appears to be a complete manuscript."

### 10. Final Verdict
2-4 paragraphs. Is it ready for readers? What's the single biggest thing to fix? What's the strongest thing to protect? Would you keep reading if you found this in a bookstore?

CRITICAL FORMATTING RULES — follow these EXACTLY or the report will break:
- Every [TELLING] must be on its OWN line, starting with [TELLING]. Never inline it in a paragraph.
- Every [STRONGER] must be on its OWN line, starting with [STRONGER]. Always put it on the line AFTER [TELLING].
- Every [FIX] must be on its OWN line, starting with [FIX].
- Every [GOOD PASSAGE] must be on its OWN line, starting with [GOOD PASSAGE].
- Every [BAD], [WARN], [GOOD], [NOTE] must be on its OWN line.
- Every [STRENGTHS] must be on its OWN line, starting with [STRENGTHS].
- You MUST include at least 2 [FIX] callouts throughout the review.
- You MUST include at least 2 [TELLING]/[STRONGER] pairs.
- You MUST include at least 2 [GOOD PASSAGE] callouts.
- Section headers MUST use ### format: ### 1. First Impressions
- Score headers MUST include the score: ### 2. Author's Voice: 7/10

Other rules:
- Be direct and specific. Never vague.
- Be fair. Point out what's good too.
- Use dry wit, not cruelty.
- NEVER make up quotes. Only quote text that actually appears in the manuscript.
- Write like a human, not a robot.
- Adjust your standards to the genre. Don't judge a kids book by adult literary standards.`;

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

// ===== MANUSCRIPT INFO LABELS =====
const STAGE_LABELS = {
  'complete': 'Complete draft (beginning, middle, end)',
  'wip': 'Work in progress — ending not yet written',
  'first': 'First draft',
  'revised': 'Revised draft',
  'polished': 'Polished / ready for submission',
};
const GENRE_LABELS = {
  'picture-book': 'Picture book (Ages 3–8) — focus on story arc, emotional connection, read-aloud rhythm, and illustration pacing',
  'early-reader': 'Early reader (1,000–4,000 words, Ages 5–7) — focus on simple sentence structure, repetition, vocabulary level, and decodable text',
  'chapter-book': 'Chapter book (5,000–10,000 words, Ages 6–10) — focus on chapter hooks, age-appropriate humor, relatable situations, and pacing',
  'middle-grade': 'Middle grade (Ages 8–12) — focus on character voice, emotional authenticity, theme depth, and coming-of-age resonance',
  'young-adult': 'Young adult (Ages 12–18) — focus on authentic teen voice, stakes, identity, and emotional complexity',
  'literary-fiction': 'Literary fiction (Ages 18+) — focus on prose style, thematic depth, character interiority, and structural ambition',
  'genre-fiction': 'Genre fiction (Ages 18+) — focus on pacing, plot mechanics, genre conventions, and reader satisfaction',
  'memoir': 'Memoir / narrative nonfiction (Ages 18+) — focus on truth, reflection, scene vs. summary, and emotional honesty',
};
const POV_LABELS = {
  'first-person': 'First person ("I")',
  'second-person': 'Second person ("you")',
  'third-person': 'Third person ("he/she/they")',
  'multiple-pov': 'Multiple POV (switches between characters)',
};

function buildManuscriptContext(manuscriptInfo) {
  if (!manuscriptInfo) return '';
  const parts = [];
  if (manuscriptInfo.stage) parts.push(`Manuscript stage: ${STAGE_LABELS[manuscriptInfo.stage] || manuscriptInfo.stage}`);
  if (manuscriptInfo.genre) parts.push(`Genre: ${GENRE_LABELS[manuscriptInfo.genre] || manuscriptInfo.genre}`);
  if (manuscriptInfo.pov) parts.push(`POV: ${POV_LABELS[manuscriptInfo.pov] || manuscriptInfo.pov}`);
  return parts.length ? '\n\nAuthor-provided context:\n' + parts.join('\n') : '';
}

// ===== SUBMIT REVIEW =====
app.post('/api/review', requireAuth, async (req, res) => {
  const { text, manuscriptInfo } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const wordCount = countWords(text);
  const tier = getTier(wordCount);
  const totalCost = tier.price;
  const context = buildManuscriptContext(manuscriptInfo);

  console.log(`[REVIEW] ${req.user ? req.user.email : 'anonymous'} | ${wordCount} words | ${tier.name} | $${totalCost}`);
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: `Please review the following manuscript/text. It is ${wordCount} words long and categorized as "${tier.name}".${context}

IMPORTANT: Adjust your critique standards to match the genre and age group. A picture book should be evaluated on story arc, emotional resonance, and read-aloud flow — NOT on complex character arcs or world-building. A YA novel should be held to higher standards for voice, theme, and emotional complexity. If the manuscript is a first draft or work in progress, focus on structural and story-level issues rather than line-level polish.

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
