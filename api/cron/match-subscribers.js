// Vercel Cron — Daily Subscriber Deal Matcher
// Runs at 08:00 UTC daily. Matches subscribers to live Imoova deals.
// ALL matches create DRAFTS — Frank reviews and approves in the dashboard.
// Nothing is auto-sent.

import { buildDealAlertEmail, buildDigestEmail, buildNonEUWelcomeEmail, isNonEU, getUnsubUrl } from '../email.js';

const IMOOVA_EU_URL = 'https://www.imoova.com/en/relocations?region=EU';

const CITY_SLUGS = {
  'munchen': 'munich', 'münchen': 'munich', 'muenchen': 'munich',
  'wien': 'vienna', 'wenen': 'vienna',
  'lissabon': 'lisbon', 'lisboa': 'lisbon',
  'kopenhagen': 'copenhagen', 'københavn': 'copenhagen',
  'brussel': 'brussels', 'bruxelles': 'brussels',
  'mailand': 'milan', 'milano': 'milan',
  'rom': 'rome', 'roma': 'rome',
  'prag': 'prague', 'praha': 'prague',
  'gütersloh': 'gutersloh',
};

const HUB_CITIES = ['munich', 'berlin', 'hamburg', 'frankfurt', 'lisbon', 'porto', 'barcelona', 'london', 'amsterdam', 'paris'];

function normalizeCitySlug(city) {
  const normalized = city.toLowerCase().trim().replace(/\s+/g, '-');
  return CITY_SLUGS[normalized] || CITY_SLUGS[normalized.replace(/-/g, ' ')] || normalized;
}

// ── Fetch Imoova deals for a city ──
async function fetchImoovaDeals(city) {
  const slug = normalizeCitySlug(city);
  const url = `https://www.imoova.com/en/relocations?region=EU&departure_city=${encodeURIComponent(slug)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return [];
    const html = await resp.text();

    // Parse SSR data
    const deals = [];
    const refs = [...html.matchAll(/reference:"(RLC\d+)",created_at:"[^"]*",name:"([^"]+)"/g)];
    const dates = [...html.matchAll(/available_from_date:"(\d{4}-\d{2}-\d{2})",available_to_date:"(\d{4}-\d{2}-\d{2})"/g)];
    const rates = [...html.matchAll(/,hire_unit_rate:(\d+)/g)];
    const vehicles = [...html.matchAll(/seatbelts:(\d+),sleeps:[^,]*,transmission:"(\w+)"/g)];

    const urlMap = {};
    const urlRegex = /href="\/en\/relocations\/deal\/([^"]+)"/g;
    let um;
    while ((um = urlRegex.exec(html)) !== null) {
      const s = um[1];
      const refMatch = s.match(/(RLC\d+)$/);
      if (refMatch) urlMap[refMatch[1]] = 'https://www.imoova.com/en/relocations/deal/' + s;
    }

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i][1];
      const name = refs[i][2];
      const routeMatch = name.match(/^(.+?)\s+to\s+(.+)$/i);
      if (!routeMatch) continue;

      const fromDate = dates[i] ? dates[i][1] : null;
      const toDate = dates[i] ? dates[i][2] : null;
      const rate = rates[i] ? parseInt(rates[i][1]) : 100;
      const seats = vehicles[i] ? parseInt(vehicles[i][1]) : 0;
      const trans = vehicles[i] ? vehicles[i][2] : 'Unknown';

      deals.push({
        vehicle: 'Campervan',
        from: routeMatch[1].trim(),
        to: routeMatch[2].trim(),
        seats,
        transmission: trans.charAt(0).toUpperCase() + trans.slice(1).toLowerCase(),
        price: '€' + (rate / 100).toFixed(2) + '/night',
        date_range: fromDate && toDate ? formatDateRange(fromDate, toDate) : 'Flexible dates',
        date_start: fromDate,
        date_end: toDate,
        url: urlMap[ref] || IMOOVA_EU_URL,
        provider: 'Imoova',
      });
    }

    // Fallback: deal pattern parsing
    if (deals.length === 0) {
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const dealPattern = /([\w][\w\s]*?)\s+available for one-way rental from\s+([A-Za-zÀ-ÿ\s\-\.]+?)\s+to\s+([A-Za-zÀ-ÿ\s\-\.]+?)\.\s*Flexible relocation with\s+(\d+)\s+seats?,\s*(Automatic|Manual)\s+transmission\.\s*Starting\s+([€$£][\d.]+)\s+per\s+(?:night|day)/gi;
      let match;
      while ((match = dealPattern.exec(text)) !== null) {
        deals.push({
          vehicle: match[1].trim(),
          from: match[2].trim(),
          to: match[3].trim(),
          seats: parseInt(match[4]),
          transmission: match[5],
          price: match[6] + '/day',
          date_range: 'Flexible dates',
          url: IMOOVA_EU_URL,
          provider: 'Imoova',
        });
      }
    }

    return deals;
  } catch (err) {
    console.error(`Imoova fetch error for ${city}:`, err.message);
    return [];
  }
}

function formatDateRange(fromStr, toStr) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  try {
    const f = new Date(fromStr + 'T00:00:00Z');
    const t = new Date(toStr + 'T00:00:00Z');
    if (isNaN(f) || isNaN(t)) return 'unknown';
    return `${f.getUTCDate()} ${MONTHS[f.getUTCMonth()]} - ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
  } catch (e) { return 'unknown'; }
}

// ── Match deals to subscriber preferences ──
function matchDeals(deals, subscriber) {
  const { city, date, flexibility } = subscriber;
  const subCity = normalizeCitySlug(city);

  return deals.filter(deal => {
    const dealFrom = deal.from.toLowerCase().replace(/\s+/g, '-');
    if (dealFrom !== subCity && !dealFrom.includes(subCity) && !subCity.includes(dealFrom)) {
      return false;
    }
    if (date && deal.date_start) {
      const subDate = new Date(date);
      const dealStart = new Date(deal.date_start);
      const dealEnd = deal.date_end ? new Date(deal.date_end) : dealStart;
      const flex = (flexibility || 7) * 24 * 60 * 60 * 1000;
      if (dealEnd.getTime() < subDate.getTime() - flex) return false;
      if (dealStart.getTime() > subDate.getTime() + flex) return false;
    }
    return true;
  });
}

// ── Redis helper ──
async function getRedis() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
  return null;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const token = req.query.token;
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isDashboard = token === 'mc-dash-9xK7qW3p';

  if (!isVercelCron && !isDashboard) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const redis = await getRedis();
  if (!redis) return res.status(200).json({ ok: false, reason: 'no redis' });

  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const results = { drafts: 0, skipped: 0, errors: 0, details: [] };

  try {
    const emails = await redis.smembers('subscribers:emails');
    if (!emails || emails.length === 0) {
      return res.status(200).json({ ok: true, message: 'No subscribers', results });
    }

    const pipe = redis.pipeline();
    for (const email of emails) pipe.get(`sub:${email}`);
    const rawResults = await pipe.exec();
    const subResults = rawResults.map(r => Array.isArray(r) ? r[1] : r);

    const subscribers = [];
    for (let i = 0; i < emails.length; i++) {
      try {
        const data = typeof subResults[i] === 'string' ? JSON.parse(subResults[i]) : subResults[i];
        if (data && data.status !== 'unsubscribed') subscribers.push(data);
      } catch (e) { /* skip broken records */ }
    }

    const dealCache = new Map();

    for (const sub of subscribers) {
      try {
        // Skip if draft already exists for this subscriber
        const existingDraft = await redis.get(`draft:${sub.email}`);
        if (existingDraft) {
          results.skipped++;
          results.details.push({ email: sub.email, reason: 'draft already pending' });
          continue;
        }

        // Anti-spam: don't create draft if emailed within last 7 days
        if (sub.lastEmailed) {
          const lastEmailed = new Date(sub.lastEmailed);
          const daysSince = (now - lastEmailed) / (1000 * 60 * 60 * 24);
          if (daysSince < 7) {
            results.skipped++;
            results.details.push({ email: sub.email, reason: `emailed ${Math.floor(daysSince)}d ago` });
            continue;
          }
        }

        const hasCity = sub.city && sub.city !== 'any';

        // ── Non-EU subscribers: draft with non-EU message ──
        if (hasCity && isNonEU(sub.city)) {
          const emailData = buildNonEUWelcomeEmail(sub);
          const draft = {
            to: sub.email,
            subject: emailData.subject,
            html: emailData.html,
            type: 'non-eu',
            city: sub.city,
            deals: [],
            created: now.toISOString(),
            status: 'draft',
          };
          await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
          await redis.sadd('email:drafts', sub.email);
          results.drafts++;
          results.details.push({ email: sub.email, action: 'draft created (non-EU)' });
          continue;
        }

        // ── Specific subscribers: match deals → create draft ──
        if (hasCity) {
          const citySlug = normalizeCitySlug(sub.city);
          if (!dealCache.has(citySlug)) {
            dealCache.set(citySlug, await fetchImoovaDeals(sub.city));
          }
          const deals = dealCache.get(citySlug);
          const matches = matchDeals(deals, sub);

          if (matches.length > 0) {
            const emailData = buildDealAlertEmail(sub, matches);
            const draft = {
              to: sub.email,
              subject: emailData.subject,
              html: emailData.html,
              type: 'deal-alert',
              city: sub.city,
              deals: matches.slice(0, 5).map(d => ({ from: d.from, to: d.to, price: d.price, date_range: d.date_range })),
              matchCount: matches.length,
              created: now.toISOString(),
              status: 'draft',
            };
            await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
            await redis.sadd('email:drafts', sub.email);
            results.drafts++;
            results.details.push({ email: sub.email, action: `draft created: ${matches.length} deals from ${sub.city}` });
          } else {
            results.skipped++;
            results.details.push({ email: sub.email, reason: 'no matching deals' });
          }
          continue;
        }

        // ── Generic subscribers: weekly digest draft (Mondays only) ──
        if (!hasCity && isMonday) {
          let allDeals = [];
          const cityCounts = {};
          for (const hub of HUB_CITIES.slice(0, 5)) {
            if (!dealCache.has(hub)) {
              dealCache.set(hub, await fetchImoovaDeals(hub));
            }
            const hubDeals = dealCache.get(hub);
            allDeals.push(...hubDeals);
            if (hubDeals.length > 0) cityCounts[hub] = hubDeals.length;
          }

          const seen = new Set();
          const uniqueDeals = allDeals.filter(d => {
            const key = `${d.from}-${d.to}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          if (uniqueDeals.length > 0) {
            const topCity = Object.entries(cityCounts).sort((a, b) => b[1] - a[1])[0];
            const emailData = buildDigestEmail(sub, uniqueDeals.slice(0, 5), {
              totalDeals: uniqueDeals.length,
              topCity: topCity ? topCity[0].charAt(0).toUpperCase() + topCity[0].slice(1) : null,
              topCityCount: topCity ? topCity[1] : 0,
            });
            const draft = {
              to: sub.email,
              subject: emailData.subject,
              html: emailData.html,
              type: 'weekly-digest',
              city: 'all',
              deals: uniqueDeals.slice(0, 5).map(d => ({ from: d.from, to: d.to, price: d.price, date_range: d.date_range })),
              matchCount: uniqueDeals.length,
              created: now.toISOString(),
              status: 'draft',
            };
            await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
            await redis.sadd('email:drafts', sub.email);
            results.drafts++;
            results.details.push({ email: sub.email, action: 'digest draft created' });
          } else {
            results.skipped++;
            results.details.push({ email: sub.email, reason: 'no deals for digest' });
          }
        } else if (!hasCity && !isMonday) {
          results.skipped++;
          results.details.push({ email: sub.email, reason: 'digest only on Mondays' });
        }

      } catch (err) {
        results.errors++;
        results.details.push({ email: sub.email, error: err.message });
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
