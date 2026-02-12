// Vercel Serverless Function — Relocamp v3.1
// Origin-based campervan relocation deal finder

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { from, date, flexibility = 3, headingTowards = '', radius = 50 } = req.body;
  if (!from || !date) return res.status(400).json({ error: 'Missing: from, date' });

  const searchRadius = Math.min(Math.max(parseInt(radius) || 50, 0), 100);
  const cacheKey = `${from.toLowerCase()}|${date}|${flexibility}|${headingTowards.toLowerCase()}|${searchRadius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const dirClause = headingTowards
    ? `Heading towards "${headingTowards}". Mark matching deals "direction_match":true, but include ALL deals.`
    : 'No direction filter. "direction_match":false for all.';

  const radiusNote = searchRadius === 0 ? 'exact city only' : `within ${searchRadius}km`;

  const prompt = `Find campervan relocation deals departing from/near "${from}" (${radiusNote}) around ${date} ±${flexibility} days.

Search these sites:
- imoova.com/en/relocations (EU relocations, EUR 1/day)
- roadsurfer.com/rv-rental/rally/ (EUR 129 rally deals)
- indiecampers.com/deals/europe (relocation specials)
- bunkcampers.com/campervan-relocation-deals/ (UK/Ireland)

${dirClause}

Return ONLY a JSON array (no markdown). Each deal:
{"from":"City","to":"City","date_range":"11-26 Apr","nights":"9+3","price":"EUR 1/night","vehicle":"Model","seats":5,"provider":"Imoova|Roadsurfer|Indie Campers|Bunk Campers","url":"booking_url","direction_match":false,"description":"summary"}

Empty if none found: []
Real deals only.`;

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
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 3,
        }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (response.status === 429 && attempt <= 2) {
      const wait = attempt * 15000;
      console.log(`Rate limited, retry ${attempt} in ${wait/1000}s`);
      await new Promise(r => setTimeout(r, wait));
      return callAPI(attempt + 1);
    }

    return response;
  }

  try {
    const response = await callAPI();

    if (!response.ok) {
      const err = await response.text();
      console.error('API error:', err);
      return res.status(502).json({ error: 'Search API error', detail: err });
    }

    const data = await response.json();

    let text = '';
    for (const block of data.content || []) {
      if (block.type === 'text') text += block.text;
    }

    let deals = [];
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) deals = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('Parse error:', parseErr.message, 'Raw:', text.substring(0, 300));
    }

    deals.sort((a, b) => (b.direction_match ? 1 : 0) - (a.direction_match ? 1 : 0));

    const result = {
      deals,
      meta: { from, date, flexibility, headingTowards: headingTowards || null, radius: searchRadius, count: deals.length, cached: false, timestamp: new Date().toISOString() },
    };

    cache.set(cacheKey, { data: result, time: Date.now() });
    return res.status(200).json(result);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
