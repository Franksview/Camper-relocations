// Vercel Serverless — Movacamper Featured Deals API
// 2026-09: was sourced entirely from Imoova's global pool. Imoova removed as a
// data source/affiliate partner (see decisions.md) and there's no drop-in
// replacement for a city-less "featured" feed — the Haiku search path needs a
// city to search from. Returns an honest empty state until a replacement
// source is wired in, rather than erroring or silently serving stale data.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(200).json({
    deals: [],
    hub: null,
    total_available: 0,
    timestamp: new Date().toISOString(),
  });
}
