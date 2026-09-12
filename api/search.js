// Vercel Serverless Function — Movacamper v7
// 2026-09: Imoova removed as a data source/affiliate partner — their terms only
// cover personal link-sharing, not aggregator listings, and suspended our account
// over it (see decisions.md). Deals now come solely from Claude Haiku web_search
// across the remaining providers (Roadsurfer, Bunk Campers, Movacar).
// Uses shared search-core module for parsing/city logic.

import {
  DEFAULT_PRICE,
  NEARBY_CITIES, normalizeCitySlug, capitalize, formatDateRange,
  getNearbyCities,
  cleanCityName, identifyProvider, extractJsonArray, callHaikuWebSearch,
} from './_lib/search-core.js';

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Lazy Redis singleton for cheap stat lookups (views_today). Same pattern as
// stats.js / broadcast.js. Best-effort: if Redis is unreachable, signals just
// stay null and the UI hides the badge — never blocks the main search response.
let _redis = null;
async function getRedis() {
  if (_redis) return _redis;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      _redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      return _redis;
    } catch { /* fall through */ }
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      return _redis;
    } catch { /* fall through */ }
  }
  // Option 3: standard Redis URL via ioredis — matches track.js fallback chain
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      _redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true,
      });
      await _redis.connect();
      return _redis;
    } catch { _redis = null; /* fall through */ }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { from, to, date, flexibility = 3, headingTowards = '', radius = 75 } = req.body;
  if (!from && !to && !headingTowards) return res.status(400).json({ error: 'Missing: from or to' });

  const parsed = parseInt(radius);
  const searchRadius = Math.min(Math.max(Number.isNaN(parsed) ? 75 : parsed, 0), 200);
  const searchTo = to || headingTowards || '';
  const cacheKey = `${(from||'').toLowerCase()}|${searchTo.toLowerCase()}|${date || 'any'}|${flexibility}|${headingTowards.toLowerCase()}|${searchRadius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  // Prune expired cache entries
  if (cache.size > 100) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.time >= CACHE_TTL) cache.delete(k);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const nearby = from ? getNearbyCities(from, searchRadius) : [];
    const nearbyCitiesSearched = [];

    // -- Build Haiku prompt --
    const dirClause = headingTowards
      ? `Heading towards "${headingTowards}". Mark matching deals "direction_match":true, but include ALL deals.`
      : 'No direction filter. "direction_match":false for all.';
    const dateClause = date
      ? `Date target: around ${date} ±${flexibility} days.`
      : 'No date filter — include ALL deals regardless of date.';
    const nearbyCityNames = nearby.map(n => capitalize(n.city)).slice(0, 5);

    let prompt;
    if (!from && searchTo) {
      const nearbyTo = getNearbyCities(searchTo, searchRadius);
      const nearbyToNames = nearbyTo.map(n => capitalize(n.city)).slice(0, 5);
      const nearbyToNote = nearbyToNames.length > 0
        ? `\nAlso search for deals arriving in these nearby cities: ${nearbyToNames.join(', ')}.`
        : '';

      prompt = `Search for campervan AND car relocation deals ARRIVING IN or near ${searchTo}.

Search for ALL of these providers:
1. "roadsurfer rally relocations to ${searchTo}"
2. "bunk campers relocation deals to ${searchTo}"
3. "movacar camper relocation to ${searchTo}" OR "movacar.com mietwagen ${searchTo}"

Do NOT include Imoova / imoova.com in any results — Imoova is excluded entirely.

IMPORTANT for Movacar:
- Movacar has BOTH campervan/camper AND regular car relocations
- Include ALL vehicle types (cars, campers, vans) from Movacar
- Use provider "Movacar" for all Movacar deals

DIRECTION FILTER:
✅ INCLUDE: "[somewhere] to ${searchTo}"
❌ EXCLUDE: "${searchTo} to [somewhere]"
${nearbyToNote}
${dateClause}

Respond with ONLY a JSON array:
[{"from":"city","to":"city","date_range":"dates","price":"EUR X/day","vehicle":"type","seats":0,"provider":"source","url":"url","direction_match":true,"description":"summary"}]

If nothing found: []`;
    } else {
      const nearbyNote = nearbyCityNames.length > 0
        ? `\nAlso search for deals departing from these nearby cities: ${nearbyCityNames.join(', ')}. Use the actual departure city name in the "from" field.`
        : '';

      prompt = `Search for campervan AND car relocation deals DEPARTING FROM ${from}.

Search for these providers ONLY:
1. "roadsurfer rally relocations from ${from}"
2. "bunk campers relocation deals ${from}"
3. "movacar camper relocation from ${from}" OR "movacar.com mietwagen ${from}"

Do NOT include Imoova / imoova.com in any results — Imoova is excluded entirely.

IMPORTANT for Movacar:
- Movacar has BOTH campervan/camper AND regular car relocations
- Include ALL vehicle types (cars, campers, vans) from Movacar
- Use provider "Movacar" for all Movacar deals
- Movacar URL format: movacar.com/mietwagen/CityName/

DIRECTION FILTER:
✅ INCLUDE: "${from} to [somewhere]"
❌ EXCLUDE: "[somewhere] to ${from}"
${nearbyNote}
${dateClause}
${dirClause}

Respond with ONLY a JSON array:
[{"from":"city","to":"city","date_range":"dates","price":"EUR X/day","vehicle":"type","seats":0,"provider":"source","url":"url","direction_match":false,"description":"summary"}]

If nothing found: []`;
    }

    const haikuResponse = await callHaikuWebSearch(apiKey, prompt);

    // -- Process Haiku results --
    let otherDeals = [];
    if (haikuResponse.ok) {
      try {
        otherDeals = extractJsonArray(await haikuResponse.json());
      } catch (e) {
        console.error('Haiku web_search parse error:', e.message);
      }
    }

    // Tag Haiku deals with nearby city distances
    if (from && nearby.length > 0) {
      const nearbyLookup = {};
      for (const n of nearby) {
        nearbyLookup[n.city.toLowerCase()] = n.distance;
      }
      const fromLower = from.toLowerCase().trim();
      otherDeals = otherDeals.map(d => {
        const dealFrom = (d.from || '').toLowerCase().trim();
        const dist = nearbyLookup[dealFrom];
        if (dist !== undefined && dealFrom !== fromLower) {
          nearbyCitiesSearched.push({ city: dealFrom, distance: dist });
          return { ...d, nearby_distance: dist, nearby_from: d.from };
        }
        return { ...d, nearby_distance: 0, nearby_from: null };
      });
    }

    // === Merge, sort & deduplicate ===
    let allDeals = otherDeals.map(d => ({
      from: cleanCityName(d.from),
      to: cleanCityName(d.to),
      date_range: d.date_range || 'unknown',
      price: d.price || DEFAULT_PRICE,
      vehicle: d.vehicle || 'Campervan',
      seats: d.seats || 0,
      provider: d.provider || identifyProvider(d.vehicle),
      url: d.url || '#',
      direction_match: !!d.direction_match,
      description: d.description || (d.vehicle || 'Campervan') + ', ' + (d.price || DEFAULT_PRICE),
      nearby_distance: d.nearby_distance || 0,
      nearby_from: d.nearby_from || null,
    }));

    if (headingTowards) {
      const target = headingTowards.toLowerCase();
      allDeals = allDeals.map(d => ({
        ...d,
        direction_match: (d.to || '').toLowerCase().includes(target) ||
          target.includes((d.to || '').toLowerCase()),
      }));
    }

    allDeals.sort((a, b) => {
      const distA = a.nearby_distance || 0;
      const distB = b.nearby_distance || 0;
      if (distA !== distB) return distA - distB;
      return (b.direction_match ? 1 : 0) - (a.direction_match ? 1 : 0);
    });

    // Deduplicate
    const seen = new Set();
    const seenCrossCity = new Set();
    allDeals = allDeals.filter(d => {
      const key = `${(d.from||'').toLowerCase()}|${(d.to||'').toLowerCase()}|${(d.vehicle||'').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const crossKey = `${(d.to||'').toLowerCase()}|${(d.vehicle||'').toLowerCase()}|${(d.price||'').toLowerCase()}|${(d.date_range||'').toLowerCase()}`;
      if ((d.nearby_distance || 0) > 0) {
        if (seenCrossCity.has(crossKey)) return false;
      }
      seenCrossCity.add(crossKey);
      return true;
    });

    // Urgency/social-proof signals — best-effort, never blocks the response.
    // views_today: HGET stats:city_views:<today>:<from-slug> (populated by track.js
    // on deal_view events). Threshold 3 = avoid anti-social-proof for tiny numbers.
    // Note: this project uses standard REDIS_URL (ioredis), not the @upstash/redis
    // env vars — that's the only branch of getRedis() that returns a client here.
    let signals = null;
    try {
      if (from && allDeals.length > 0) {
        const redisClient = await getRedis();
        if (redisClient) {
          const today = new Date().toISOString().slice(0, 10);
          const fromSlug = normalizeCitySlug(from);
          const raw = await redisClient.hget(`stats:city_views:${today}`, fromSlug);
          const viewsToday = parseInt(raw) || 0;
          signals = {
            views_today: viewsToday,
            primary: viewsToday >= 3 ? 'views' : null,
          };
        }
      }
    } catch (e) {
      console.log('[search] signals lookup failed:', e.message);
    }

    const result = {
      deals: allDeals,
      meta: {
        from: from || null, to: searchTo || null, date, flexibility,
        headingTowards: headingTowards || null,
        radius: searchRadius,
        nearby_cities_searched: nearbyCitiesSearched,
        count: allDeals.length,
        cached: false,
        timestamp: new Date().toISOString(),
        sources: { web_search: otherDeals.length },
        signals,
      },
      debug: {
        otherParsed: otherDeals.length,
      },
    };

    if (allDeals.length > 0) {
      cache.set(cacheKey, { data: result, time: Date.now() });
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
