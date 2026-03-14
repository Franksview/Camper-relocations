// Vercel Serverless — Movacamper Analytics Dashboard API
// Hybrid: Vercel Analytics (pageviews, visitors, referrers) + Redis (searches, subscribes, cities)
// Protected with a simple token (not public data)

const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN || '';
const PROJECT_ID = 'prj_GfYueje1crUpH7hHxTcjrpd0Yakf';
const TEAM_ID = 'team_c27AX5TXS9iXkl11bF1X0Hyj';
const VERCEL_INSIGHTS_BASE = 'https://vercel.com/api/web/insights';

let store = null;

async function getStore() {
  if (store) return store;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      return store;
    } catch (e) { /* fall through */ }
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      return store;
    } catch (e) { /* fall through */ }
  }
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      store = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true,
      });
      await store.connect();
      return store;
    } catch (e) { /* fall through */ }
  }
  return null;
}

// ── Vercel Analytics fetchers ──
async function fetchVercel(endpoint, params = {}) {
  const qs = new URLSearchParams({
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    ...params,
  }).toString();
  try {
    const res = await fetch(`${VERCEL_INSIGHTS_BASE}/${endpoint}?${qs}`, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function getDates(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.query.token;
  if (token !== 'movacamper-stats-2026') {
    return res.status(401).json({ error: 'Unauthorized. Add ?token=movacamper-stats-2026' });
  }

  const redis = await getStore();

  // DELETE: reset a specific day's custom stats
  if (req.method === 'DELETE') {
    if (!redis) return res.status(200).json({ ok: true, note: 'no redis' });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const keys = [
      `stats:pv:${date}`, `stats:uv:${date}`, `stats:pages:${date}`,
      `stats:ref:${date}`, `stats:cities:${date}`,
      `stats:evt:search:${date}`, `stats:evt:subscribe:${date}`,
    ];
    for (const key of keys) {
      try { await redis.del(key); } catch (e) { /* ignore */ }
    }
    return res.status(200).json({ ok: true, cleared: date });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or DELETE only' });

  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const dates = getDates(days);
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  try {
    // ── Fetch Vercel Analytics + Redis in parallel ──
    const vercelParams = { from: fromDate, to: toDate };

    const [
      vercelTimeseries,
      vercelPages,
      vercelReferrers,
      vercelCountries,
      vercelDevices,
      vercelOverview,
      redisData,
    ] = await Promise.all([
      fetchVercel('timeseries', vercelParams),
      fetchVercel('stats/path', { ...vercelParams, limit: '20' }),
      fetchVercel('stats/referrer_hostname', { ...vercelParams, limit: '20' }),
      fetchVercel('stats/country', { ...vercelParams, limit: '20' }),
      fetchVercel('stats/device_type', { ...vercelParams, limit: '10' }),
      fetchVercel('overview', vercelParams),
      fetchRedisData(redis, dates),
    ]);

    // ── Build timeseries (Vercel for traffic, Redis for searches) ──
    const vercelByDate = {};
    if (vercelTimeseries?.data) {
      for (const d of vercelTimeseries.data) {
        vercelByDate[d.key] = { total: d.total || 0, devices: d.devices || 0 };
      }
    }

    const timeseries = [];
    let totalPV = 0, totalUV = 0, totalSearches = 0, totalSubs = 0;

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const v = vercelByDate[date] || { total: 0, devices: 0 };
      const r = redisData.daily[i] || { searches: 0, subscribes: 0 };

      totalPV += v.total;
      totalUV += v.devices;
      totalSearches += r.searches;
      totalSubs += r.subscribes;

      timeseries.push({
        date,
        pageviews: v.total,
        visitors: v.devices,
        searches: r.searches,
        subscribes: r.subscribes,
      });
    }

    // ── Top pages (Vercel) ──
    const topPages = (vercelPages?.data || []).map(d => ({
      path: d.key, count: d.total, visitors: d.devices,
    }));

    // ── Top referrers (Vercel) ──
    const topReferrers = (vercelReferrers?.data || []).map(d => ({
      source: d.key, count: d.total, visitors: d.devices,
    }));

    // ── Countries (Vercel) ──
    const countries = (vercelCountries?.data || []).map(d => ({
      country: d.key, count: d.total, visitors: d.devices,
    }));

    // ── Devices (Vercel) ──
    const devices = (vercelDevices?.data || []).map(d => ({
      type: d.key, count: d.total, visitors: d.devices,
    }));

    // ── Subscriber count (Redis) ──
    let subscriberCount = 0;
    if (redis) {
      try { subscriberCount = await redis.scard('subscribers:emails') || 0; } catch (e) { /* */ }
    }

    const avgPagesPerVisitor = totalUV > 0 ? parseFloat((totalPV / totalUV).toFixed(1)) : 0;

    return res.status(200).json({
      period: { days, from: fromDate, to: toDate },
      totals: {
        pageviews: totalPV,
        visitors: totalUV,
        searches: totalSearches,
        subscribes: totalSubs,
        subscribers_total: subscriberCount,
        avg_pages_per_visitor: avgPagesPerVisitor,
      },
      timeseries,
      top_referrers: topReferrers,
      top_pages: topPages,
      top_search_cities: redisData.topCities,
      countries,
      devices,
      sources: {
        traffic: vercelTimeseries ? 'vercel-analytics' : 'redis-fallback',
        searches: 'redis',
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: 'Failed to fetch stats', detail: err.message });
  }
}

// ── Redis: fetch search/subscribe/city data ──
async function fetchRedisData(redis, dates) {
  const empty = { daily: dates.map(() => ({ searches: 0, subscribes: 0 })), topCities: [] };
  if (!redis) return empty;

  try {
    const pipe = redis.pipeline();
    for (const date of dates) {
      pipe.get(`stats:evt:search:${date}`);
      pipe.get(`stats:evt:subscribe:${date}`);
      pipe.hgetall(`stats:cities:${date}`);
    }

    const rawResults = await pipe.exec();
    const results = rawResults.map(r => Array.isArray(r) ? r[1] : r);

    const daily = [];
    const allCities = {};

    for (let i = 0; i < dates.length; i++) {
      const base = i * 3;
      const searches = parseInt(results[base]) || 0;
      const subscribes = parseInt(results[base + 1]) || 0;
      const cities = results[base + 2] || {};

      daily.push({ searches, subscribes });

      for (const [k, v] of Object.entries(cities)) {
        allCities[k] = (allCities[k] || 0) + (parseInt(v) || 0);
      }
    }

    const topCities = Object.entries(allCities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([city, count]) => ({ city, count }));

    return { daily, topCities };
  } catch (err) {
    console.error('Redis fetch error:', err.message);
    return empty;
  }
}
