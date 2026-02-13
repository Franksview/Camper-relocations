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

  const prompt = `Search for campervan relocation deals DEPARTING FROM ${from}.

Search queries to use:
- "imoova relocation deals from ${from}"
- "roadsurfer rally relocations"
- "indie campers relocation deals"

CRITICAL: Only include deals where the PICKUP/START city is "${from}" or within ${radiusNote} of "${from}".
The "from" field = where you COLLECT the vehicle. The "to" field = where you DROP OFF the vehicle.
Do NOT include deals where "${from}" is the destination/drop-off city.

Date target: around ${date} ±${flexibility} days. Include deals even if exact dates are approximate.

${dirClause}

Respond with ONLY a JSON array:
[{"from":"pickup city","to":"dropoff city","date_range":"approx dates","price":"EUR X/day","vehicle":"type if known","seats":0,"provider":"source","url":"page_url","direction_match":false,"description":"one line summary"}]

Use "unknown" for missing fields. If nothing found: []`;

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
          max_uses: 5,
        }],
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a web scraping API that extracts deal data from search results. Output ONLY valid JSON arrays. Never explain, apologize, or add commentary. Never say you cannot do something. Extract whatever deal information is visible in search results, even if incomplete. Use "unknown" for missing fields.',
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
    const blockTypes = [];
    for (const block of data.content || []) {
      blockTypes.push(block.type);
      if (block.type === 'text') text += block.text;
    }
    console.log('Block types:', blockTypes.join(', '));
    console.log('Raw text length:', text.length);
    console.log('Raw text preview:', text.substring(0, 500));
    console.log('Stop reason:', data.stop_reason);

    let deals = [];
    let parseError = null;
    try {
      let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        console.log('JSON match found, length:', jsonMatch[0].length);
        deals = JSON.parse(jsonMatch[0]);
      } else {
        console.log('No JSON array found in response');
        parseError = 'No JSON array found';
      }
    } catch (parseErr) {
      parseError = parseErr.message;
      console.error('Parse error:', parseErr.message);
    }

    deals.sort((a, b) => (b.direction_match ? 1 : 0) - (a.direction_match ? 1 : 0));

    const result = {
      deals,
      meta: { from, date, flexibility, headingTowards: headingTowards || null, radius: searchRadius, count: deals.length, cached: false, timestamp: new Date().toISOString() },
      debug: { blockTypes, textLength: text.length, textPreview: text.substring(0, 800), parseError, stopReason: data.stop_reason },
    };

    // Only cache if we found deals
    if (deals.length > 0) {
      cache.set(cacheKey, { data: result, time: Date.now() });
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
