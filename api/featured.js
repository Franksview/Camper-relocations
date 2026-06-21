// Vercel Serverless — Movacamper Featured Deals API
// Returns top deals from the live Imoova pool for homepage showcase / no-results fallback
// Shares the scraper with api/search.js (api/lib/search-core.js) so deep-link URLs
// (relocations/deal/<slug>-RLC<id>) match the post-2026-06 Imoova site rebuild.

import { fetchImoovaPage, parseImoovaHtml } from './lib/search-core.js';

const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours (deals don't change that fast)

async function fetchImoovaDeals() {
  const { html } = await fetchImoovaPage('featured');
  if (!html) return [];
  return parseImoovaHtml(html);
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

    const deals = await fetchImoovaDeals();

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
