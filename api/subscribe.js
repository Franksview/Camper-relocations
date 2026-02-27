// Vercel Serverless — Movacamper Email Alert Subscription
// Stores subscriber data for deal notifications
// MVP: logs to Vercel console + in-memory store
// TODO: Connect to Vercel KV, Supabase, or Notion for persistence

const subscribers = new Map(); // In-memory (survives cold start period)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, city, date, flexibility } = req.body || {};

  // Validate email
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  const subscription = {
    email: email.toLowerCase().trim(),
    city: city || 'any',
    date: date || null,
    flexibility: flexibility || 7,
    created: new Date().toISOString(),
    source: 'movacamper.com',
  };

  // Store in memory (survives for this function instance)
  subscribers.set(subscription.email, subscription);

  // Log to Vercel console — check Runtime Logs in Vercel dashboard
  console.log('📬 NEW SUBSCRIBER:', JSON.stringify(subscription));

  // TODO: Add persistent storage here. Options:
  // 1. Vercel KV: await kv.set(`sub:${email}`, subscription)
  // 2. Supabase: await supabase.from('subscribers').insert(subscription)
  // 3. Notion API: POST to Notion database
  // 4. Google Sheets: Append via Sheets API
  // 5. Resend/SendGrid: Send notification to hello@movacamper.com

  return res.status(200).json({
    success: true,
    message: 'Subscribed! We\'ll email you when matching deals appear.',
  });
}
