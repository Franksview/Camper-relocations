// Vercel Serverless — Movacamper Featured Deals API
// Lightweight: Imoova direct fetch only (2-3 seconds)
// Returns top deals from popular hub cities for homepage showcase

const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours (deals don't change that fast)

const CITY_SLUGS = {
  'munchen': 'munich', 'münchen': 'munich', 'muenchen': 'munich',
  'wien': 'vienna', 'wenen': 'vienna',
  'lissabon': 'lisbon', 'lisboa': 'lisbon',
  'kopenhagen': 'copenhagen', 'københavn': 'copenhagen',
  'brussel': 'brussels', 'bruxelles': 'brussels',
  'mailand': 'milan', 'milano': 'milan',
  'rom': 'rome', 'roma': 'rome',
  'prag': 'prague', 'praha': 'prague',
};

const HUB_CITIES = ['munich', 'berlin', 'hamburg', 'frankfurt', 'lisbon'];

async function fetchImoovaDeals(city) {
  const slug = CITY_SLUGS[city.toLowerCase()] || city.toLowerCase().replace(/\s+/g, '-');
  const url = `https://www.imoova.com/en/relocations?region=EU&departure_city=${encodeURIComponent(slug)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return [];

    const html = await resp.text();

    // Extract deal URLs
    const hrefPattern = /href="\/en\/relocations\/(\d+)"/g;
    const dealUrlIds = [];
    let hm;
    while ((hm = hrefPattern.exec(html)) !== null) {
      dealUrlIds.push(hm[1]);
    }

    // Strip HTML
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&rarr;/g, '→').replace(/&#8594;/g, '→').replace(/&#x2192;/g, '→')
      .replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&#x20AC;/g, '€')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Check if we got actual city results
    if (text.includes('Relocations In Europe') && !text.toLowerCase().includes('relocations in ' + slug)) {
      return [];
    }

    // Parse deals with regex
    const dealPattern = /([\w][\w\s]*?)\s+available for one-way rental from\s+([A-Za-zÀ-ÿ\s\-\.]+?)\s+to\s+([A-Za-zÀ-ÿ\s\-\.]+?)\.\s*Flexible relocation with\s+(\d+)\s+seats?,\s*(Automatic|Manual)\s+transmission\.\s*Starting\s+([€$£][\d.]+)\s+per\s+(?:night|day)/gi;

    const deals = [];
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
        price: match[6] + '/day',
      });
    }

    // Extract dates
    const datePattern = /(\d{1,2})\s*(?:-|–)\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/gi;
    const allDates = [...text.matchAll(datePattern)].map(m => m[1] + '–' + m[2] + ' ' + m[3]);

    // Assign URLs and dates
    for (let i = 0; i < deals.length; i++) {
      deals[i].date_range = allDates[i] || 'Flexible dates';
      deals[i].url = dealUrlIds[i]
        ? 'https://www.imoova.com/en/relocations/' + dealUrlIds[i] + '?via=relocamp'
        : 'https://www.imoova.com/en/relocations?region=EU&via=relocamp';
      deals[i].provider = /eu\s*(active|comfort|standard)|vw\s*california|atlas|nomad|etrusco|comfort\s*family|selena/i.test(deals[i].vehicle)
        ? 'Indie Campers via Imoova' : 'Imoova';
    }

    // Fallback: arrow pattern
    if (deals.length === 0) {
      const routePattern = /([A-Za-zÀ-ÿ][\w\s\-\.]{1,28})\s*→\s*([A-Za-zÀ-ÿ][\w\s\-\.]{1,28})/g;
      const routes = [...text.matchAll(routePattern)]
        .filter(r => !/sort|filter|map|menu|nav/i.test(r[1] + r[2]));

      for (let i = 0; i < Math.min(routes.length, 30); i++) {
        deals.push({
          vehicle: 'Campervan',
          from: routes[i][1].trim(),
          to: routes[i][2].trim(),
          seats: 0,
          transmission: 'unknown',
          price: '€1/day',
          date_range: allDates[i] || 'Flexible dates',
          url: dealUrlIds[i]
            ? 'https://www.imoova.com/en/relocations/' + dealUrlIds[i] + '?via=relocamp'
            : 'https://www.imoova.com/en/relocations?region=EU&via=relocamp',
          provider: 'Imoova',
        });
      }
    }

    return deals;
  } catch (err) {
    console.error(`Imoova fetch error for ${city}:`, err.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Check cache
  const cacheKey = 'featured';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    const limit = parseInt(req.query?.limit) || 3;
    
    // Fetch from top hub city (Munich has most deals)
    const deals = await fetchImoovaDeals('munich');

    // Take top N diverse deals (different destinations)
    const seen = new Set();
    const featured = [];
    for (const deal of deals) {
      const destKey = deal.to.toLowerCase();
      if (!seen.has(destKey) && featured.length < limit) {
        seen.add(destKey);
        featured.push(deal);
      }
    }

    // If Munich has few deals, also try Berlin
    if (featured.length < 3) {
      const berlinDeals = await fetchImoovaDeals('berlin');
      for (const deal of berlinDeals) {
        const key = `${deal.from.toLowerCase()}-${deal.to.toLowerCase()}`;
        if (!seen.has(key) && featured.length < limit) {
          seen.add(key);
          featured.push(deal);
        }
      }
    }

    const result = {
      deals: featured,
      hub: featured.length > 0 ? featured[0].from : 'Munich',
      total_available: deals.length,
      timestamp: new Date().toISOString(),
    };

    if (featured.length > 0) {
      cache.set(cacheKey, { data: result, time: Date.now() });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Featured API error:', err);
    return res.status(500).json({ error: 'Failed to fetch featured deals' });
  }
}
