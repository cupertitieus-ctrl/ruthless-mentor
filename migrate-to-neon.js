// One-time migration: Supabase -> Neon. Run from website/: node migrate-to-neon.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  clerk_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  word_count INTEGER,
  tier TEXT,
  price NUMERIC,
  review_markdown TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  customer_email TEXT,
  title TEXT,
  payment_type TEXT,
  manuscript_info JSONB
);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_email ON reviews(lower(customer_email));

CREATE TABLE IF NOT EXISTS used_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_used_coupons_code ON used_coupons(code);

CREATE TABLE IF NOT EXISTS pending_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manuscript_text TEXT,
  manuscript_info JSONB,
  genre TEXT,
  price_cents INTEGER,
  status TEXT,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  plan TEXT,
  credits_remaining INTEGER,
  credits_per_month INTEGER,
  status TEXT,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
`;

async function fetchAll(table) {
  const rows = [];
  const CHUNK = 50;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await sb.from(table).select('*').range(from, from + CHUNK - 1);
    if (error) throw new Error(table + ': ' + error.message);
    rows.push(...data);
    if (data.length < CHUNK) break;
  }
  return rows;
}

async function insertRows(table, rows) {
  if (rows.length === 0) { console.log(table + ': 0 rows'); return; }
  const cols = Object.keys(rows[0]);
  for (const row of rows) {
    const vals = cols.map(c => {
      const v = row[c];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    await pool.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
      vals
    );
  }
  const { rows: [{ count }] } = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
  console.log(`${table}: inserted ${rows.length}, total in Neon: ${count}`);
}

(async () => {
  console.log('Creating schema...');
  await pool.query(SCHEMA);

  console.log('Copying auth users -> users table...');
  const { data: authData, error: authErr } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authErr) throw authErr;
  for (const u of authData.users) {
    await pool.query(
      'INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [u.id, u.email, u.created_at]
    );
  }
  const { rows: [{ count: uc }] } = await pool.query('SELECT COUNT(*) AS count FROM users');
  console.log(`users: ${authData.users.length} auth users, total in Neon: ${uc}`);

  for (const table of ['reviews', 'used_coupons', 'subscriptions']) {
    const rows = await fetchAll(table);
    await insertRows(table, rows);
  }

  await pool.end();
  console.log('DONE');
})().catch(e => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
