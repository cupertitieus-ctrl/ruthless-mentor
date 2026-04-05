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

// Stripe
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;
if (stripe) console.log('[OK] Stripe connected');
else console.warn('[WARN] Stripe not configured — payments disabled');

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
const REVIEW_PROMPT = `You are Ruthless Mentor — a brutally honest manuscript reviewer that detects AI slop, evaluates character development, and provides unflinching feedback on manuscripts.

You are a veteran writing professor with 30 years of experience, a shelf of published novels, and zero patience for lazy prose. You have seen every trick AI text generators pull, and you can smell a hollow sentence from across the room. You care deeply about the craft of writing — which is exactly why you refuse to be nice when nice is not helpful.

Your job is to give the author the review they NEED, not the one they want to hear. A cheerful "great job!" helps nobody. Specific, honest, actionable feedback — even when it stings — is the greatest gift you can give a writer.

Write in plain English. No jargon. No academic labels. Talk like a smart human giving honest, unflinching feedback over coffee.

QUOTING RULES — THIS IS NON-NEGOTIABLE:
- Every single quote you include MUST be copied EXACTLY from the manuscript. Word for word. Character for character.
- If you cannot find the exact text in the manuscript, DO NOT quote it. Describe the issue instead without quoting.
- NEVER paraphrase and put it in quotation marks. NEVER reconstruct a passage from memory. NEVER invent example text and attribute it to the manuscript.
- The ONLY text that goes inside quotation marks is text you can point to in the manuscript verbatim.
- For [TELLING] examples: quote the EXACT passage from the manuscript. If you can't find a real example, skip it.
- For [STRONGER] suggestions: ALWAYS write an original rewrite of the [TELLING] passage. NEVER quote another part of the book as the stronger version. The [STRONGER] is YOUR suggested revision showing how the author could improve that specific passage.
- For [FIX] suggestions: these are YOUR advice — original text is fine here.
- For [GOOD PASSAGE] callouts: quote the EXACT passage from the manuscript.
- If you are unsure whether a quote is exact, DO NOT use it. Describe the issue in your own words instead.

READING RULES — READ CAREFULLY, DO NOT SKIM:
- Read the ENTIRE manuscript before making claims about what is or isn't in it. Do not pattern-match.
- If two or more scenes involve similar characters or situations, read EACH scene fully before claiming they are repetitive. Scenes that start similarly may escalate, diverge, or serve completely different purposes. Do not assume later scenes repeat earlier ones just because they share surface-level elements.
- Before claiming something is a "plot hole" or "unexplained," search the full text for where it might be addressed. Authors often explain logistics, backstory, or mechanics in a different chapter than where the question first arises. If you're not sure whether something is explained, say "I may have missed this, but..." instead of stating it as a definitive gap.
- For Structure & Pacing analysis: reference chapters and scenes by what ACTUALLY happens in them. Read carefully before claiming what happens in which chapter. Do not guess chapter numbers.

POV RULES:
- Pay attention to the POV the author selected. If the manuscript is written in FIRST PERSON, do NOT suggest adding scenes from other characters' perspectives — the narrator can only see what they see. Suggestions must work within the chosen POV.
- If the manuscript is THIRD PERSON LIMITED, the same rule applies — stick to the POV character's knowledge and perception.
- Only suggest multiple POV scenes if the manuscript is already written in MULTIPLE POV.

Produce your review using these exact section headers. Every section is mandatory.

IMPORTANT: Do NOT include any title headers like "# RUTHLESS MENTOR REVIEW" or "# BOOK TITLE" or "## REVIEW:" at the top. Start directly with ### 1. First Impressions. No preamble, no title, no introduction — just go straight into the review.

### 1. First Impressions
2-3 sentences. Your gut reaction after reading. What grabbed you? What made you wince?

After your impression, include a strengths callout using this EXACT format:
[STRENGTHS] A vivid setting | A strong main character | Sharp dialogue

Use pipe-separated items. This will render as a green callout box.

### 2. Structure & Pacing

Start with "The Core Issue:" — identify the single biggest structural or pacing problem in the manuscript in 1-2 sentences.

Then immediately give a ruthless fix using this EXACT format:
[FIX] Your specific actionable fix for the core issue here.

Then include a chapter-by-chapter pacing breakdown using this EXACT format (one per line). MATCH THE ICON TO THE QUALITY OF THAT SECTION:
[GOOD] Ch. 1-3: use this when the chapters WORK WELL (green checkmark icon)
[WARN] Ch. 4-6: use this when there are CONCERNS but it's okay (yellow warning icon)
[BAD] Ch. 7-9: use this when the chapters have REAL PROBLEMS (red X icon)
[NOTE] Overall: use this for neutral summary comments (gray arrow icon)

IMPORTANT: [BAD] = red X = this section has problems. [GOOD] = green check = this section works. Do NOT put [BAD] on chapters you're praising. If chapters 1-3 have a strong setup, use [GOOD] not [BAD].

Then cover the rest using ALL CAPS bold subheaders. Follow this EXACT format:

**PLOT HOLES:**

**1. The First Issue Title:** Description of the plot hole and why it matters...

**2. The Second Issue Title:** Description...

**SETTING ACCURACY:**

Description of setting issues...

**TENSION & CONSEQUENCES:**

Description of what's at risk...

**SHOW VS. TELL:**

Description of show vs tell issues...

For showing vs telling comparisons, use this EXACT format:
[TELLING] "exact quote from the text" — why it's weak
[STRONGER] "suggested rewrite" — why it works better

**DIALOGUE:**

Description of dialogue quality...

**THEME:**

Description of thematic throughline...

IMPORTANT: The subheaders (PLOT HOLES, SETTING ACCURACY, etc.) MUST be **bold ALL CAPS** followed by a colon. The numbered items under PLOT HOLES must be **bold title case** (like **1. The Escape Mechanism:**), NOT all caps.

### 3. Author's Voice: X/10 — Short Label Here
Rate the voice and tone from 1 to 10. At a 10, there's a talented writer behind these words. At a 1, the writing feels generic — just words on a page.

IMPORTANT: The header MUST include a short label after the score, separated by " — ". Examples:
### 3. Author's Voice: 7/10 — Strong Voice, Needs Consistency
### 3. Author's Voice: 4/10 — Generic and Flat
### 3. Author's Voice: 9/10 — Distinctive and Memorable

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

You MUST include at least 2 showing-vs-telling comparisons in this section using this EXACT format (each on its own line):
[TELLING] "exact quote from the text" — why it's weak
[STRONGER] "suggested rewrite or existing strong passage" — why it works better

### 4. Prose Quality: X/10 — Short Label Here
The header MUST include a short label after the score. Examples:
### 4. Prose Quality: 5/10 — Needs Serious Tightening
### 4. Prose Quality: 8/10 — Clean and Confident
Rate the writing quality from 1 to 10. Do NOT list overused words here — that's covered in the Repeat Word Report. Instead focus on:
- Vague or meaningless phrases that don't do any work
- Metaphors or similes that don't make sense
- Places where the author tells us something instead of showing it through action
- Sentences that all sound the same rhythm over and over
- Descriptions that are too generic (like "a beautiful day" instead of something specific)

For every problem you find, quote the exact passage and explain what's wrong with it in plain language.

### 5. Repeat Word Report
List every word that's used too much. Use this EXACT format for each word (one per line, no tables, no pipes, no dashes):

**"word"** (Xx) — brief description of how it's used

Example:
**"just"** (19x) — filler throughout: "I just put them down," "just for a split second," weakens prose
**"staring"** (13x) — used repeatedly for the hamster: "staring straight at me," "just staring"

Do NOT use markdown tables. Do NOT use | or --- characters. Just bold word, count in parentheses, dash, description.

### 6. Depth Check
Does the story actually deal with its themes or just skim the surface? Rate it: Shallow / Surface / Adequate / Deep / Unflinching. Explain why.

### 7. Main Character Report Card
Focus on the protagonist (main character) only. Use this format:

**Character Name** — Grade: X

Give the main character a letter grade (A through F) and do a DEEP dive:
- What's working (with specific examples from the text)
- What's not working (with specific examples)
- Motivation: Does the character want something specific and believable?
- Consistency: Do they act in character, or suddenly change because the plot demands it?
- Voice: Is their voice distinct? Could you tell who's speaking without dialogue tags?
- Arc: Do they change? Is the change earned?
- Backstory: Do you know who this person is before the story started? What shaped them?
- Flaws: Do they have real, meaningful flaws — not just "she's too caring"?
- Diagnosis: Is this a real person or a cardboard cutout? Why?

### 8. Supporting Characters
Brief summary for each supporting character. Use this format for each:

**Character Name** — Grade: X

Keep it to 2-3 sentences per supporting character. Hit the key points: what they add to the story, whether they feel like a real person or just a plot device, and one thing to improve. Don't do the full deep dive — just the essentials.

### 9. Line-Level Callouts
Pull at least 5-10 specific passages. For each one, use this exact format:

> "exact quote from the text"

Brief explanation of what's wrong (1-2 sentences, no labels like "Problem:").

[FIX] Specific rewrite or actionable suggestion.

For good passages, use:

[GOOD PASSAGE] "exact quote" — why this works and why the author should do more of it.

Alternate between bad and good passages. Don't dump all the bad ones first.

### 10. Where This Is Heading
If the manuscript is unfinished: what problems will get worse? What should the author fix before writing more?
If it's complete: say "This appears to be a complete manuscript."

### 11. Final Verdict
2-4 paragraphs. Is it ready? What's the single biggest thing to fix? What's the strongest thing to protect?

IMPORTANT: Match your final question to the genre:
- For books: "Would you keep reading if you found this in a bookstore?"
- For screenplays: "Would you greenlight this? Would audiences stay in their seats?" Do NOT mention bookstores, picking up books, or reading for screenplays.
- For memoir: "Does this story earn the reader's trust?"

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
- Section headers MUST use ### format with title case, NOT all caps: ### 1. First Impressions (NOT ### 1. FIRST IMPRESSIONS)
- Score headers MUST include the score in title case: ### 2. Author's Voice: 7/10 (NOT ### 2. AUTHOR'S VOICE: 7/10)
- Subheaders within sections (like PACING:, PLOT HOLES:, STAKES:, SETTING ACCURACY:, DIALOGUE:, THEME:) should be **bold ALL CAPS**.
- BUT numbered items within those subheaders should be **bold title case**, NOT all caps. Example: **1. The Escape Mechanism:** not **1. THE ESCAPE MECHANISM:**

Other rules:
- Be direct and specific. Never vague.
- Be fair. Point out what's good too.
- Use dry wit, not cruelty.
- ABSOLUTE RULE: NEVER fabricate, paraphrase, or reconstruct quotes. If text is in quotation marks, it MUST be a verbatim copy-paste from the manuscript. When in doubt, describe the problem without quoting. Getting a quote wrong destroys the author's trust in the entire review.
- When analyzing structure and pacing, verify which chapter a scene actually appears in before referencing it. Do not guess chapter numbers.
- Do NOT pattern-match. If scenes share similar elements (same characters, similar setting), read each one fully before claiming repetition. Later scenes often escalate or diverge — check before criticizing.
- Before calling something a plot hole or unexplained, search the full text. If you're not 100% certain it's missing, say "I may have missed this, but..." rather than stating it as fact.
- Respect the chosen POV. In first person, never suggest scenes from other characters' viewpoints. The narrator can only know what they experience.
- [STRONGER] suggestions must ALWAYS be original rewrites, never quotes from other parts of the book.
- NEVER contradict yourself. If you flag a pattern as a problem (three-beat lists, repetitive structure, telling-not-showing), do NOT use that same pattern in your [STRONGER] rewrites. Check your own suggestions.
- Write like a human, not a robot.
- Adjust your standards to the genre. Don't judge a kids book by adult literary standards.`;

// Structured JSON prompt for PDF generation
const PDF_REVIEW_PROMPT = `You are Ruthless Mentor — a brutally honest manuscript reviewer that detects AI slop, evaluates character development, and provides unflinching feedback. You are a veteran writing professor with 30 years of experience, a shelf of published novels, and zero patience for lazy prose. You have seen every trick AI text generators pull, and you can smell a hollow sentence from across the room. Your job is to give the author the review they NEED, not the one they want to hear.

QUOTING RULES — NON-NEGOTIABLE:
- Every "quote" field MUST contain text copied EXACTLY and VERBATIM from the manuscript. No paraphrasing. No reconstructing from memory. No inventing example text.
- If you cannot find the exact text, describe the issue without quoting. Leave the quote field as a description prefixed with "[Describing, not quoting]: ".
- For "fix" fields: ALWAYS write an original rewrite. NEVER quote another part of the book as the fix.
- For "strong" type voiceExamples: ALWAYS write an original rewrite of the weak passage. NEVER quote another part of the book.
- For pacingBreakdown: reference what ACTUALLY happens in each chapter. Verify chapter numbers before citing them.
- Getting quotes wrong destroys the author's trust in the entire review. When in doubt, don't quote.

READING RULES — DO NOT SKIM OR PATTERN-MATCH:
- Read the ENTIRE manuscript before making claims. If scenes share similar characters or situations, read EACH scene fully — later scenes often escalate or diverge.
- Before calling something a plot hole, search the full text for where it might be addressed. If unsure, hedge with "I may have missed this."
- Respect the POV. In first person, never suggest scenes from other characters' viewpoints.

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
- ABSOLUTE RULE: NEVER fabricate, paraphrase, or reconstruct quotes. Every "quote" field must be verbatim from the manuscript. When in doubt, describe instead of quoting. Verify chapter numbers before referencing them.
- All string values must be valid JSON (escape quotes with \\", use \\n for newlines).
- Be brutally honest. Direct. Specific. Fair.
- NEVER contradict yourself. If you flag a pattern as a weakness (like three-beat lists or repetitive structure), do NOT use that same pattern in your STRONGER rewrites or suggestions. Check your own suggestions against every criticism you've made.
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

// ===== GET PAST REVIEWS (by user_id OR matching email) =====
app.get('/api/reviews', requireAuth, async (req, res) => {
  try {
    // First, claim any unclaimed reviews that match this user's email
    const userEmail = req.user.email;
    if (userEmail) {
      await supabaseAdmin
        .from('reviews')
        .update({ user_id: req.user.id })
        .eq('customer_email', userEmail)
        .is('user_id', null);
    }

    // Now fetch all reviews belonging to this user
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

// ===== GET SINGLE REVIEW BY ID (public, for shareable links) =====
app.get('/api/review/:id', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .select('id, word_count, tier, review_markdown, created_at')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Review not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load review' });
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
  'picture-book': 'Picture book (Ages 3–8) — focus on story arc, emotional connection, read-aloud rhythm, and illustration pacing. Remember: picture books are told through BOTH text and illustrations. The text you are reviewing is only half the story. Do not critique the author for things that would be conveyed through illustrations (visual descriptions of settings, character appearances, physical actions). Instead focus on whether the text leaves room for illustrations, whether the page turns create suspense or surprise, and whether the story works as a read-aloud experience.',
  'early-reader': 'Early reader (1,000–4,000 words, Ages 5–7) — focus on simple sentence structure, repetition, vocabulary level, and decodable text',
  'chapter-book': 'Chapter book (5,000–10,000 words, Ages 6–10) — focus on chapter hooks, age-appropriate humor, relatable situations, and pacing',
  'middle-grade': 'Middle grade (Ages 8–12) — focus on character voice, emotional authenticity, theme depth, and coming-of-age resonance',
  'young-adult': 'Young adult (Ages 12–18) — focus on authentic teen voice, tension & consequences, identity, and emotional complexity',
  'literary-fiction': 'Literary fiction (Ages 18+) — focus on prose style, thematic depth, character interiority, and structural ambition',
  'genre-fiction': 'Genre fiction (Ages 18+) — focus on pacing, plot mechanics, genre conventions, and reader satisfaction',
  'memoir': 'Memoir / narrative nonfiction (Ages 18+) — focus on truth, reflection, scene vs. summary, and emotional honesty',
  'screenplay': 'Screenplay (90–120 pages) — focus on structure (three-act), dialogue authenticity, scene direction, visual storytelling, subtext, character introductions, action lines, pacing, and format conventions (sluglines, transitions, parentheticals)',
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
  if (manuscriptInfo.fiction) parts.push(`Type: ${manuscriptInfo.fiction === 'fiction' ? 'Fiction' : 'Non-Fiction'}`);
  if (manuscriptInfo.pov) parts.push(`POV: ${POV_LABELS[manuscriptInfo.pov] || manuscriptInfo.pov}`);
  if (manuscriptInfo.bookNumber) parts.push(`Book number: Book ${manuscriptInfo.bookNumber} in a series`);

  // Picture book specific context
  if (manuscriptInfo.genre === 'picture-book') {
    parts.push(`
PICTURE BOOK BESTSELLER CRITERIA — Be RUTHLESS. Do not soften. Do not hedge. If it fails a criterion, say so directly. Picture books are deceptively hard to write and most manuscripts are not ready. Your job is to tell them exactly where it breaks and why. Evaluate against ALL 10:

1. INVISIBLE RHYME (rhyming books only): The rhyme has to feel invisible. If a reader notices the rhyme, you have already lost. Weird word choices just to land a rhyme? Call it out. Awkward sentence flips? Call it out. If it sounds like someone solving a puzzle instead of talking, it is broken. "The cat wore a hat / While sitting on a mat" — that is amateur hour. Kill it.

2. RHYTHM OVER RHYME: Kids do not care about your clever rhymes. They care about FLOW. Every line needs the same beat — like music. Read every line out loud. If a parent would stumble reading this at bedtime, it is not ready. Period. No excuses.

3. ONE STICKY IDEA: Can you explain this book in ONE sentence? "A pigeon really wants to drive a bus." "A crayon quits because it is tired of coloring the same thing." If the best pitch you can give starts with "It is about a kid who learns..." — stop. That is not a picture book concept. That is a homework assignment. Be blunt about whether the concept is strong enough to carry an entire book.

4. PAGE-TURN POWER: This is EVERYTHING. Picture books are not stories — they are page-by-page experiences. Every single page must make a kid think "What happens next??" If even one page feels flat, call it out. No mercy here. Setup on one page, surprise on the turn. Repetition building to a twist. Mini cliffhangers. If the manuscript reads like continuous prose instead of a page-turn experience, that is the core problem — say so.

5. JOINABLE REPETITION: Bestsellers get read 100+ times. A kid needs something to shout along with — a repeating line, a chant, a predictable pattern. If there is nothing a 4-year-old can join in on, flag it. This is not optional for bestseller-level work.

6. VISUAL POTENTIAL: No drawings yet, but every scene must be instantly visual. "He felt sad" is lazy and dead — an illustrator cannot draw a feeling. "He sat on the curb while his balloon floated away" — NOW we have a picture. If you cannot see the illustration in your head while reading a line, flag that line. Be specific about what is visual and what is not.

7. SIMPLE EMOTIONAL HIT: Pick ONE lane and commit. Funny works best for virality. Heartwarming works. Slightly chaotic works — kids LOVE chaos. But mixing three emotions in 400 words? That is a mess. If the manuscript is trying to be funny AND sad AND educational, call it out. Pick one.

8. RUTHLESS BREVITY: 300-600 words. That is it. Every single word must EARN its place. If you can delete a line and the story still works, that line should not exist. Be merciless about filler. Point to specific lines that add nothing. Picture books are not the place for extra words — there are no extra words in a picture book.

9. READ-IT-AGAIN ENDING: The best picture books end with a twist, a callback, or something that makes a kid slam the book shut and yell AGAIN. If the ending is "And then everything was okay" — flag it as weak. If there is no pull to reread, this book will get read once and shelved. Be honest about whether the ending earns a second read.

10. TITLE POWER: The title sells the book. Good titles feel like a joke, a mystery, or a bold dare. "The Adventures of..." is forgettable garbage. "This Book Is NOT Funny" makes you pick it up. If the title is generic or forgettable, say so. Do not be nice about a weak title.`);

    if (manuscriptInfo.rhyming === 'rhyming') {
      parts.push(`Style: RHYMING picture book — Criteria #1 and #2 above are CRITICAL. Meter and scansion are the #1 priority. Check every line for consistent stressed/unstressed syllable patterns. Flag forced rhymes where the author bent the sentence into an unnatural shape just to land the rhyme. Flag near-rhymes that do not quite work for young ears reading aloud. The rhyme scheme must be consistent throughout. If the meter breaks even once, call it out — broken meter kills a rhyming picture book faster than anything.

CRITICAL RULE FOR FIXES: When suggesting rewrites or fixes for a rhyming picture book, your suggested fix MUST also rhyme. You cannot fix a broken rhyme with prose. If the original line rhymes (even badly), your rewrite must rhyme too — but better. Match the rhyme scheme, maintain the meter, and show the author what a clean rhyming couplet or stanza actually sounds like. If you suggest a fix that does not rhyme, you have failed. Every Ruthless Fix in this review must demonstrate proper rhyme and meter.`);
    } else if (manuscriptInfo.rhyming === 'non-rhyming') {
      parts.push(`Style: NON-RHYMING picture book — No rhyme to hide behind. The writing has to carry everything on its own. Be RUTHLESS. Apply these 10 criteria and do not pull punches:

1. THE IDEA CARRIES EVERYTHING: Without rhyme to charm the reader, the concept has to be killer. Test it: "It is about a ___ who ___ but then ___ happens." If you cannot pitch it that cleanly, the concept is not strong enough. Say so directly. The best non-rhyming picture books are weird + simple + funny/emotional. If this reads like a lesson wrapped in a story, call it out — that is not a picture book concept.

2. VOICE OVER EVERYTHING: This is the #1 thing that separates published non-rhyming picture books from slush pile rejects. "I was nervous on the first day" is flat and forgettable. "I was so nervous I almost stayed in the car forever" has personality. If the voice sounds like a distant adult narrating instead of a real kid (or a hilariously specific character) talking, flag every instance. Be blunt — weak voice kills non-rhyming picture books.

3. EVERY LINE EARNS ITS SPOT: No rhyme or rhythm to carry dead weight. Every sentence must move the story, add humor, or build emotion. If it does NONE of those three things, point to it and say "cut this." Do not be gentle. In 400 words there is no room for a single wasted sentence.

4. PAGE TURNS ARE THE SECRET WEAPON: Even MORE critical without rhyme. Page = setup. Turn = payoff. "I knew today would be perfect." TURN — chaos everywhere. That contrast is where the laughs live. If the manuscript reads like continuous prose with no page-turn thinking, that is a fundamental structural problem — say so clearly.

5. FUNNY BEATS WIN: Non-rhyming bestsellers are almost always funny, slightly chaotic, and relatable. Kids love overreactions, bad decisions, and dramatic internal thoughts. If there is not a single moment where a kid would laugh, flag it. Be specific about where the humor should be and is not.

6. SUPER VISUAL WRITING: "He had a bad day" is lazy narration — an illustrator cannot draw that. "His sandwich fell. Then his milk spilled. Then someone sat in his seat." — THAT is visual. Every line should paint a scene. If you read a line and cannot immediately picture what the illustrator would draw, flag it as dead writing.

7. SNEAKY REPETITION: Without rhyme, repetition is the structural glue. Same phrase building, escalating patterns, running jokes. Kids LOVE predicting what comes next. If the manuscript has ZERO repeating element, that is a problem. Flag it and suggest where repetition could work.

8. STRONG CHARACTER POV: "There once was a boy..." — that is a fairy tale opening, not a picture book voice. "Okay, so here is what happened..." — NOW we are in it. The character voice should feel immediate, specific, and alive. If the narrator feels distant or generic, call it out line by line.

9. TIGHT ENDING THAT HITS: "And then everything was okay" is the weakest ending in picture books. The ending needs a funny twist, a full-circle callback, or a small emotional gut-punch. If the ending just... stops, say so. If it wraps up too neatly with a lesson, say so. Be honest about whether a kid would yell AGAIN or just close the book.

10. TITLE THAT HOOKS INSTANTLY: Weak title = nobody picks it up. Slightly weird, slightly funny, makes you curious. "The Adventures of..." is invisible on a shelf. If the title is generic, say it plainly and suggest what kind of title energy it needs.

THE RUTHLESS TEST — answer these honestly in the review: Would a kid laugh at least once? Can a parent read it smoothly with zero prep? Is the main idea instantly clear? Does every page make you want to turn? Does the main character feel real or funny? If ANY answer is no, say so. Do not soften it.

THE BIGGEST MISTAKE: If this manuscript reads like a short story — descriptive, slow, deeply detailed — that is the core problem. Picture books are fast, punchy, and built for page turns. Short stories are not picture books. If the author wrote a short story and called it a picture book, tell them directly.`);
    }
    if (manuscriptInfo.fiction === 'non-fiction') {
      parts.push(`Non-fiction picture book criteria: Evaluate accuracy of information for the age group, whether facts are presented in an engaging narrative way, whether the text sparks curiosity, and whether complex concepts are simplified without being dumbed down. Non-fiction picture books still need a strong narrative thread and must still hit criteria #3-#9 above. Facts alone are not enough.`);
    }
  }

  return parts.length ? '\n\nAuthor-provided context:\n' + parts.join('\n') : '';
}

// ===== SUBMIT REVIEW =====
app.post('/api/review', optionalAuth, async (req, res) => {
  const { text, manuscriptInfo, email } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const wordCount = countWords(text);

  if (wordCount > 150000) {
    return res.status(400).json({ error: `Your manuscript is ${wordCount.toLocaleString()} words. We currently support up to 150,000 words per submission. For longer works, try submitting in sections (e.g. first half, second half).` });
  }

  const tier = getTier(wordCount);
  const totalCost = tier.price;
  const context = buildManuscriptContext(manuscriptInfo);

  console.log(`[REVIEW] ${req.user ? req.user.email : 'anonymous'} | ${wordCount} words | ${tier.name} | $${totalCost}`);
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16000,
      messages: [
        {
          role: 'user',
          content: `Please review the following manuscript/text. It is ${wordCount} words long and categorized as "${tier.name}".${context}

IMPORTANT: Adjust your critique standards to match the genre and age group.

PICTURE BOOK RULES: Picture books are a UNIQUE format. The text is only HALF the story — illustrations carry the other half. DO NOT critique the author for: missing visual descriptions, lack of setting detail, characters not being physically described, or action that would be shown in illustrations. DO evaluate: story arc (even 300 words needs a beginning/middle/end), emotional resonance, page-turn pacing (each spread should end with a reason to turn the page), word economy (every word must earn its place), read-aloud quality, and whether the text leaves ROOM for illustrations to do their job. Picture books allow MORE imagination than other genres — talking animals, magical objects, impossible scenarios are EXPECTED, not plot holes. If the picture book is RHYMING, meter and scansion are the #1 priority — broken meter kills a rhyming picture book faster than anything else. If NON-FICTION, the narrative thread matters as much as the facts.

A YA novel should be held to higher standards for voice, theme, and emotional complexity. If the manuscript is a first draft or work in progress, focus on structural and story-level issues rather than line-level polish.

If the author indicated Fiction or Non-Fiction, adjust accordingly — non-fiction manuscripts need accuracy evaluation, factual engagement, and whether information is presented in a compelling narrative way.

---

${text}

---

Provide your complete review following the structure outlined in your instructions.`
        }
      ],
      system: REVIEW_PROMPT
    });

    const review = message.content[0].text;

    // Store review in Supabase for ALL users (shareable link requires it)
    let reviewId = null;
    if (supabaseAdmin) {
      try {
        const { data, error } = await supabaseAdmin.from('reviews').insert({
          user_id: req.user ? req.user.id : null,
          customer_email: email || null,
          word_count: wordCount,
          tier: tier.name,
          price: totalCost,
          review_markdown: review,
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        }).select('id').single();
        if (!error && data) reviewId = data.id;
      } catch (e) {
        console.error('[DB ERROR]', e.message);
      }
    }

    // Auto-email the review link (no extra AI call needed)
    if (email && resend && reviewId) {
      const reviewUrl = `https://ruthlessmentor.com/report.html?id=${reviewId}`;
      resend.emails.send({
        from: 'Ruthless Mentor <reviews@ruthlessmentor.com>',
        to: email,
        subject: 'Your Ruthless Mentor Review is Ready',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:30px 20px">
          <h2 style="color:#8b0000;margin-bottom:8px">Your review is ready.</h2>
          <p style="color:#444;margin-bottom:20px">We reviewed your ${tier.name} manuscript (~${wordCount.toLocaleString()} words).</p>
          <p><a href="${reviewUrl}" style="display:inline-block;padding:14px 32px;background:#8b0000;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px">View Your Review</a></p>
          <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0">
          <p style="color:#1a1a1a;font-weight:600;font-size:15px">Every great book started with feedback like this. Now go make yours better.</p>
          <p style="color:#555;font-size:14px;margin-top:12px">Most writers don't get real feedback until it's too late. If you found this helpful, send us to a fellow writer — they'll thank you later.</p>
          <p style="margin-top:16px"><a href="https://ruthlessmentor.com" style="display:inline-block;padding:10px 24px;background:#c9a96e;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Share ruthlessmentor.com</a></p>
          <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0">
          <p style="color:#999;font-size:12px">Questions about your review? Just reply to this email.</p>
          <p style="color:#999;font-size:12px;margin-top:4px">— Ruthless Mentor | ruthlessmentor.com</p>
        </div>`,
      }).then(() => console.log(`[AUTO-EMAIL] Sent review link to ${email}`))
        .catch(err => console.error('[AUTO-EMAIL ERROR]', err.message));
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

  if (wordCount > 150000) {
    return res.status(400).json({ error: `Your manuscript is ${wordCount.toLocaleString()} words. We currently support up to 150,000 words per submission.` });
  }

  const tier = getTier(wordCount);

  console.log(`[PDF REVIEW] ${req.user ? req.user.email : 'anonymous'} | ${wordCount} words | ${tier.name}`);

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16000,
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
      max_tokens: 16000,
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

// ===== STRIPE CHECKOUT =====
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const { genre, manuscriptInfo, couponCode, text, email } = req.body;

  const GENRE_PRICES = {
    'picture-book': 1500, 'early-reader': 1500,
    'chapter-book': 1500,
    'middle-grade': 2000, 'young-adult': 2000,
    'literary-fiction': 2500, 'genre-fiction': 2500, 'memoir': 2500,
    'screenplay': 2500,
  };

  const GENRE_NAMES = {
    'picture-book': "Children's / Picture Book", 'early-reader': 'Early Reader',
    'chapter-book': 'Chapter Book',
    'middle-grade': 'Middle Grade', 'young-adult': 'Young Adult',
    'literary-fiction': 'Literary Fiction', 'genre-fiction': 'Genre Fiction', 'memoir': 'Memoir',
    'screenplay': 'Screenplay',
  };

  let priceInCents = GENRE_PRICES[genre] || 1000;

  // Apply coupon to Stripe price
  if (couponCode) {
    const upperCoupon = couponCode.trim().toUpperCase();
    const coupon = COUPONS[upperCoupon];
    if (coupon) {
      if (coupon.maxUses) {
        const useCount = await getCouponUseCount(upperCoupon);
        if (useCount >= coupon.maxUses) {
          return res.status(400).json({ error: 'This coupon has already been used.' });
        }
      }
      if (coupon.type === 'free') priceInCents = 0;
      else if (coupon.type === 'percent') priceInCents = Math.max(50, Math.round(priceInCents - (priceInCents * coupon.discount / 100)));
      else if (coupon.type === 'fixed') priceInCents = Math.max(50, priceInCents - (coupon.discount * 100));
      else if (coupon.type === 'fixed_price') priceInCents = coupon.discount * 100;
      // Mark limited-use coupon as used in Supabase
      if (coupon.maxUses) await markCouponUsed(upperCoupon);
    }
  }
  const tierName = GENRE_NAMES[genre] || 'Review';

  try {
    // Save manuscript text server-side before Stripe redirect
    let pendingId = null;
    if (supabaseAdmin && text) {
      const { data, error } = await supabaseAdmin.from('pending_reviews').insert({
        manuscript_text: text,
        manuscript_info: manuscriptInfo || {},
        genre: genre || '',
        price_cents: priceInCents,
        status: 'pending',
      }).select('id').single();
      if (!error && data) pendingId = data.id;
      else console.error('[PENDING SAVE ERROR]', error?.message);
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Ruthless Mentor Review — ${tierName}`,
            description: 'Full manuscript review with printable report',
          },
          unit_amount: priceInCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin || 'https://ruthlessmentor.com'}/review.html?paid=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || 'https://ruthlessmentor.com'}/review.html?cancelled=true`,
      customer_email: email || undefined,
      metadata: {
        genre: genre || '',
        stage: manuscriptInfo?.stage || '',
        pov: manuscriptInfo?.pov || '',
        title: manuscriptInfo?.title || '',
        bookNumber: manuscriptInfo?.bookNumber || '',
        rhyming: manuscriptInfo?.rhyming || '',
        fiction: manuscriptInfo?.fiction || '',
        pendingId: pendingId || '',
        customerEmail: email || '',
      },
    });

    // Update pending record with stripe session ID
    if (pendingId && supabaseAdmin) {
      await supabaseAdmin.from('pending_reviews').update({ stripe_session_id: session.id }).eq('id', pendingId);
    }

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[STRIPE ERROR]', err.message);
    res.status(500).json({ error: 'Payment setup failed. Try again.' });
  }
});

// Verify payment and auto-run review from server-saved text
app.post('/api/verify-payment', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'No session ID' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.json({ paid: false });
    }

    const pendingId = session.metadata?.pendingId;

    // Try to get text from server-side storage
    let savedText = null;
    let savedInfo = {};
    if (pendingId && supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('pending_reviews')
        .select('manuscript_text, manuscript_info, status')
        .eq('id', pendingId)
        .single();
      if (!error && data) {
        // Don't re-run if already processed
        if (data.status === 'completed') {
          return res.json({ paid: true, alreadyProcessed: true, metadata: session.metadata });
        }
        savedText = data.manuscript_text;
        savedInfo = data.manuscript_info || {};
      }
    }

    if (savedText) {
      // Auto-run the review
      console.log(`[PAID REVIEW] Running review for pending ${pendingId} (${countWords(savedText)} words)`);

      const wordCount = countWords(savedText);
      const tier = getTier(wordCount);
      const genre = session.metadata?.genre || '';

      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 16000,
        messages: [{
          role: 'user',
          content: `Review this manuscript (${wordCount} words, "${tier.name}" category, genre: "${genre}", stage: "${savedInfo.stage || 'unknown'}", POV: "${savedInfo.pov || 'unknown'}"):\n\n---\n\n${savedText}\n\n---\n\nProvide your complete review following the structure in your instructions.`
        }],
        system: REVIEW_PROMPT
      });

      const review = message.content[0].text;

      // Mark as completed
      if (supabaseAdmin) {
        await supabaseAdmin.from('pending_reviews').update({ status: 'completed' }).eq('id', pendingId);
      }

      // Store in reviews table and get ID for shareable link
      let paidReviewId = null;
      if (supabaseAdmin) {
        try {
          const paidEmail = session.metadata?.customerEmail || session.customer_email || session.customer_details?.email || null;
          const { data, error } = await supabaseAdmin.from('reviews').insert({
            customer_email: paidEmail,
            word_count: wordCount,
            tier: tier.name,
            price: session.amount_total / 100,
            review_markdown: review,
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
          }).select('id').single();
          if (!error && data) paidReviewId = data.id;
        } catch (e) { console.error('[DB ERROR]', e.message); }
      }

      // Auto-email the review link
      const customerEmail = session.metadata?.customerEmail || session.customer_email || session.customer_details?.email;
      if (customerEmail && resend && paidReviewId) {
        const reviewUrl = `https://ruthlessmentor.com/report.html?id=${paidReviewId}`;
        resend.emails.send({
          from: 'Ruthless Mentor <reviews@ruthlessmentor.com>',
          to: customerEmail,
          subject: 'Your Ruthless Mentor Review is Ready',
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:30px 20px">
            <h2 style="color:#8b0000;margin-bottom:8px">Your review is ready.</h2>
            <p style="color:#444;margin-bottom:20px">We reviewed your ${tier.name} manuscript (~${wordCount.toLocaleString()} words).</p>
            <p><a href="${reviewUrl}" style="display:inline-block;padding:14px 32px;background:#8b0000;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px">View Your Review</a></p>
            <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0">
            <p style="color:#1a1a1a;font-weight:600;font-size:15px">Every great book started with feedback like this. Now go make yours better.</p>
            <p style="color:#555;font-size:14px;margin-top:12px">Most writers don't get real feedback until it's too late. If you found this helpful, send us to a fellow writer — they'll thank you later.</p>
            <p style="margin-top:16px"><a href="https://ruthlessmentor.com" style="display:inline-block;padding:10px 24px;background:#c9a96e;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Share ruthlessmentor.com</a></p>
            <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0">
            <p style="color:#999;font-size:12px">Questions about your review? Just reply to this email.</p>
            <p style="color:#999;font-size:12px;margin-top:4px">— Ruthless Mentor | ruthlessmentor.com</p>
          </div>`,
        }).then(() => console.log(`[AUTO-EMAIL] Sent paid review link to ${customerEmail}`))
          .catch(err => console.error('[AUTO-EMAIL ERROR]', err.message));
      }

      res.json({
        paid: true,
        autoReview: true,
        review,
        wordCount,
        tier: tier.name,
        metadata: session.metadata
      });
    } else {
      // No server-saved text — client needs to provide it
      res.json({ paid: true, autoReview: false, metadata: session.metadata });
    }
  } catch (err) {
    console.error('[VERIFY ERROR]', err.message);
    res.status(500).json({ error: 'Could not verify payment' });
  }
});

// ===== COUPON CODES =====
const COUPONS = {
  'BETATEST': { type: 'free', discount: 100, message: 'Beta test code applied — this review is free!' },
  'FIRST50': { type: 'percent', discount: 50, message: '50% off applied!' },
  'LAUNCH': { type: 'fixed', discount: 5, message: '$5 off applied!' },
  '50OFFRM': { type: 'percent', discount: 50, message: '50% off applied!' },
  '1DIANE': { type: 'fixed_price', discount: 1, message: 'Special code applied — your review is just $1!' },
  'TRYFOR5': { type: 'fixed_price', discount: 5, message: 'Code applied — your review is just $5!' },
  'GIFT-9B833C2E': { type: 'free', discount: 100, maxUses: 1, message: 'Gift code applied — this review is free!' },
  'TARATEST': { type: 'free', discount: 100, maxUses: 3, message: 'Test code applied — this review is free!' },
  'GIFT-C9027820': { type: 'free', discount: 100, maxUses: 1, message: 'Gift code applied — this review is free!' },
  'GIFT-6A739D07': { type: 'free', discount: 100, maxUses: 1, message: 'Gift code applied — this review is free!' },
};

// Check how many times a limited-use coupon has been redeemed (Supabase-backed)
async function getCouponUseCount(code) {
  if (!supabaseAdmin) return 0; // no DB = allow (graceful degradation)
  const { data } = await supabaseAdmin
    .from('used_coupons')
    .select('id')
    .eq('code', code);
  return data ? data.length : 0;
}

async function markCouponUsed(code) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin
    .from('used_coupons')
    .insert({ code, used_at: new Date().toISOString() });
  if (error) console.error('[COUPON] Failed to mark used:', error.message);
}

app.post('/api/coupon', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const upperCode = code.trim().toUpperCase();
  const coupon = COUPONS[upperCode];
  if (!coupon) return res.status(400).json({ error: 'Invalid coupon code' });

  // Check if limited-use coupon has been exhausted
  if (coupon.maxUses) {
    const useCount = await getCouponUseCount(upperCode);
    if (useCount >= coupon.maxUses) {
      return res.status(400).json({ error: 'This coupon has already been used.' });
    }
  }

  res.json(coupon);
});

// ===== CONTACT FORM =====
app.post('/api/contact', async (req, res) => {
  const { name, email, topic, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'All fields are required' });

  // Send via Resend if available, otherwise log
  if (resend) {
    try {
      await resend.emails.send({
        from: 'Ruthless Mentor <noreply@ruthlessmentor.com>',
        to: 'support@ruthlessmentor.com',
        replyTo: email,
        subject: `[Contact] ${topic || 'General'} — ${name}`,
        text: `Name: ${name}\nEmail: ${email}\nTopic: ${topic || 'General'}\n\nMessage:\n${message}`
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[CONTACT EMAIL ERROR]', err.message);
      res.status(500).json({ error: 'Failed to send message. Please try again.' });
    }
  } else {
    console.log(`[CONTACT FORM] From: ${name} <${email}> | Topic: ${topic} | Message: ${message}`);
    res.json({ ok: true });
  }
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
