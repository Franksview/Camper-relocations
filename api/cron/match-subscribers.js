// Vercel Cron — Daily Subscriber Deal Matcher v2
// Runs at 08:00 UTC daily. Matches subscribers to live deals from ALL providers.
// Three scenarios: exact match, nearby match, no match.
// ALL matches create DRAFTS — Frank reviews and approves in the dashboard.

async function getEmailHelpers() {
  const mod = await import('../email.js');
  return mod;
}

async function getSearchCore() {
  const mod = await import('../lib/search-core.js');
  return mod;
}

async function getHistory() {
  const mod = await import('../lib/history.js');
  return mod;
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
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      const client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true,
      });
      await client.connect();
      return client;
    } catch (e) { /* fall through */ }
  }
  return null;
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const token = req.query.token;
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const dashToken = process.env.DASH_TOKEN || 'mc-dash-9xK7qW3p';
  const isDashboard = token === dashToken;

  if (!isVercelCron && !isDashboard) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const redis = await getRedis();
  if (!redis) return res.status(200).json({ ok: false, reason: 'no redis' });

  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const results = { drafts: 0, skipped: 0, errors: 0, details: [] };

  const {
    buildDealAlertEmail, buildDigestEmail, buildNonEUWelcomeEmail,
    buildNearbyAlertEmail, buildNoMatchEmail, isNonEU,
  } = await getEmailHelpers();

  const {
    normalizeCitySlug, fetchAllDealsForCity, matchDealsToDate,
    HUB_CITIES, fetchImoovaPage, parseImoovaHtml, capitalize,
  } = await getSearchCore();

  const { logEvent } = await getHistory();

  const apiKey = process.env.ANTHROPIC_API_KEY;

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

    // Group subscribers by normalized city slug (same city = one search)
    const cityGroups = new Map(); // slug → [subscriber, ...]
    const genericSubs = [];

    for (const sub of subscribers) {
      const hasCity = sub.city && sub.city !== 'any';
      if (hasCity) {
        const slug = normalizeCitySlug(sub.city);
        if (!cityGroups.has(slug)) cityGroups.set(slug, []);
        cityGroups.get(slug).push(sub);
      } else {
        genericSubs.push(sub);
      }
    }

    // ── Process city-specific subscribers (grouped by city) ──
    const dealCache = new Map(); // slug → { exact, nearby }
    let cityGroupsProcessed = 0;

    // Pre-check which subscribers already have drafts, so we can skip entire city groups
    const existingDrafts = new Set();
    try {
      const draftEmails = await redis.smembers('email:drafts');
      if (draftEmails) draftEmails.forEach(e => existingDrafts.add(e));
    } catch (e) { /* best-effort */ }

    // Sort city groups: prioritize groups with subscribers who need drafts
    const sortedCityGroups = [...cityGroups.entries()].sort((a, b) => {
      const aNeedsDraft = a[1].some(s => !existingDrafts.has(s.email));
      const bNeedsDraft = b[1].some(s => !existingDrafts.has(s.email));
      if (aNeedsDraft && !bNeedsDraft) return -1;
      if (!aNeedsDraft && bNeedsDraft) return 1;
      return 0;
    });

    for (const [citySlug, subs] of sortedCityGroups) {
      // Skip entire city group if all subscribers already have pending drafts
      const needsDraft = subs.some(s => !existingDrafts.has(s.email));
      if (!needsDraft) {
        for (const sub of subs) {
          results.skipped++;
          results.details.push({ email: sub.email, reason: 'draft already pending' });
        }
        continue; // Does NOT count toward batch limit
      }

      // Timeout safety: max 15 city groups per cron run
      if (cityGroupsProcessed >= 15) {
        for (const sub of subs) {
          results.skipped++;
          results.details.push({ email: sub.email, reason: 'deferred (batch limit)' });
        }
        continue;
      }

      // Fetch deals for this city (all providers + nearby) — cached per city
      if (!dealCache.has(citySlug)) {
        try {
          const cityResult = await fetchAllDealsForCity(citySlug, {
            radiusKm: 300,
            timeoutMs: 5000,
            apiKey: apiKey || null,
          });
          dealCache.set(citySlug, cityResult);
        } catch (e) {
          console.error(`Deal fetch error for ${citySlug}:`, e.message);
          // Do NOT silently proceed — flag every subscriber in this group as an error
          // so they are retried next cron run rather than receiving a false no-match draft.
          for (const sub of subs) {
            results.errors++;
            results.details.push({ email: sub.email, reason: 'deal fetch error', city: citySlug, error: e.message });
          }
          cityGroupsProcessed++;
          continue; // skip to next city group
        }
      }
      cityGroupsProcessed++;

      const { exact, nearby } = dealCache.get(citySlug);

      // Process each subscriber in this city group
      for (const sub of subs) {
        try {
          // Skip if draft already exists (use pre-fetched set, fallback to Redis)
          if (existingDrafts.has(sub.email)) {
            results.skipped++;
            results.details.push({ email: sub.email, reason: 'draft already pending' });
            continue;
          }

          // Anti-spam: don't create draft if emailed within last 7 days
          // BUT welcome email (emailCount===1) doesn't count — new subs are most engaged,
          // drafts are hand-reviewed, so 7-day dead zone post-welcome was blocking matches.
          if (sub.lastEmailed && (sub.emailCount || 0) > 1) {
            const daysSince = (now - new Date(sub.lastEmailed)) / (1000 * 60 * 60 * 24);
            if (daysSince < 7) {
              results.skipped++;
              results.details.push({ email: sub.email, reason: `emailed ${Math.floor(daysSince)}d ago` });
              continue;
            }
          }

          const subSource = sub.source || 'movacamper';
          const brandName = subSource === 'relocamp' ? 'Relocamp' : 'Movacamper';

          // ── Non-EU subscribers ──
          // Use normalized slug so alias cities (e.g. "Lisboa") are recognized as EU
          if (isNonEU(normalizeCitySlug(sub.city))) {
            const emailData = buildNonEUWelcomeEmail(sub);
            const draft = {
              to: sub.email, subject: emailData.subject, html: emailData.html,
              type: 'non-eu', city: sub.city, deals: [],
              created: now.toISOString(), status: 'draft',
              source: subSource, fromName: brandName,
            };
            await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
            await redis.sadd('email:drafts', sub.email);
            await logEvent(redis, sub.email, 'non-eu-drafted', { city: sub.city });
            results.drafts++;
            results.details.push({ email: sub.email, action: 'draft created (non-EU)' });
            continue;
          }

          // ── Scenario 1: Exact city match ──
          const matchedDeals = matchDealsToDate(exact, sub.date, sub.flexibility);
          if (matchedDeals.length > 0) {
            const emailData = buildDealAlertEmail(sub, matchedDeals);
            const draft = {
              to: sub.email, subject: emailData.subject, html: emailData.html,
              type: 'deal-alert', city: sub.city,
              deals: matchedDeals.slice(0, 5).map(d => ({
                from: d.from, to: d.to, price: d.price, date_range: d.date_range, provider: d.provider || 'Imoova',
              })),
              matchCount: matchedDeals.length,
              created: now.toISOString(), status: 'draft',
              source: subSource, fromName: brandName,
            };
            await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
            await redis.sadd('email:drafts', sub.email);
            await logEvent(redis, sub.email, 'deal-alert-drafted', {
              city: sub.city, matchCount: matchedDeals.length,
              providers: [...new Set(matchedDeals.map(d => d.provider || 'Imoova'))],
            });
            results.drafts++;
            results.details.push({ email: sub.email, action: `draft: ${matchedDeals.length} deals from ${sub.city}` });
            continue;
          }

          // ── Scenario 2: Nearby city match ──
          // Filter nearby deals by subscriber's date preference
          const nearbyWithDateMatch = nearby
            .map(group => ({
              ...group,
              deals: matchDealsToDate(group.deals, sub.date, sub.flexibility),
            }))
            .filter(group => group.deals.length > 0);

          if (nearbyWithDateMatch.length > 0) {
            const emailData = buildNearbyAlertEmail(sub, nearbyWithDateMatch);
            const totalNearby = nearbyWithDateMatch.reduce((s, g) => s + g.deals.length, 0);
            const draft = {
              to: sub.email, subject: emailData.subject, html: emailData.html,
              type: 'nearby-alert', city: sub.city,
              deals: nearbyWithDateMatch.slice(0, 3).flatMap(g =>
                g.deals.slice(0, 2).map(d => ({
                  from: d.from, to: d.to, price: d.price, date_range: d.date_range,
                  nearbyCity: g.city, nearbyDistance: g.distance,
                }))
              ),
              matchCount: totalNearby,
              created: now.toISOString(), status: 'draft',
              source: subSource, fromName: brandName,
            };
            await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
            await redis.sadd('email:drafts', sub.email);
            await logEvent(redis, sub.email, 'nearby-alert-drafted', {
              city: sub.city, nearbyCities: nearbyWithDateMatch.map(g => `${g.city} (${g.distance}km)`),
              totalDeals: totalNearby,
            });
            results.drafts++;
            results.details.push({ email: sub.email, action: `draft: nearby deals (${nearbyWithDateMatch.map(g => g.city).join(', ')})` });
            continue;
          }

          // ── Scenario 3: No match anywhere ──
          // Throttle: max 1 no-match email per 14 days
          if (sub.lastNoMatchSent) {
            const daysSinceNoMatch = (now - new Date(sub.lastNoMatchSent)) / (1000 * 60 * 60 * 24);
            if (daysSinceNoMatch < 14) {
              results.skipped++;
              results.details.push({ email: sub.email, reason: `no-match sent ${Math.floor(daysSinceNoMatch)}d ago` });
              continue;
            }
          }

          const emailData = buildNoMatchEmail(sub);
          const draft = {
            to: sub.email, subject: emailData.subject, html: emailData.html,
            type: 'no-match', city: sub.city, deals: [],
            created: now.toISOString(), status: 'draft',
            source: subSource, fromName: brandName,
          };
          await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
          await redis.sadd('email:drafts', sub.email);
          await logEvent(redis, sub.email, 'no-match-drafted', { city: sub.city });
          results.drafts++;
          results.details.push({ email: sub.email, action: 'draft: no match (watching)' });

        } catch (err) {
          results.errors++;
          results.details.push({ email: sub.email, error: err.message });
        }
      }
    }

    // ── Generic subscribers: weekly digest (Mondays), BUT new subs get an intro digest on any day ──
    for (const sub of genericSubs) {
      try {
        const isFirstDigest = !sub.digestSent;
        // Skip non-Monday runs only for subs that already received their intro digest
        if (!isMonday && !isFirstDigest) {
          results.skipped++;
          results.details.push({ email: sub.email, reason: 'digest only on Mondays' });
          continue;
        }

        const existingDraft = await redis.get(`draft:${sub.email}`);
        if (existingDraft) {
          results.skipped++;
          results.details.push({ email: sub.email, reason: 'draft already pending' });
          continue;
        }

        // Same welcome-exception for generic/digest subs
        if (sub.lastEmailed && (sub.emailCount || 0) > 1) {
          const daysSince = (now - new Date(sub.lastEmailed)) / (1000 * 60 * 60 * 24);
          if (daysSince < 7) {
            results.skipped++;
            results.details.push({ email: sub.email, reason: `emailed ${Math.floor(daysSince)}d ago` });
            continue;
          }
        }

        const subSource = sub.source || 'movacamper';
        const brandName = subSource === 'relocamp' ? 'Relocamp' : 'Movacamper';

        let allDeals = [];
        const cityCounts = {};
        for (const hub of HUB_CITIES.slice(0, 5)) {
          if (!dealCache.has(hub)) {
            try {
              const { exact } = await fetchAllDealsForCity(hub, { radiusKm: 0, timeoutMs: 5000 });
              dealCache.set(hub, { exact, nearby: [] });
            } catch (e) {
              dealCache.set(hub, { exact: [], nearby: [] });
            }
          }
          const hubDeals = dealCache.get(hub).exact || [];
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
            topCity: topCity ? capitalize(topCity[0]) : null,
            topCityCount: topCity ? topCity[1] : 0,
          });
          const draft = {
            to: sub.email, subject: emailData.subject, html: emailData.html,
            type: 'weekly-digest', city: 'all',
            deals: uniqueDeals.slice(0, 5).map(d => ({
              from: d.from, to: d.to, price: d.price, date_range: d.date_range,
            })),
            matchCount: uniqueDeals.length,
            created: now.toISOString(), status: 'draft',
            source: subSource, fromName: brandName,
          };
          await redis.set(`draft:${sub.email}`, JSON.stringify(draft));
          await redis.sadd('email:drafts', sub.email);
          await logEvent(redis, sub.email, 'digest-drafted', {
            totalDeals: uniqueDeals.length,
            intro: isFirstDigest,
          });
          // Mark digestSent so we don't re-create intro drafts every cron run
          try {
            sub.digestSent = true;
            await redis.set(`sub:${sub.email}`, JSON.stringify(sub));
          } catch (e) { /* best-effort */ }
          results.drafts++;
          results.details.push({
            email: sub.email,
            action: isFirstDigest ? 'intro digest draft created' : 'digest draft created',
          });
        } else {
          results.skipped++;
          results.details.push({ email: sub.email, reason: 'no deals for digest' });
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
