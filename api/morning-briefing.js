// api/morning-briefing.js
// Daily 8:30 AM briefing email — Movacamper + Relocamp
// Trigger: GET /api/morning-briefing?token=<DASH_TOKEN>
//
// Required env vars (all already set in your Vercel project):
//   RESEND_API_KEY      — your Resend API key
//   DASH_TOKEN     — auth token (required — no fallback, fails closed)
//   BRIEFING_FROM       — from address, e.g. briefing@movacamper.com (must be verified in Resend)
//   BRIEFING_TO         — recipient, defaults to snelders.f@gmail.com

const TOKEN    = process.env.DASH_TOKEN;
const FROM     = process.env.BRIEFING_FROM   || 'Movacamper Dashboard <frank@movacamper.com>';
const TO       = process.env.BRIEFING_TO     || 'snelders.f@gmail.com';
const BASE     = 'https://www.movacamper.com';

export default async function handler(req, res) {
  if (req.query.token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // ── 1. Fetch all data in parallel ────────────────────────────────────────
    // Inventory snapshot tells us whether the cron actually fired, independent
    // of whether any emails were sent. "0 sent" can happen for legitimate
    // reasons (thin Imoova pool, all subs throttled) — we shouldn't alert in
    // those cases. The snapshot is the honest "did cron run yesterday" signal.
    const [statsRes, subsRes, logRes, invRes] = await Promise.all([
      fetch(`${BASE}/api/stats?token=${TOKEN}&days=60`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=subscribers`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=auto-sent-log&limit=200`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=imoova-pool-history&days=2`),
    ]);

    if (!statsRes.ok || !subsRes.ok || !logRes.ok) {
      throw new Error(`API fetch failed: stats=${statsRes.status} subs=${subsRes.status} log=${logRes.status}`);
    }

    const [stats, subsData, logData] = await Promise.all([
      statsRes.json(), subsRes.json(), logRes.json(),
    ]);

    // ── 2. Delta calculations from timeseries ────────────────────────────────
    function sumKey(arr, key) {
      return arr.reduce((s, d) => s + (d[key] || 0), 0);
    }

    function pct(current, previous) {
      if (!previous || previous === 0) return null;
      return Math.round(((current - previous) / previous) * 100);
    }

    function deltas(timeseries, key) {
      const n = timeseries.length;
      if (n < 3) return { yesterday: 0, day: null, week: null, month: null };

      const yest      = timeseries[n - 2]?.[key] || 0;
      const dayBefore = timeseries[n - 3]?.[key] || 0;

      const slice  = (from, to) => timeseries.slice(Math.max(0, from), Math.max(0, to));
      const last7  = sumKey(slice(n - 8, n - 1), key);
      const prev7  = sumKey(slice(n - 15, n - 8), key);
      const last30 = sumKey(slice(n - 31, n - 1), key);
      const prev30 = sumKey(slice(n - 61, n - 31), key);

      return {
        yesterday: yest,
        day:   pct(yest, dayBefore),
        week:  pct(last7, prev7),
        month: pct(last30, prev30),
        last7,
        last30,
      };
    }

    const mcTs = stats.timeseries || [];
    const rcTs = (stats.relocamp && stats.relocamp.timeseries) || [];

    const mc = {
      visitors:   deltas(mcTs, 'visitors'),
      pageviews:  deltas(mcTs, 'pageviews'),
      subscribes: deltas(mcTs, 'subscribes'),
    };
    const rc = {
      visitors:  deltas(rcTs, 'visitors'),
      pageviews: deltas(rcTs, 'pageviews'),
    };

    // ── 3. Subscriber + email stats ──────────────────────────────────────────
    const subscribersTotal = subsData.total || 0;
    const allLogs = logData.log || [];

    const todayStr     = new Date().toISOString().slice(0, 10);
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const sentToday     = allLogs.filter(e => e.ts?.startsWith(todayStr)).length;
    const sentYesterday = allLogs.filter(e => e.ts?.startsWith(yesterdayStr)).length;

    // Did the cron actually run yesterday? Best signal = inventory snapshot
    // existence (cron writes one every run, even when 0 emails go out).
    // Fall back to "emails sent" as a weak positive signal.
    let yesterdayInventory = null;
    try {
      if (invRes && invRes.ok) {
        const invData = await invRes.json();
        const ydEntry = (invData.days || []).find(d => d.date === yesterdayStr);
        yesterdayInventory = ydEntry?.snapshot || null;
      }
    } catch { /* best-effort */ }
    const cronRanYesterday = !!yesterdayInventory || sentYesterday > 0;

    // ── 4. Rotating marketing tip — 5-section proposal format ──────────────
    // Each tip is a complete worked-out proposal, not a one-liner. Sections:
    //   what / how / hypothesis / risk / effort. Frank approves with ja/nee.
    const tips = [
      {
        // Sunday
        emoji: '📊', title: 'Weekly inventory review: prune dead HUB_CITIES',
        what: `Audit which HUB_CITIES actually saw deals in the last 7 days of inventory snapshots, and decide whether to swap inactive ones for current-trending origins (Florence, Stuttgart, Düsseldorf).`,
        how: `Read \`stats:imoova_pool\` for last 7 days, list origins per day, mark any HUB_CITY with 0 appearances. Edit HUB_CITIES in api/lib/search-core.js + add multilingual aliases in email.js. Update Relocamp city pages to match (already done for Florence/Stuttgart/Düsseldorf).`,
        hypothesis: `Cron pre-fetches 10 cities daily. Replacing dead hubs with trending ones raises cron-pool from 4-6 → 10-15 deals on the same daily fetch budget.`,
        risk: `Removing a hub kills future matches for subs in that city. Mitigation: keep all sub-cities (Amsterdam, Lisbon, Valencia, London, Paris, Munich, Berlin) regardless of inventory — only swap unused legacy hubs.`,
        effort: `30 min code + 30 min verify.`,
      },
      {
        // Monday
        emoji: '🔍', title: 'UTM-flavoured Imoova links per channel',
        what: `Separate Imoova-click attribution per channel: deal-alert email, weekly-digest, no-results fallback, organic search. Today all clicks land in the same Rewardful bucket (?via=relocamp) — no way to know which channel converts.`,
        how: `Wrap Imoova URL builder in a small helper \`buildImoovaUrl(deal, {source, medium})\` that appends \`?via=relocamp&utm_source=movacamper&utm_medium=<channel>\`. Update email.js (3 call sites), search.js card render, featured.js, no-results fallback. Rewardful preserves these as referral metadata.`,
        hypothesis: `Within 30 days we know whether email vs. organic clicks convert at different rates. If e.g. email = 3% / organic = 0.5%, double down on email cadence and cut affiliate spend elsewhere.`,
        risk: `Imoova or Rewardful strips unknown query params → tracking lost but link still works. Mitigation: keep \`?via=relocamp\` as the first param (already required for commission); UTMs come after.`,
        effort: `45 min code + 30 min curl verify all surfaces.`,
      },
      {
        // Tuesday
        emoji: '🤖', title: 'AI-search optimization (ChatGPT is 9% of MC traffic)',
        what: `ChatGPT, Perplexity and Claude.ai are already sending ~9% of Movacamper traffic. Optimize for AI crawlers so we're THE answer to "where can I find cheap campervan relocations" instead of one of many citations.`,
        how: `(1) Write a structured FAQ section on Movacamper home covering top AI-asked questions (how do relocations work, cost, requirements, top routes). (2) Add JSON-LD FAQPage schema. (3) Ensure robots.txt allows GPTBot, ClaudeBot, PerplexityBot. (4) Cross-link to Relocamp blog posts with anchor text matching long-tail queries.`,
        hypothesis: `AI-referral traffic doubles from ~9% to ~18% in 60 days. AI-clickers are higher-intent (they've already been recommended us by name) → expect 2-3× normal CTR on deal cards.`,
        risk: `AI crawlers may scrape and answer without citation — net loss. Mitigation: keep enough specificity (live deal counts, current routes) that the answer benefits from clicking through.`,
        effort: `~3h: 1h FAQ content, 30 min schema + robots, 30 min cross-links, 1h validate via ChatGPT manual test.`,
      },
      {
        // Wednesday
        emoji: '📧', title: 'Weekly cross-city digest to all 61 subs',
        what: `Right now subs only get mails for their own city. Most cities have 0 deals most days → 97% of searches give nothing. A weekly Wednesday digest of TOP 5 cross-EU deals reframes "nothing for you" into "here's what's hot anywhere".`,
        how: `New campaign \`weekly-digest-wed\` in api/broadcast.js. Pulls top 5 from \`/api/featured\`, builds an email card per deal with route + price + Book on Imoova CTA. Suppress for subs that opted into city-specific only. Schedule via Cowork task or Vercel cron.`,
        hypothesis: `+30 extra Imoova clicks per week from 50 engaged subs at ~5% click rate. At 1% Rewardful conversion = ~1 extra booking/month = +$40 AUD/month.`,
        risk: `Unsubscribe rate ↑ if subs find weekly mails too noisy. Mitigation: clear opt-out in footer + soft language ("ignore if not relevant").`,
        effort: `~1.5h: campaign template + scheduling. Reuses comeback-jun26 plumbing.`,
      },
      {
        // Thursday
        emoji: '⏰', title: 'Per-deal expiry countdown on deal cards',
        what: `Every Imoova deal has an \`available_to_date\`. Render a real countdown badge per card: "🔥 Expires in 2 days" (red), "Expires this week" (amber), "X days left" (subtle). Real urgency, no fake countdowns.`,
        how: `Calculate \`days_remaining = available_to_date - today\` in search.js (already in the deal object). Add to deal payload. In public/index.html renderDealCard: small badge above price block. Sort deals so most-urgent come first.`,
        hypothesis: `Per-deal urgency lifts CTR on result pages from ~5/page baseline to ~7/page. Most-urgent-first sort also drives bookings to the deals that genuinely need a driver fast = higher Imoova conversion.`,
        risk: `Sorting by urgency demotes flexible deals which may be better matches for some users. Mitigation: keep secondary sort by perfectness (date+location match).`,
        effort: `45 min code + 30 min CSS tuning + verify.`,
      },
      {
        // Friday
        emoji: '🌱', title: 'Cross-link Relocamp from Movacamper SEO pages',
        what: `Relocamp does ~20% of Movacamper traffic. Each Movacamper city result page should link to its Relocamp counterpart ("plan a full trip from Berlin →") and vice versa. Free SEO juice for both domains.`,
        how: `In public/index.html search-results render, when there's a Relocamp \`/deals/<city>\` page (current set: Munich, Berlin, Amsterdam, Milan, Paris, Barcelona, Florence, Düsseldorf, Stuttgart), add a soft callout below the deal list: "Plan a multi-leg trip from <City> on Relocamp →". Same direction back from Relocamp city pages.`,
        hypothesis: `Movacamper → Relocamp click-through ~5% on city pages. Boosts Relocamp organic visibility (more user-time, more shares, more backlinks).`,
        risk: `Sends traffic AWAY from Movacamper without immediate Imoova click. Mitigation: only show callout AFTER user has seen 3+ deals (i.e. didn't click any yet) — captures the "this isn't for me" segment.`,
        effort: `~45 min: lookup table of existing Relocamp city pages + conditional render.`,
      },
      {
        // Saturday
        emoji: '📩', title: 'Exit-intent / scroll-up subscribe modal',
        what: `Modal triggered on desktop exit-intent (mouse leaves viewport top) and mobile scroll-up (user scrolled past content, then up — strong leave intent). Headline pre-filled with city they searched: "Don't see what you need? Get notified when <City> deals appear."`,
        how: `Desktop: mouseout y<5. Mobile: scroll-up >100px after scrolled ≥80% AND ≥5s engagement. Suppression: localStorage 7-day cooldown, 14d after dismiss, never if already subscribed. Reuses subscribeFromCity() — no backend changes.`,
        hypothesis: `Subscriber rate from 3.1% of visitors → 4.5-5.5% within 14 days. At today's 50 visitors/day = +1 sub/day → +30 subs/month → larger weekly-digest audience compounds with the Wednesday-digest tip above.`,
        risk: `Google mobile interstitial penalty if shown too early. Mitigation: trigger only AFTER engagement (5s + 80% scroll), occupies <70% viewport, easy close. Track dismiss rate — kill if >50% in week 1.`,
        effort: `~2h: modal HTML/CSS, trigger logic, suppression localStorage, tracking events.`,
      },
    ];

    const tip = tips[new Date().getDay()];

    // ── 5. HTML email ────────────────────────────────────────────────────────
    const dateStr = new Date().toLocaleDateString('nl-NL', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    function fmtPct(n) {
      if (n == null) return '—';
      return (n >= 0 ? `+${n}%` : `${n}%`);
    }
    function color(n) {
      if (n == null) return '#64748b';
      return n >= 0 ? '#4ade80' : '#f87171';
    }

    function metricRow(label, val, d, w, m) {
      return `
        <tr style="border-bottom:1px solid #1e293b">
          <td style="padding:9px 10px;color:#94a3b8;font-size:13px">${label}</td>
          <td style="padding:9px 10px;text-align:right;color:#fff;font-weight:600;font-size:14px">${val ?? '—'}</td>
          <td style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;color:${color(d)}">${fmtPct(d)}</td>
          <td style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;color:${color(w)}">${fmtPct(w)}</td>
          <td style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;color:${color(m)}">${fmtPct(m)}</td>
        </tr>`;
    }

    function thead() {
      return `
        <tr>
          <th style="text-align:left;padding:6px 10px;color:#475569;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Metric</th>
          <th style="text-align:right;padding:6px 10px;color:#475569;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Yesterday</th>
          <th style="text-align:right;padding:6px 10px;color:#475569;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">vs Day</th>
          <th style="text-align:right;padding:6px 10px;color:#475569;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">vs Week</th>
          <th style="text-align:right;padding:6px 10px;color:#475569;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">vs Month</th>
        </tr>`;
    }

    // Three states: (a) snapshot exists → cron healthy, show pool size for context
    // (b) no snapshot but emails went out → legacy fallback, still healthy
    // (c) no snapshot AND no emails → real problem, alert
    const cronBadge = (() => {
      if (yesterdayInventory) {
        const pool = yesterdayInventory.global_unique_deals ?? yesterdayInventory.unique_deals ?? 0;
        return `<span style="color:#4ade80;font-weight:700">✓ Ran yesterday · ${sentYesterday} emails sent · ${pool} deals in Imoova pool</span>`;
      }
      if (sentYesterday > 0) {
        return `<span style="color:#4ade80;font-weight:700">✓ Ran yesterday (${sentYesterday} emails)</span>`;
      }
      return `<span style="color:#fbbf24;font-weight:700">⚠ No cron activity yesterday — check Vercel cron</span>`;
    })();

    const html = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Daily Briefing</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a">
<tr><td align="center" style="padding:24px 16px">
<table width="580" cellpadding="0" cellspacing="0">
  <tr><td style="padding-bottom:20px">
    <p style="margin:0;font-size:22px;font-weight:700;color:#fff">
      <span style="color:#38bdf8">Mova</span>camper + <span style="color:#fb923c">Relo</span>camp
    </p>
    <p style="margin:4px 0 0;color:#64748b;font-size:12px">Daily briefing &middot; ${dateStr}</p>
  </td></tr>
  <tr><td style="background:#1e293b;border-radius:12px;padding:18px 20px;margin-bottom:14px">
    <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#38bdf8;letter-spacing:1.5px;text-transform:uppercase">&#9679; Movacamper</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${thead()}
      ${metricRow('Visitors',  mc.visitors.yesterday,   mc.visitors.day,   mc.visitors.week,   mc.visitors.month)}
      ${metricRow('Pageviews', mc.pageviews.yesterday,  mc.pageviews.day,  mc.pageviews.week,  mc.pageviews.month)}
      ${metricRow('New subs',  mc.subscribes.yesterday, mc.subscribes.day, mc.subscribes.week, mc.subscribes.month)}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-top:1px solid #334155;padding-top:12px">
      <tr>
        <td style="color:#94a3b8;font-size:12px">Total subscribers: <strong style="color:#fff">${subscribersTotal}</strong></td>
        <td style="color:#94a3b8;font-size:12px;text-align:right">Emails sent today: <strong style="color:#fff">${sentToday}</strong></td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="height:12px"></td></tr>
  <tr><td style="background:#1e293b;border-radius:12px;padding:18px 20px">
    <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#fb923c;letter-spacing:1.5px;text-transform:uppercase">&#9679; Relocamp</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${thead()}
      ${metricRow('Visitors',  rc.visitors.yesterday,  rc.visitors.day,  rc.visitors.week,  rc.visitors.month)}
      ${metricRow('Pageviews', rc.pageviews.yesterday, rc.pageviews.day, rc.pageviews.week, rc.pageviews.month)}
    </table>
  </td></tr>
  <tr><td style="height:12px"></td></tr>
  <tr><td style="background:#1e293b;border-radius:12px;padding:18px 20px">
    <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1.5px;text-transform:uppercase">⚙ System health</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#0f172a;border-radius:8px;padding:12px 14px;width:48%">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Cron / deal matcher</div>
          <div style="font-size:13px">${cronBadge}</div>
        </td>
        <td style="width:4%"></td>
        <td style="background:#0f172a;border-radius:8px;padding:12px 14px;width:48%">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Emails sent today</div>
          <div style="color:${sentToday > 0 ? '#4ade80' : '#94a3b8'};font-size:22px;font-weight:700">${sentToday}</div>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="height:12px"></td></tr>
  <tr><td style="background:#0f2318;border:1px solid #14532d;border-radius:12px;padding:18px 20px">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#4ade80;letter-spacing:1.5px;text-transform:uppercase">
      ${tip.emoji} Proposal — ${['Zon','Ma','Di','Wo','Do','Vr','Za'][new Date().getDay()]}
    </p>
    <p style="margin:0 0 12px;color:#fff;font-size:16px;font-weight:700">${tip.title}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:1.55">
      <tr><td style="padding:4px 0;color:#86efac;width:78px;vertical-align:top;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Wat</td><td style="color:#dcfce7;padding:4px 0">${tip.what}</td></tr>
      <tr><td style="padding:4px 0;color:#86efac;vertical-align:top;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Hoe</td><td style="color:#dcfce7;padding:4px 0">${tip.how}</td></tr>
      <tr><td style="padding:4px 0;color:#86efac;vertical-align:top;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Hypothese</td><td style="color:#dcfce7;padding:4px 0">${tip.hypothesis}</td></tr>
      <tr><td style="padding:4px 0;color:#86efac;vertical-align:top;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Risico</td><td style="color:#dcfce7;padding:4px 0">${tip.risk}</td></tr>
      <tr><td style="padding:4px 0;color:#86efac;vertical-align:top;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Effort</td><td style="color:#dcfce7;padding:4px 0">${tip.effort}</td></tr>
    </table>
    <p style="margin:14px 0 0;color:#86efac;font-size:12px;font-style:italic">Reply "ja", "nee" of een aanpassing.</p>
  </td></tr>
  <tr><td style="height:20px"></td></tr>
  <tr><td style="text-align:center">
    <p style="margin:0;color:#334155;font-size:11px">
      <a href="${BASE}/dashboard.html" style="color:#38bdf8;text-decoration:none">Open dashboard</a>
      &nbsp;&middot;&nbsp;Movacamper + Relocamp Daily Briefing
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    // ── 6. Send via Resend ───────────────────────────────────────────────────
    const dayLabel = new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    const subject  = `📊 ${dayLabel} — MC ${mc.visitors.yesterday ?? '?'} | RC ${rc.visitors.yesterday ?? '?'} visitors · ${subscribersTotal} subs`;

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: TO, subject, html }),
    });

    const sendData = await sendRes.json();

    if (!sendRes.ok) {
      console.error('[morning-briefing] Resend error:', sendData);
      return res.status(500).json({ error: 'Email send failed', resend: sendData });
    }

    console.log(`[morning-briefing] Sent to ${TO} — ${subject}`);
    return res.status(200).json({
      ok:                    true,
      sent_to:               TO,
      subject,
      mc_visitors_yesterday: mc.visitors.yesterday,
      rc_visitors_yesterday: rc.visitors.yesterday,
      subscribers_total:     subscribersTotal,
      sent_today:            sentToday,
      cron_ran_yesterday:    cronRanYesterday,
      resend_id:             sendData.id,
    });

  } catch (err) {
    console.error('[morning-briefing] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
