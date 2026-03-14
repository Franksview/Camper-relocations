// Vercel Serverless Function — Movacamper v5.0
// Hybrid: direct Imoova fetch + Claude Haiku for other providers (incl. Movacar)

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

async function fetchImoovaPage(city) {
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
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.log('Imoova fetch failed:', resp.status);
      return { html: null };
    }

    const html = await resp.text();
    console.log('Imoova HTML length:', html.length);
    return { html };
  } catch (err) {
    console.log('Imoova fetch error:', err.message);
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
  console.log('Deal URLs found:', Object.keys(urlMap).length);

  // 2. Extract deal data from Imoova SSR ($R[] objects)
  //    Fields appear in consistent order: reference, created_at, name, ..., dates, ..., rate
  const refs = [...html.matchAll(/reference:"(RLC\d+)",created_at:"[^"]*",name:"([^"]+)"/g)];
  const dates = [...html.matchAll(/available_from_date:"(\d{4}-\d{2}-\d{2})",available_to_date:"(\d{4}-\d{2}-\d{2})"/g)];
  const rates = [...html.matchAll(/,hire_unit_rate:(\d+)/g)];
  const vehicles = [...html.matchAll(/seatbelts:(\d+),sleeps:[^,]*,transmission:"(\w+)"/g)];

  console.log(`SSR extracted: ${refs.length} refs, ${dates.length} dates, ${rates.length} rates, ${vehicles.length} vehicles`);

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i][1];
    const name = refs[i][2];

    // Parse from/to from name: "Munich to Palma"
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
    // Remove "Available Relocations" or truncated prefix (e.g. "ailable Relocations")
    .replace(/^.*?relocations\s+/i, '')
    // Remove date suffixes: "Available 16 Mar - 19" or "Available 16 Mar - 19 Mar"
    .replace(/\s+available\s+\d{1,2}\s+\w{3}.*$/i, '')
    // Remove standalone date patterns: "16 Mar - 19 Mar 2025"
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

  const { from, to, date, flexibility = 3, headingTowards = '', radius = 50 } = req.body;
  if (!from && !to && !headingTowards) return res.status(400).json({ error: 'Missing: from or to' });

  const searchRadius = Math.min(Math.max(parseInt(radius) || 50, 0), 100);
  const searchTo = to || headingTowards || '';
  const cacheKey = `${(from||'').toLowerCase()}|${searchTo.toLowerCase()}|${date || 'any'}|${flexibility}|${headingTowards.toLowerCase()}|${searchRadius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // === STEP 1: Direct Imoova fetch (only if we have a from city) ===
    const { html: imoovaHtml } = from ? await fetchImoovaPage(from) : { html: null };
    let imoovaDeals = [];

    if (imoovaHtml) {
      // Parse deal data from Imoova's SSR-rendered HTML
      imoovaDeals = parseImoovaHtml(imoovaHtml);
      console.log('SSR parsed Imoova deals:', imoovaDeals.length);

      // Fallback: if SSR parsing found nothing but page has content, use Haiku to parse
      if (imoovaDeals.length === 0 && imoovaHtml.length > 500) {
        console.log('SSR parsing found nothing, trying Haiku parser...');
        // Strip HTML to plain text for Haiku
        const imoovaText = imoovaHtml
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
              imoovaDeals = JSON.parse(jsonMatch[0]);
              console.log('Haiku parsed Imoova deals:', imoovaDeals.length);
            }
          }
        } catch (e) {
          console.error('Haiku Imoova parse error:', e.message);
        }
      }
    }

    // Format Imoova deals (clean city names to strip scraper noise)
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
    }));

    // === STEP 2: Haiku web_search for other providers ===
    const dirClause = headingTowards
      ? `Heading towards "${headingTowards}". Mark matching deals "direction_match":true, but include ALL deals.`
      : 'No direction filter. "direction_match":false for all.';
    const radiusNote = searchRadius === 0 ? 'exact city only' : `within ${searchRadius}km`;
    const dateClause = date
      ? `Date target: around ${date} ±${flexibility} days.`
      : 'No date filter — include ALL deals regardless of date.';

    const imoovaFailed = !imoovaHtml || formattedImoovaDeals.length === 0;

    let prompt;
    if (!from && searchTo) {
      // ── TO-ONLY search: find deals ARRIVING AT a destination ──
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

${dateClause}

Respond with ONLY a JSON array:
[{"from":"city","to":"city","date_range":"dates","price":"EUR X/day","vehicle":"type","seats":0,"provider":"source","url":"url","direction_match":true,"description":"summary"}]

If nothing found: []`;
    } else {
      // ── FROM search (original logic) ──
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

Also include deals within ${radiusNote} of "${from}".
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

    // === STEP 3: Merge ===
    let allDeals = [...formattedImoovaDeals, ...otherDeals];

    if (headingTowards) {
      const target = headingTowards.toLowerCase();
      allDeals = allDeals.map(d => ({
        ...d,
        direction_match: (d.to || '').toLowerCase().includes(target) ||
          target.includes((d.to || '').toLowerCase()),
      }));
    }

    allDeals.sort((a, b) => (b.direction_match ? 1 : 0) - (a.direction_match ? 1 : 0));

    const seen = new Set();
    allDeals = allDeals.filter(d => {
      const key = `${(d.from||'').toLowerCase()}|${(d.to||'').toLowerCase()}|${(d.vehicle||'').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const result = {
      deals: allDeals,
      meta: {
        from: from || null, to: searchTo || null, date, flexibility,
        headingTowards: headingTowards || null,
        radius: searchRadius,
        count: allDeals.length,
        cached: false,
        timestamp: new Date().toISOString(),
        sources: { imoova_direct: formattedImoovaDeals.length, web_search: otherDeals.length },
      },
      debug: {
        imoovaFetched: !!imoovaHtml,
        imoovaHtmlLength: imoovaHtml ? imoovaHtml.length : 0,
        imoovaParsed: imoovaDeals.length,
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
