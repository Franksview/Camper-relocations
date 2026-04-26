// Vercel Serverless — Lightweight Movacamper Analytics Tracker
// Logs pageviews, unique visitors, referrers, and pages to Upstash Redis
// Called by a tiny beacon in index.html — no cookies, privacy-friendly

let store = null;
const ALLOWED_EVENTS = new Set([
  'search', 'subscribe', 'trip_add', 'trip_share',
  'deal_click', 'alt_click', 'sub_impression',
  'search_no_results', 'search_results', 'deal_view',
]);

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

  const { page, referrer, event, city, source, provider, from, to, variant } = req.body || {};
  const date = today();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const visitorHash = hashVisitor(ip, ua);

  // Key prefix: 'relo:' for Relocamp, '' for Movacamper
  const pre = source === 'relocamp' ? 'relo:' : '';
  const ownDomain = source === 'relocamp' ? 'relocamp.vercel.app' : 'movacamper.com';

  try {
    // TTL for all keys: 90 days — MUST be defined before any reference below.
    // Pre-existing bug (fixed april 20): ttl was declared after deal_click block,
    // causing ReferenceError (silent via try/catch) → deal_clicks_log + clicks_by_provider never written.
    // Explains why dashboard showed deal_click counts but no provider breakdown.
    const ttl = 90 * 24 * 60 * 60;

    const pipe = redis.pipeline();

    // Pageview count
    pipe.incr(`${pre}stats:pv:${date}`);

    // Unique visitors (set of hashed fingerprints)
    pipe.sadd(`${pre}stats:uv:${date}`, visitorHash);

    // Page breakdown
    if (page) {
      pipe.hincrby(`${pre}stats:pages:${date}`, page || '/', 1);
    }

    // Referrer breakdown
    if (referrer && referrer !== '' && !referrer.includes(ownDomain)) {
      // Extract domain from referrer
      try {
        const refDomain = new URL(referrer).hostname.replace('www.', '');
        pipe.hincrby(`${pre}stats:ref:${date}`, refDomain, 1);
      } catch (e) {
        pipe.hincrby(`${pre}stats:ref:${date}`, 'direct', 1);
      }
    } else if (!referrer) {
      pipe.hincrby(`${pre}stats:ref:${date}`, 'direct', 1);
    }

    // Custom events (allow-listed only to prevent arbitrary Redis keys)
    if (event && ALLOWED_EVENTS.has(event)) {
      pipe.incr(`${pre}stats:evt:${event}:${date}`);
    }

    // Track search cities for "top search cities" dashboard
    if (event === 'search' && city) {
      pipe.hincrby(`${pre}stats:cities:${date}`, city.toLowerCase().trim(), 1);
    }

    // Store deal_click details — provider, route, timestamp (last 200 clicks)
    if (event === 'deal_click' && (provider || from || to)) {
      const clickEntry = JSON.stringify({
        provider: (provider || 'unknown').toLowerCase(),
        from: from || '',
        to: to || '',
        source: source || 'movacamper',
        ts: new Date().toISOString(),
      });
      pipe.lpush(`${pre}stats:deal_clicks_log`, clickEntry);
      pipe.ltrim(`${pre}stats:deal_clicks_log`, 0, 199); // keep last 200
      pipe.expire(`${pre}stats:deal_clicks_log`, ttl);
      // Per-provider counter
      if (provider) {
        pipe.hincrby(`${pre}stats:clicks_by_provider:${date}`, provider.toLowerCase(), 1);
        pipe.expire(`${pre}stats:clicks_by_provider:${date}`, ttl);
      }
    }

    // Store alt_click details — separate from deal_click so we can measure
    // no-results affiliate cards + contextual explore affiliates distinctly.
    // Added april 20 to answer: "do no-results Camperdays/Hostelworld/GetYourGuide cards actually convert?"
    if (event === 'alt_click' && (provider || from)) {
      const altEntry = JSON.stringify({
        provider: (provider || 'unknown').toLowerCase(),
        from: from || '',
        to: to || '',
        source: source || 'movacamper',
        ts: new Date().toISOString(),
        type: 'alt',
      });
      pipe.lpush(`${pre}stats:alt_clicks_log`, altEntry);
      pipe.ltrim(`${pre}stats:alt_clicks_log`, 0, 199);
      pipe.expire(`${pre}stats:alt_clicks_log`, ttl);
      if (provider) {
        pipe.hincrby(`${pre}stats:alt_clicks_by_provider:${date}`, provider.toLowerCase(), 1);
        pipe.expire(`${pre}stats:alt_clicks_by_provider:${date}`, ttl);
      }
    }

    // Store sub_impression — how often subscribe CTA was shown.
    // Added april 20 to answer: "are subs dropping because fewer people see the CTA, or fewer convert?"
    if (event === 'sub_impression') {
      const v = (typeof variant === 'string' && variant) ? variant.slice(0, 40) : 'unknown';
      pipe.hincrby(`${pre}stats:sub_impressions_by_variant:${date}`, v, 1);
      pipe.expire(`${pre}stats:sub_impressions_by_variant:${date}`, ttl);
    }

    // Set TTL on core keys
    pipe.expire(`${pre}stats:pv:${date}`, ttl);
    pipe.expire(`${pre}stats:uv:${date}`, ttl);
    pipe.expire(`${pre}stats:pages:${date}`, ttl);
    pipe.expire(`${pre}stats:ref:${date}`, ttl);
    pipe.expire(`${pre}stats:cities:${date}`, ttl);
    if (event && ALLOWED_EVENTS.has(event)) pipe.expire(`${pre}stats:evt:${event}:${date}`, ttl);

    await pipe.exec();
  } catch (err) {
    console.error('Track error:', err.message);
  }

  return res.status(200).json({ ok: true });
}
