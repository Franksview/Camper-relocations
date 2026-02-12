// Vercel Serverless Function: /api/search
// Receives search requests from frontend, calls Claude API with web search,
// returns structured relocation deals

// Simple in-memory cache (persists per serverless instance, ~5-15 min)
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { from, to, startDate, dateFlex } = req.body || {};

  if (!from || !to) {
    return res.status(400).json({ error: 'Missing "from" and "to" fields' });
  }

  // Check cache
  const cacheKey = `${from.toLowerCase()}-${to.toLowerCase()}-${startDate || 'any'}-${dateFlex || 7}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.status(200).json({ deals: cached.deals, source: 'cache' });
  }

  // Build the prompt
  const dateInfo = startDate
    ? `around ${startDate} (within ${dateFlex || 7} days flexibility)`
    : 'for any upcoming available dates in the next 2-3 months';

  const prompt = `Search for real, currently available campervan and motorhome relocation deals in Europe.

I need deals going from or near "${from}" to or near "${to}" ${dateInfo}.

Search these specific websites:
1. imoova.com/en/relocations - they list €1/day relocation deals across Europe
2. roadsurfer.com relocation/transfer deals
3. indiecampers.com/deals/europe
4. movacar.de camper relocation deals
5. bunkcampers.com/campervan-relocation-deals
6. spaceshipsrentals.co.uk/deals/relocation

For each deal you find, extract:
- Provider name
- Departure city and country
- Destination city and country
- Available dates (start and end date window)
- Number of nights/days allowed
- Price per night/day
- Vehicle type and description
- Number of seats/passengers
- Direct booking URL for that specific deal

IMPORTANT: Only include REAL deals you actually find on these websites. Do not invent deals.
If no exact route matches, also look for nearby cities (within ~300km) as alternatives.

Respond ONLY with a JSON array. No markdown, no backticks, no explanation text.
Each object must have this exact structure:
[
  {
    "provider": "Imoova",
    "from_city": "Berlin",
    "from_country": "Germany",
    "to_city": "Barcelona",
    "to_country": "Spain",
    "available_from": "2026-03-21",
    "available_to": "2026-04-04",
    "days_allowed": 14,
    "price_per_day": 1,
    "currency": "EUR",
    "vehicle_type": "Motorhome - 4 berth",
    "seats": 4,
    "booking_url": "https://www.imoova.com/en/relocations/..."
  }
]

If you find NO deals at all, respond with exactly: []`;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfigured: missing API key' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', errData);
      return res.status(502).json({
        error: 'Failed to search providers',
        detail: errData.error?.message || `API returned ${response.status}`
      });
    }

    const data = await response.json();

    // Extract text content from response
    const textBlocks = data.content
      .filter(item => item.type === 'text')
      .map(item => item.text);
    const fullText = textBlocks.join('\n');

    // Parse JSON from response
    let deals = [];
    try {
      const cleaned = fullText.replace(/```json|```/g, '').trim();
      deals = JSON.parse(cleaned);
    } catch {
      const jsonMatch = fullText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          deals = JSON.parse(jsonMatch[0]);
        } catch {
          console.error('Failed to parse deals JSON:', fullText.substring(0, 500));
        }
      }
    }

    if (!Array.isArray(deals)) deals = [];

    // Normalize the data
    const normalized = deals.map((deal, idx) => ({
      id: `deal-${Date.now()}-${idx}`,
      provider: deal.provider || 'Unknown',
      from_city: deal.from_city || '',
      from_country: deal.from_country || '',
      to_city: deal.to_city || '',
      to_country: deal.to_country || '',
      available_from: deal.available_from || '',
      available_to: deal.available_to || '',
      days_allowed: deal.days_allowed || deal.min_nights || deal.max_nights || 0,
      price_per_day: deal.price_per_day || deal.price_per_night || 0,
      currency: deal.currency || 'EUR',
      vehicle_type: deal.vehicle_type || 'Campervan',
      seats: deal.seats || 0,
      booking_url: deal.booking_url || ''
    }));

    // Cache results
    cache.set(cacheKey, { deals: normalized, timestamp: Date.now() });

    return res.status(200).json({ deals: normalized, source: 'live' });

  } catch (err) {
    console.error('Search handler error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
