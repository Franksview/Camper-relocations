// Vercel Serverless — Movacamper Analytics Dashboard API
// Returns pageviews, visitors, searches, referrers, pages for the last N days
// Protected with a simple token (not public data)

let store = null;

async function getStore() {
  if (store) return store;
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
  return null;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Simple auth: ?token=movacamper-stats-2026
  const token = req.query.token;
  if (token !== 'movacamper-stats-2026') {
    return res.status(401).json({ error: 'Unauthorized. Add ?token=movacamper-stats-2026' });
  }

  const redis = await getStore();
  if (!redis) {
    return res.status(200).json({ error: 'Redis not available', data: null });
  }

  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const dates = getDates(days);

  try {
    // Fetch all data in parallel using pipeline
    const pipe = redis.pipeline();

    for (const date of dates) {
      pipe.get(`stats:pv:${date}`);           // pageviews
      pipe.scard(`stats:uv:${date}`);          // unique visitors
      pipe.get(`stats:evt:search:${date}`);    // searches
      pipe.get(`stats:evt:subscribe:${date}`); // subscribes
      pipe.hgetall(`stats:ref:${date}`);       // referrers
      pipe.hgetall(`stats:pages:${date}`);     // pages
      pipe.hgetall(`stats:cities:${date}`);    // search cities
    }

    const results = await pipe.exec();
    const FIELDS_PER_DAY = 7;

    // Build daily timeseries
    const timeseries = [];
    let totalPV = 0, totalUV = 0, totalSearches = 0, totalSubs = 0;
    const allReferrers = {};
    const allPages = {};
    const allCities = {};

    for (let i = 0; i < dates.length; i++) {
      const base = i * FIELDS_PER_DAY;
      const pv = parseInt(results[base]) || 0;
      const uv = parseInt(results[base + 1]) || 0;
      const searches = parseInt(results[base + 2]) || 0;
      const subs = parseInt(results[base + 3]) || 0;
      const refs = results[base + 4] || {};
      const pages = results[base + 5] || {};
      const cities = results[base + 6] || {};

      totalPV += pv;
      totalUV += uv;
      totalSearches += searches;
      totalSubs += subs;

      // Aggregate referrers
      for (const [k, v] of Object.entries(refs)) {
        allReferrers[k] = (allReferrers[k] || 0) + (parseInt(v) || 0);
      }
      // Aggregate pages
      for (const [k, v] of Object.entries(pages)) {
        allPages[k] = (allPages[k] || 0) + (parseInt(v) || 0);
      }
      // Aggregate cities
      for (const [k, v] of Object.entries(cities)) {
        allCities[k] = (allCities[k] || 0) + (parseInt(v) || 0);
      }

      timeseries.push({
        date: dates[i],
        pageviews: pv,
        visitors: uv,
        searches,
        subscribes: subs,
      });
    }

    // Sort referrers and pages by count descending
    const topReferrers = Object.entries(allReferrers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([source, count]) => ({ source, count }));

    const topPages = Object.entries(allPages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([path, count]) => ({ path, count }));

    const topCities = Object.entries(allCities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([city, count]) => ({ city, count }));

    // Get subscriber count
    let subscriberCount = 0;
    try {
      subscriberCount = await redis.scard('subscribers:emails') || 0;
    } catch (e) { /* ignore */ }

    // Calculate simple bounce-like metric:
    // If pages tracked > visitors → avg pages per session > 1 → low bounce
    const avgPagesPerVisitor = totalUV > 0 ? (totalPV / totalUV).toFixed(1) : 0;

    return res.status(200).json({
      period: { days, from: dates[0], to: dates[dates.length - 1] },
      totals: {
        pageviews: totalPV,
        visitors: totalUV,
        searches: totalSearches,
        subscribes: totalSubs,
        subscribers_total: subscriberCount,
        avg_pages_per_visitor: parseFloat(avgPagesPerVisitor),
      },
      timeseries,
      top_referrers: topReferrers,
      top_pages: topPages,
      top_search_cities: topCities,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: 'Failed to fetch stats', detail: err.message });
  }
}
