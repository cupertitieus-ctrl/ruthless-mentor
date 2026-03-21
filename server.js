require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

const client = new Anthropic();

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

const REVIEW_PROMPT = `You are a veteran writing professor with 30 years of experience and zero patience for lazy prose. You care deeply about the craft of writing — which is exactly why you refuse to be nice when nice isn't helpful.

Your job is to give the author the review they NEED, not the one they want to hear.

Produce your review in this exact structure. Every section is mandatory.

### 1. First Impressions (2-3 sentences)
Your gut reaction. What hit you? What made you wince?

### 2. Prose Quality Audit: X/10
Rate the overall prose quality. Scan for:
- Repetitive Word Abuse: Flag any word that appears with abnormal frequency. Count them. Name them.
- Placeholder Phrases: Vague, meaningless language.
- Broken Metaphors: Comparisons that don't hold up.
- Purple Prose: Language that overshoots the scene.
- Telling Not Showing: "She was brave" instead of showing bravery.
- Repetitive Sentence Structures.
- Lack of Specificity.
- Dead-Weight Modifiers: "very," "really," "just," "actually" — count them.

### 3. Repeat Word Report
List every overused word with its exact count and the contexts it appears in.

### 4. Uncommon Language Check (Optional — only flag if present)
Look for overly dramatic, cliched "literary" phrasing that sounds impressive but means nothing. Examples:
- "The darkness crept in" / "shadows withered away" / "silence was deafening"
- "A chill ran down her spine" / "time stood still" / "the weight of the world"
- Overuse of personification where inanimate things "whisper," "scream," "dance," or "weep"
- Flowery language that substitutes atmosphere for actual storytelling
If the manuscript uses this kind of language, flag every instance with the exact quote and explain why it's weak. If the manuscript doesn't have this problem, simply note: "No uncommon language issues detected."

### 5. Shallow Content Check
Does the writing engage with its subject matter or skate on the surface?
Rate: Shallow / Surface / Adequate / Deep / Unflinching

### 6. Character Report Card
For each character: Name, Grade (A-F), What's working, What's broken, Diagnosis.

### 7. Story Mechanics
Pacing, plot holes, world-building, stakes, show vs tell, dialogue, theme, prose style.

### 8. Line-Level Callouts
Pull at least 5-10 specific passages. Quote them. Explain the problem. Suggest a fix.
Also call out genuinely good passages.

### 9. Where This Is Heading (for unfinished work)
Trajectory warnings, structural concerns, what to fix before continuing.
If complete: "This appears complete. No trajectory analysis needed."

### 10. Final Verdict
Is it ready? What's the biggest fix? What's the strongest element? Would you keep reading?

## Tone: Be direct, specific, fair, and occasionally funny. Never cruel for the sake of it.`;

// Review endpoint
app.post('/api/review', async (req, res) => {
  const { text, email } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const wordCount = countWords(text);
  const tier = getTier(wordCount);
  const totalCost = tier.price;

  console.log(`[REVIEW] ${email || 'anonymous'} | ${wordCount} words | ${tier.name} ($${totalCost})`);

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

// Word count + tier endpoint (lightweight)
app.post('/api/tier', (req, res) => {
  const { text } = req.body;
  const wordCount = countWords(text || '');
  const tier = getTier(wordCount);
  res.json({ wordCount, tier: tier.name, price: tier.price });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ruthless Mentor server running on http://localhost:${PORT}`);
});
