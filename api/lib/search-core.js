// Shared search infrastructure for Movacamper
// Used by both api/search.js (interactive search) and api/cron/match-subscribers.js (daily cron)

// ── Constants ──
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const ANTHROPIC_VERSION = '2023-06-01';
export const IMOOVA_FALLBACK_URL = 'https://www.imoova.com/en/relocations?region=EU&via=relocamp';
export const DEFAULT_PRICE = '€1.00/night';

// ── City slug normalization (multilingual) ──
export const CITY_SLUGS = {
  // Munich (DE/NL/PT/IT/FR)
  'munchen': 'munich', 'münchen': 'munich', 'muenchen': 'munich',
  'munique': 'munich', 'monaco di baviera': 'munich',
  // Berlin (NL/PT/IT)
  'berlijn': 'berlin', 'berlim': 'berlin', 'berlino': 'berlin',
  // Hamburg (FR/IT)
  'hambourg': 'hamburg', 'amburgo': 'hamburg',
  // Frankfurt (FR/IT)
  'francfort': 'frankfurt', 'francoforte': 'frankfurt',
  'frankfurt am main': 'frankfurt', 'frankfurt-am-main': 'frankfurt',
  // Vienna (NL/FR/IT/ES)
  'wien': 'vienna', 'wenen': 'vienna',
  'vienne': 'vienna', 'vena': 'vienna',
  // Lisbon (NL/DE/PT)
  'lissabon': 'lisbon', 'lisboa': 'lisbon',
  // Copenhagen (DE/NL)
  'kopenhagen': 'copenhagen', 'københavn': 'copenhagen',
  // Brussels (NL/FR)
  'brussel': 'brussels', 'bruxelles': 'brussels',
  // Milan (DE/IT)
  'mailand': 'milan', 'milano': 'milan',
  // Rome (DE/IT/ES/FR)
  'rom': 'rome', 'roma': 'rome', 'rooma': 'rome',
  // Prague (DE/FR/IT/ES)
  'prag': 'prague', 'praha': 'prague', 'praga': 'prague',
  // Warsaw (DE/IT/FR)
  'warschau': 'warsaw', 'warszawa': 'warsaw',
  'varsavia': 'warsaw', 'varsovie': 'warsaw',
  // Geneva (DE/FR)
  'genf': 'geneva', 'geneve': 'geneva', 'genève': 'geneva',
  // London (NL/ES/FR)
  'londen': 'london', 'londres': 'london',
  // Paris (NL)
  'parijs': 'paris',
  // Antwerp (NL)
  'antwerpen': 'antwerp', 'anvers': 'antwerp',
  // The Hague (NL)
  'den haag': 'the-hague',
  // Seville (ES)
  'sevilla': 'seville',
  // Athens (NL/DE)
  'athene': 'athens', 'athen': 'athens', 'atenas': 'athens',
  // Bucharest (NL/DE)
  'boekarest': 'bucharest', 'bukarest': 'bucharest', 'bucuresti': 'bucharest', 'bucurești': 'bucharest',
  // Cologne (NL/DE/FR/IT)
  'keulen': 'cologne', 'köln': 'cologne', 'koln': 'cologne',
  'colonia': 'cologne', 'cologne': 'cologne',
  // Nuremberg (NL/DE)
  'nurnberg': 'nuremberg', 'nürnberg': 'nuremberg', 'neurenberg': 'nuremberg',
  // Hanover (DE)
  'hannover': 'hanover',
  // Marseille (EN variant)
  'marseilles': 'marseille',
  // Edinburgh (NL/DE)
  'edinburg': 'edinburgh',
  // Barcelona (FR/IT)
  'barcelone': 'barcelona', 'barcellona': 'barcelona',
  // Amsterdam (DE/FR)
  'amsterdam': 'amsterdam',
  // Florence (IT/ES/DE/FR)
  'firenze': 'florence', 'florencia': 'florence', 'florenz': 'florence',
  // Venice (IT/ES/DE/FR)
  'venezia': 'venice', 'venecia': 'venice', 'venedig': 'venice',
  // Zurich (DE/FR/IT)
  'zürich': 'zurich', 'zurich': 'zurich', 'zurigo': 'zurich',
  // Stuttgart (same across languages, but umlaut variant)
  'gütersloh': 'gutersloh',
  'flensburg': 'flensburg', 'flensborg': 'flensburg',
  // Düsseldorf
  'dusseldorf': 'dusseldorf', 'düsseldorf': 'dusseldorf',
};

// ── Nearby cities with driving distances (km) ──
export const NEARBY_CITIES = {
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
    { city: 'flensburg', distance: 155 },
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
  'flensburg': [
    { city: 'kiel', distance: 85 },
    { city: 'hamburg', distance: 155 },
    { city: 'copenhagen', distance: 240 },
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

// Hub cities for weekly digest
// EXP-017 inventory data (juni 12-14): Imoova rotation shifted toward Italy +
// southern Germany + western France hubs. Florence alone supplied 50%+ of the
// EU pool on multiple days; Stuttgart/Düsseldorf/Nantes consistently appeared
// outside our HUB_CITIES coverage. Adding (not replacing) — see decision file
// 13 juni: legacy hubs stay for seasonal recovery.
export const HUB_CITIES = [
  'munich', 'berlin', 'hamburg', 'frankfurt', 'lisbon', 'porto', 'barcelona',
  'london', 'amsterdam', 'paris',
  'florence', 'stuttgart', 'dusseldorf', 'nantes',
  // Added 14 juni after EXP-017 snapshot review — top origins consistently
  // present in Imoova's 12-14 juni rotation that weren't yet pre-fetched.
  // Free per-city (60s cache shares the single global EU fetch since juni 10).
  'oslo', 'madrid', 'bari', 'bologna', 'seville',
];

// ── Helper Functions ──

export function normalizeCitySlug(city) {
  const normalized = city.toLowerCase().trim().replace(/\s+/g, '-');
  return CITY_SLUGS[normalized] || CITY_SLUGS[normalized.replace(/-/g, ' ')] || normalized;
}

export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDateRange(fromStr, toStr) {
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
  } catch (e) {
    return 'unknown';
  }
}

// Get nearby cities within radius (direct + reverse lookup)
export function getNearbyCities(city, radiusKm) {
  if (!radiusKm || radiusKm <= 0) return [];
  const slug = normalizeCitySlug(city);

  const direct = NEARBY_CITIES[slug] || [];
  const result = [...direct];
  const seen = new Set(result.map(n => n.city));

  // Reverse lookup: cities that list THIS city as their neighbor
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

// ── Imoova Scraping ──

// In-memory dedupe cache so parallel callers (e.g. HUB_CITIES loop, 4-city search)
// hit Imoova at most once per request cycle. Short TTL (60s) since this only needs
// to bridge a single function invocation's parallel fan-out — not persist across runs.
const _imoovaCache = new Map(); // url → { html, expiresAt }

export async function fetchImoovaPage(city, timeoutMs = 10000) {
  // 2026-06-10: Imoova rebuilt their site. Per-city URLs (?departure_city=X) now
  // redirect to client-rendered SPA pages with no deals in HTML. The global EU page
  // still server-renders ~50 deals. Strategy: fetch global once, filter by origin
  // city at the caller. `city` param kept for log/debug only.
  const url = 'https://www.imoova.com/en/relocations?region=EU';
  const now = Date.now();
  const cached = _imoovaCache.get(url);
  if (cached && cached.expiresAt > now) {
    return { html: cached.html };
  }

  console.log('Fetching Imoova (global EU):', url, 'for city:', city);

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
    console.log(`Imoova global HTML length:`, html.length);
    _imoovaCache.set(url, { html, expiresAt: now + 60_000 });
    return { html };
  } catch (err) {
    console.log(`Imoova fetch error (city=${city}):`, err.message);
    return { html: null };
  }
}

export function parseImoovaHtml(html) {
  const deals = [];

  const urlMap = {};
  // Imoova 2026-06 rebuild dropped /en/ prefix. Accept both for robustness.
  const urlRegex = /href="\/(?:en\/)?relocations\/deal\/([^"]+)"/g;
  let um;
  while ((um = urlRegex.exec(html)) !== null) {
    const slug = um[1];
    const refMatch = slug.match(/(RLC\d+)$/);
    if (refMatch) {
      urlMap[refMatch[1]] = 'https://www.imoova.com/relocations/deal/' + slug;
    }
  }

  // 2026-06: Imoova inserted a `deal_slug:"..."` field between `reference` and `created_at`.
  // Allow any field ordering between reference and name by skipping non-`}` chars.
  const refs = [...html.matchAll(/reference:"(RLC\d+)"[^}]*?name:"([^"]+)"/g)];
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
      date_range: fromDate && toDate ? formatDateRange(fromDate, toDate) : 'Flexible dates',
      date_start: fromDate,
      date_end: toDate,
      url: urlMap[ref] || IMOOVA_FALLBACK_URL,
      provider: 'Imoova',
    });
  }

  // Fallback: text pattern parsing
  if (deals.length === 0) {
    const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const dealPattern = /([\w][\w\s]*?)\s+available for one-way rental from\s+([A-Za-zÀ-ÿ\s\-\.]+?)\s+to\s+([A-Za-zÀ-ÿ\s\-\.]+?)\.\s*Flexible relocation with\s+(\d+)\s+seats?,\s*(Automatic|Manual)\s+transmission\.\s*Starting\s+([€$£][\d.]+)\s+per\s+(?:night|day)/gi;
    let match;
    while ((match = dealPattern.exec(text)) !== null) {
      deals.push({
        vehicle: match[1].trim(),
        from: match[2].trim(),
        to: match[3].trim(),
        seats: parseInt(match[4]),
        transmission: match[5],
        price: match[6] + '/day',
        date_range: 'Flexible dates',
        url: IMOOVA_FALLBACK_URL,
        provider: 'Imoova',
      });
    }
  }

  return deals;
}

export function cleanCityName(name) {
  if (!name) return name;
  let clean = name
    .replace(/^.*?relocations\s+/i, '')
    .replace(/\s+available\s+\d{1,2}\s+\w{3}.*$/i, '')
    .replace(/\s+\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*[-–]\s*\d{1,2}.*$/i, '')
    .trim();
  return clean || name.trim();
}

export function identifyProvider(vehicleName) {
  const name = (vehicleName || '').toLowerCase();
  if (/eu\s*(active|comfort|standard)|vw\s*california|atlas|nomad|etrusco|comfort\s*family|selena/i.test(name)) {
    return 'Indie Campers via Imoova';
  }
  return 'Imoova';
}

// ── Haiku Web Search ──

export function extractJsonArray(responseData) {
  let text = '';
  for (const block of responseData.content || []) {
    if (block.type === 'text') text += block.text;
  }
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
}

export async function callHaikuWebSearch(apiKey, prompt, attempt = 1) {
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

  // Short retry on rate limit
  if (response.status === 429 && attempt <= 2) {
    await new Promise(r => setTimeout(r, 2000));
    return callHaikuWebSearch(apiKey, prompt, attempt + 1);
  }
  return response;
}

// Build a Haiku prompt for searching deals from a city (other providers, Imoova handled separately)
export function buildHaikuFromPrompt(from, nearby, date, flexibility) {
  const nearbyCityNames = nearby.map(n => capitalize(n.city)).slice(0, 5);
  const dateClause = date
    ? `Date target: around ${date} ±${flexibility || 7} days.`
    : 'No date filter — include ALL deals regardless of date.';
  const nearbyNote = nearbyCityNames.length > 0
    ? `\nAlso search for deals departing from these nearby cities: ${nearbyCityNames.join(', ')}. Use the actual departure city name in the "from" field.`
    : '';

  return `Search for campervan AND car relocation deals DEPARTING FROM ${from}.

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

Respond with ONLY a JSON array:
[{"from":"city","to":"city","date_range":"dates","price":"EUR X/day","vehicle":"type","seats":0,"provider":"source","url":"url","direction_match":false,"description":"summary"}]

If nothing found: []`;
}

// ── Fetch all deals for a city (Imoova + nearby, returns structured result) ──
export async function fetchAllDealsForCity(city, { radiusKm = 300, timeoutMs = 5000, apiKey = null } = {}) {
  const slug = normalizeCitySlug(city);
  const nearby = getNearbyCities(city, radiusKm);

  // Cities to fetch from Imoova: primary + top 3 nearby
  const citiesToFetch = [
    { city: slug, distance: 0, label: city },
    ...nearby.slice(0, 3),
  ];

  // Fetch Imoova in parallel for all cities. Since 2026-06 the fetch always returns
  // the global EU pool (Imoova removed per-city SSR), so we filter each result down
  // to deals originating in the requested city.
  const imoovaResults = await Promise.all(
    citiesToFetch.map(({ city: c, distance }) =>
      fetchImoovaPage(c, timeoutMs)
        .then(({ html }) => {
          const all = html ? parseImoovaHtml(html) : [];
          const cSlug = normalizeCitySlug(c);
          const deals = all.filter(d => normalizeCitySlug(d.from || '') === cSlug);
          return { city: c, distance, deals };
        })
        .catch(() => ({ city: c, distance, deals: [] }))
    )
  );

  // Categorize: exact matches vs nearby matches
  const exactDeals = [];
  const nearbyDeals = []; // { city, distance, deals[] }

  for (const result of imoovaResults) {
    if (result.distance === 0) {
      exactDeals.push(...result.deals);
    } else if (result.deals.length > 0) {
      nearbyDeals.push({
        city: capitalize(result.city),
        distance: result.distance,
        deals: result.deals,
      });
    }
  }

  // If we have an API key, also search Haiku for other providers
  let otherDeals = [];
  if (apiKey) {
    try {
      const prompt = buildHaikuFromPrompt(city, nearby, null, null);
      const haikuResp = await callHaikuWebSearch(apiKey, prompt);
      if (haikuResp.ok) {
        otherDeals = extractJsonArray(await haikuResp.json());
      }
    } catch (e) {
      console.error('Haiku web search error:', e.message);
    }

    // Split Haiku results into exact vs nearby
    const fromLower = slug;
    for (const deal of otherDeals) {
      const dealFrom = normalizeCitySlug(deal.from || '');
      if (dealFrom === fromLower) {
        exactDeals.push(deal);
      } else {
        // Check if it's from a nearby city
        const nearbyMatch = nearby.find(n => n.city === dealFrom);
        if (nearbyMatch) {
          let group = nearbyDeals.find(g => g.city.toLowerCase() === dealFrom);
          if (!group) {
            group = { city: capitalize(dealFrom), distance: nearbyMatch.distance, deals: [] };
            nearbyDeals.push(group);
          }
          group.deals.push(deal);
        } else {
          exactDeals.push(deal); // Unknown origin, treat as exact
        }
      }
    }
  }

  // Sort nearby by distance
  nearbyDeals.sort((a, b) => a.distance - b.distance);

  return {
    exact: exactDeals,
    nearby: nearbyDeals, // [{ city, distance, deals[] }]
    allNearby: nearby,   // Full nearby cities list (even those without deals)
  };
}

// Map of citySlug → distance for cities within radius (incl. the city itself at 0).
export function cityRegionMap(city, radiusKm) {
  const slug = normalizeCitySlug(city || '');
  const map = new Map();
  if (slug) map.set(slug, 0);
  for (const n of getNearbyCities(city || '', radiusKm)) {
    map.set(n.city, n.distance);
  }
  return map;
}

// "Perfect" deal = pickup OR drop-off within 50 km of sub's city AND
// date inside sub's window with (flexibility + 2) days extra slack.
// Perfect deals bypass throttles and the "always draft" rule.
export function isPerfectDeal(deal, sub) {
  if (!sub || !sub.city) return false;
  const perfectRegion = cityRegionMap(sub.city, 50);
  const fromSlug = normalizeCitySlug(deal.from || '');
  const toSlug = normalizeCitySlug(deal.to || '');
  if (!perfectRegion.has(fromSlug) && !perfectRegion.has(toSlug)) return false;
  if (!sub.date || !deal.date_start) return true;
  const subDate = new Date(sub.date).getTime();
  const flexMs = ((sub.flexibility || 7) + 2) * 86400000;
  const dealStart = new Date(deal.date_start).getTime();
  const dealEnd = deal.date_end ? new Date(deal.date_end).getTime() : dealStart;
  if (dealEnd < subDate - flexMs) return false;
  if (dealStart > subDate + flexMs) return false;
  return true;
}

// ── Match deals to subscriber date preferences ──
export function matchDealsToDate(deals, date, flexibility) {
  if (!date) return deals; // No date filter = all deals match
  const subDate = new Date(date);
  const flex = (flexibility || 7) * 24 * 60 * 60 * 1000;

  return deals.filter(deal => {
    if (!deal.date_start) return true; // No date on deal = always show
    const dealStart = new Date(deal.date_start);
    const dealEnd = deal.date_end ? new Date(deal.date_end) : dealStart;
    if (dealEnd.getTime() < subDate.getTime() - flex) return false;
    if (dealStart.getTime() > subDate.getTime() + flex) return false;
    return true;
  });
}

// ── Transport tip for nearby cities ──
export function getTransportTip(distanceKm) {
  if (distanceKm < 100) {
    const price = Math.round(8 + distanceKm * 0.04);
    return { mode: 'FlixBus', estimate: `~€${price}` };
  }
  if (distanceKm < 250) {
    const price = Math.round(10 + distanceKm * 0.05);
    return { mode: 'FlixBus', estimate: `~€${price}` };
  }
  const price = Math.round(15 + distanceKm * 0.06);
  return { mode: 'Train', estimate: `~€${price}` };
}
