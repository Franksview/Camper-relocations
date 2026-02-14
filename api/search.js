// Vercel Serverless Function — Relocamp v4.1
// Hybrid: direct Imoova fetch + Claude Haiku for other providers

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchImoovaPage(city) {
  const slug = city.toLowerCase().replace(/\s+/g, '-');
  const url = `https://www.imoova.com/en/relocations?region=EU&departure_city=${encodeURIComponent(slug)}`;
  console.log('Fetching Imoova:', url);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.log('Imoova fetch failed:', resp.status);
      return { text: null, dealUrlIds: [] };
    }

    const html = await resp.text();
    console.log('Imoova HTML length:', html.length);

    // Extract deal URLs from href BEFORE stripping tags
    const hrefPattern = /href="\/en\/relocations\/(\d+)"/g;
    const dealUrlIds = [];
    let hm;
    while ((hm = hrefPattern.exec(html)) !== null) {
      dealUrlIds.push(hm[1]);
    }
    console.log('Deal URL IDs from href:', dealUrlIds.length);

    // Strip HTML to plain text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&rarr;/g, '→').replace(/&#8594;/g, '→').replace(/&#x2192;/g, '→')
      .replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&#x20AC;/g, '€')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log('Stripped text length:', text.length);
    console.log('Text sample:', text.substring(0, 300));

    return { text, dealUrlIds };
  } catch (err) {
    console.log('Imoova fetch error:', err.message);
    return { text: null, dealUrlIds: [] };
  }
}

function parseImoovaText(text, dealUrlIds) {
  const deals = [];

  // Generic vehicle pattern: captures any vehicle name before "available for one-way rental"
  // The lazy quantifier (.*?) grabs minimal text, anchored by "available for one-way rental from"
  // which is Imoova's standard phrasing for all deal listings
  const dealPattern = /([\w][\w\s]*?)\s+available for one-way rental from\s+([A-Za-zÀ-ÿ\s\-\.]+?)\s+to\s+([A-Za-zÀ-ÿ\s\-\.]+?)\.\s*Flexible relocation with\s+(\d+)\s+seats?,\s*(Automatic|Manual)\s+transmission\.\s*Starting\s+([€$£][\d.]+)\s+per\s+(?:night|day)/gi;

  let match;
  while ((match = dealPattern.exec(text)) !== null) {
    const vehicle = match[1].trim();
    if (vehicle.length < 3) continue;

    deals.push({
      vehicle,
      from: match[2].trim(),
      to: match[3].trim(),
      seats: parseInt(match[4]),
      transmission: match[5],
      price: match[6] + '/night',
    });
  }

  // Extract dates
  const datePattern = /(\d{1,2})\s*(?:-|–)\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/gi;
  const allDates = [...text.matchAll(datePattern)].map(m => m[1] + '-' + m[2] + ' ' + m[3]);

  // Assign URLs and dates
  for (let i = 0; i < deals.length; i++) {
    deals[i].date_range = allDates[i] || 'unknown';
    deals[i].url = dealUrlIds[i]
      ? 'https://www.imoova.com/en/relocations/' + dealUrlIds[i]
      : 'https://www.imoova.com/en/relocations?region=EU';
  }

  // Fallback: route arrow pattern if regex missed
  if (deals.length === 0) {
    const routePattern = /([A-Za-zÀ-ÿ][\w\s\-\.]{1,28})\s*→\s*([A-Za-zÀ-ÿ][\w\s\-\.]{1,28})/g;
    const routes = [...text.matchAll(routePattern)]
      .filter(r => !/sort|filter|map|menu|nav/i.test(r[1] + r[2]));

    for (let i = 0; i < routes.length; i++) {
      deals.push({
        vehicle: 'Campervan',
        from: routes[i][1].trim(),
        to: routes[i][2].trim(),
        seats: 0,
        transmission: 'unknown',
        price: '€1.00/night',
        date_range: allDates[i] || 'unknown',
        url: dealUrlIds[i]
          ? 'https://www.imoova.com/en/relocations/' + dealUrlIds[i]
          : 'https://www.imoova.com/en/relocations?region=EU',
      });
    }
  }

  return deals;
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

  const { from, date, flexibility = 3, headingTowards = '', radius = 50 } = req.body;
  if (!from) return res.status(400).json({ error: 'Missing: from' });

  const searchRadius = Math.min(Math.max(parseInt(radius) || 50, 0), 100);
  const cacheKey = `${from.toLowerCase()}|${date || 'any'}|${flexibility}|${headingTowards.toLowerCase()}|${searchRadius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // === STEP 1: Direct Imoova fetch ===
    const { text: imoovaText, dealUrlIds } = await fetchImoovaPage(from);
    let imoovaDeals = [];

    if (imoovaText) {
      // Try regex parsing first
      imoovaDeals = parseImoovaText(imoovaText, dealUrlIds);
      console.log('Regex parsed Imoova deals:', imoovaDeals.length);

      // Fallback: if regex found nothing but page has content, use Haiku to parse
      if (imoovaDeals.length === 0 && imoovaText.length > 500) {
        console.log('Regex found nothing, trying Haiku parser...');
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

    // Format Imoova deals
    const formattedImoovaDeals = imoovaDeals.map(d => ({
      from: d.from,
      to: d.to,
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

    const imoovaFailed = !imoovaText || formattedImoovaDeals.length === 0;

    const providerQueries = imoovaFailed
      ? `Search for ALL of these providers:
1. "imoova relocations departing from ${from} Europe"
2. "roadsurfer rally relocations from ${from}"
3. "bunk campers relocation deals ${from}"`
      : `Search for these providers ONLY (Imoova already handled):
1. "roadsurfer rally relocations from ${from}"
2. "bunk campers relocation deals ${from}"`;

    const prompt = `Search for campervan relocation deals DEPARTING FROM ${from}.

${providerQueries}

DIRECTION FILTER:
✅ INCLUDE: "${from} to [somewhere]"
❌ EXCLUDE: "[somewhere] to ${from}"

Also include deals within ${radiusNote} of "${from}".
${dateClause}
${dirClause}

Respond with ONLY a JSON array:
[{"from":"city","to":"city","date_range":"dates","price":"EUR X/day","vehicle":"type","seats":0,"provider":"source","url":"url","direction_match":false,"description":"summary"}]

If nothing found: []`;

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
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: imoovaFailed ? 5 : 3 }],
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
        from, date, flexibility,
        headingTowards: headingTowards || null,
        radius: searchRadius,
        count: allDeals.length,
        cached: false,
        timestamp: new Date().toISOString(),
        sources: { imoova_direct: formattedImoovaDeals.length, web_search: otherDeals.length },
      },
      debug: {
        imoovaFetched: !!imoovaText,
        imoovaTextLength: imoovaText ? imoovaText.length : 0,
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
