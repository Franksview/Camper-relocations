// Vercel Cron — Daily Subscriber Deal Matcher v3
// Runs at 08:00 UTC daily. Matches subscribers to live deals from ALL providers.
// AUTO-SENDS deal-alert and nearby-alert emails (max 2x/week, only when new deals).
// No-match emails remain as drafts for Frank to review.
// Auto-send log visible in dashboard via email:auto-sent-log Redis key.

const AUTO_SEND = true;           // flip to false to revert to draft-only mode
const MIN_DAYS_BETWEEN = 3.5;     // max 2 emails per week per subscriber
const AUTO_SEND_LOG_KEY = 'email:auto-sent-log';
const AUTO_SEND_LOG_MAX = 200;    // keep last 200 entries

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
  const dashToken = process.env.DASH_TOKEN;
  const isDashboard = !!dashToken && token === dashToken;

  if (!isVercelCron && !isDashboard) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const redis = await getRedis();
  if (!redis) return res.status(200).json({ ok: false, reason: 'no redis' });

  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const results = { sent: 0, drafts: 0, skipped: 0, errors: 0, details: [] };

  // ── Auto-send helper ──
  // Sends email directly if AUTO_SEND=true and deals are fresh.
  // Falls back to draft if send fails. Logs all auto-sends for dashboard.
  async function autoSendOrDraft(sub, emailData, draftPayload, dealFingerprints = []) {
    // Freshness check: skip if all current deals were already in the last email
    if (dealFingerprints.length > 0 && sub.lastSentDealIds && sub.lastSentDealIds.length > 0) {
      const newDeals = dealFingerprints.filter(f => !sub.lastSentDealIds.includes(f));
      if (newDeals.length === 0) {
        results.skipped++;
        results.details.push({ email: sub.email, reason: 'no new deals since last email' });
        return 'skipped';
      }
    }

    if (AUTO_SEND && draftPayload.type !== 'no-match' && draftPayload.type !== 'non-eu') {
      const sendResult = await sendEmail({
        to: sub.email,
        subject: emailData.subject,
        html: emailData.html,
        fromName: draftPayload.fromName,
      });

      if (sendResult.sent) {
        // Update subscriber record
        sub.lastEmailed = now.toISOString();
        sub.emailCount = (sub.emailCount || 0) + 1;
        if (dealFingerprints.length > 0) sub.lastSentDealIds = dealFingerprints;
        await redis.set(`sub:${sub.email}`, JSON.stringify(sub));
        // Log for dashboard
        await redis.lpush(AUTO_SEND_LOG_KEY, JSON.stringify({
          email: sub.email, city: sub.city || 'any',
          type: draftPayload.type, deals: draftPayload.deals?.length || 0,
          subject: emailData.subject, ts: now.toISOString(),
        }));
        await redis.ltrim(AUTO_SEND_LOG_KEY, 0, AUTO_SEND_LOG_MAX - 1);
        results.sent++;
        results.details.push({ email: sub.email, action: `auto-sent: ${draftPayload.type} (${draftPayload.deals?.length || 0} deals)` });
        return 'sent';
      }
      // Send failed — fall through to draft
    }

    // Store as draft (manual review)
    await redis.set(`draft:${sub.email}`, JSON.stringify(draftPayload));
    await redis.sadd('email:drafts', sub.email);
    results.drafts++;
    results.details.push({ email: sub.email, action: `draft: ${draftPayload.type}` });
    return 'draft';
  }

  const {
    buildDealAlertEmail, buildDigestEmail, buildNonEUWelcomeEmail,
    buildNearbyAlertEmail, buildNoMatchEmail, isNonEU, sendEmail,
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

          // Anti-spam: max 2 emails per week (3.5 day minimum gap).
          // Welcome email (emailCount===1) doesn't count toward throttle.
          if (sub.lastEmailed && (sub.emailCount || 0) > 1) {
            const daysSince = (now - new Date(sub.lastEmailed)) / (1000 * 60 * 60 * 24);
            if (daysSince < MIN_DAYS_BETWEEN) {
              results.skipped++;
              results.details.push({ email: sub.email, reason: `emailed ${Math.floor(daysSince)}d ago` });
              continue;
            }
          }

          const subSource = sub.source || 'movacamper';
          const brandName = subSource === 'relocamp' ? 'Relocamp' : 'Movacamper';

          // ── Non-EU subscribers ── (always draft, Frank decides)
          if (isNonEU(normalizeCitySlug(sub.city))) {
            const emailData = buildNonEUWelcomeEmail(sub);
            const draft = {
              to: sub.email, subject: emailData.subject, html: emailData.html,
              type: 'non-eu', city: sub.city, deals: [],
              created: now.toISOString(), status: 'draft',
              source: subSource, fromName: brandName,
            };
            await autoSendOrDraft(sub, emailData, draft);
            await logEvent(redis, sub.email, 'non-eu-drafted', { city: sub.city });
            continue;
          }

          // ── Scenario 1: Exact city match ──
          const matchedDeals = matchDealsToDate(exact, sub.date, sub.flexibility);
          if (matchedDeals.length > 0) {
            const emailData = buildDealAlertEmail(sub, matchedDeals);
            const dealFingerprints = matchedDeals.map(d => `${d.from}-${d.to}-${d.date_range}`);
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
            const outcome = await autoSendOrDraft(sub, emailData, draft, dealFingerprints);
            if (outcome !== 'skipped') {
              await logEvent(redis, sub.email, outcome === 'sent' ? 'deal-alert-sent' : 'deal-alert-drafted', {
                city: sub.city, matchCount: matchedDeals.length,
                providers: [...new Set(matchedDeals.map(d => d.provider || 'Imoova'))],
              });
            }
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
            const nearbyDeals = nearbyWithDateMatch.slice(0, 3).flatMap(g =>
              g.deals.slice(0, 2).map(d => ({
                from: d.from, to: d.to, price: d.price, date_range: d.date_range,
                nearbyCity: g.city, nearbyDistance: g.distance,
              }))
            );
            const dealFingerprints = nearbyDeals.map(d => `${d.from}-${d.to}-${d.date_range}`);
            const draft = {
              to: sub.email, subject: emailData.subject, html: emailData.html,
              type: 'nearby-alert', city: sub.city,
              deals: nearbyDeals,
              matchCount: totalNearby,
              created: now.toISOString(), status: 'draft',
              source: subSource, fromName: brandName,
            };
            const outcome = await autoSendOrDraft(sub, emailData, draft, dealFingerprints);
            if (outcome !== 'skipped') {
              await logEvent(redis, sub.email, outcome === 'sent' ? 'nearby-alert-sent' : 'nearby-alert-drafted', {
                city: sub.city, nearbyCities: nearbyWithDateMatch.map(g => `${g.city} (${g.distance}km)`),
                totalDeals: totalNearby,
              });
            }
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

          // No-match stays as draft — Frank decides whether to re-engage
          const emailData = buildNoMatchEmail(sub);
          const draft = {
            to: sub.email, subject: emailData.subject, html: emailData.html,
            type: 'no-match', city: sub.city, deals: [],
            created: now.toISOString(), status: 'draft',
            source: subSource, fromName: brandName,
          };
          await autoSendOrDraft(sub, emailData, draft);
          await logEvent(redis, sub.email, 'no-match-drafted', { city: sub.city });

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
          const dealFingerprints = uniqueDeals.slice(0, 5).map(d => `${d.from}-${d.to}-${d.date_range}`);
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
          const outcome = await autoSendOrDraft(sub, emailData, draft, dealFingerprints);
          if (outcome !== 'skipped') {
            await logEvent(redis, sub.email, outcome === 'sent' ? 'digest-sent' : 'digest-drafted', {
              totalDeals: uniqueDeals.length, intro: isFirstDigest,
            });
          }
          // Mark digestSent so we don't re-create intro drafts every cron run
          try {
            sub.digestSent = true;
            await redis.set(`sub:${sub.email}`, JSON.stringify(sub));
          } catch (e) { /* best-effort */ }
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
