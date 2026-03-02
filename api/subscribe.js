// Vercel Serverless — Movacamper Email Alert Subscription
// Persistent storage via Vercel KV (Redis)
// Fallback: console logging if KV not configured

let kv = null;

async function getKV() {
  if (kv) return kv;
  try {
    const mod = await import('@vercel/kv');
    kv = mod.kv;
    return kv;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const store = await getKV();

  // GET: return subscriber count (no personal data exposed)
  if (req.method === 'GET') {
    if (!store) {
      return res.status(200).json({ count: 0, storage: 'none', message: 'KV not configured' });
    }
    try {
      const count = await store.scard('subscribers:emails') || 0;
      return res.status(200).json({ count, storage: 'kv' });
    } catch (err) {
      return res.status(200).json({ count: 0, storage: 'error', detail: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, city, date, flexibility } = req.body || {};

  // Validate email
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const subscription = {
    email: normalizedEmail,
    city: city || 'any',
    date: date || null,
    flexibility: flexibility || 7,
    created: new Date().toISOString(),
    source: 'movacamper.com',
  };

  // Always log to Vercel console as backup
  console.log('NEW SUBSCRIBER:', JSON.stringify(subscription));

  // Store in Vercel KV if available
  if (store) {
    try {
      // Store subscription data keyed by email
      await store.set(`sub:${normalizedEmail}`, JSON.stringify(subscription));
      // Add email to a set for easy counting/listing
      await store.sadd('subscribers:emails', normalizedEmail);
      console.log('Stored in KV:', normalizedEmail);
    } catch (err) {
      console.error('KV store error:', err.message);
      // Don't fail the request — subscriber still gets a success response
    }
  } else {
    console.warn('KV not configured — subscriber data only in logs');
  }

  return res.status(200).json({
    success: true,
    message: "Subscribed! We'll email you when matching deals appear.",
  });
}
