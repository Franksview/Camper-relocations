// Vercel Serverless Function — Camper Relocation Deal Finder v3
// Origin-based browsing with optional "heading towards" filtering
// Providers: Imoova, Roadsurfer, Indie Campers, Bunk Campers

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { from, date, flexibility = 3, headingTowards = '' } = req.body;

  if (!from || !date) {
    return res.status(400).json({ error: 'Missing required fields: from, date' });
  }

  // Build cache key
  const cacheKey = `${from.toLowerCase()}|${date}|${flexibility}|${headingTowards.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Build the search prompt
  const headingClause = headingTowards
    ? `The traveller is heading towards "${headingTowards}". Prioritise deals going in that general direction, but still include ALL other deals from this origin. Mark deals matching the direction with "direction_match": true.`
    : 'Show ALL available deals from this origin city. No direction filter.';

  const prompt = `You are a campervan relocation deal search engine. Find ALL available relocation deals departing from or near "${from}" around ${date} (plus or minus ${flexibility} days).

Search these 4 providers for current deals:
1. Imoova (imoova.com/en/relocations?region=EU) - EUR 1/day relocations
2. Roadsurfer (roadsurfer.com/rv-rental/rally/) - EUR 129 one-way rally deals
3. Indie Campers (indiecampers.com/deals/europe) - relocation specials up to 80% off
4. Bunk Campers (bunkcampers.com/campervan-relocation-deals/) - UK/Ireland factory relocations

${headingClause}

"Near" means the exact city or cities within 50km (e.g. Berlin includes Potsdam, Munich includes Augsburg).

For EACH deal found, return this exact JSON structure:
{
  "from": "City name",
  "to": "City name",
  "date_range": "e.g. 11 - 26 Apr",
  "nights": "e.g. 9 + 3 nights",
  "price": "e.g. EUR 1/night or EUR 129 total",
  "vehicle": "e.g. Comfort Standard 5 Auto",
  "seats": 5,
  "provider": "Imoova|Roadsurfer|Indie Campers|Bunk Campers",
  "url": "direct booking URL",
  "direction_match": true or false,
  "description": "one-line summary"
}

Return ONLY a JSON array of deal objects. No markdown, no explanation, no wrapping. Just the raw JSON array.
If no deals found at all, return an empty array: []
Be thorough - check each provider carefully. Real deals only, no invented data.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 10,
          },
        ],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('API error:', err);
      return res.status(502).json({ error: 'Search API error', detail: err });
    }

    const data = await response.json();

    // Extract text from content blocks
    let text = '';
    for (const block of data.content || []) {
      if (block.type === 'text') {
        text += block.text;
      }
    }

    // Parse deals from response
    let deals = [];
    try {
      // Try to find JSON array in the response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        deals = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.error('Parse error:', parseErr.message, 'Raw:', text.substring(0, 500));
    }

    // Sort: direction matches first, then by date
    deals.sort((a, b) => {
      if (a.direction_match && !b.direction_match) return -1;
      if (!a.direction_match && b.direction_match) return 1;
      return 0;
    });

    const result = {
      deals,
      meta: {
        from,
        date,
        flexibility,
        headingTowards: headingTowards || null,
        count: deals.length,
        cached: false,
        timestamp: new Date().toISOString(),
      },
    };

    // Cache it
    cache.set(cacheKey, { data: result, time: Date.now() });

    return res.status(200).json(result);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
