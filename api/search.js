// Vercel Serverless Function — Movacamper v6.1
// Hybrid: direct Imoova fetch (primary + nearby cities) + Claude Haiku for other providers

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
const IMOOVA_FALLBACK_URL = 'https://www.imoova.com/en/relocations?region=EU';
const DEFAULT_PRICE = '€1.00/night';

// Imoova uses English city names in URLs
const CITY_SLUGS = {
  'munchen': 'munich', 'münchen': 'munich', 'muenchen': 'munich',
  'wien': 'vienna', 'wenen': 'vienna',
  'lissabon': 'lisbon', 'lisboa': 'lisbon',
  'kopenhagen': 'copenhagen', 'københavn': 'copenhagen',
  'brussel': 'brussels', 'bruxelles': 'brussels',
  'mailand': 'milan', 'milano': 'milan',
  'rom': 'rome', 'roma': 'rome',
  'prag': 'prague', 'praha': 'prague',
  'warschau': 'warsaw', 'warszawa': 'warsaw',
  'genf': 'geneva', 'geneve': 'geneva', 'genève': 'geneva',
  'londen': 'london', 'londres': 'london',
  'parijs': 'paris',
  'antwerpen': 'antwerp',
  'den haag': 'the-hague',
  'sevilla': 'seville',
  'athene': 'athens', 'athen': 'athens',
  'boekarest': 'bucharest', 'bukarest': 'bucharest',
  'keulen': 'cologne', 'köln': 'cologne', 'koln': 'cologne',
  'nurnberg': 'nuremberg', 'nürnberg': 'nuremberg',
  'hannover': 'hanover',
  'marseilles': 'marseille',
  'edinburg': 'edinburgh',
};

// Nearby cities with approximate driving distances (km)
// Used to expand searches when radius > 0
const NEARBY_CITIES = {
  // ── Germany ──
  'munich': [
    { city: 'augsburg', distance: 70 },
    { city: 'salzburg', distance: 145 },
    { city: 'innsbruck', distance: 190 },
    { city: 'nuremberg', distance: 170 },
    { city: 'stuttgart', distance: 230 },
  ],
  'berlin': [
    { city: 'potsdam', distance: 35 },
    { city: 'leipzig', distance: 190 },
    { city: 'dresden', distance: 195 },
    { city: 'hamburg', distance: 290 },
  ],
  'hamburg': [
    { city: 'bremen', distance: 120 },
    { city: 'hanover', distance: 150 },
    { city: 'kiel', distance: 100 },
    { city: 'berlin', distance: 290 },
  ],
  'frankfurt': [
    { city: 'mainz', distance: 40 },
    { city: 'darmstadt', distance: 35 },
    { city: 'wiesbaden', distance: 40 },
    { city: 'cologne', distance: 190 },
    { city: 'stuttgart', distance: 210 },
    { city: 'nuremberg', distance: 230 },
  ],
  'cologne': [
    { city: 'bonn', distance: 30 },
    { city: 'dusseldorf', distance: 40 },
    { city: 'essen', distance: 75 },
    { city: 'dortmund', distance: 95 },
    { city: 'frankfurt', distance: 190 },
  ],
  'dusseldorf': [
    { city: 'cologne', distance: 40 },
    { city: 'essen', distance: 35 },
    { city: 'dortmund', distance: 70 },
    { city: 'bochum', distance: 50 },
    { city: 'duisburg', distance: 25 },
    { city: 'bonn', distance: 70 },
  ],
  'dortmund': [
    { city: 'bochum', distance: 20 },
    { city: 'essen', distance: 35 },
    { city: 'dusseldorf', distance: 70 },
    { city: 'cologne', distance: 95 },
    { city: 'hanover', distance: 260 },
  ],
  'bochum': [
    { city: 'dortmund', distance: 20 },
    { city: 'essen', distance: 15 },
    { city: 'dusseldorf', distance: 50 },
    { city: 'cologne', distance: 75 },
  ],
  'essen': [
    { city: 'bochum', distance: 15 },
    { city: 'dortmund', distance: 35 },
    { city: 'dusseldorf', distance: 35 },
    { city: 'duisburg', distance: 20 },
    { city: 'cologne', distance: 75 },
  ],
  'stuttgart': [
    { city: 'karlsruhe', distance: 80 },
    { city: 'munich', distance: 230 },
    { city: 'frankfurt', distance: 210 },
    { city: 'nuremberg', distance: 210 },
    { city: 'freiburg', distance: 200 },
  ],
  'nuremberg': [
    { city: 'munich', distance: 170 },
    { city: 'frankfurt', distance: 230 },
    { city: 'stuttgart', distance: 210 },
  ],
  'hanover': [
    { city: 'hamburg', distance: 150 },
    { city: 'bremen', distance: 125 },
    { city: 'berlin', distance: 290 },
  ],
  'leipzig': [
    { city: 'dresden', distance: 120 },
    { city: 'berlin', distance: 190 },
    { city: 'nuremberg', distance: 280 },
  ],
  'dresden': [
    { city: 'leipzig', distance: 120 },
    { city: 'berlin', distance: 195 },
    { city: 'prague', distance: 150 },
  ],
  'freiburg': [
    { city: 'basel', distance: 70 },
    { city: 'strasbourg', distance: 85 },
    { city: 'zurich', distance: 170 },
    { city: 'karlsruhe', distance: 130 },
    { city: 'stuttgart', distance: 200 },
  ],

  // ── Netherlands ──
  'amsterdam': [
    { city: 'utrecht', distance: 45 },
    { city: 'the-hague', distance: 60 },
    { city: 'rotterdam', distance: 75 },
    { city: 'eindhoven', distance: 125 },
  ],
  'rotterdam': [
    { city: 'the-hague', distance: 25 },
    { city: 'amsterdam', distance: 75 },
    { city: 'utrecht', distance: 60 },
    { city: 'antwerp', distance: 100 },
  ],
  'eindhoven': [
    { city: 'antwerp', distance: 90 },
    { city: 'amsterdam', distance: 125 },
    { city: 'cologne', distance: 200 },
    { city: 'dusseldorf', distance: 130 },
  ],
  'utrecht': [
    { city: 'amsterdam', distance: 45 },
    { city: 'rotterdam', distance: 60 },
    { city: 'eindhoven', distance: 100 },
  ],

  // ── Belgium ──
  'brussels': [
    { city: 'antwerp', distance: 50 },
    { city: 'ghent', distance: 55 },
    { city: 'liege', distance: 100 },
    { city: 'cologne', distance: 220 },
  ],
  'antwerp': [
    { city: 'brussels', distance: 50 },
    { city: 'rotterdam', distance: 100 },
    { city: 'eindhoven', distance: 90 },
    { city: 'ghent', distance: 60 },
  ],

  // ── Austria ──
  'vienna': [
    { city: 'bratislava', distance: 80 },
    { city: 'graz', distance: 200 },
    { city: 'linz', distance: 185 },
  ],
  'salzburg': [
    { city: 'munich', distance: 145 },
    { city: 'innsbruck', distance: 190 },
    { city: 'linz', distance: 130 },
  ],
  'innsbruck': [
    { city: 'munich', distance: 190 },
    { city: 'salzburg', distance: 190 },
    { city: 'zurich', distance: 290 },
  ],

  // ── Switzerland ──
  'zurich': [
    { city: 'basel', distance: 85 },
    { city: 'bern', distance: 125 },
    { city: 'lucerne', distance: 55 },
    { city: 'stuttgart', distance: 210 },
  ],
  'geneva': [
    { city: 'lausanne', distance: 65 },
    { city: 'lyon', distance: 150 },
    { city: 'bern', distance: 160 },
  ],
  'basel': [
    { city: 'zurich', distance: 85 },
    { city: 'freiburg', distance: 70 },
    { city: 'strasbourg', distance: 150 },
    { city: 'bern', distance: 100 },
  ],

  // ── France ──
  'paris': [
    { city: 'lille', distance: 225 },
    { city: 'rouen', distance: 135 },
    { city: 'orleans', distance: 130 },
    { city: 'brussels', distance: 310 },
  ],
  'lyon': [
    { city: 'geneva', distance: 150 },
    { city: 'grenoble', distance: 115 },
    { city: 'marseille', distance: 315 },
  ],
  'marseille': [
    { city: 'nice', distance: 200 },
    { city: 'montpellier', distance: 170 },
    { city: 'lyon', distance: 315 },
    { city: 'toulouse', distance: 400 },
  ],
  'nice': [
    { city: 'marseille', distance: 200 },
    { city: 'monaco', distance: 20 },
    { city: 'genoa', distance: 195 },
  ],
  'toulouse': [
    { city: 'bordeaux', distance: 245 },
    { city: 'montpellier', distance: 245 },
    { city: 'marseille', distance: 400 },
  ],
  'bordeaux': [
    { city: 'toulouse', distance: 245 },
    { city: 'nantes', distance: 345 },
    { city: 'bilbao', distance: 230 },
  ],

  // ── Italy ──
  'milan': [
    { city: 'turin', distance: 140 },
    { city: 'bologna', distance: 215 },
    { city: 'genoa', distance: 145 },
    { city: 'zurich', distance: 290 },
  ],
  'rome': [
    { city: 'naples', distance: 230 },
    { city: 'florence', distance: 275 },
    { city: 'bari', distance: 450 },
  ],
  'venice': [
    { city: 'bologna', distance: 155 },
    { city: 'milan', distance: 270 },
    { city: 'vienna', distance: 600 },
  ],

  // ── Spain ──
  'barcelona': [
    { city: 'valencia', distance: 350 },
    { city: 'zaragoza', distance: 310 },
    { city: 'montpellier', distance: 340 },
  ],
  'madrid': [
    { city: 'toledo', distance: 75 },
    { city: 'zaragoza', distance: 325 },
    { city: 'seville', distance: 530 },
  ],
  'malaga': [
    { city: 'seville', distance: 210 },
    { city: 'granada', distance: 130 },
    { city: 'cordoba', distance: 160 },
  ],

  // ── Portugal ──
  'lisbon': [
    { city: 'porto', distance: 315 },
    { city: 'faro', distance: 280 },
  ],

  // ── UK ──
  'london': [
    { city: 'birmingham', distance: 190 },
    { city: 'bristol', distance: 190 },
    { city: 'cambridge', distance: 100 },
    { city: 'manchester', distance: 330 },
  ],
  'edinburgh': [
    { city: 'glasgow', distance: 75 },
    { city: 'newcastle', distance: 200 },
  ],

  // ── Scandinavia ──
  'copenhagen': [
    { city: 'malmo', distance: 30 },
    { city: 'hamburg', distance: 320 },
  ],
  'stockholm': [
    { city: 'gothenburg', distance: 470 },
    { city: 'malmo', distance: 615 },
  ],
  'malmo': [
    { city: 'copenhagen', distance: 30 },
    { city: 'gothenburg', distance: 270 },
  ],
};

// ── Shared helpers ──

function normalizeCitySlug(city) {
  const normalized = city.toLowerCase().trim().replace(/\s+/g, '-');
  return CITY_SLUGS[normalized] || CITY_SLUGS[normalized.replace(/-/g, ' ')] || normalized;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Extract JSON array from Haiku API response
function extractJsonArray(responseData) {
  let text = '';
  for (const block of responseData.content || []) {
    if (block.type === 'text') text += block.text;
  }
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
}

// Get nearby cities within a given radius (direct + reverse lookup)
function getNearbyCities(city, radiusKm) {
  if (!radiusKm || radiusKm <= 0) return [];
  const slug = normalizeCitySlug(city);

  // Direct lookup: cities listed as neighbors of this city
  const direct = NEARBY_CITIES[slug] || [];
  const result = [...direct];
  const seen = new Set(result.map(n => n.city));

  // Reverse lookup: cities that list THIS city as their neighbor
  // (e.g. searching from Augsburg finds Munich, because Munich lists Augsburg)
  for (const [otherCity, otherNeighbors] of Object.entries(NEARBY_CITIES)) {
    if (otherCity === slug) continue;
    if (seen.has(otherCity)) continue;
    for (const n of otherNeighbors) {
      if (n.city === slug) {
        result.push({ city: otherCity, distance: n.distance });
        seen.add(otherCity);
        break;
      }
    }
  }

  return result.filter(n => n.distance <= radiusKm).sort((a, b) => a.distance - b.distance);
}

async function fetchImoovaPage(city, timeoutMs = 10000) {
  const slug = normalizeCitySlug(city);
  const url = `https://www.imoova.com/en/relocations?region=EU&departure_city=${encodeURIComponent(slug)}`;
  console.log('Fetching Imoova:', url);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      console.log('Imoova fetch failed:', resp.status);
      return { html: null };
    }

    const html = await resp.text();
    console.log(`Imoova ${city} HTML length:`, html.length);
    return { html };
  } catch (err) {
    console.log(`Imoova ${city} fetch error:`, err.message);
    return { html: null };
  }
}

function formatDateRange(fromStr, toStr) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  try {
    const f = new Date(fromStr + 'T00:00:00Z');
    const t = new Date(toStr + 'T00:00:00Z');
    if (isNaN(f) || isNaN(t)) return 'unknown';
    const fd = f.getUTCDate();
    const fm = MONTHS[f.getUTCMonth()];
    const td = t.getUTCDate();
    const tm = MONTHS[t.getUTCMonth()];
    return fm === tm ? `${fd}-${td} ${fm}` : `${fd} ${fm} - ${td} ${tm}`;
  } catch(e) {
    return 'unknown';
  }
}

function parseImoovaHtml(html) {
  const deals = [];

  const urlMap = {};
  const urlRegex = /href="\/en\/relocations\/deal\/([^"]+)"/g;
  let um;
  while ((um = urlRegex.exec(html)) !== null) {
    const slug = um[1];
    const refMatch = slug.match(/(RLC\d+)$/);
    if (refMatch) {
      urlMap[refMatch[1]] = 'https://www.imoova.com/en/relocations/deal/' + slug;
    }
  }

  const refs = [...html.matchAll(/reference:"(RLC\d+)",created_at:"[^"]*",name:"([^"]+)"/g)];
  const dates = [...html.matchAll(/available_from_date:"(\d{4}-\d{2}-\d{2})",available_to_date:"(\d{4}-\d{2}-\d{2})"/g)];
  const rates = [...html.matchAll(/,hire_unit_rate:(\d+)/g)];
  const vehicles = [...html.matchAll(/seatbelts:(\d+),sleeps:[^,]*,transmission:"(\w+)"/g)];

  console.log(`SSR extracted: ${refs.length} refs, ${dates.length} dates, ${rates.length} rates, ${vehicles.length} vehicles`);

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i][1];
    const name = refs[i][2];

    const routeMatch = name.match(/^(.+?)\s+to\s+(.+)$/i);
    if (!routeMatch) continue;

    const fromDate = dates[i] ? dates[i][1] : null;
    const toDate = dates[i] ? dates[i][2] : null;
    const rate = rates[i] ? parseInt(rates[i][1]) : 100;
    const seats = vehicles[i] ? parseInt(vehicles[i][1]) : 0;
    const trans = vehicles[i] ? vehicles[i][2] : 'Unknown';

    deals.push({
      vehicle: 'Campervan',
      from: routeMatch[1].trim(),
      to: routeMatch[2].trim(),
      seats,
      transmission: capitalize(trans.toLowerCase()),
      price: '€' + (rate / 100).toFixed(2) + '/night',
      date_range: fromDate && toDate ? formatDateRange(fromDate, toDate) : 'unknown',
      url: urlMap[ref] || IMOOVA_FALLBACK_URL,
    });
  }

  return deals;
}

function cleanCityName(name) {
  if (!name) return name;
  let clean = name
    .replace(/^.*?relocations\s+/i, '')
    .replace(/\s+available\s+\d{1,2}\s+\w{3}.*$/i, '')
    .replace(/\s+\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*[-–]\s*\d{1,2}.*$/i, '')
    .trim();
  return clean || name.trim();
}

function identifyProvider(vehicleName) {
  const name = (vehicleName || '').toLowerCase();
  if (/eu\s*(active|comfort|standard)|vw\s*california|atlas|nomad|etrusco|comfort\s*family|selena/i.test(name)) {
    return 'Indie Campers via Imoova';
  }
  return 'Imoova';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { from, to, date, flexibility = 3, headingTowards = '', radius = 75 } = req.body;
  if (!from && !to && !headingTowards) return res.status(400).json({ error: 'Missing: from or to' });

  // FIX: parseInt(0) is falsy, so `|| 75` would override radius=0. Use explicit NaN check.
  const parsed = parseInt(radius);
  const searchRadius = Math.min(Math.max(Number.isNaN(parsed) ? 75 : parsed, 0), 200);
  const searchTo = to || headingTowards || '';
  const cacheKey = `${(from||'').toLowerCase()}|${searchTo.toLowerCase()}|${date || 'any'}|${flexibility}|${headingTowards.toLowerCase()}|${searchRadius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  // Prune expired cache entries when cache grows large
  if (cache.size > 100) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.time >= CACHE_TTL) cache.delete(k);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // Pre-compute nearby cities once (used by both Imoova fetch and Haiku prompt)
    const nearby = from ? getNearbyCities(from, searchRadius) : [];

    // === STEP 1 & 2: Run Imoova fetches AND Haiku web_search IN PARALLEL ===

    // -- Build Imoova fetch promises --
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
            .then(({ html }) => ({
              city, distance, html,
              deals: html ? parseImoovaHtml(html) : [],
            }))
            .catch(() => ({ city, distance, html: null, deals: [] }))
        )
      );
    } else {
      imoovaPromise = Promise.resolve([]);
    }

    // -- Build Haiku prompt (optimistically assume Imoova will succeed → skip Imoova in Haiku) --
    const dirClause = headingTowards
      ? `Heading towards "${headingTowards}". Mark matching deals "direction_match":true, but include ALL deals.`
      : 'No direction filter. "direction_match":false for all.';
    const dateClause = date
      ? `Date target: around ${date} ±${flexibility} days.`
      : 'No date filter — include ALL deals regardless of date.';
    const nearbyCityNames = nearby.map(n => capitalize(n.city)).slice(0, 5);

    let prompt;
    if (!from && searchTo) {
      // ── TO-ONLY search ──
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
      // ── FROM search (skip Imoova in Haiku — direct fetch handles it) ──
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

    // -- Fire Haiku web_search in parallel with Imoova --
    async function callHaikuAPI(attempt = 1) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 3000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
          messages: [{ role: 'user', content: prompt }],
          system: 'Web scraping API. Output ONLY valid JSON arrays. No commentary. Use "unknown" for missing fields.',
        }),
      });

      // Short retry on rate limit (2s, not 15s — must fit within Vercel timeout)
      if (response.status === 429 && attempt <= 2) {
        await new Promise(r => setTimeout(r, 2000));
        return callHaikuAPI(attempt + 1);
      }
      return response;
    }

    const haikuPromise = callHaikuAPI();

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

    // Haiku fallback: only for primary city if SSR parsing found nothing
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

    // Format Imoova deals (clean city names, add nearby metadata)
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

    // Sort: primary city first (distance 0), then closer nearby, then direction_match.
    // IMPORTANT: this ordering is required for cross-city dedup below to work correctly —
    // primary city deals must come first so they "claim" the cross-city key.
    allDeals.sort((a, b) => {
      const distA = a.nearby_distance || 0;
      const distB = b.nearby_distance || 0;
      if (distA !== distB) return distA - distB;
      return (b.direction_match ? 1 : 0) - (a.direction_match ? 1 : 0);
    });

    // Deduplicate: standard key + cross-city dedup
    const seen = new Set();
    const seenCrossCity = new Set();
    allDeals = allDeals.filter(d => {
      // Standard dedup: exact same from/to/vehicle
      const key = `${(d.from||'').toLowerCase()}|${(d.to||'').toLowerCase()}|${(d.vehicle||'').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);

      // Cross-city dedup: same deal listed from a nearby city
      // (same destination + vehicle + price + dates = likely same physical vehicle)
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
