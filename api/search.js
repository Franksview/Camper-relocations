// Vercel Serverless Function — Movacamper v6.2
// Hybrid: direct Imoova fetch (primary + nearby cities) + Claude Haiku for other providers
// Uses shared search-core module for all scraping/parsing logic

import {
  HAIKU_MODEL, ANTHROPIC_VERSION, IMOOVA_FALLBACK_URL, DEFAULT_PRICE,
  NEARBY_CITIES, normalizeCitySlug, capitalize, formatDateRange,
  getNearbyCities, fetchImoovaPage, parseImoovaHtml,
  cleanCityName, identifyProvider, extractJsonArray, callHaikuWebSearch,
} from './lib/search-core.js';

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

    // === STEP 1 & 2: Run Imoova fetches AND Haiku web_search IN PARALLEL ===

    let imoovaPromise;
    const nearbyCitiesSearched = [];

    if (from) {
      const citiesToFetch = [
        { city: from, distance: 0 },
        ...nearby.slice(0, 3),
      ];
      console.log(`Imoova fetching: ${citiesToFetch.map(c => `${c.city} (${c.distance}km)`).join(', ')}`);

      imoovaPromise = Promise.all(
        citiesToFetch.map(({ city, distance }) =>
          fetchImoovaPage(city, 5000)
            .then(({ html }) => {
              const all = html ? parseImoovaHtml(html) : [];
              // 2026-06: Imoova fetch returns global EU pool; filter to origin city.
              const citySlug = normalizeCitySlug(city);
              const deals = all.filter(d => normalizeCitySlug(d.from || '') === citySlug);
              return { city, distance, html, deals };
            })
            .catch(() => ({ city, distance, html: null, deals: [] }))
        )
      );
    } else {
      imoovaPromise = Promise.resolve([]);
    }

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
1. "imoova relocations to ${searchTo} Europe"
2. "roadsurfer rally relocations to ${searchTo}"
3. "bunk campers relocation deals to ${searchTo}"
4. "movacar camper relocation to ${searchTo}" OR "movacar.com mietwagen ${searchTo}"

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

Search for these providers ONLY (Imoova already handled separately):
1. "roadsurfer rally relocations from ${from}"
2. "bunk campers relocation deals ${from}"
3. "movacar camper relocation from ${from}" OR "movacar.com mietwagen ${from}"

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

    const haikuPromise = callHaikuWebSearch(apiKey, prompt);

    // -- Await both in parallel --
    const [fetchResults, haikuResponse] = await Promise.all([imoovaPromise, haikuPromise]);

    // -- Process Imoova results --
    let imoovaDeals = [];
    for (const result of fetchResults) {
      if (result.deals.length > 0) {
        if (result.distance > 0) {
          nearbyCitiesSearched.push({ city: result.city, distance: result.distance });
        }
        for (const deal of result.deals) {
          deal._nearbyDistance = result.distance;
          deal._nearbyCity = result.distance > 0 ? result.city : null;
        }
        imoovaDeals.push(...result.deals);
      }
    }

    console.log(`Imoova total deals: ${imoovaDeals.length} (${fetchResults[0]?.deals?.length || 0} primary + ${imoovaDeals.length - (fetchResults[0]?.deals?.length || 0)} nearby)`);

    // Haiku fallback for primary city if SSR parsing found nothing
    const primaryHtml = fetchResults[0]?.html;
    const primaryDeals = fetchResults[0]?.deals || [];
    if (primaryHtml && primaryDeals.length === 0 && primaryHtml.length > 500) {
      console.log('SSR parsing found nothing for primary city, trying Haiku parser...');
      const imoovaText = primaryHtml
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 6000);

      try {
        const parseResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: HAIKU_MODEL,
            max_tokens: 2000,
            messages: [{ role: 'user', content: `Extract campervan relocation deals from this Imoova page. Only deals DEPARTING FROM ${from}.

PAGE TEXT:
${imoovaText}

Return ONLY a JSON array:
[{"from":"city","to":"city","date_range":"dates","price":"price","vehicle":"name","seats":0,"provider":"Imoova","url":"url","description":"summary"}]

If no deals: []` }],
            system: 'Data extraction API. Output ONLY valid JSON arrays. No commentary.',
          }),
        });

        if (parseResp.ok) {
          const fallbackDeals = extractJsonArray(await parseResp.json());
          for (const d of fallbackDeals) {
            d._nearbyDistance = 0;
            d._nearbyCity = null;
          }
          imoovaDeals.push(...fallbackDeals);
          console.log('Haiku parsed Imoova deals:', fallbackDeals.length);
        }
      } catch (e) {
        console.error('Haiku Imoova parse error:', e.message);
      }
    }

    // Format Imoova deals
    const formattedImoovaDeals = imoovaDeals.map(d => ({
      from: cleanCityName(d.from),
      to: cleanCityName(d.to),
      date_range: d.date_range || 'unknown',
      price: d.price || DEFAULT_PRICE,
      vehicle: d.vehicle || 'Campervan',
      seats: d.seats || 0,
      provider: d.provider || identifyProvider(d.vehicle),
      url: d.url || IMOOVA_FALLBACK_URL,
      direction_match: false,
      description: d.description || (d.vehicle || 'Campervan') + ', ' + (d.price || DEFAULT_PRICE),
      nearby_distance: d._nearbyDistance || 0,
      nearby_from: d._nearbyCity || null,
    }));

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
          return { ...d, nearby_distance: dist, nearby_from: d.from };
        }
        return { ...d, nearby_distance: 0, nearby_from: null };
      });
    }

    // === STEP 3: Merge, sort & deduplicate ===
    let allDeals = [...formattedImoovaDeals, ...otherDeals];

    if (headingTowards) {
      const target = headingTowards.toLowerCase();
      allDeals = allDeals.map(d => ({
        ...d,
        direction_match: (d.to || '').toLowerCase().includes(target) ||
          target.includes((d.to || '').toLowerCase()),
      }));
    }

    // Imoova affiliate priority: treat Imoova deals as if they are 25km closer than other providers.
    // Commissions doubled May 2026 — only provider with active tracking.
    const IMOOVA_DISTANCE_BONUS = 25;
    allDeals.sort((a, b) => {
      const aImoova = (a.provider || '').toLowerCase().includes('imoova');
      const bImoova = (b.provider || '').toLowerCase().includes('imoova');
      const distA = (a.nearby_distance || 0) - (aImoova ? IMOOVA_DISTANCE_BONUS : 0);
      const distB = (b.nearby_distance || 0) - (bImoova ? IMOOVA_DISTANCE_BONUS : 0);
      if (distA !== distB) return distA - distB;
      if (a.direction_match !== b.direction_match) return (b.direction_match ? 1 : 0) - (a.direction_match ? 1 : 0);
      return aImoova === bImoova ? 0 : (aImoova ? -1 : 1);
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

    const nearbyDealCount = formattedImoovaDeals.filter(d => d.nearby_from).length;
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
        sources: { imoova_direct: formattedImoovaDeals.length, web_search: otherDeals.length },
      },
      debug: {
        imoovaFetched: true,
        imoovaPrimaryDeals: formattedImoovaDeals.length - nearbyDealCount,
        imoovaNearbyCities: nearbyCitiesSearched.length,
        imoovaNearbyCityDeals: nearbyDealCount,
        imoovaFallbackUsed: formattedImoovaDeals.length === 0,
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
