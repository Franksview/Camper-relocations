// Movacamper Broadcast Endpoint
// ──────────────────────────────
// One-off marketing broadcasts to active subscribers (e.g. Camperdays promo).
// Token-gated (DASH_TOKEN), date-gated per campaign, rate-limited.
//
// USAGE:
//   GET  /api/broadcast?token=X&campaign=camperdays-apr26&mode=preview
//        → sends a single PREVIEW email to frank@movacamper.com (not to subs)
//
//   POST /api/broadcast?token=X&campaign=camperdays-apr26&mode=send&confirm=true
//        → live broadcast to all active subscribers (skips unsubscribed + digestOptOut)
//        → date-gated: refuses to send before campaign.validFrom
//        → logs each send to email:broadcast-log

import { sendEmail, getUnsubUrl } from './email.js';

const TEST_RECIPIENT = 'frank@movacamper.com';

// ─── Redis getter (inline, matches stats.js pattern) ───
let _store = null;
async function getStore() {
  if (_store) return _store;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      _store = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      return _store;
    } catch (e) { /* fall through */ }
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      _store = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      return _store;
    } catch (e) { /* fall through */ }
  }
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      _store = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true,
      });
      await _store.connect();
      return _store;
    } catch (e) { /* fall through */ }
  }
  return null;
}

// ─── Campaigns ───
const CAMPAIGNS = {
  'camperdays-apr26': {
    subject: '\u20AC90 off your next campervan rental \u2014 this week only \uD83D\uDE90',
    fromName: 'Frank from Movacamper',
    validFrom: '2026-04-24',
    validUntil: '2026-04-30',
    build: (sub) => buildCamperdaysEmail(sub),
  },
  'comeback-jun26': {
    subject: 'Sorry for the silence \u2014 weekly digests resume Monday',
    fromName: 'Frank from Movacamper',
    validFrom: '2026-06-11',
    validUntil: '2026-06-30',
    build: (sub) => buildComebackEmail(sub),
  },
  'camper26-jun22': {
    subject: '\u20ac85 off a campervan rental \u2014 code expires June 30 \ud83d\ude90',
    fromName: 'Frank from Movacamper',
    validFrom: '2026-06-22',
    validUntil: '2026-06-30',
    build: (sub) => buildCamper26Email(sub),
  },
};

// ─── HTML escape helper ───
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Comeback email builder (jun 2026) ───
// Audience: subs that didn't hear from us in 30+ days because our Imoova
// scraper silently broke on 2026-05-24 (Imoova rebuild). Honest "our fault,
// we're back" note with a clear promise (weekly digests resume Monday) and
// a low-pressure CTA. Camperdays partner link as soft fallback so the email
// has something actionable beyond "sit tight".
function buildComebackEmail(sub) {
  const email = sub?.email || 'preview@example.com';
  const firstName = (sub?.name || '').trim().split(' ')[0];
  const greeting = firstName ? `Hey ${esc(firstName)}` : 'Hey there';
  const unsubUrl = getUnsubUrl(email);

  const camperdaysUrl = `https://www.awin1.com/cread.php?awinmid=52885&awinaffid=1795498&ued=${encodeURIComponent('https://www.camperdays.com')}&clickref=${encodeURIComponent('comeback-jun26-' + Buffer.from(email).toString('base64').slice(0, 8))}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Movacamper — we're back</title>
</head>
<body style="margin:0;padding:0;background:#f7f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;line-height:1.6;">
<div style="max-width:560px;margin:0 auto;padding:24px 20px;">

  <div style="text-align:center;margin-bottom:24px;">
    <div style="font-family:Georgia,serif;font-size:1.5rem;color:#2d6a4f;font-weight:700;">Movacamper</div>
  </div>

  <h2 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:400;color:#1f2937;margin:0 0 16px;">${greeting} — sorry for the silence.</h2>

  <p style="font-size:15px;color:#374151;margin:0 0 14px;">You may have noticed: no Movacamper deal updates from us for the past few weeks. That's on us, not on you.</p>

  <p style="font-size:15px;color:#374151;margin:0 0 14px;">One of our deal sources rebuilt their site at the end of May, and our scraper quietly went blind. We didn't catch it for longer than we should have. It's fixed now, and emails are flowing again.</p>

  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 18px;margin:22px 0;">
    <p style="font-size:14px;color:#1f2937;margin:0;line-height:1.6;">📬 <strong>What to expect from here:</strong><br>
    Your <strong>weekly digest resumes this Monday</strong>. As soon as a relocation deal lights up near you mid-week, you'll hear about it that day — same as before.</p>
  </div>

  <p style="font-size:15px;color:#374151;margin:0 0 14px;">If you can't wait until Monday and you're itching to plan something — <a href="${camperdaysUrl}" style="color:#2d6a4f;">our partner Camperdays</a> compares 30+ campervan rental companies across Europe. Not relocation deals, but a useful shortcut if your dates are fixed.</p>

  <p style="font-size:15px;color:#374151;margin:18px 0 6px;">Thanks for sticking around,</p>
  <p style="font-size:15px;color:#374151;margin:0 0 24px;">Frank · Movacamper</p>

  <div style="text-align:center;margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb;">
    <a href="${esc(unsubUrl)}" style="font-size:12px;color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
  </div>

</div>
</body>
</html>`;
}

// ─── Camperdays email builder ───
function buildCamperdaysEmail(sub) {
  const email = sub?.email || 'preview@example.com';
  const city = sub?.city && sub.city !== 'any' ? sub.city : '';
  const cityDisplay = city ? city.charAt(0).toUpperCase() + city.slice(1) : '';
  const unsubUrl = getUnsubUrl(email);

  // Awin deeplink with optional city search
  const ued = city
    ? encodeURIComponent('https://www.camperdays.com/search?location=' + city)
    : encodeURIComponent('https://www.camperdays.com');
  const camperdaysUrl = `https://www.awin1.com/cread.php?awinmid=52885&awinaffid=1795498&ued=${ued}&clickref=${encodeURIComponent('bc-apr26-' + Buffer.from(email).toString('base64').slice(0, 8))}`;

  const cityLine = cityDisplay
    ? `If you\u2019ve been waiting for a Movacamper deal from <strong>${esc(cityDisplay)}</strong> but your dates don\u2019t quite match, this is your shortcut.`
    : `If your summer dates don\u2019t quite match what\u2019s live on Movacamper right now, this is your shortcut.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Movacamper \u2014 Camperdays promo</title>
</head>
<body style="margin:0;padding:0;background:#f7f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;line-height:1.55;">
<div style="max-width:560px;margin:0 auto;padding:24px 20px;">

  <div style="text-align:center;margin-bottom:20px;">
    <div style="font-family:Georgia,serif;font-size:1.5rem;color:#2d6a4f;font-weight:700;">Movacamper</div>
  </div>

  <h2 style="font-family:Georgia,serif;font-size:1.5rem;font-weight:400;color:#1f2937;margin:0 0 12px;">\uD83D\uDE90 &euro;90 off a campervan rental, this week only</h2>

  <p style="font-size:15px;color:#374151;margin:0 0 16px;">Hey,</p>

  <p style="font-size:15px;color:#374151;margin:0 0 16px;">Quick heads-up \u2014 <strong>Camperdays</strong> (one of our partners) is running a limited promotion this week. ${cityLine}</p>

  <div style="background:#fff8e6;border:1.5px solid #f5b731;border-radius:10px;padding:18px;margin:20px 0;">
    <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#b8860b;font-weight:700;margin-bottom:8px;">Limited-time promo</div>
    <div style="font-size:15px;line-height:1.8;color:#1f2937;">
      \uD83D\uDCB0 <strong>&euro;90 off</strong> any booking of &euro;900 or more<br>
      \uD83C\uDFF7\uFE0F Code: <code style="background:#fff;padding:3px 8px;border-radius:4px;border:1px solid #f5b731;font-size:14px;font-weight:700;letter-spacing:0.05em;">CDKD26</code><br>
      \uD83D\uDCC5 Valid <strong>April 24 \u2013 April 30, 2026</strong>
    </div>
  </div>

  <p style="font-size:15px;color:#374151;margin:0 0 20px;">Camperdays compares <strong>30+ campervan rental companies</strong> across Europe so you can pick dates and pickup city that actually fit your plan.</p>

  <div style="text-align:center;margin:28px 0;">
    <a href="${camperdaysUrl}" style="display:inline-block;background:#e8734a;color:#fff;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:700;text-decoration:none;box-shadow:0 3px 10px rgba(232,115,74,0.25);">\uD83D\uDE90 Browse Camperdays deals &rarr;</a>
  </div>

  <p style="font-size:14px;color:#6b7280;text-align:center;margin:0 0 20px;">Just enter code <strong>CDKD26</strong> at checkout before April 30.</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;">

  <p style="font-size:12px;color:#9ca3af;line-height:1.55;margin:0 0 12px;"><em>Small note: Camperdays is an affiliate partner \u2014 we earn a small commission when you book through us. The price stays the same for you, and every booking helps keep Movacamper running.</em></p>

  <p style="font-size:14px;color:#374151;margin:16px 0 6px;">Happy travels,</p>
  <p style="font-size:14px;color:#374151;margin:0 0 24px;">Frank \u00B7 Movacamper</p>

  <div style="text-align:center;margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb;">
    <a href="${unsubUrl}" style="font-size:12px;color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
  </div>

</div>
</body>
</html>`;
}

// ─── Camper26 email builder (jun 2026 — €85 off €850+) ───
function buildCamper26Email(sub) {
  const email = sub?.email || 'preview@example.com';
  const city = sub?.city && sub.city !== 'any' ? sub.city : '';
  const cityDisplay = city ? city.charAt(0).toUpperCase() + city.slice(1) : '';
  const unsubUrl = getUnsubUrl(email);

  const camperdaysUrl = `https://www.awin1.com/cread.php?awinmid=52885&awinaffid=1795498&ued=${encodeURIComponent('https://www.camperdays.com')}&clickref=${encodeURIComponent('bc-jun22-' + Buffer.from(email).toString('base64').slice(0, 8))}`;

  const cityLine = cityDisplay
    ? `If you've been watching for a relocation deal from <strong>${esc(cityDisplay)}</strong> but the timing hasn't lined up — this is a solid backup.`
    : `If the timing on relocation deals hasn't lined up yet, this is a solid backup.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Movacamper — €85 off campervan rental</title>
</head>
<body style="margin:0;padding:0;background:#f7f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;line-height:1.55;">
<div style="max-width:560px;margin:0 auto;padding:24px 20px;">

  <div style="text-align:center;margin-bottom:20px;">
    <div style="font-family:Georgia,serif;font-size:1.5rem;color:#2d6a4f;font-weight:700;">Movacamper</div>
  </div>

  <h2 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:400;color:#1f2937;margin:0 0 12px;">🚐 €85 off a campervan rental — ends June 30</h2>

  <p style="font-size:15px;color:#374151;margin:0 0 16px;">Hey,</p>

  <p style="font-size:15px;color:#374151;margin:0 0 16px;">Quick heads-up from our partners at <strong>Camperdays</strong>. ${cityLine}</p>

  <div style="background:#fff8e6;border:1.5px solid #f5b731;border-radius:10px;padding:18px;margin:20px 0;">
    <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#b8860b;font-weight:700;margin-bottom:8px;">Limited-time promo</div>
    <div style="font-size:15px;line-height:1.9;color:#1f2937;">
      💰 <strong>€85 off</strong> any booking of €850 or more<br>
      🏷️ Code: <code style="background:#fff;padding:3px 8px;border-radius:4px;border:1px solid #f5b731;font-size:14px;font-weight:700;letter-spacing:0.05em;">camper26</code><br>
      📅 Valid <strong>now until June 30, 2026</strong>
    </div>
  </div>

  <p style="font-size:15px;color:#374151;margin:0 0 20px;">Camperdays compares <strong>30+ campervan rental companies</strong> across Europe — so you pick the dates, pickup city, and van that work for you.</p>

  <div style="text-align:center;margin:28px 0;">
    <a href="${camperdaysUrl}" style="display:inline-block;background:#e8734a;color:#fff;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:700;text-decoration:none;box-shadow:0 3px 10px rgba(232,115,74,0.25);">🚐 Browse Camperdays deals →</a>
  </div>

  <p style="font-size:14px;color:#6b7280;text-align:center;margin:0 0 20px;">Enter code <strong>camper26</strong> at checkout. Offer ends June 30.</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;">

  <p style="font-size:12px;color:#9ca3af;line-height:1.55;margin:0 0 12px;"><em>Small note: Camperdays is an affiliate partner — we earn a small commission when you book through us. The price stays the same for you, and every booking helps keep Movacamper running.</em></p>

  <p style="font-size:14px;color:#374151;margin:16px 0 6px;">Happy travels,</p>
  <p style="font-size:14px;color:#374151;margin:0 0 24px;">Frank · Movacamper</p>

  <div style="text-align:center;margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb;">
    <a href="${esc(unsubUrl)}" style="font-size:12px;color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
  </div>

</div>
</body>
</html>`;
}

// ─── Handler ───
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const token = req.query.token;
  const dashToken = process.env.DASH_TOKEN;
  if (!dashToken) return res.status(500).json({ error: 'Server misconfigured: DASH_TOKEN not set' });
  if (token !== dashToken) return res.status(401).json({ error: 'Unauthorized' });

  // Campaign selection
  const campaignId = req.query.campaign;
  const config = CAMPAIGNS[campaignId];
  if (!config) {
    return res.status(400).json({
      error: 'Unknown campaign',
      available: Object.keys(CAMPAIGNS),
    });
  }

  const mode = req.query.mode || 'preview';

  // ─── PREVIEW MODE ───
  if (mode === 'preview') {
    const previewSub = { email: TEST_RECIPIENT, city: req.query.city || 'munich' };
    const html = config.build(previewSub);
    const result = await sendEmail({
      to: TEST_RECIPIENT,
      subject: `[PREVIEW] ${config.subject}`,
      html,
      fromName: config.fromName,
    });
    return res.status(result.sent ? 200 : 500).json({
      ok: result.sent,
      mode: 'preview',
      campaign: campaignId,
      recipient: TEST_RECIPIENT,
      messageId: result.messageId || null,
      reason: result.reason || null,
      fromName: config.fromName,
      subject: config.subject,
    });
  }

  // ─── SEND MODE ───
  if (mode === 'send') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Send mode requires POST' });
    }
    if (req.query.confirm !== 'true') {
      return res.status(400).json({ error: 'Send mode requires ?confirm=true' });
    }

    // Date gate
    const today = new Date().toISOString().slice(0, 10);
    if (config.validFrom && today < config.validFrom) {
      return res.status(400).json({
        error: `Campaign not yet active. Valid from ${config.validFrom}. Today: ${today}.`,
        hint: 'Waiting prevents sending promos before the advertiser\'s promotional window.',
      });
    }
    if (config.validUntil && today > config.validUntil) {
      return res.status(400).json({ error: `Campaign expired on ${config.validUntil}` });
    }

    const redis = await getStore();
    if (!redis) return res.status(500).json({ error: 'Redis unavailable' });

    // Fetch subscriber list
    const emails = await redis.smembers('subscribers:emails');
    if (!emails || emails.length === 0) {
      return res.status(200).json({ ok: true, total: 0, sent: 0 });
    }

    // Bulk-fetch subscriber records
    const pipe = redis.pipeline();
    emails.forEach(e => pipe.get(`sub:${e}`));
    const raw = await pipe.exec();
    const subs = raw.map((r, i) => {
      const val = Array.isArray(r) ? r[1] : r;
      try { return typeof val === 'string' ? JSON.parse(val) : val; }
      catch { return null; }
    }).filter(Boolean);

    // Filter out unsubscribed / opt-out
    let eligible = subs.filter(s =>
      s && s.email && s.status !== 'unsubscribed' && !s.unsubscribed && !s.digestOptOut
    );

    // Optional: narrow to an explicit recipient list. Use for targeted catch-up
    // broadcasts (e.g. "sorry for the silence" to subs >30d inactive).
    // Comma-separated emails, case-insensitive, max 50 to prevent abuse.
    if (req.query.onlyEmails) {
      const wanted = String(req.query.onlyEmails)
        .split(',').map(e => e.trim().toLowerCase()).filter(Boolean).slice(0, 50);
      if (wanted.length > 0) {
        const wantedSet = new Set(wanted);
        eligible = eligible.filter(s => wantedSet.has((s.email || '').toLowerCase()));
      }
    }

    // Dedupe: skip subscribers who already received this campaign in a previous run.
    // Prevents double-sends when re-firing a partial broadcast (e.g. after rate-limit failures).
    const alreadySent = new Set();
    try {
      const logRaw = await redis.lrange('email:broadcast-log', 0, 499);
      (logRaw || []).forEach(entry => {
        try {
          const e = typeof entry === 'string' ? JSON.parse(entry) : entry;
          if (e && e.campaign === campaignId && e.email) alreadySent.add(e.email);
        } catch { /* skip */ }
      });
    } catch { /* best-effort */ }

    // Batched parallel send — 4 emails in parallel, then wait 1s, repeat.
    // Resend caps at 5 req/sec; we stay strictly under at 4/sec. Vercel serverless
    // has a 10s function timeout on free plan, so batching is faster than serial-
    // with-sleep (28 emails: ~7s instead of ~12s). Previous all-parallel approach
    // hit 28/33 rate-limit failures.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const BATCH_SIZE = 4;
    const queue = eligible.filter(s => !alreadySent.has(s.email));
    const results = eligible
      .filter(s => alreadySent.has(s.email))
      .map(s => ({ email: s.email, sent: false, reason: 'already sent in earlier run' }));

    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (sub) => {
        try {
          const html = config.build(sub);
          const r = await sendEmail({
            to: sub.email,
            subject: config.subject,
            html,
            fromName: config.fromName,
          });
          if (r.sent) {
            const entry = JSON.stringify({
              email: sub.email,
              campaign: campaignId,
              ts: new Date().toISOString(),
              messageId: r.messageId,
            });
            await redis.lpush('email:broadcast-log', entry).catch(() => {});
            return { email: sub.email, sent: true, messageId: r.messageId };
          }
          return { email: sub.email, sent: false, reason: r.reason };
        } catch (err) {
          return { email: sub.email, sent: false, reason: err.message };
        }
      }));
      results.push(...batchResults);
      // Don't sleep after the last batch
      if (i + BATCH_SIZE < queue.length) await sleep(1100);
    }
    await redis.ltrim('email:broadcast-log', 0, 499).catch(() => {});
    const sent = results.filter(r => r.sent);
    const failed = results.filter(r => !r.sent);
    const skipped = subs.length - eligible.length;

    return res.status(200).json({
      ok: true,
      mode: 'send',
      campaign: campaignId,
      total: subs.length,
      eligible: eligible.length,
      sent: sent.length,
      failed: failed.length,
      skipped,
      failures: failed.length > 0 ? failed : undefined,
    });
  }

  // ─── STATS (default) ───
  // GET without mode returns basic info
  const redis = await getStore();
  const subCount = redis ? await redis.scard('subscribers:emails').catch(() => 0) : 0;
  return res.status(200).json({
    campaign: campaignId,
    subject: config.subject,
    fromName: config.fromName,
    validFrom: config.validFrom,
    validUntil: config.validUntil,
    subscribers: subCount,
    modes: {
      preview: `GET /api/broadcast?token=${token}&campaign=${campaignId}&mode=preview&city=munich`,
      send: `POST /api/broadcast?token=${token}&campaign=${campaignId}&mode=send&confirm=true`,
    },
  });
}
