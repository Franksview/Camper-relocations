// Vercel Cron — Weekly Cross-City Digest
// Runs every Wednesday at 08:00 UTC.
//
// Fetches the top 5 live Imoova deals (any city) and sends them to all active
// subscribers who haven't opted out of digests. Unlike the daily matcher which
// only emails subs when a deal matches their specific city, this one contacts
// everyone — the point is to show what's hot across Europe this week.
//
// Suppressed for subs who received any email in the last 2 days (already active).
// Rate-limited at 4 emails/sec to stay within Resend free tier.

import { buildDigestEmail, sendEmail } from '../_lib/email.js';
import { fetchImoovaPage, parseImoovaHtml, buildImoovaUrl, IMOOVA_FALLBACK_URL } from '../_lib/search-core.js';

const DIGEST_SENT_KEY_PREFIX = 'digest:weekly:sent:';
const AUTO_SEND_LOG_KEY = 'email:auto-sent-log';
const AUTO_SEND_LOG_MAX = 200;
// 156h (6.5 days), not 48h: a generic subscriber's one-time intro digest
// (sent by match-subscribers.js, up to 6 days before the next Wednesday
// depending on signup day) must stay suppressed until this cron's normal
// 7-day cadence catches up, or they'd get a near-duplicate digest within
// the same week. See _learning/decisions.md 2026-07-14 for the incident.
const SUPPRESS_WITHIN_HOURS = 156;

async function getRedis() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      const client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true,
      });
      await client.connect();
      return client;
    } catch { return null; }
  }
  return null;
}

async function fetchTopDeals(limit = 5) {
  try {
    const { html } = await fetchImoovaPage('featured');
    if (!html) return [];
    const raw = parseImoovaHtml(html);

    // Diverse destinations — one deal per destination city
    const seen = new Set();
    const top = [];
    for (const deal of raw) {
      const destKey = (deal.to || '').toLowerCase();
      if (!seen.has(destKey) && top.length < limit) {
        seen.add(destKey);
        top.push({
          ...deal,
          url: buildImoovaUrl(deal.url || IMOOVA_FALLBACK_URL, { medium: 'email', campaign: 'weekly-digest-wed' }),
        });
      }
    }
    return top;
  } catch (err) {
    console.error('[weekly-digest] fetchTopDeals error:', err.message);
    return [];
  }
}

function computeStats(deals) {
  const cityCount = {};
  for (const d of deals) {
    const city = (d.from || '').toLowerCase();
    if (city) cityCount[city] = (cityCount[city] || 0) + 1;
  }
  let topCity = null;
  let topCityCount = 0;
  for (const [city, count] of Object.entries(cityCount)) {
    if (count > topCityCount) { topCity = city; topCityCount = count; }
  }
  return {
    totalDeals: deals.length,
    topCity: topCity ? topCity.charAt(0).toUpperCase() + topCity.slice(1) : null,
    topCityCount,
  };
}

export default async function handler(req, res) {
  // Allow Vercel cron (GET) or manual trigger with DASH_TOKEN
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const token = req.query.token;
  const dashToken = process.env.DASH_TOKEN;

  if (!isVercelCron) {
    if (!dashToken) return res.status(500).json({ error: 'Server misconfigured: DASH_TOKEN not set' });
    if (token !== dashToken) return res.status(401).json({ error: 'Unauthorized' });
  }

  const preview = req.query.mode === 'preview';

  // ── Fetch deals ──
  const deals = await fetchTopDeals(5);
  if (deals.length === 0) {
    console.log('[weekly-digest] No deals found — skipping send');
    return res.status(200).json({ ok: true, skipped: 'no deals', sent: 0 });
  }
  const stats = computeStats(deals);
  console.log(`[weekly-digest] ${deals.length} deals fetched, topCity=${stats.topCity}`);

  // ── Preview: send test email to frank@movacamper.com ──
  if (preview) {
    const previewSub = { email: 'frank@movacamper.com', name: 'Frank', city: 'any' };
    const { html, subject } = buildDigestEmail(previewSub, deals, stats);
    const result = await sendEmail({ to: previewSub.email, subject: `[PREVIEW] ${subject}`, html });
    return res.status(result.sent ? 200 : 500).json({
      ok: result.sent,
      mode: 'preview',
      deals: deals.length,
      stats,
      recipient: previewSub.email,
      reason: result.reason || null,
    });
  }

  // ── Fetch subscribers ──
  const redis = await getRedis();
  if (!redis) return res.status(500).json({ error: 'Redis unavailable' });

  const emails = await redis.smembers('subscribers:emails');
  if (!emails || emails.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, total: 0 });
  }

  const pipe = redis.pipeline();
  emails.forEach(e => pipe.get(`sub:${e}`));
  const raw = await pipe.exec();
  const subs = raw.map((r) => {
    const val = Array.isArray(r) ? r[1] : r;
    try { return typeof val === 'string' ? JSON.parse(val) : val; }
    catch { return null; }
  }).filter(Boolean);

  // ── Week key — one digest per subscriber per ISO week ──
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay()); // Sunday
  const weekKey = weekStart.toISOString().slice(0, 10); // e.g. 2026-07-07
  const sentKey = `${DIGEST_SENT_KEY_PREFIX}${weekKey}`;

  // Who already got this week's digest?
  const alreadySentThisWeek = new Set();
  try {
    const sentMembers = await redis.smembers(sentKey);
    (sentMembers || []).forEach(e => alreadySentThisWeek.add(e));
  } catch { /* best-effort */ }

  // Who got ANY email in the last 48h (don't pile on)?
  const suppressCutoff = Date.now() - SUPPRESS_WITHIN_HOURS * 60 * 60 * 1000;
  const recentlySuppressed = new Set();
  try {
    const logEntries = await redis.lrange(AUTO_SEND_LOG_KEY, 0, 499);
    (logEntries || []).forEach(entry => {
      try {
        const e = typeof entry === 'string' ? JSON.parse(entry) : entry;
        if (e && e.email && e.ts && new Date(e.ts).getTime() > suppressCutoff) {
          recentlySuppressed.add(e.email);
        }
      } catch { /* skip */ }
    });
  } catch { /* best-effort */ }

  // Filter eligible subs
  const eligible = subs.filter(s =>
    s && s.email &&
    s.status !== 'unsubscribed' && !s.unsubscribed && !s.digestOptOut &&
    !alreadySentThisWeek.has(s.email) &&
    !recentlySuppressed.has(s.email)
  );

  console.log(`[weekly-digest] ${subs.length} total, ${eligible.length} eligible (${subs.length - eligible.length} skipped)`);

  // ── Send in batches of 4 (Resend rate limit) ──
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const BATCH_SIZE = 4;
  const results = [];

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (sub) => {
      try {
        const { html, subject } = buildDigestEmail(sub, deals, stats);
        const r = await sendEmail({ to: sub.email, subject, html, fromName: 'Frank from Movacamper' });
        if (r.sent) {
          // Mark as sent this week
          await redis.sadd(sentKey, sub.email).catch(() => {});
          // Log to auto-sent-log
          const entry = JSON.stringify({ email: sub.email, campaign: `weekly-digest-${weekKey}`, ts: new Date().toISOString(), messageId: r.messageId });
          await redis.lpush(AUTO_SEND_LOG_KEY, entry).catch(() => {});
          return { email: sub.email, sent: true, messageId: r.messageId };
        }
        return { email: sub.email, sent: false, reason: r.reason };
      } catch (err) {
        return { email: sub.email, sent: false, reason: err.message };
      }
    }));
    results.push(...batchResults);
    if (i + BATCH_SIZE < eligible.length) await sleep(1100);
  }

  // TTL on the week key — auto-expires after 10 days
  try { await redis.expire(sentKey, 10 * 24 * 60 * 60); } catch { /* best-effort */ }
  await redis.ltrim(AUTO_SEND_LOG_KEY, 0, AUTO_SEND_LOG_MAX - 1).catch(() => {});

  const sent = results.filter(r => r.sent);
  const failed = results.filter(r => !r.sent);

  console.log(`[weekly-digest] Done: ${sent.length} sent, ${failed.length} failed`);

  return res.status(200).json({
    ok: true,
    week: weekKey,
    deals: deals.length,
    stats,
    total: subs.length,
    eligible: eligible.length,
    sent: sent.length,
    failed: failed.length,
    failures: failed.length > 0 ? failed : undefined,
  });
}
