// Vercel Serverless — Movacamper Email Alert Subscription
// Persistent storage via Redis (Vercel Storage)
// Tries Upstash REST API first, falls back to ioredis, then graceful fallback

let store = null;
let storeType = 'none';

async function getStore() {
  if (store) return store;

  // Option 1: Upstash REST API (KV_REST_API_URL + KV_REST_API_TOKEN)
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      storeType = 'upstash-rest';
      return store;
    } catch (e) {
      console.warn('Upstash REST init failed:', e.message);
    }
  }

  // Option 2: Upstash REST via REDIS_URL pattern (some Vercel setups)
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      storeType = 'upstash-rest-alt';
      return store;
    } catch (e) {
      console.warn('Upstash REST alt init failed:', e.message);
    }
  }

  // Option 3: Standard Redis via REDIS_URL (ioredis)
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      store = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        lazyConnect: true,
      });
      await store.connect();
      storeType = 'ioredis';
      return store;
    } catch (e) {
      console.warn('ioredis init failed:', e.message);
    }
  }

  return null;
}

// Unified interface: both @upstash/redis and ioredis use the same method names
// for scard, set, sadd — so we can use them interchangeably

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getStore();

  // GET: return subscriber count (no personal data exposed)
  if (req.method === 'GET') {
    if (!redis) {
      return res.status(200).json({
        count: 0,
        storage: 'none',
        message: 'Redis not configured',
        debug: {
          hasKvUrl: !!process.env.KV_REST_API_URL,
          hasKvToken: !!process.env.KV_REST_API_TOKEN,
          hasUpstashUrl: !!process.env.UPSTASH_REDIS_REST_URL,
          hasUpstashToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
          hasRedisUrl: !!process.env.REDIS_URL,
        }
      });
    }
    try {
      const count = await redis.scard('subscribers:emails') || 0;
      return res.status(200).json({ count, storage: storeType });
    } catch (err) {
      return res.status(200).json({ count: 0, storage: 'error', type: storeType, detail: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, city, date, flexibility } = req.body || {};

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

  console.log('NEW SUBSCRIBER:', JSON.stringify(subscription));

  if (redis) {
    try {
      await redis.set(`sub:${normalizedEmail}`, JSON.stringify(subscription));
      await redis.sadd('subscribers:emails', normalizedEmail);
      console.log(`Stored in ${storeType}:`, normalizedEmail);
    } catch (err) {
      console.error('Redis store error:', err.message);
    }
  } else {
    console.warn('Redis not configured — subscriber data only in logs');
  }

  return res.status(200).json({
    success: true,
    message: "Subscribed! We'll email you when matching deals appear.",
  });
}
