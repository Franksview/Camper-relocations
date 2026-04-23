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
  const dashToken = process.env.DASH_TOKEN || 'mc-dash-9xK7qW3p';
  if (token !== dashToken) {
    return res.status(401).json({ error: 'Unauthorized' });
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
    try {
      const pipe = redis.pipeline();
      for (const key of keys) pipe.del(key);
      await pipe.exec();
    } catch (e) { /* ignore */ }
    return res.status(200).json({ ok: true, cleared: date });
  }

  // PATCH: mark subscriber as replied
  if (req.method === 'PATCH') {
    if (!redis) return res.status(200).json({ ok: false, note: 'no redis' });
    const email = req.query.email || (req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'email required' });
    try {
      const raw = await redis.get(`sub:${email}`);
      if (!raw) return res.status(404).json({ error: 'subscriber not found' });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      data.replied = !data.replied; // toggle
      data.repliedAt = data.replied ? new Date().toISOString() : null;
      await redis.set(`sub:${email}`, JSON.stringify(data));
      return res.status(200).json({ ok: true, replied: data.replied });
    } catch (err) {
      console.error('Mark replied error:', err);
      return res.status(500).json({ error: 'Failed to update subscriber' });
    }
  }

  // POST: send a draft email or trigger cron
  if (req.method === 'POST') {
    if (!redis) return res.status(200).json({ ok: false, note: 'no redis' });

    // Send a draft email (uses pre-built HTML from draft)
    if (req.query.action === 'send-draft') {
      const email = req.query.email || (req.body && req.body.email);
      if (!email) return res.status(400).json({ error: 'email required' });
      try {
        const raw = await redis.get(`draft:${email}`);
        if (!raw) return res.status(404).json({ error: 'draft not found' });
        const draft = typeof raw === 'string' ? JSON.parse(raw) : raw;

        const { sendEmail } = await import('./email.js');

        // Use the pre-built HTML stored in the draft, with source-aware branding
        const result = await sendEmail({
          to: draft.to,
          subject: draft.subject,
          html: draft.html,
          fromName: draft.fromName || 'Movacamper',
        });

        if (result.sent) {
          // Remove draft
          await redis.del(`draft:${email}`);
          await redis.srem('email:drafts', email);

          // Update subscriber record
          const sub = await redis.get(`sub:${email}`);
          const subData = typeof sub === 'string' ? JSON.parse(sub) : sub;
          if (subData) {
            subData.lastEmailed = new Date().toISOString();
            subData.emailCount = (subData.emailCount || 0) + 1;
            subData.replied = true;
            subData.repliedAt = new Date().toISOString();
            await redis.set(`sub:${email}`, JSON.stringify(subData));
          }

          // Update lastNoMatchSent if this was a no-match draft
          if (draft.type === 'no-match' && subData) {
            subData.lastNoMatchSent = new Date().toISOString();
            await redis.set(`sub:${email}`, JSON.stringify(subData));
          }

          // Log sent email
          await redis.lpush('email:sent-log', JSON.stringify({
            to: email, subject: draft.subject, type: draft.type, sentAt: new Date().toISOString(),
          }));

          // Log history event
          try {
            const { logEvent } = await import('./lib/history.js');
            await logEvent(redis, email, `${draft.type}-sent`, { subject: draft.subject });
          } catch (e) { /* best-effort */ }

          return res.status(200).json({ ok: true, sent: true });
        }
        return res.status(200).json({ ok: false, reason: result.reason });
      } catch (err) {
        console.error('Send draft error:', err);
        return res.status(500).json({ error: 'Failed to send draft' });
      }
    }

    // Dismiss a draft
    if (req.query.action === 'dismiss-draft') {
      const email = req.query.email || (req.body && req.body.email);
      if (!email) return res.status(400).json({ error: 'email required' });
      try {
        await redis.del(`draft:${email}`);
        await redis.srem('email:drafts', email);
        try {
          const { logEvent } = await import('./lib/history.js');
          await logEvent(redis, email, 'dismissed', {});
        } catch (e) { /* best-effort */ }
        return res.status(200).json({ ok: true });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to dismiss draft' });
      }
    }

    // Edit subscriber preferences (from dashboard)
    if (req.query.action === 'edit-subscriber') {
      const email = req.query.email || (req.body && req.body.email);
      if (!email) return res.status(400).json({ error: 'email required' });
      try {
        const raw = await redis.get(`sub:${email}`);
        if (!raw) return res.status(404).json({ error: 'subscriber not found' });
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

        const { city, date, flexibility, notes } = req.body || {};
        const changes = {};
        if (city !== undefined) { changes.oldCity = data.city; data.city = city.trim() || 'any'; changes.newCity = data.city; }
        if (date !== undefined) { changes.oldDate = data.date; data.date = date || null; changes.newDate = data.date; }
        if (flexibility !== undefined) { data.flexibility = parseInt(flexibility) || 7; changes.flexibility = data.flexibility; }
        if (notes !== undefined) { data.notes = notes; changes.notes = true; }

        await redis.set(`sub:${email}`, JSON.stringify(data));

        try {
          const { logEvent } = await import('./lib/history.js');
          await logEvent(redis, email, 'admin-edited', changes);
        } catch (e) { /* best-effort */ }

        return res.status(200).json({ ok: true, subscriber: data });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to update subscriber' });
      }
    }

    return res.status(400).json({ error: 'Unknown POST action' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET, DELETE, PATCH, or POST only' });

  // ── Drafts list endpoint ──
  if (req.query.action === 'drafts') {
    if (!redis) return res.status(200).json({ drafts: [] });
    try {
      const draftEmails = await redis.smembers('email:drafts');
      if (!draftEmails || draftEmails.length === 0) return res.status(200).json({ drafts: [] });
      const pipe = redis.pipeline();
      for (const e of draftEmails) pipe.get(`draft:${e}`);
      const rawResults = await pipe.exec();
      const drafts = rawResults
        .map(r => { try { const v = Array.isArray(r) ? r[1] : r; return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } })
        .filter(Boolean);
      return res.status(200).json({ drafts, total: drafts.length });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch drafts' });
    }
  }

  // ── Sent log endpoint ──
  if (req.query.action === 'sent-log') {
    if (!redis) return res.status(200).json({ log: [] });
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const raw = await redis.lrange('email:sent-log', 0, limit - 1);
      const log = (raw || []).map(entry => {
        try { return typeof entry === 'string' ? JSON.parse(entry) : entry; } catch { return null; }
      }).filter(Boolean);
      return res.status(200).json({ log, total: log.length });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch sent log' });
    }
  }

  // ── Deal click log endpoint ──
  if (req.query.action === 'deal-clicks') {
    if (!redis) return res.status(200).json({ clicks: [] });
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const [mcClicks, reloClicks] = await Promise.all([
        redis.lrange('stats:deal_clicks_log', 0, limit - 1).catch(() => []),
        redis.lrange('relo:stats:deal_clicks_log', 0, limit - 1).catch(() => []),
      ]);
      const clicks = [...(mcClicks || []), ...(reloClicks || [])]
        .map(c => { try { return typeof c === 'string' ? JSON.parse(c) : c; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts));
      return res.status(200).json({ clicks, total: clicks.length });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch deal clicks' });
    }
  }

  // ── Alt click log endpoint (no-results affiliate cards + contextual explore) ──
  if (req.query.action === 'alt-clicks') {
    if (!redis) return res.status(200).json({ clicks: [], by_provider: {} });
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const days = Math.max(1, Math.min(parseInt(req.query.days) || 7, 90));
      // Build date range for by-provider breakdown
      const dates = [];
      const today = new Date();
      for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
      const [mcLog, reloLog, ...breakdowns] = await Promise.all([
        redis.lrange('stats:alt_clicks_log', 0, limit - 1).catch(() => []),
        redis.lrange('relo:stats:alt_clicks_log', 0, limit - 1).catch(() => []),
        ...dates.flatMap(date => [
          redis.hgetall(`stats:alt_clicks_by_provider:${date}`).catch(() => ({})),
          redis.hgetall(`relo:stats:alt_clicks_by_provider:${date}`).catch(() => ({})),
        ]),
      ]);
      const clicks = [...(mcLog || []), ...(reloLog || [])]
        .map(c => { try { return typeof c === 'string' ? JSON.parse(c) : c; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts));
      // Aggregate by_provider across both sources + all dates
      const byProvider = {};
      breakdowns.forEach(hash => {
        if (!hash) return;
        Object.entries(hash).forEach(([provider, count]) => {
          byProvider[provider] = (byProvider[provider] || 0) + parseInt(count, 10);
        });
      });
      return res.status(200).json({ clicks, total: clicks.length, by_provider: byProvider, days });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch alt clicks' });
    }
  }

  // ── Subscribe impression breakdown ──
  // Returns impressions count + subs count + conversion rate per variant.
  // Answers: are subs dropping because fewer impressions, or fewer conversions?
  if (req.query.action === 'sub-funnel') {
    if (!redis) return res.status(200).json({ by_variant: {}, total_impressions: 0, total_subs: 0 });
    try {
      const days = Math.max(1, Math.min(parseInt(req.query.days) || 14, 90));
      const dates = [];
      const today = new Date();
      for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
      const pipe = redis.pipeline();
      dates.forEach(date => {
        pipe.hgetall(`stats:sub_impressions_by_variant:${date}`);
        pipe.get(`stats:evt:sub_impression:${date}`);
        pipe.get(`stats:evt:subscribe:${date}`);
      });
      const raw = await pipe.exec();
      const results = raw.map(r => Array.isArray(r) ? r[1] : r);
      const byVariant = {};
      let totalImpressions = 0;
      let totalSubs = 0;
      for (let i = 0; i < dates.length; i++) {
        const variantHash = results[i * 3] || {};
        const impDay = parseInt(results[i * 3 + 1] || 0, 10);
        const subDay = parseInt(results[i * 3 + 2] || 0, 10);
        totalImpressions += impDay;
        totalSubs += subDay;
        Object.entries(variantHash).forEach(([v, count]) => {
          byVariant[v] = (byVariant[v] || 0) + parseInt(count, 10);
        });
      }
      return res.status(200).json({
        by_variant: byVariant,
        total_impressions: totalImpressions,
        total_subs: totalSubs,
        conversion_rate: totalImpressions > 0 ? (totalSubs / totalImpressions * 100).toFixed(2) + '%' : 'n/a',
        days,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch sub funnel' });
    }
  }

  // ── Subscriber history endpoint ──
  if (req.query.action === 'subscriber-history') {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!redis) return res.status(200).json({ history: [] });
    try {
      const { getHistory } = await import('./lib/history.js');
      const history = await getHistory(redis, email, 50);
      return res.status(200).json({ history, email });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch history' });
    }
  }

  // ── Subscriber list endpoint ──
  if (req.query.action === 'subscribers') {
    if (!redis) return res.status(200).json({ subscribers: [], note: 'no redis' });
    try {
      const emails = await redis.smembers('subscribers:emails');
      if (!emails || emails.length === 0) return res.status(200).json({ subscribers: [] });

      const pipe = redis.pipeline();
      for (const email of emails) pipe.get(`sub:${email}`);
      const rawResults = await pipe.exec();
      const results = rawResults.map(r => Array.isArray(r) ? r[1] : r);

      const subscribers = [];
      for (let i = 0; i < emails.length; i++) {
        try {
          const data = typeof results[i] === 'string' ? JSON.parse(results[i]) : results[i];
          if (data) {
            subscribers.push(data);
          } else {
            subscribers.push({ email: emails[i], city: 'unknown', created: null });
          }
        } catch (e) {
          subscribers.push({ email: emails[i], city: 'unknown', created: null });
        }
      }

      // Sort by created date, newest first
      subscribers.sort((a, b) => {
        if (!a.created) return 1;
        if (!b.created) return -1;
        return new Date(b.created) - new Date(a.created);
      });

      return res.status(200).json({ subscribers, total: subscribers.length });
    } catch (err) {
      console.error('Subscriber list error:', err);
      return res.status(500).json({ error: 'Failed to fetch subscribers' });
    }
  }

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
      redisData,
      subscriberCount,
      relocampData,
    ] = await Promise.all([
      fetchVercel('timeseries', vercelParams),
      fetchVercel('stats/path', { ...vercelParams, limit: '20' }),
      fetchVercel('stats/referrer_hostname', { ...vercelParams, limit: '20' }),
      fetchVercel('stats/country', { ...vercelParams, limit: '20' }),
      fetchVercel('stats/device_type', { ...vercelParams, limit: '10' }),
      fetchRedisData(redis, dates),
      redis ? redis.scard('subscribers:emails').catch(() => 0) : Promise.resolve(0),
      fetchRelocampData(redis, dates),
    ]);

    // ── Build timeseries (Vercel for traffic, Redis for searches) ──
    const vercelByDate = {};
    if (vercelTimeseries?.data) {
      for (const d of vercelTimeseries.data) {
        vercelByDate[d.key] = { total: d.total || 0, devices: d.devices || 0 };
      }
    }

    // Redis PV/UV fallback — fixes "0 visitors" dashboard bug.
    // (april 23: Vercel API returned populated date keys with 0 totals → previous
    //  `if (!vercelHasData)` check was false but every day was still 0. Now we ALWAYS
    //  fetch Redis PV/UV and take max per-day so numbers never silently disappear,
    //  regardless of whether Vercel Analytics is broken, delayed, or under-counting.)
    let redisPvUv = {};
    if (redis) {
      try {
        const pipe = redis.pipeline();
        dates.forEach(date => {
          pipe.get(`stats:pv:${date}`);
          pipe.scard(`stats:uv:${date}`);
        });
        const raw = await pipe.exec();
        const results = raw.map(r => Array.isArray(r) ? r[1] : r);
        dates.forEach((date, i) => {
          redisPvUv[date] = {
            total: parseInt(results[i * 2] || 0, 10),
            devices: parseInt(results[i * 2 + 1] || 0, 10),
          };
        });
      } catch (e) { /* fall through, use zeros */ }
    }

    const timeseries = [];
    let totalPV = 0, totalUV = 0, totalSearches = 0, totalSubs = 0;
    let totalDealClicks = 0, totalDealViews = 0, totalTripAdds = 0, totalTripShares = 0;
    let totalSearchResults = 0, totalSearchNoResults = 0;

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      // Take max(vercel, redis) per-day so we never lose numbers if either source
      // under-reports or silently returns zeros. Redis is ground truth (our own
      // tracker pixel); Vercel is a secondary signal that sometimes includes bots.
      const vcl = vercelByDate[date] || { total: 0, devices: 0 };
      const rds = redisPvUv[date] || { total: 0, devices: 0 };
      const v = {
        total: Math.max(vcl.total, rds.total),
        devices: Math.max(vcl.devices, rds.devices),
      };
      const r = redisData.daily[i] || {};

      totalPV += v.total;
      totalUV += v.devices;
      totalSearches += r.searches || 0;
      totalSubs += r.subscribes || 0;
      totalDealClicks += r.deal_clicks || 0;
      totalDealViews += r.deal_views || 0;
      totalTripAdds += r.trip_adds || 0;
      totalTripShares += r.trip_shares || 0;
      totalSearchResults += r.search_results || 0;
      totalSearchNoResults += r.search_no_results || 0;

      timeseries.push({
        date,
        pageviews: v.total,
        visitors: v.devices,
        searches: r.searches || 0,
        subscribes: r.subscribes || 0,
        deal_clicks: r.deal_clicks || 0,
        deal_views: r.deal_views || 0,
        trip_adds: r.trip_adds || 0,
        trip_shares: r.trip_shares || 0,
        search_results: r.search_results || 0,
        search_no_results: r.search_no_results || 0,
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
        deal_clicks: totalDealClicks,
        deal_views: totalDealViews,
        trip_adds: totalTripAdds,
        trip_shares: totalTripShares,
        search_results: totalSearchResults,
        search_no_results: totalSearchNoResults,
      },
      timeseries,
      top_referrers: topReferrers,
      top_pages: topPages,
      top_search_cities: redisData.topCities,
      countries,
      devices,
      relocamp: relocampData,
      sources: {
        traffic: vercelTimeseries ? 'vercel-analytics' : 'redis-fallback',
        searches: 'redis',
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
}

// ── Redis: fetch search/subscribe/city data ──
async function fetchRedisData(redis, dates) {
  const empty = { daily: dates.map(() => ({ searches: 0, subscribes: 0, deal_clicks: 0, deal_views: 0, trip_adds: 0, trip_shares: 0, search_results: 0, search_no_results: 0 })), topCities: [] };
  if (!redis) return empty;

  try {
    const pipe = redis.pipeline();
    for (const date of dates) {
      pipe.get(`stats:evt:search:${date}`);              // 0: searches
      pipe.get(`stats:evt:subscribe:${date}`);            // 1: subscribes
      pipe.hgetall(`stats:cities:${date}`);               // 2: cities
      pipe.get(`stats:evt:deal_click:${date}`);           // 3: deal clicks
      pipe.get(`stats:evt:deal_view:${date}`);            // 4: deal views
      pipe.get(`stats:evt:trip_add:${date}`);             // 5: trip adds
      pipe.get(`stats:evt:trip_share:${date}`);           // 6: trip shares
      pipe.get(`stats:evt:search_results:${date}`);       // 7: search results
      pipe.get(`stats:evt:search_no_results:${date}`);    // 8: search no results
    }

    const rawResults = await pipe.exec();
    const results = rawResults.map(r => Array.isArray(r) ? r[1] : r);

    const daily = [];
    const allCities = {};

    for (let i = 0; i < dates.length; i++) {
      const base = i * 9;
      const searches = parseInt(results[base]) || 0;
      const subscribes = parseInt(results[base + 1]) || 0;
      const cities = results[base + 2] || {};
      const dealClicks = parseInt(results[base + 3]) || 0;
      const dealViews = parseInt(results[base + 4]) || 0;
      const tripAdds = parseInt(results[base + 5]) || 0;
      const tripShares = parseInt(results[base + 6]) || 0;
      const searchResults = parseInt(results[base + 7]) || 0;
      const searchNoResults = parseInt(results[base + 8]) || 0;

      daily.push({ searches, subscribes, deal_clicks: dealClicks, deal_views: dealViews, trip_adds: tripAdds, trip_shares: tripShares, search_results: searchResults, search_no_results: searchNoResults });

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

// ── Redis: fetch Relocamp data (relo: prefix) ──
async function fetchRelocampData(redis, dates) {
  const empty = {
    totals: { visitors: 0, pageviews: 0, searches: 0, trip_adds: 0, trip_shares: 0, deal_clicks: 0 },
    timeseries: dates.map(d => ({ date: d, visitors: 0, pageviews: 0, searches: 0 })),
    topCities: [],
  };
  if (!redis) return empty;

  try {
    const pipe = redis.pipeline();
    for (const date of dates) {
      pipe.get(`relo:stats:pv:${date}`);               // 0: pageviews
      pipe.scard(`relo:stats:uv:${date}`);              // 1: unique visitors
      pipe.get(`relo:stats:evt:search:${date}`);        // 2: searches
      pipe.get(`relo:stats:evt:trip_add:${date}`);      // 3: trip adds
      pipe.get(`relo:stats:evt:trip_share:${date}`);    // 4: trip shares
      pipe.get(`relo:stats:evt:deal_click:${date}`);    // 5: deal clicks
      pipe.hgetall(`relo:stats:cities:${date}`);        // 6: cities
      pipe.get(`relo:stats:evt:search_no_results:${date}`); // 7: no results
      pipe.get(`relo:stats:evt:search_results:${date}`);    // 8: results found
      pipe.get(`relo:stats:evt:deal_view:${date}`);         // 9: deal views
    }

    const rawResults = await pipe.exec();
    const results = rawResults.map(r => Array.isArray(r) ? r[1] : r);

    const timeseries = [];
    const allCities = {};
    let totalPV = 0, totalUV = 0, totalSearches = 0, totalAdds = 0, totalShares = 0, totalClicks = 0;
    let totalNoResults = 0, totalResults = 0, totalDealViews = 0;

    for (let i = 0; i < dates.length; i++) {
      const base = i * 10;
      const pv = parseInt(results[base]) || 0;
      const uv = parseInt(results[base + 1]) || 0;
      const searches = parseInt(results[base + 2]) || 0;
      const adds = parseInt(results[base + 3]) || 0;
      const shares = parseInt(results[base + 4]) || 0;
      const clicks = parseInt(results[base + 5]) || 0;
      const cities = results[base + 6] || {};
      const noResults = parseInt(results[base + 7]) || 0;
      const withResults = parseInt(results[base + 8]) || 0;
      const dealViews = parseInt(results[base + 9]) || 0;

      totalPV += pv;
      totalUV += uv;
      totalSearches += searches;
      totalAdds += adds;
      totalShares += shares;
      totalClicks += clicks;
      totalNoResults += noResults;
      totalResults += withResults;
      totalDealViews += dealViews;

      timeseries.push({ date: dates[i], pageviews: pv, visitors: uv, searches, trip_adds: adds, trip_shares: shares, search_no_results: noResults, search_results: withResults, deal_views: dealViews });

      for (const [k, v] of Object.entries(cities)) {
        allCities[k] = (allCities[k] || 0) + (parseInt(v) || 0);
      }
    }

    const topCities = Object.entries(allCities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([city, count]) => ({ city, count }));

    return {
      totals: { visitors: totalUV, pageviews: totalPV, searches: totalSearches, trip_adds: totalAdds, trip_shares: totalShares, deal_clicks: totalClicks, search_no_results: totalNoResults, search_results: totalResults, deal_views: totalDealViews },
      timeseries,
      topCities,
    };
  } catch (err) {
    console.error('Relocamp Redis fetch error:', err.message);
    return empty;
  }
}
