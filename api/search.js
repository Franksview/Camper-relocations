// Vercel Serverless Function — Movacamper v6.0
// Hybrid: direct Imoova fetch (primary + nearby cities) + Claude Haiku for other providers

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

// Get nearby cities within a given radius
function getNearbyCities(city, radiusKm) {
  if (!radiusKm || radiusKm <= 0) return [];
  const normalized = city.toLowerCase().trim().replace(/\s+/g, '-');
  const slug = CITY_SLUGS[normalized] || CITY_SLUGS[normalized.replace(/-/g, ' ')] || normalized;
  // Try slug first (e.g. 'munich'), then original normalized (e.g. 'dusseldorf')
  const neighbors = NEARBY_CITIES[slug] || NEARBY_CITIES[normalized] || NEARBY_CITIES[normalized.replace(/-/g, ' ')] || [];
  return neighbors.filter(n => n.distance <= radiusKm);
}

async function fetchImoovaPage(city, timeoutMs = 10000) {
  const normalized = city.toLowerCase().trim().replace(/\s+/g, '-');
  const slug = CITY_SLUGS[normalized] || CITY_SLUGS[normalized.replace(/-/g, ' ')] || normalized;
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

  // 1. Build URL map: reference code → full deal URL
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

  // 2. Extract deal data from Imoova SSR ($R[] objects)
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
      transmission: trans.charAt(0).toUpperCase() + trans.slice(1).toLowerCase(),
      price: '€' + (rate / 100).toFixed(2) + '/night',
      date_range: fromDate && toDate ? formatDateRange(fromDate, toDate) : 'unknown',
      url: urlMap[ref] || 'https://www.imoova.com/en/relocations?region=EU',
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

  const searchRadius = Math.min(Math.max(parseInt(radius) || 75, 0), 200);
  const searchTo = to || headingTowards || '';
  const cacheKey = `${(from||'').toLowerCase()}|${searchTo.toLowerCase()}|${date || 'any'}|${flexibility}|${headingTowards.toLowerCase()}|${searchRadius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // === STEP 1: Direct Imoova fetch — primary city + nearby cities in parallel ===
    let imoovaDeals = [];
    const nearbyCitiesSearched = [];

    if (from) {
      const nearby = getNearbyCities(from, searchRadius);
      const citiesToFetch = [
        { city: from, distance: 0 },
        ...nearby.slice(0, 3), // cap at 3 nearby to stay within timeout
      ];

      console.log(`Imoova fetching: ${citiesToFetch.map(c => `${c.city} (${c.distance}km)`).join(', ')}`);

      // Fetch all cities in parallel with a shorter timeout
      const fetchResults = await Promise.all(
        citiesToFetch.map(({ city, distance }) =>
          fetchImoovaPage(city, 6000) // 6s per city
            .then(({ html }) => ({
              city, distance, html,
              deals: html ? parseImoovaHtml(html) : [],
            }))
            .catch(() => ({ city, distance, html: null, deals: [] }))
        )
      );

      for (const result of fetchResults) {
        if (result.deals.length > 0) {
          // Track which nearby cities returned results
          if (result.distance > 0) {
            nearbyCitiesSearched.push({ city: result.city, distance: result.distance });
          }
          // Tag every deal with its source info
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
          .trim();
        const truncated = imoovaText.substring(0, 6000);

        try {
          const parseResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 2000,
              messages: [{ role: 'user', content: `Extract campervan relocation deals from this Imoova page. Only deals DEPARTING FROM ${from}.

PAGE TEXT:
${truncated}

Return ONLY a JSON array:
[{"from":"city","to":"city","date_range":"dates","price":"price","vehicle":"name","seats":0,"provider":"Imoova","url":"url","description":"summary"}]

If no deals: []` }],
              system: 'Data extraction API. Output ONLY valid JSON arrays. No commentary.',
            }),
          });

          if (parseResp.ok) {
            const parseData = await parseResp.json();
            let pText = '';
            for (const block of parseData.content || []) {
              if (block.type === 'text') pText += block.text;
            }
            const cleaned = pText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
            const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const fallbackDeals = JSON.parse(jsonMatch[0]);
              // Tag as primary city (distance 0)
              for (const d of fallbackDeals) {
                d._nearbyDistance = 0;
                d._nearbyCity = null;
              }
              imoovaDeals.push(...fallbackDeals);
              console.log('Haiku parsed Imoova deals:', fallbackDeals.length);
            }
          }
        } catch (e) {
          console.error('Haiku Imoova parse error:', e.message);
        }
      }
    }

    // Format Imoova deals (clean city names, add nearby metadata)
    const formattedImoovaDeals = imoovaDeals.map(d => ({
      from: cleanCityName(d.from),
      to: cleanCityName(d.to),
      date_range: d.date_range || 'unknown',
      price: d.price || '€1.00/night',
      vehicle: d.vehicle || 'Campervan',
      seats: d.seats || 0,
      provider: d.provider || identifyProvider(d.vehicle),
      url: d.url || 'https://www.imoova.com/en/relocations?region=EU',
      direction_match: false,
      description: d.description || (d.vehicle || 'Campervan') + ', ' + (d.price || '€1/night'),
      nearby_distance: d._nearbyDistance || 0,
      nearby_from: d._nearbyCity || null,
    }));

    // === STEP 2: Haiku web_search for other providers ===
    const dirClause = headingTowards
      ? `Heading towards "${headingTowards}". Mark matching deals "direction_match":true, but include ALL deals.`
      : 'No direction filter. "direction_match":false for all.';
    const dateClause = date
      ? `Date target: around ${date} ±${flexibility} days.`
      : 'No date filter — include ALL deals regardless of date.';

    const imoovaFailed = formattedImoovaDeals.length === 0;

    // Build nearby city names for Haiku prompt
    const nearby = from ? getNearbyCities(from, searchRadius) : [];
    const nearbyCityNames = nearby.map(n => n.city.charAt(0).toUpperCase() + n.city.slice(1)).slice(0, 5);

    let prompt;
    if (!from && searchTo) {
      // ── TO-ONLY search ──
      const nearbyTo = getNearbyCities(searchTo, searchRadius);
      const nearbyToNames = nearbyTo.map(n => n.city.charAt(0).toUpperCase() + n.city.slice(1)).slice(0, 5);
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
      // ── FROM search ──
      const nearbyNote = nearbyCityNames.length > 0
        ? `\nAlso search for deals departing from these nearby cities: ${nearbyCityNames.join(', ')}. Use the actual departure city name in the "from" field.`
        : '';

      const providerQueries = imoovaFailed
        ? `Search for ALL of these providers:
1. "imoova relocations departing from ${from} Europe"
2. "roadsurfer rally relocations from ${from}"
3. "bunk campers relocation deals ${from}"
4. "movacar camper relocation from ${from}" OR "movacar.com mietwagen ${from}"`
        : `Search for these providers ONLY (Imoova already handled):
1. "roadsurfer rally relocations from ${from}"
2. "bunk campers relocation deals ${from}"
3. "movacar camper relocation from ${from}" OR "movacar.com mietwagen ${from}"`;

      prompt = `Search for campervan AND car relocation deals DEPARTING FROM ${from}.

${providerQueries}

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

    let otherDeals = [];

    async function callAPI(attempt = 1) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 3000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: imoovaFailed ? 6 : 4 }],
          messages: [{ role: 'user', content: prompt }],
          system: 'Web scraping API. Output ONLY valid JSON arrays. No commentary. Use "unknown" for missing fields.',
        }),
      });

      if (response.status === 429 && attempt <= 2) {
        await new Promise(r => setTimeout(r, attempt * 15000));
        return callAPI(attempt + 1);
      }
      return response;
    }

    const response = await callAPI();
    if (response.ok) {
      const data = await response.json();
      let text = '';
      for (const block of data.content || []) {
        if (block.type === 'text') text += block.text;
      }
      try {
        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (jsonMatch) otherDeals = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.error('Haiku web_search parse error:', e.message);
      }
    }

    // Post-process Haiku deals: tag nearby city distances
    if (from && nearby.length > 0) {
      const nearbyLookup = {};
      for (const n of nearby) {
        nearbyLookup[n.city.toLowerCase()] = n.distance;
      }
      otherDeals = otherDeals.map(d => {
        const dealFrom = (d.from || '').toLowerCase().trim();
        const dist = nearbyLookup[dealFrom];
        if (dist !== undefined && dealFrom !== from.toLowerCase().trim()) {
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

    // Sort: primary city first (distance 0), then closer nearby cities, then direction_match
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
        // Nearby city deal: skip if we already have this from primary city
        if (seenCrossCity.has(crossKey)) return false;
      }
      seenCrossCity.add(crossKey);

      return true;
    });

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
        imoovaPrimaryDeals: formattedImoovaDeals.filter(d => !d.nearby_from).length,
        imoovaNearbyCities: nearbyCitiesSearched.length,
        imoovaNearbyCityDeals: formattedImoovaDeals.filter(d => d.nearby_from).length,
        imoovaFallbackUsed: imoovaFailed,
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
