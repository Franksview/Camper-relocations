// Vercel Serverless — Lightweight Movacamper Analytics Tracker
// Logs pageviews, unique visitors, referrers, and pages to Upstash Redis
// Called by a tiny beacon in index.html — no cookies, privacy-friendly

let store = null;
const ALLOWED_EVENTS = new Set(['search', 'subscribe']);

async function getStore() {
  if (store) return store;

  // Option 1: Upstash REST API
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      return store;
    } catch (e) { /* fall through */ }
  }

  // Option 2: Upstash REST alt
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      return store;
    } catch (e) { /* fall through */ }
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
      return store;
    } catch (e) { /* fall through */ }
  }

  return null;
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Simple hash for visitor fingerprint (no PII stored)
function hashVisitor(ip, ua) {
  let hash = 0;
  const str = `${ip}|${ua}|${today()}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 'v' + Math.abs(hash).toString(36);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // No-cache — tracking pixel should never be cached
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const redis = await getStore();
  if (!redis) return res.status(200).json({ ok: true, stored: false });

  const { page, referrer, event, city } = req.body || {};
  const date = today();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const visitorHash = hashVisitor(ip, ua);

  try {
    const pipe = redis.pipeline();

    // Pageview count
    pipe.incr(`stats:pv:${date}`);

    // Unique visitors (set of hashed fingerprints)
    pipe.sadd(`stats:uv:${date}`, visitorHash);

    // Page breakdown
    if (page) {
      pipe.hincrby(`stats:pages:${date}`, page || '/', 1);
    }

    // Referrer breakdown
    if (referrer && referrer !== '' && !referrer.includes('movacamper.com')) {
      // Extract domain from referrer
      try {
        const refDomain = new URL(referrer).hostname.replace('www.', '');
        pipe.hincrby(`stats:ref:${date}`, refDomain, 1);
      } catch (e) {
        pipe.hincrby(`stats:ref:${date}`, 'direct', 1);
      }
    } else if (!referrer) {
      pipe.hincrby(`stats:ref:${date}`, 'direct', 1);
    }

    // Custom events (allow-listed only to prevent arbitrary Redis keys)
    if (event && ALLOWED_EVENTS.has(event)) {
      pipe.incr(`stats:evt:${event}:${date}`);
    }

    // Track search cities for "top search cities" dashboard
    if (event === 'search' && city) {
      pipe.hincrby(`stats:cities:${date}`, city.toLowerCase().trim(), 1);
    }

    // Set TTL on all keys: 90 days
    const ttl = 90 * 24 * 60 * 60;
    pipe.expire(`stats:pv:${date}`, ttl);
    pipe.expire(`stats:uv:${date}`, ttl);
    pipe.expire(`stats:pages:${date}`, ttl);
    pipe.expire(`stats:ref:${date}`, ttl);
    pipe.expire(`stats:cities:${date}`, ttl);
    if (event && ALLOWED_EVENTS.has(event)) pipe.expire(`stats:evt:${event}:${date}`, ttl);

    await pipe.exec();
  } catch (err) {
    console.error('Track error:', err.message);
  }

  return res.status(200).json({ ok: true });
}
