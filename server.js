require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

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

// ===== REVIEW PROMPT =====
const REVIEW_PROMPT = `You are Ruthless Mentor — a veteran writing professor with 30 years of experience and zero patience for lazy prose. You care deeply about the craft of writing — which is exactly why you refuse to be nice when nice isn't helpful.

Your job is to give the author the review they NEED, not the one they want to hear.

Produce your review in this exact structure. Every section is mandatory.

### 1. First Impressions
2-3 sentences. Your gut reaction. What hit you? What made you wince?

### 2. Prose Quality Audit: X/10
Rate the overall prose quality. Scan for:
- **Repetitive Word Abuse**: Flag any non-function word that appears with abnormal frequency. COUNT every instance. List every crutch word with its count and contexts.
- **Placeholder Phrases**: Vague, meaningless language that does zero work. "Something shifted." "It was what it was." Quote them all.
- **Broken Metaphors**: Comparisons that collapse under scrutiny. Quote every broken one.
- **Purple Prose**: Language that overshoots the emotional reality of the scene.
- **Telling Not Showing**: "She was brave" instead of showing bravery through action.
- **Repetitive Sentence Structures**: Same rhythm paragraph after paragraph.
- **Lack of Specificity**: "A beautiful flower" vs "a half-dead marigold in a cracked pot."
- **Dead-Weight Modifiers**: Count every "very," "really," "just," "actually."

For EVERY problem, quote the specific passage and explain why it fails.

### 3. Repeat Word Report
Dedicated section listing every overused word with exact count and every context it appears in. Be thorough.

### 4. Uncommon Language Check
Flag overly dramatic, cliched "literary" phrasing: "the darkness crept in," "silence was deafening," "time stood still," overuse of personification. Quote every instance. If none found, note: "No uncommon language issues detected."

### 5. Shallow Content Check
Does the writing engage with its subject matter or skate on the surface?
- Themes handled with oven mitts?
- Convenient psychology?
- Emotional flinching?
Rate: Shallow / Surface / Adequate / Deep / Unflinching

### 6. Character Report Card
For each character: Name, Grade (A-F), What's working (with quotes), What's broken (with quotes), Diagnosis.

### 7. Story Mechanics
Pacing, plot holes, world-building, stakes, show vs tell, dialogue quality, theme, prose style.

### 8. Line-Level Callouts
Pull at least 5-10 specific passages. Quote them. Explain the problem. Suggest a specific fix. Also call out genuinely GOOD passages.

### 9. Where This Is Heading
If unfinished: trajectory warnings, structural concerns, what to fix before continuing.
If complete: "This appears complete. No trajectory analysis needed."

### 10. Final Verdict
2-4 paragraphs. Is it ready? What's the single biggest fix? Strongest element? Would you keep reading?
End with one sentence of genuine encouragement — but only if earned.

## Tone Rules
- Be direct. "This doesn't work because..." not "You might consider perhaps..."
- Be specific. Never say "the writing could be stronger" without saying exactly where and how.
- Be fair. The goal is to make the author better, not make them quit.
- Be funny when appropriate. Dry wit lands better than cruelty.
- Adjust expectations to the genre. A cozy middle-grade mystery has different standards than literary adult fiction.
- NEVER fabricate quotes. Only quote passages that actually appear in the text.`;

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

  // Check if first review (free)
  let isFirstFree = false;
  if (req.user && supabaseAdmin) {
    try {
      const { count } = await supabaseAdmin
        .from('reviews')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', req.user.id);
      isFirstFree = count === 0;
    } catch (e) { isFirstFree = true; }
  } else {
    isFirstFree = true; // No auth = treat as free (first anonymous review)
  }

  const totalCost = isFirstFree ? 0 : tier.price;

  console.log(`[REVIEW] ${req.user ? req.user.email : 'anonymous'} | ${wordCount} words | ${tier.name} | $${totalCost}${isFirstFree ? ' (FREE)' : ''}`);

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
      isFirstFree,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ruthless Mentor server running on http://localhost:${PORT}`);
});
