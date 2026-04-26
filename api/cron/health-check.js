// Movacamper — Subscriber Pipeline Health Check
// GET /api/cron/health-check?token=mc-dash-9xK7qW3p
// Detects: broken records, missed deal notifications, failed welcome emails, fetch errors.

async function getRedis() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      const client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true,
      });
      await client.connect();
      return client;
    } catch (e) { /* fall through */ }
  }
  return null;
}

async function getSearchCore() {
  const mod = await import('../lib/search-core.js');
  return mod;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dashToken = process.env.DASH_TOKEN;
  if (!dashToken || req.query.token !== dashToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const redis = await getRedis();
  if (!redis) {
    return res.status(200).json({ ok: false, reason: 'no redis' });
  }

  const { fetchAllDealsForCity, normalizeCitySlug } = await getSearchCore();
  const now = new Date();
  const anomalies = [];

  try {
    // ── 1. Read all subscriber emails ──
    const emails = await redis.smembers('subscribers:emails');
    const totalSubscribers = emails ? emails.length : 0;

    if (!emails || emails.length === 0) {
      return res.status(200).json({
        ok: true,
        checked_at: now.toISOString(),
        total_subscribers: 0,
        anomalies: [],
        anomaly_count: 0,
      });
    }

    // ── 2. Fetch all sub records in one pipeline ──
    const pipe = redis.pipeline();
    for (const email of emails) pipe.get(`sub:${email}`);
    const rawResults = await pipe.exec();
    const subResults = rawResults.map(r => Array.isArray(r) ? r[1] : r);

    // ── 3. Read pending drafts set ──
    const pendingDrafts = new Set();
    try {
      const draftEmails = await redis.smembers('email:drafts');
      if (draftEmails) draftEmails.forEach(e => pendingDrafts.add(e));
    } catch (e) { /* best-effort */ }

    // ── 4. Parse records; flag broken ones ──
    // Optional source filter: ?source=movacamper or ?source=relocamp
    const sourceFilter = req.query.source || null;

    const validSubs = [];
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const raw = subResults[i];
      let sub = null;
      try {
        sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!sub || typeof sub !== 'object') throw new Error('null or non-object');
      } catch (e) {
        anomalies.push({ type: 'broken_record', email });
        continue;
      }
      if (sourceFilter && sub.source !== sourceFilter) continue;
      validSubs.push(sub);
    }

    // ── 5. Filter to active city-specific subscribers eligible for checking ──
    const eligibleSubs = validSubs.filter(sub => {
      if (sub.status === 'unsubscribed') return false;
      if (!sub.city || sub.city === 'any') return false;
      if (pendingDrafts.has(sub.email)) return false;
      // Only check subscribers who haven't been emailed in 7+ days (or never)
      if (sub.lastEmailed) {
        const daysSince = (now - new Date(sub.lastEmailed)) / (1000 * 60 * 60 * 24);
        if (daysSince < 7) return false;
      }
      return true;
    });

    // ── 6. Check for welcome email failures ──
    for (const sub of validSubs) {
      if (sub.status === 'unsubscribed') continue;
      if (sub.emailCount === 0 || sub.emailCount == null) {
        if (sub.created) {
          const hoursAgo = (now - new Date(sub.created)) / (1000 * 60 * 60);
          if (hoursAgo > 48) {
            anomalies.push({
              type: 'welcome_not_sent',
              email: sub.email,
              source: sub.source || 'unknown',
              hours_ago: Math.round(hoursAgo),
            });
          }
        }
      }
    }

    // ── 7. Per city: call fetchAllDealsForCity, check for missed notifications ──
    const cityGroups = new Map(); // slug → [subscriber, ...]
    for (const sub of eligibleSubs) {
      const slug = normalizeCitySlug(sub.city);
      if (!cityGroups.has(slug)) cityGroups.set(slug, []);
      cityGroups.get(slug).push(sub);
    }

    const fetchCache = new Map(); // slug → { deals, error }

    for (const [citySlug, subs] of cityGroups) {
      if (!fetchCache.has(citySlug)) {
        try {
          const result = await fetchAllDealsForCity(citySlug, {
            radiusKm: 300,
            timeoutMs: 6000,
            apiKey: process.env.ANTHROPIC_API_KEY || null,
          });
          fetchCache.set(citySlug, { result, error: null });
        } catch (e) {
          fetchCache.set(citySlug, { result: null, error: e.message });
          anomalies.push({ type: 'fetch_error', city: citySlug, error: e.message });
        }
      }

      const cached = fetchCache.get(citySlug);
      if (cached.error) continue; // already flagged above

      const { result } = cached;
      const exactDeals = (result && result.exact) ? result.exact : [];
      const nearbyDeals = (result && result.nearby) ? result.nearby : [];
      const totalDeals = exactDeals.length + nearbyDeals.reduce((s, g) => s + (g.deals ? g.deals.length : 0), 0);

      if (totalDeals > 0) {
        for (const sub of subs) {
          // Deals exist, subscriber is eligible, no draft pending — potential missed notification
          anomalies.push({
            type: 'missed_deals',
            email: sub.email,
            source: sub.source || 'unknown',
            city: citySlug,
            deals_found: totalDeals,
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      checked_at: now.toISOString(),
      total_subscribers: totalSubscribers,
      anomalies,
      anomaly_count: anomalies.length,
    });

  } catch (err) {
    console.error('Health check error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
