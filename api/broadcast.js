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
};

// ─── HTML escape helper ───
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  const camperdaysUrl = `https://www.awin1.com/cread.php?awinmid=72498&awinaffid=1795498&ued=${ued}&clickref=${encodeURIComponent('bc-apr26-' + Buffer.from(email).toString('base64').slice(0, 8))}`;

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

// ─── Handler ───
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const token = req.query.token;
  const dashToken = process.env.DASH_TOKEN || 'mc-dash-9xK7qW3p';
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
    const eligible = subs.filter(s =>
      s && s.email && s.status !== 'unsubscribed' && !s.unsubscribed && !s.digestOptOut
    );

    // Parallel send with Promise.allSettled (respects Resend rate limits at 30 total)
    const sendPromises = eligible.map(async (sub) => {
      try {
        const html = config.build(sub);
        const r = await sendEmail({
          to: sub.email,
          subject: config.subject,
          html,
          fromName: config.fromName,
        });
        if (r.sent) {
          // Log broadcast send
          const entry = JSON.stringify({
            email: sub.email,
            campaign: campaignId,
            ts: new Date().toISOString(),
            messageId: r.messageId,
          });
          await redis.lpush('email:broadcast-log', entry).catch(() => {});
          return { email: sub.email, sent: true, messageId: r.messageId };
        } else {
          return { email: sub.email, sent: false, reason: r.reason };
        }
      } catch (err) {
        return { email: sub.email, sent: false, reason: err.message };
      }
    });

    const settled = await Promise.allSettled(sendPromises);
    await redis.ltrim('email:broadcast-log', 0, 499).catch(() => {});

    const results = settled.map(s => s.status === 'fulfilled' ? s.value : { sent: false, reason: s.reason?.message || 'promise rejected' });
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
