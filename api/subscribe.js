// Vercel Serverless — Movacamper Email Alert Subscription
// Persistent storage via Redis (Vercel Storage)
// Now with welcome emails and unsubscribe

import { sendEmail, buildWelcomeEmail, buildNonEUWelcomeEmail, isNonEU, verifyUnsubToken, verifyPrefsToken, getPrefsUrl } from './email.js';
import { logEvent } from './lib/history.js';

let store = null;
let storeType = 'none';

async function getStore() {
  if (store) return store;

  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      storeType = 'upstash-rest';
      return store;
    } catch (e) { console.warn('Upstash REST init failed:', e.message); }
  }

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      store = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      storeType = 'upstash-rest-alt';
      return store;
    } catch (e) { console.warn('Upstash REST alt init failed:', e.message); }
  }

  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      store = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true });
      await store.connect();
      storeType = 'ioredis';
      return store;
    } catch (e) { console.warn('ioredis init failed:', e.message); }
  }

  return null;
}

// ── Unsubscribe page HTML ──
function unsubPage(success, email, source) {
  const brand = source === 'relocamp' ? 'Relocamp' : 'Movacamper';
  const site = source === 'relocamp' ? 'relocamp.nl' : 'movacamper.com';
  const message = success
    ? `<h2>You've been unsubscribed</h2><p><strong>${email}</strong> has been removed from our deal alerts.</p><p>Changed your mind? You can always sign up again at <a href="https://${site}">${site}</a></p><p style="margin-top:24px;font-size:32px">👋</p>`
    : `<h2>Oops, something went wrong</h2><p>We couldn't process your unsubscribe request. The link may have expired.</p><p>You can email <a href="mailto:frank@movacamper.com">frank@movacamper.com</a> and we'll sort it out.</p>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand} — Unsubscribe</title>
<style>body{margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{max-width:440px;background:#fff;border-radius:12px;padding:40px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
h2{color:#1f2937;margin:0 0 12px} p{color:#6b7280;line-height:1.6} a{color:#2d6a4f}</style>
</head><body><div class="card">${message}</div></body></html>`;
}

// ── Preferences page HTML ──
function prefsPage(sub, error, success) {
  const brand = sub?.source === 'relocamp' ? 'Relocamp' : 'Movacamper';
  const accentColor = sub?.source === 'relocamp' ? '#c4704b' : '#2d6a4f';

  let body;
  if (error) {
    body = `<h2>Oops</h2><p>${error}</p><p><a href="mailto:frank@movacamper.com">Contact us</a> if you need help.</p>`;
  } else if (success) {
    body = `<h2>Preferences updated! ✅</h2>
<p>We'll look for deals${sub.city && sub.city !== 'any' ? ` from <strong>${sub.city}</strong>` : ' across Europe'}${sub.date ? ` around <strong>${sub.date}</strong>` : ''}.</p>
<p>You'll hear from us when something matches.</p>
<p style="margin-top:24px;font-size:32px">🚐</p>`;
  } else {
    body = `<h2>Update your deal alert preferences</h2>
<form method="POST" style="text-align:left;margin-top:20px">
  <label style="display:block;margin-bottom:16px">
    <span style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px">Departure city</span>
    <input name="city" type="text" value="${(sub.city === 'any' ? '' : sub.city || '')}" placeholder="e.g. Munich, Amsterdam..." style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:15px;box-sizing:border-box">
    <span style="font-size:12px;color:#9ca3af">Leave empty for deals across all of Europe</span>
  </label>
  <label style="display:block;margin-bottom:16px">
    <span style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px">Preferred travel date</span>
    <input name="date" type="date" value="${sub.date || ''}" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:15px;box-sizing:border-box">
    <span style="font-size:12px;color:#9ca3af">Optional — helps us match deals to your schedule</span>
  </label>
  <label style="display:block;margin-bottom:20px">
    <span style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px">Flexibility</span>
    <select name="flexibility" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:15px;box-sizing:border-box">
      <option value="3"${sub.flexibility == 3 ? ' selected' : ''}>± 3 days</option>
      <option value="7"${sub.flexibility == 7 || !sub.flexibility ? ' selected' : ''}>± 1 week</option>
      <option value="14"${sub.flexibility == 14 ? ' selected' : ''}>± 2 weeks</option>
      <option value="30"${sub.flexibility == 30 ? ' selected' : ''}>± 1 month</option>
    </select>
  </label>
  <button type="submit" style="width:100%;padding:12px;background:${accentColor};color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer">Save preferences</button>
</form>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand} — Preferences</title>
<style>body{margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{max-width:440px;width:100%;background:#fff;border-radius:12px;padding:40px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
h2{color:#1f2937;margin:0 0 12px} p{color:#6b7280;line-height:1.6} a{color:${accentColor}}
input:focus,select:focus{outline:none;border-color:${accentColor};box-shadow:0 0 0 2px ${accentColor}22}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getStore();

  // ── Unsubscribe Handler ──
  if (req.query.action === 'unsub') {
    const email = (req.query.email || '').toLowerCase().trim();
    const token = req.query.token || '';

    if (!email || !verifyUnsubToken(email, token)) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(unsubPage(false));
    }

    let subSource = 'movacamper';
    if (redis) {
      try {
        const raw = await redis.get(`sub:${email}`);
        if (raw) {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data.source) subSource = data.source;
        }
        await redis.srem('subscribers:emails', email);
        await redis.del(`sub:${email}`);
        console.log('Unsubscribed:', email);
      } catch (err) {
        console.error('Unsub Redis error:', err.message);
      }
    }

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(unsubPage(true, email, subSource));
  }

  // ── Preferences Page (GET = form, POST = update) ──
  if (req.query.action === 'preferences') {
    const email = (req.query.email || '').toLowerCase().trim();
    const token = req.query.token || '';

    if (!email || !verifyPrefsToken(email, token)) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(prefsPage(null, 'Invalid or expired link. Please use the link from your latest email.'));
    }

    // GET: show preferences form
    if (req.method === 'GET') {
      let sub = null;
      if (redis) {
        try {
          const raw = await redis.get(`sub:${email}`);
          if (raw) sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) { /* ok */ }
      }
      if (!sub) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(404).send(prefsPage(null, 'Subscription not found. You may have already unsubscribed.'));
      }
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(prefsPage(sub));
    }

    // POST: update preferences
    if (req.method === 'POST') {
      const { city: newCity, date: newDate, flexibility: newFlex } = req.body || {};
      if (!redis) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(500).send(prefsPage(null, 'Service temporarily unavailable.'));
      }

      try {
        const raw = await redis.get(`sub:${email}`);
        if (!raw) {
          res.setHeader('Content-Type', 'text/html');
          return res.status(404).send(prefsPage(null, 'Subscription not found.'));
        }
        const sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const oldCity = sub.city;
        const oldDate = sub.date;

        // Update fields
        if (newCity !== undefined) sub.city = newCity.trim() || 'any';
        if (newDate !== undefined) sub.date = newDate || null;
        if (newFlex !== undefined) sub.flexibility = parseInt(newFlex) || 7;

        await redis.set(`sub:${email}`, JSON.stringify(sub));

        // Log history
        await logEvent(redis, email, 'preferences-updated', {
          oldCity, newCity: sub.city, oldDate, newDate: sub.date, flexibility: sub.flexibility,
        });

        // Notify Frank
        try {
          await fetch('https://ntfy.sh/movacamper-subs-x7k', {
            method: 'POST',
            headers: { 'Title': 'Subscriber updated preferences', 'Tags': 'pencil' },
            body: `${email}: ${oldCity} → ${sub.city}${sub.date ? `, date: ${sub.date}` : ''}`,
          });
        } catch (e) { /* best-effort */ }

        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(prefsPage(sub, null, true));
      } catch (err) {
        console.error('Preferences update error:', err.message);
        res.setHeader('Content-Type', 'text/html');
        return res.status(500).send(prefsPage(null, 'Something went wrong. Please try again.'));
      }
    }
  }

  // ── GET: return subscriber count ──
  if (req.method === 'GET') {
    if (!redis) {
      return res.status(200).json({
        count: 0, storage: 'none', message: 'Redis not configured',
        debug: {
          hasKvUrl: !!process.env.KV_REST_API_URL,
          hasKvToken: !!process.env.KV_REST_API_TOKEN,
          hasUpstashUrl: !!process.env.UPSTASH_REDIS_REST_URL,
          hasUpstashToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
          hasRedisUrl: !!process.env.REDIS_URL,
        }
      });
    }
    try {
      const count = await redis.scard('subscribers:emails') || 0;
      return res.status(200).json({ count, storage: storeType });
    } catch (err) {
      return res.status(200).json({ count: 0, storage: 'error', type: storeType, detail: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Rate limiting: max 5 subscriptions per IP per hour ──
  const clientIP = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();
  if (redis && clientIP !== 'unknown') {
    try {
      const rateKey = `ratelimit:sub:${clientIP}`;
      const attempts = await redis.incr(rateKey);
      if (attempts === 1) await redis.expire(rateKey, 3600); // 1 hour window
      if (attempts > 5) {
        console.warn(`Rate limited: ${clientIP} (${attempts} attempts)`);
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
    } catch (e) { /* rate limit is best-effort, don't block if Redis fails */ }
  }

  // ── POST: new subscription ──
  const { email, city, date, flexibility, source } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const subSource = source === 'relocamp' ? 'relocamp' : 'movacamper';
  const subscription = {
    email: normalizedEmail,
    city: city || 'any',
    date: date || null,
    flexibility: flexibility || 7,
    created: new Date().toISOString(),
    source: subSource,
    status: 'active',
    emailCount: 0,
    lastEmailed: null,
  };

  console.log('NEW SUBSCRIBER:', JSON.stringify(subscription));

  // Push notification to Frank via ntfy.sh
  const brandName = subSource === 'relocamp' ? 'Relocamp' : 'Movacamper';
  try {
    await fetch('https://ntfy.sh/movacamper-subs-x7k', {
      method: 'POST',
      headers: { 'Title': `New ${brandName} subscriber!`, 'Tags': 'envelope' },
      body: `${normalizedEmail} subscribed on ${brandName} (city: ${city || 'any'})`,
    });
  } catch (e) { /* notification is best-effort */ }

  if (redis) {
    try {
      await redis.set(`sub:${normalizedEmail}`, JSON.stringify(subscription));
      await redis.sadd('subscribers:emails', normalizedEmail);
      await logEvent(redis, normalizedEmail, 'subscribed', { city: subscription.city, source: subSource });
      console.log(`Stored in ${storeType}:`, normalizedEmail);
    } catch (err) {
      console.error('Redis store error:', err.message);
    }
  }

  // ── Send Welcome Email (async, don't block response) ──
  const cityNonEU = isNonEU(city);
  const welcomeEmail = cityNonEU
    ? buildNonEUWelcomeEmail(subscription)
    : buildWelcomeEmail(subscription);

  // Override branding for Relocamp subscribers
  if (subSource === 'relocamp') {
    welcomeEmail.fromName = 'Relocamp';
  }

  // Fire and forget — don't slow down the subscribe response
  sendEmail(welcomeEmail).then(result => {
    console.log('Welcome email result:', result);
    // Log the sent email in Redis
    if (redis && result.sent) {
      const logEntry = {
        to: normalizedEmail,
        subject: welcomeEmail.subject,
        type: cityNonEU ? 'welcome-non-eu' : 'welcome',
        sentAt: new Date().toISOString(),
      };
      redis.lpush('email:sent-log', JSON.stringify(logEntry)).catch(() => {});
      redis.ltrim('email:sent-log', 0, 499).catch(() => {}); // keep last 500
    }
  }).catch(err => console.error('Welcome email failed:', err.message));

  return res.status(200).json({
    success: true,
    message: "Subscribed! We'll email you when matching deals appear.",
  });
}
