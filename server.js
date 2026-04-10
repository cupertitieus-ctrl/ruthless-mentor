require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
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

// Stripe webhook needs raw body BEFORE json parser
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).send('Webhook signature failed');
  }

  console.log(`[WEBHOOK] ${event.type}`);

  // Lazy-load supabaseAdmin (it's initialized below)
  const getSupabase = () => {
    if (!supabaseAdmin) return null;
    return supabaseAdmin;
  };

  const PLAN_CREDITS = { 'basic': 10, 'pro': 25, 'advanced': 60 };

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode !== 'subscription') return res.json({ received: true });

      console.log(`[WEBHOOK] checkout.session.completed — subscription: ${session.subscription}, customer: ${session.customer}, email: ${session.customer_email || session.customer_details?.email}`);

      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const plan = session.metadata?.plan || 'basic';
      const credits = PLAN_CREDITS[plan] || 10;
      let userId = session.metadata?.userId;
      const db = getSupabase();

      // Fallback: if userId missing from metadata, look up user by email
      if (!userId && db) {
        const email = session.customer_email || session.customer_details?.email;
        if (email) {
          const { data: { users } } = await db.auth.admin.listUsers();
          const matched = users.find(u => u.email === email);
          if (matched) {
            userId = matched.id;
            console.log(`[WEBHOOK] Resolved userId from email ${email}: ${userId}`);
          } else {
            console.error(`[WEBHOOK] No user found for email ${email}`);
          }
        }
      }

      if (db && userId) {
        // Safely get current_period_end
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        const { error } = await db.from('subscriptions').upsert({
          user_id: userId,
          stripe_subscription_id: session.subscription,
          stripe_customer_id: session.customer,
          plan,
          credits_remaining: credits,
          credits_per_month: credits,
          status: 'active',
          current_period_end: periodEnd,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
        if (error) console.error('[WEBHOOK] Subscription upsert error:', error.message, error.details || '', error.hint || '');
        else console.log(`[WEBHOOK] Subscription created: ${plan} for user ${userId} (${credits} reviews)`);
      } else {
        console.error(`[WEBHOOK] Cannot save subscription — db:${!!db} userId:${userId}`);
      }
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      if (!invoice.subscription) return res.json({ received: true });

      const db = getSupabase();
      if (db) {
        // Find subscription by stripe_subscription_id
        const { data: sub } = await db.from('subscriptions')
          .select('*')
          .eq('stripe_subscription_id', invoice.subscription)
          .single();

        if (sub && invoice.billing_reason === 'subscription_cycle') {
          // Monthly renewal — RESET reviews (no rollover)
          const newCredits = sub.credits_per_month;
          const stripeSub = await stripe.subscriptions.retrieve(invoice.subscription);
          await db.from('subscriptions').update({
            credits_remaining: newCredits,
            status: 'active',
            current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', sub.id);
          console.log(`[WEBHOOK] Renewal: ${sub.plan} reset to ${newCredits} reviews`);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const db = getSupabase();
      if (db) {
        await db.from('subscriptions').update({
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        }).eq('stripe_subscription_id', subscription.id);
        console.log(`[WEBHOOK] Subscription cancelled: ${subscription.id}`);
      }
    }
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
  }

  res.json({ received: true });
});

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

- MYSTERY ELEMENTS ARE NOT PLOT HOLES — THIS IS GLOBAL, IT APPLIES TO THE ENTIRE REVIEW. If the manuscript is a mystery, detective story, whodunit, thriller, or has ANY mystery element at its core, the unanswered questions ARE the story. In a mystery book, the protagonist NOT KNOWING how something works is the entire point. Do NOT demand that the author "explain how the villain escapes" or "show how the magic works" or "clarify the mechanism" if that unknown IS what the protagonist is trying to figure out. This rule applies EVERYWHERE in the review — not just the PLOT HOLES subsection. Do not sneak the same critique into:
  - The Final Verdict ("fix the escape mechanism")
  - Line-Level Callouts ([FIX] suggesting to explain a mystery element)
  - Ruthless Fix boxes
  - Where This Is Heading warnings
  - Any other section
  If the protagonist doesn't know something and is trying to figure it out, the author SHOULDN'T explain it to the reader yet. That would destroy the mystery. If you want to suggest clearer foreshadowing or better clue-planting, frame it that way — NOT as "fix the plot hole."
  If the book is Book 1 of a series, unresolved mysteries are even more clearly intentional and will be answered in later books. Do not demand resolution of mystery hooks in Book 1.
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

ALWAYS use the header **PLOT HOLES:** regardless of whether this is a standalone or series book. The author needs real, substantive analysis of every unresolved element, consistency issue, and logical question in the manuscript. This subsection must be DETAILED. A numbered list of 3-5 specific observations is expected. "None that I can identify" is almost never the right answer — if you can't find any issues, you are not looking hard enough.

What to list under PLOT HOLES:
- Unresolved story elements readers will wonder about
- Character behavior that's inconsistent or undermotivated
- Missing scenes that would anchor key plot moments
- Worldbuilding or logic gaps
- Subplots that get introduced and then disappear
- Questions the narrative raises but doesn't address

For each numbered item:
- Give it a specific, descriptive title (e.g., "How Does Mr. Whiskers Escape?" not "Plot Issue 1")
- Describe what the manuscript shows and what it leaves out
- Explain why it matters — what the reader is going to wonder about
- For SERIES books: if the issue is clearly the central mystery the author is saving for a later book, note that and suggest a single craft move (like "a line earlier that says 'I'd figure out later how he escaped' would anchor this intentionally for the reader"). Don't demand the author resolve it in this book, but DO point out where the reader is going to feel the gap.
- For STANDALONE books: suggest a specific fix — the scene that's missing, the line that needs to be added, the subplot that needs to be committed to or cut.
- For every item: the verdict is either "fix it" (standalone) or "plant a single breadcrumb so the reader knows you meant it" (series).

EXAMPLE of the right output format — match this exact style and depth:

**PLOT HOLES:**

**1. How Does Mr. Whiskers Escape?** The manuscript never explains how he breaks out of the cage. James suspects the cracked wall, mentions his cousin's hamster, but we never see him chew through or escape. In Chapter 13, he's suddenly out and in the nacho container. A hamster escaping its cage is a huge plot point — this needs a scene, not a head-canon theory. For a Book 1, you could plant a single line like "I'd figure out how he escaped later" to make the withhold feel intentional — but right now, readers will wonder if they missed a page.

**2. The Accomplice Subplot.** Chapter 6 spends significant time building suspects (Kevin, Mia, Tyler, Mrs. Fairy). James eliminates them in Chapter 7 when they all look shocked. But the accomplice theory just disappears. Either commit to it (someone really is helping) or drop it earlier so it doesn't feel like a dangling thread.

**3. What Happened to the Nachos?** We see one chip disappear from the window (Chapter 11), and one chip taken after the nacho bath (Chapter 13). But what about the full trays that vanished in the cafeteria? If Mr. Whiskers is working alone, where are all those nachos? Hidden in the cage? Eaten? This disconnect makes the final reveal feel incomplete.

**4. Cage Security.** If Mr. Whiskers can break out whenever he wants, why doesn't he escape more often? Why only when nachos are available? The hamster's behavior isn't consistent enough to feel like a real creature with motives — he only moves the plot when the story needs him to.

Notice: each point is specific (named the exact problem), detailed (describes what the manuscript shows and doesn't show), concrete (references chapters), and actionable (suggests a fix or craft move). That's the bar. Do not produce anything less substantive than this.

CRITICAL GLOBAL RULE: Do NOT say "this is fine because it's Book 1 of a series" and skip the detailed analysis. Series books STILL need substantive plot hole / open thread analysis — the author still benefits from knowing exactly where readers will get confused or feel the gap. The difference is the SUGGESTED FIX: for standalone books, fix the hole; for series books, plant a breadcrumb that signals the withhold is intentional.

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
CRITICAL: Letter grades (A+, A, B, C, etc.) ONLY appear in Section 7 and Section 8 (the character report cards). DO NOT use letter grades anywhere else in the review. Prose quality uses a 10-point score. Depth uses Shallow/Surface/Adequate/Deep/Unflinching. Everything else is prose analysis. Letter grades are ONLY for characters.

Focus on the protagonist (main character) only. Use this format:

**Character Name** — Grade: X

Give the main character a letter grade. VALID GRADES ARE ONLY: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, F. There is NO grade of "E" — traditional letter grading skips E and goes from D to F. Do not invent grades. Do DEEP dive:
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

VALID GRADES ARE ONLY: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, F. There is NO grade of "E". Keep it to 2-3 sentences per supporting character. Hit the key points: what they add to the story, whether they feel like a real person or just a plot device, and one thing to improve. Don't do the full deep dive — just the essentials.

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

### 11. Market Reality Check
This is the substance section — it needs to be DEEP and DETAILED, not a two-paragraph brush-off. The author needs a real, honest assessment of who will relate to this book, how big the audience actually is, what the sea-of-sameness problem looks like for this specific concept, and what the realistic path to readers looks like.

Write it the way a smart friend who knows the industry would talk to the author at a coffee shop. Direct, warm, specific. Ruthless honesty + real substance.

OPEN with a one-to-two-sentence plain-English answer to "how many people will actually care about this book?" Write it the way a real person would say it out loud. No corporate-speak. No "broad-to-moderate spectrum." No "this book sits on the X range." Just say the actual thing, in a human voice, matching the ruthless-and-warm tone of the rest of the review.

Examples of GOOD openings:
- "Let's be honest — a lot of kids are going to see themselves in this. It's not universal, but it's close. Most kids have wondered where the class hamster really goes at night."
- "The audience for this is huge. Every single kid between 6 and 10 has had a mystery they couldn't prove — this book nails that feeling."
- "Here's the real deal: this is a small audience. Not small-bad — small-specific. The families who need this book are going to be profoundly grateful you wrote it."
- "Most kids can relate to this, but not all of them. The ones who've had a weird classroom pet or a theory nobody believed? They're going to eat this up."

Examples of BAD openings (FORBIDDEN):
- "This book sits on the broad-to-moderate spectrum, leaning toward broad." — corporate nonsense
- "This is a moderate audience — specific enough to stand out, broad enough to scale." — still market-analyst speak
- "The audience is moderately broad." — meaningless
- "The target demographic is..." — never say "demographic"
- "This book appeals to readers who..." — stiff and formal

The opening should feel like a real writing teacher talking to a real writer. Ruthless, honest, warm, direct. Plain English. Like the rest of the review.

Then produce SEVEN named sub-sections, each as a bolded label followed by substantive analysis (3-6 sentences each). Use these exact bolded labels:

**Who will relate:** Name specific audience segments in human terms — the experiences, life situations, and interests that will draw readers in. Be specific and layered (e.g., "kids aged 6-10 who like silly low-stakes mysteries, kids who've had classroom pets, kids who enjoy absurdist humor, observant kids who feel slightly paranoid"). Give an estimated built-in audience scale — large, medium, small, niche — and justify it with a specific observation about the concept. NEVER gender the audience explicitly (no "boys who..." or "girls who...") — describe by lived experience and interest instead.

**The size calculation:** Is this a broad, moderate, or niche concept? WHY? What does this concept resemble in the existing market? Is the angle specific enough to feel fresh, or so niche that only a tiny group will care? Be honest about potential audience size in concrete terms (millions, hundreds of thousands, tens of thousands).

**The sea-of-sameness problem:** Every book has one version of this. For broad books: how crowded is the shelf, and how does this book need to stand out through execution (voice, humor, pacing, hook)? For niche books: the opposite problem — how to actually reach the small audience that needs it. Be specific about what this manuscript is doing well and where it needs to sharpen to break through. Name the specific craft elements (voice, pacing, humor, premise freshness) that will determine whether it stands out.

=== UNIVERSAL RULES FOR SECTION 11 ===

- ALWAYS produce all three named subsections above (Who will relate, The size calculation, The sea-of-sameness problem). This section should be 3-5 paragraphs long. Shallow one-paragraph answers are BANNED.
- DO NOT include any publishing path discussion — no self-publishing vs. traditional publishing, no "how to get this book to readers," no query-letter advice, no marketing tactics. This section is about AUDIENCE and the sea-of-sameness problem ONLY. Publishing path is not part of this review.
- Each subsection needs real substance — 3-6 sentences of specific analysis, not platitudes.
- Be specific, never vague. "This will appeal to many readers" is banned. Name the readers.
- Never gender the audience explicitly. Describe holistically by age, life situation, experience, and interest.
- Never discourage the author. Validate niche and risky bets — they are often the best books.
- Never tell the author to abandon their concept to make it more "universal."
- Do not give tactical marketing advice (keywords, Amazon categories, ad angles, cover concepts, BookTok pitches) — this section is about AUDIENCE, sea-of-sameness, and path realism, not marketing tactics.
- Keep it human. Contractions are fine. Direct questions are fine. Ruthlessly honest + warm = the right tone.
- Reference the specific manuscript wherever possible — character names, scenes, wordcount, specific craft elements. Never generic.

### 12. Final Verdict
2-4 paragraphs. Is it ready? What's the single biggest thing to fix? What's the strongest thing to protect?

SERIES BOOKS — CRITICAL: If the author marked this as Book N of a series, do NOT demand resolution of series-level mysteries in the Final Verdict. Do not ask "does Mr. Whiskers steal again? Do the kids tell the teacher? Does the character learn something?" — those are questions the NEXT book answers. Those are not flaws. Asking them here contradicts the Book N framing at the top of the review.

BANNED PHRASES for series books in the Final Verdict:
- "Resolve the ending"
- "The ending just stops"
- "A chapter book needs a clearer resolution"
- "What happens to [mystery element]?"
- "Does the character learn something?" (if that learning is the arc of future books)
- "Wrap up [X plot thread]"
- "Explain [mystery element]"

Instead, for a series book, frame the verdict like this:
- "As Book ${'[N]'} of a planned series, this book's arc lands / does not land."
- "The open threads (list them) are clearly intentional hooks for Book ${'[N+1]'}, and they work / feel accidental."
- "The cliffhanger earns its stop — it makes you want the next book / it feels like the author just ran out of steam."
- "What this Book ${'[N]'} needs is tighter [pacing / voice / humor / dialogue], not a bigger ending."

The Final Verdict should focus on execution-level fixes (voice, pacing, humor landing, dialogue, character depth, prose quality) NOT plot resolution for series books. Series plot resolution is a non-issue — that is literally the point of a series.

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
    // First, claim any unclaimed reviews that match this user's email (case-insensitive)
    const userEmail = req.user.email;
    if (userEmail) {
      await supabaseAdmin
        .from('reviews')
        .update({ user_id: req.user.id })
        .ilike('customer_email', userEmail)
        .is('user_id', null);
    }

    // Now fetch all reviews belonging to this user
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .select('id, word_count, tier, price, review_markdown, created_at, title, payment_type, manuscript_info')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load reviews' });
    res.json({ reviews: data || [] });
  } catch (e) {
    res.json({ reviews: [] });
  }
});

// ===== SUBSCRIPTION ENDPOINTS =====
const SUBSCRIPTION_PLANS = {
  'basic': { priceId: 'price_1TJNiUF4oWcY2jpCsIFkZcLR', credits: 10, name: 'Basic', price: 50 },
  // 'pro': { priceId: 'price_XXXXXXXX', credits: 25, name: 'Pro', price: 100 },
  // 'advanced': { priceId: 'price_XXXXXXXX', credits: 60, name: 'Advanced', price: 200 },
};

// Get user's subscription (active or cancelled — cancelled still has access until period end)
app.get('/api/subscription', requireAuth, async (req, res) => {
  if (!supabaseAdmin) return res.json({ subscription: null });
  try {
    const { data } = await supabaseAdmin.from('subscriptions')
      .select('*')
      .eq('user_id', req.user.id)
      .in('status', ['active', 'cancelled'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    // If cancelled and past period end, treat as no subscription
    if (data && data.status === 'cancelled' && data.current_period_end && new Date(data.current_period_end) < new Date()) {
      return res.json({ subscription: null });
    }
    res.json({ subscription: data || null });
  } catch (e) {
    res.json({ subscription: null });
  }
});

// Create subscription checkout
app.post('/api/subscribe', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const { plan } = req.body;
  const planInfo = SUBSCRIPTION_PLANS[plan];
  if (!planInfo) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: planInfo.priceId, quantity: 1 }],
      success_url: `${req.headers.origin || 'https://ruthlessmentor.com'}/dashboard.html?subscribed=true`,
      cancel_url: `${req.headers.origin || 'https://ruthlessmentor.com'}/review.html?cancelled=true`,
      customer_email: req.user.email,
      metadata: {
        plan,
        userId: req.user.id,
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[SUBSCRIBE ERROR]', err.message);
    res.status(500).json({ error: 'Subscription setup failed' });
  }
});

// Stripe Customer Portal (manage subscription)
// Cancel subscription
app.post('/api/cancel-subscription', requireAuth, async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { data: sub } = await supabaseAdmin.from('subscriptions')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active')
      .single();
    if (!sub) return res.status(404).json({ error: 'No active subscription found' });

    // Cancel in Stripe (if real subscription)
    if (stripe && sub.stripe_subscription_id && !sub.stripe_subscription_id.startsWith('manual')) {
      try {
        await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
      } catch (stripeErr) {
        console.error('[CANCEL] Stripe error:', stripeErr.message);
        // Continue anyway — mark as cancelled in our DB
      }
    }

    // Mark cancelled in Supabase (status stays active until period end so they keep credits)
    await supabaseAdmin.from('subscriptions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', sub.id);

    res.json({ success: true, message: 'Subscription cancelled. You will keep access until the end of your billing period.' });
  } catch (err) {
    console.error('[CANCEL ERROR]', err.message);
    res.status(500).json({ error: 'Could not cancel subscription' });
  }
});

app.post('/api/customer-portal', requireAuth, async (req, res) => {
  if (!stripe || !supabaseAdmin) return res.status(503).json({ error: 'Not configured' });
  try {
    const { data: sub } = await supabaseAdmin.from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', req.user.id)
      .single();
    if (!sub || !sub.stripe_customer_id) return res.status(404).json({ error: 'No subscription found' });

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${req.headers.origin || 'https://ruthlessmentor.com'}/dashboard.html`,
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('[PORTAL ERROR]', err.message);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

// ===== GET SINGLE REVIEW BY ID (public, for shareable links) =====
app.get('/api/review/:id', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .select('id, word_count, tier, review_markdown, created_at, title, payment_type, manuscript_info')
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
  if (manuscriptInfo.bookNumber) {
    const bn = manuscriptInfo.bookNumber;
    const bnInt = parseInt(bn);
    parts.push(`Book number: Book ${bn} of a series. CRITICAL: This is part of a multi-book series. The author is planning more books after this one. Evaluate the ending accordingly.

This book — Book ${bn} — should resolve its OWN core arc (the main conflict this book set up) while leaving larger threads open for future books. Do NOT penalize the manuscript for leaving some things unresolved — that is a feature of a mid-series book, NOT a bug. Book ${bn} leads into Book ${bnInt + 1}. That is how series work.

This rule applies GLOBALLY across the entire review — not just the Final Verdict. Do not anywhere in the review:
- Demand the author explain mysteries that are set up to be answered in a later book
- Call unresolved series arcs "incomplete endings"
- Suggest the author "wrap up" threads that are clearly intentional hooks
- Treat cliffhangers as flaws when they feel earned
- Ask for answers to questions that are clearly the driving mystery of the series

Instead, evaluate:
1. Does THIS book's core arc land? (The conflict introduced in this specific book should resolve, even if the series arc continues.)
2. Are the open threads intentional hooks for Book ${bnInt + 1}, or sloppy loose ends with no follow-through?
3. Do the cliffhangers feel earned, or cheap?
4. Does Book ${bn} advance the overall series arc in a meaningful way?
${bnInt >= 2 ? `5. Does Book ${bn} stand on its own for a reader who already read Book ${bnInt - 1}? Does it reward returning readers while still being accessible?
6. Does the pacing match mid-series expectations (deeper character work, world expansion, escalating stakes)?` : ''}

Frame feedback as "the Book ${bn} arc lands / does not land, and here is what is set up for Book ${bnInt + 1}" — NEVER as "the ending is incomplete" without that series context. Cliffhangers, unresolved mysteries, and open threads are the LIFEBLOOD of a series. Respect them.`);
  }

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

7. SIMPLE EMOTIONAL HIT: Pick ONE lane and commit. Funny works best for virality, but it is NOT the only lane. Heartwarming works. Slightly chaotic works — kids LOVE chaos. Spooky/horror picture books are a real and selling genre (The Dark by Lemony Snicket, Creepy Carrots, The Ghost-Eye Tree, A Dark Dark Tale, Leonardo the Terrible Monster). Sad/bittersweet works (The Rabbit Listened, Ida Always). Quiet/contemplative works (The Important Book, On the Night You Were Born). IDENTIFY the tone the author is going for and EVALUATE IT AGAINST THAT TONE. Do NOT try to talk a horror picture book into being funny, or a quiet book into being loud. If the author is writing spooky, evaluate: does the spooky land? Is the tension age-appropriate but real? Are the scary beats paced like a horror book (build, pause, payoff)? The only problem with tone is if the book is trying to be funny AND sad AND educational AND scary all at once — then call it a mess. But if the author picked a lane and committed, respect the lane.

8. RUTHLESS BREVITY: 300-600 words. That is it. Every single word must EARN its place. If you can delete a line and the story still works, that line should not exist. Be merciless about filler. Point to specific lines that add nothing. Picture books are not the place for extra words — there are no extra words in a picture book.

9. READ-IT-AGAIN ENDING: The best picture books end with a twist, a callback, or something that makes a kid slam the book shut and yell AGAIN. If the ending is "And then everything was okay" — flag it as weak. If there is no pull to reread, this book will get read once and shelved. Be honest about whether the ending earns a second read.

10. TITLE POWER: The title sells the book. Good titles feel like a joke, a mystery, or a bold dare. "The Adventures of..." is forgettable garbage. "This Book Is NOT Funny" makes you pick it up. If the title is generic or forgettable, say so. Do not be nice about a weak title.`);

    if (manuscriptInfo.rhyming === 'rhyming') {
      parts.push(`Style: RHYMING picture book — Criteria #1 and #2 above are CRITICAL. Meter and scansion are the #1 priority.

STEP 1 — IDENTIFY THE RHYME SCHEME BEFORE CRITIQUING:
Before you evaluate ANY rhyming picture book, you MUST first identify the rhyme scheme the author chose. Do not assume it is AABB (rhyming couplets). Authors use many valid rhyme schemes in picture books:
- **AABB** — rhyming couplets (lines 1&2 rhyme, lines 3&4 rhyme)
- **ABAB** — alternating rhymes (lines 1&3 rhyme, lines 2&4 rhyme)
- **ABCB** — ballad/quatrain form (only lines 2&4 rhyme; lines 1 and 3 do NOT rhyme) — this is EXTREMELY COMMON in children's picture books and is NOT a mistake
- **ABAB CDCD** — sustained alternating rhyme across stanzas
- **AABBA** — limerick form
- **Monorhyme** — every line ends with the same rhyme sound
- **Irregular / free rhyme** — rhymes appear at varied intervals for emphasis
- **Refrain-based** — a repeating chorus line with new rhymes in between

Read the FIRST FULL STANZA of the manuscript carefully. Identify which lines rhyme with which. State the detected scheme explicitly in your review (e.g. "You are writing in ABCB ballad form — lines 2 and 4 rhyme, lines 1 and 3 are intentionally unrhymed"). Then evaluate the manuscript AGAINST ITS OWN CHOSEN SCHEME, not against a different scheme you assumed.

CRITICAL: Do NOT flag unrhymed lines as "missing rhymes" if they are supposed to be unrhymed in the chosen scheme. An ABCB manuscript where line 1 does not rhyme with line 3 is CORRECT, not broken. Flagging this as an error is the #1 mistake lazy reviewers make and it destroys author trust. If you are not 100% sure of the scheme, hedge: "If you intend ABCB here, this works; if you intend AABB, lines 1 and 2 need to rhyme."

STEP 2 — ONCE THE SCHEME IS IDENTIFIED, EVALUATE:
- **Scheme consistency** — does the author stick to their scheme throughout, or do they drift between AABB and ABCB randomly? Inconsistent scheme drift IS a real problem.
- **Meter and scansion** — every line should have a consistent stressed/unstressed syllable pattern. Count the beats. Flag lines that stumble or have extra/missing syllables when read aloud.
- **Forced rhymes** — the author bent a sentence into an unnatural shape just to land a rhyme (flag these).
- **Near-rhymes** — words that almost rhyme but do not quite work for young ears reading aloud (flag the weak ones but give credit when a clever near-rhyme lands).
- **Read-aloud flow** — parents read these 100+ times. If a line trips the tongue, flag it.

CRITICAL RULE FOR FIXES: When suggesting rewrites or fixes for a rhyming picture book, your suggested fix MUST match the manuscript's existing rhyme scheme. If the book is in ABCB, your fix must also be in ABCB — do not convert it to AABB. Maintain the meter. Show the author what a clean version in THEIR chosen scheme looks like. If you suggest a fix that breaks their scheme or their meter, you have failed the review.

FINAL REMINDER: Be humble about niche forms. Some picture books use rare schemes deliberately. If you encounter something unusual, assume the author knows what they are doing until proven otherwise. Ask yourself: "Could this be an intentional choice in a form I do not recognize?" If yes, frame your feedback as a question ("Is this intended as X form?") rather than an accusation.`);
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

  // Screenplay-specific overrides for Market Reality Check and Comparable Books
  if (manuscriptInfo.genre === 'screenplay') {
    parts.push(`SCREENPLAY OVERRIDE for Section 11 (Market Reality Check): Do NOT use book industry language like "query trenches", "agents and editors", "bookstore shelf", or "readers". This is a screenplay. Use screenplay industry framing:

- The market is producers, managers, production companies, studios, streamers, and festival programmers — NOT agents and editors.
- Positioning risk for a screenplay includes: genre budget (horror and thrillers are cheap; sci-fi, period, and fantasy are expensive and harder to greenlight from an unknown writer); format risk (limited series vs feature vs short); log line clarity (can you pitch this in one sentence in a room?); IP availability (is this based on something the writer owns or is it a derivative that needs rights?); commercial vs festival positioning (is this aimed at a Sundance slot or a wide theatrical release?).
- The "marketing budget" line from the book version should become: "You will need a sharper log line, a stronger calling-card writing sample, and likely a producer or manager willing to take this out to the town. For expensive-to-produce concepts, expect a longer road to greenlight."
- Validate the risk. Never tell them to abandon a spec that is hard to sell. Many of the best specs are the risky ones. Just be honest about the cost of entry.

`);
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
  let totalCost = tier.price;
  let usedCredit = false;

  // Check if user has subscription credits
  if (req.user && supabaseAdmin) {
    try {
      const { data: sub } = await supabaseAdmin.from('subscriptions')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('status', 'active')
        .single();
      if (sub && sub.credits_remaining > 0) {
        // Use a credit instead of charging
        await supabaseAdmin.from('subscriptions')
          .update({ credits_remaining: sub.credits_remaining - 1, updated_at: new Date().toISOString() })
          .eq('id', sub.id);
        totalCost = 0;
        usedCredit = true;
        console.log(`[REVIEW] ${req.user.email} used 1 review (${sub.credits_remaining - 1} remaining)`);
      }
    } catch (e) { /* no subscription, proceed with normal pricing */ }
  }
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
        // Determine payment type
        let paymentType = 'paid';
        if (usedCredit) paymentType = 'subscription';
        else if (totalCost === 0) paymentType = 'free';

        const { data, error } = await supabaseAdmin.from('reviews').insert({
          user_id: req.user ? req.user.id : null,
          customer_email: email || null,
          word_count: wordCount,
          tier: tier.name,
          price: totalCost,
          review_markdown: review,
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          title: manuscriptInfo?.title || null,
          payment_type: paymentType,
          manuscript_info: manuscriptInfo || null,
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
      usedCredit,
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
// Helper: run a paid review from saved pending_reviews data. Idempotent — if already completed,
// returns the existing review. Safe to retry after a failed Claude call or deploy interruption.
async function runPaidReviewFromPending(pendingId, session) {
  if (!supabaseAdmin) throw new Error('Database not configured');

  // 1. Load the pending review
  const { data: pending, error: loadErr } = await supabaseAdmin
    .from('pending_reviews')
    .select('manuscript_text, manuscript_info, status')
    .eq('id', pendingId)
    .single();
  if (loadErr || !pending) throw new Error('Pending review not found');

  const savedText = pending.manuscript_text;
  const savedInfo = pending.manuscript_info || {};

  // 2. If already completed, find the existing review and return it (idempotent recovery)
  if (pending.status === 'completed') {
    const paidEmail = session.metadata?.customerEmail || session.customer_email || session.customer_details?.email || null;
    // Find the most recent review for this customer (best-effort match since we don't store pending_id on reviews)
    if (paidEmail) {
      const { data: existing } = await supabaseAdmin
        .from('reviews')
        .select('id, review_markdown, word_count, tier')
        .eq('customer_email', paidEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (existing) {
        console.log(`[PAID REVIEW] Idempotent return for pending ${pendingId} — existing review ${existing.id}`);
        return {
          review: existing.review_markdown,
          wordCount: existing.word_count,
          tier: existing.tier,
          reviewId: existing.id,
          alreadyProcessed: true,
        };
      }
    }
    // Pending marked completed but no matching review found — force re-run to recover
    console.warn(`[PAID REVIEW] Pending ${pendingId} marked completed but no review found — re-running`);
  }

  // 3. Generate the review (the risky step)
  const wordCount = countWords(savedText);
  const tier = getTier(wordCount);
  const genre = session.metadata?.genre || '';

  console.log(`[PAID REVIEW] Generating review for pending ${pendingId} (${wordCount} words)`);

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

  // 4. Store in reviews table FIRST (so we have the review saved even if later steps fail)
  let paidReviewId = null;
  const paidEmail = session.metadata?.customerEmail || session.customer_email || session.customer_details?.email || null;
  try {
    const { data, error } = await supabaseAdmin.from('reviews').insert({
      customer_email: paidEmail,
      word_count: wordCount,
      tier: tier.name,
      price: session.amount_total / 100,
      review_markdown: review,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      title: savedInfo.title || null,
      payment_type: 'paid',
      manuscript_info: savedInfo,
    }).select('id').single();
    if (!error && data) paidReviewId = data.id;
  } catch (e) { console.error('[DB ERROR]', e.message); }

  // 5. Only mark pending as completed AFTER the review is safely saved
  if (paidReviewId) {
    await supabaseAdmin.from('pending_reviews').update({ status: 'completed' }).eq('id', pendingId);
  }

  // 6. Auto-email the review link (non-blocking, don't fail the request if email fails)
  if (paidEmail && resend && paidReviewId) {
    const reviewUrl = `https://ruthlessmentor.com/report.html?id=${paidReviewId}`;
    resend.emails.send({
      from: 'Ruthless Mentor <reviews@ruthlessmentor.com>',
      to: paidEmail,
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
    }).then(() => console.log(`[AUTO-EMAIL] Sent paid review link to ${paidEmail}`))
      .catch(err => console.error('[AUTO-EMAIL ERROR]', err.message));
  }

  return {
    review,
    wordCount,
    tier: tier.name,
    reviewId: paidReviewId,
    alreadyProcessed: false,
  };
}

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
    if (!pendingId || !supabaseAdmin) {
      return res.json({ paid: true, autoReview: false, metadata: session.metadata });
    }

    const result = await runPaidReviewFromPending(pendingId, session);
    res.json({
      paid: true,
      autoReview: true,
      review: result.review,
      wordCount: result.wordCount,
      tier: result.tier,
      reviewId: result.reviewId,
      alreadyProcessed: result.alreadyProcessed,
      metadata: session.metadata
    });
  } catch (err) {
    console.error('[VERIFY ERROR]', err.message);
    // Return a retryable error — client can call verify-payment again
    res.status(500).json({
      error: 'Could not generate review',
      details: err.message,
      retryable: true,
    });
  }
});

// ===== ADMIN RECOVERY ENDPOINT =====
// Use this to manually retry a failed review for a customer who paid but got an error.
// Protected by ADMIN_KEY env var. Usage:
//   curl -X POST https://ruthlessmentor.com/api/admin/retry-review \
//        -H "x-admin-key: YOUR_KEY" \
//        -H "Content-Type: application/json" \
//        -d '{"sessionId":"cs_live_..."}'
// OR pass pendingId directly: -d '{"pendingId":"uuid-here"}'
app.post('/api/admin/retry-review', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return res.status(503).json({ error: 'Admin key not configured. Set ADMIN_KEY env var on Render.' });
  if (req.headers['x-admin-key'] !== adminKey) return res.status(401).json({ error: 'Unauthorized' });

  const { sessionId, pendingId: directPendingId } = req.body;
  if (!sessionId && !directPendingId) return res.status(400).json({ error: 'Provide sessionId or pendingId' });

  try {
    let session;
    let pendingId = directPendingId;

    if (sessionId) {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
      session = await stripe.checkout.sessions.retrieve(sessionId);
      pendingId = pendingId || session.metadata?.pendingId;
    } else {
      // Fabricate a minimal session-like object from pending_reviews for direct pendingId recovery
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const { data: pending } = await supabaseAdmin
        .from('pending_reviews')
        .select('manuscript_info, stripe_session_id, price_cents')
        .eq('id', pendingId)
        .single();
      if (!pending) return res.status(404).json({ error: 'Pending review not found' });

      if (pending.stripe_session_id && stripe) {
        session = await stripe.checkout.sessions.retrieve(pending.stripe_session_id);
      } else {
        // Minimal fallback if no stripe session available
        session = {
          amount_total: pending.price_cents || 0,
          metadata: pending.manuscript_info || {},
          customer_email: null,
          customer_details: { email: null },
        };
      }
    }

    if (!pendingId) return res.status(400).json({ error: 'Could not resolve pendingId' });

    // Force re-run by resetting status to pending first (so the idempotent path doesn't short-circuit with a bad match)
    await supabaseAdmin.from('pending_reviews').update({ status: 'pending' }).eq('id', pendingId);

    const result = await runPaidReviewFromPending(pendingId, session);
    res.json({
      success: true,
      reviewId: result.reviewId,
      wordCount: result.wordCount,
      tier: result.tier,
      reviewUrl: result.reviewId ? `https://ruthlessmentor.com/report.html?id=${result.reviewId}` : null,
    });
  } catch (err) {
    console.error('[ADMIN RETRY ERROR]', err.message);
    res.status(500).json({ error: 'Retry failed', details: err.message });
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
