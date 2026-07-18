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
    const [statsRes, subsRes, logRes, invRes, ai14Res] = await Promise.all([
      fetch(`${BASE}/api/stats?token=${TOKEN}&days=60`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=subscribers`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=auto-sent-log&limit=200`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=imoova-pool-history&days=2`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&days=14`),
    ]);

    if (!statsRes.ok || !subsRes.ok || !logRes.ok) {
      throw new Error(`API fetch failed: stats=${statsRes.status} subs=${subsRes.status} log=${logRes.status}`);
    }

    const [stats, subsData, logData] = await Promise.all([
      statsRes.json(), subsRes.json(), logRes.json(),
    ]);

    // ── 1b. AI-chat referral share (14-day rolling) ──────────────────────────
    // Tracks ChatGPT/Perplexity/Claude/Copilot referral share vs the ~9%
    // baseline measured mid-June 2026, before the June 23 AI-search deploy
    // (FAQPage schema + robots.txt allows for GPTBot/ClaudeBot/PerplexityBot).
    let aiReferral = null;
    try {
      if (ai14Res.ok) {
        const ai14 = await ai14Res.json();
        const totalVisitors = ai14.totals?.visitors || 0;
        const AI_CHAT_KEYWORDS = ['chatgpt', 'openai', 'perplexity', 'claude', 'anthropic'];
        const bingCount = (ai14.top_referrers || [])
          .filter(r => (r.source || '').toLowerCase().includes('bing'))
          .reduce((s, r) => s + (r.count || 0), 0);
        const aiChatCount = (ai14.top_referrers || [])
          .filter(r => AI_CHAT_KEYWORDS.some(k => (r.source || '').toLowerCase().includes(k)))
          .reduce((s, r) => s + (r.count || 0), 0);
        if (totalVisitors >= 50) {
          const pct = Math.round((aiChatCount / totalVisitors) * 1000) / 10;
          aiReferral = { pct, count: aiChatCount, bingCount, totalVisitors, enoughData: true };
        } else {
          aiReferral = { totalVisitors, enoughData: false };
        }
      }
    } catch { /* best-effort — don't fail the whole briefing over this */ }

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
    // Only 4 days/week get a proposal (Mon/Tue/Wed/Fri) — these are the ones
    // rewritten July 15 2026 against actual shipped/measured state. Sun/Thu/Sat
    // were dropped: their old entries were stale, unverified leftovers from the
    // June 13 rewrite (see the Saturday exit-intent-modal case, July 18 2026).
    const dayNames = ['Zon', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
    const tipsByDay = {
      1: {
        // Monday
        emoji: '👥', title: 'Segment subscribers by engagement level, email differently',
        what: `Right now all 102 subs get the same digest. But some clicked a deal yesterday, others haven't clicked in 30 days. Send engaged subs the full digest + extra tips; send dormant subs a short "here's what's hot" + re-engagement question ("mind if I ask why you haven't clicked in a month?").`,
        how: `Add a \`last_click_ts\` field to subscriber records (already tracked per deal-email click). Mark subs as active (click in last 14 days), dormant (no click in 30+ days), at-risk (14-30 days). In weekly-digest.js, build two email variants based on engagement tier. Log the tier in the digest send event.`,
        hypothesis: `Engaged subs stay engaged (higher CTR, repeat clicks). Dormant subs either re-engage (re-activation flag provides signal) or opt out cleanly (capture *why*). Net: fewer silent churns, better ROI on email quota.`,
        risk: `Dormant subs get less content = fewer chances to re-engage. Mitigation: the re-engagement question is a soft offer ("no pressure, just curious"), not a guilt trip.`,
        effort: `1h: add last_click_ts field + backfill from logs, 1h: email variant + engagement tier logic, 30 min test.`,
      },
      2: {
        // Tuesday
        emoji: '🤖', title: 'Instrument per-referrer CTR for AI-chat traffic (EXP-026 unfinished half)',
        what: `EXP-026 (AI-search optimization, deployed June 23) measured AI-referral share = 8.8% (flat vs baseline). But the hypothesis had two parts: (1) AI referral traffic %, (2) AI-clickers convert 2-3× better per-click. Part 2 was never instrumented — no per-referrer CTR breakdown exists. Time to measure it.`,
        how: `In search.js, when building the deal card & click handler, tag each click with its referrer source (detect \`document.referrer\` + categorize as "ai-chat" if it's ChatGPT/Claude/Perplexity domain). Log referrer + deal + click + outcome (clicked or no). In morning-briefing.js, compute CTR per referrer (ai-chat / organic / email / etc) and compare to baseline. Update the \`ai_referral_verdict\` field with full verdict: "X% traffic, Y% CTR, conversion rate Z% vs baseline".`,
        hypothesis: `AI-chat CTR is NOT 2-3× baseline. Most likely 0.8-1.2× because AI-users have already been answered by the AI itself — they're clicking our links out of curiosity/verification, not high-intent purchase. But measurement will show the real signal for whether to invest more in AI SEO.`,
        risk: `Referrer spoofing / inconsistent tagging if users click through multiple hops. Mitigation: use first-party event tracking, not just document.referrer.`,
        effort: `1.5h: add click-source tagging + event logging, 30 min: compute per-referrer CTR in briefing, 30 min: test.`,
      },
      3: {
        // Wednesday
        emoji: '❓', title: 'Soft-unsubscribe flow: ask *why* before losing the subscriber',
        what: `Right now when a subscriber clicks unsubscribe, they're gone. No feedback, no re-engagement chance. Add a quick step: a small form asking "mind if I ask why you're leaving?" with pre-filled options (too many emails, wrong city, not enough deals, personal reasons, other). Result: Frank knows *why* subs churn, can iterate.`,
        how: `POST /api/subscribe?action=soft-unsubscribe&email=X&reason=too_many_emails. Record the reason in subscriber.unsubscribe_reason. Show a thank-you ("got it, you're unsubscribed, but we'll note that for next time") instead of just "done". In morning-briefing, compute unsubscribe reasons distribution: "3 left for too-noisy, 1 for wrong city". Frank reads the pattern.`,
        hypothesis: `Learn the real churn drivers. If "too many emails" dominates, shift to bi-weekly. If "wrong city" dominates, improve city matching. If "not enough deals in my city", make Relocamp the fallback. Result: lower future churn, faster iteration on the thing that matters.`,
        risk: `Users feel guilty or interrogated by the form. Mitigation: make it truly optional ("no pressure, but..."), 2 clicks max.`,
        effort: `45 min: soft-unsubscribe endpoint + form UI, 30 min: reason logging + aggregation in briefing, 30 min test.`,
      },
      5: {
        // Friday
        emoji: '📍', title: 'Route "no results" searchers to Relocamp with city pre-filled',
        what: `User searches "Budapest", gets 0 deals today. They leave empty-handed. But Relocamp has ~20 trips *from* Budapest right now. Instead of losing them, show a single-line callout: "Looking for trips from Budapest? Browse relocations on Relocamp →" with the city pre-filled. Real user value, feeds Relocamp, uses data Frank already has.`,
        how: `In search.js renderSearchResults: if deals.length === 0 AND searchCity matches a Relocamp city page, append a soft card: "Relocamp has X active trips from <City>. Interested?" Link to relocamp.nl/deals/<city>?departure=<city>. Relocamp already has the deep-link structure for this.`,
        hypothesis: `Capture ~10% of "no results" searchers (2-3 per week, at 50 visitors/week baseline). Each is a warm lead for Relocamp (pre-qualified: already thinking about campervan travel). Compounds subscriber base for the parallel ecosystem.`,
        risk: `User feels redirected/dismissed ("you don't have what I want, so here, try this other site"). Mitigation: frame as a genuine offer ("here's what's available from your city"), not a fallback. Make it one click, not a full redirect.`,
        effort: `30 min: detect no-results case + condition check, 30 min: build callout card, 15 min: verify Relocamp deep-link handling.`,
      },
    };

    const tip = tipsByDay[new Date().getDay()];

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

    const AI_REFERRAL_BASELINE_PCT = 9;
    const AI_REFERRAL_GOAL_PCT = 18;
    const aiReferralVerdict = (() => {
      if (!aiReferral || !aiReferral.enoughData) return 'Not enough data yet.';
      if (aiReferral.pct >= AI_REFERRAL_GOAL_PCT * 0.85) return `Tracking toward the ${AI_REFERRAL_GOAL_PCT}% goal.`;
      if (aiReferral.pct >= AI_REFERRAL_BASELINE_PCT) return 'Flat vs baseline.';
      return 'Declined vs baseline — investigate.';
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
  ${aiReferral ? `<tr><td style="background:#1e293b;border-radius:12px;padding:18px 20px">
    <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#c084fc;letter-spacing:1.5px;text-transform:uppercase">&#9679; AI-chat referral share (14d)</p>
    ${aiReferral.enoughData ? `
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="color:#94a3b8;font-size:12px">ChatGPT / Perplexity / Claude share of visitors</td>
        <td style="text-align:right;color:#fff;font-weight:700;font-size:16px">${aiReferral.pct}%</td>
      </tr>
    </table>
    <p style="margin:8px 0 0;color:#64748b;font-size:11px">Baseline (mid-June, pre AI-search deploy): 9%. ${aiReferralVerdict}</p>
    ` : `<p style="margin:0;color:#64748b;font-size:12px">Not enough data yet (${aiReferral.totalVisitors} visitors in last 14 days, need 50+).</p>`}
  </td></tr>
  <tr><td style="height:12px"></td></tr>` : ''}
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
  ${tip ? `<tr><td style="height:12px"></td></tr>
  <tr><td style="background:#0f2318;border:1px solid #14532d;border-radius:12px;padding:18px 20px">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#4ade80;letter-spacing:1.5px;text-transform:uppercase">
      ${tip.emoji} Proposal — ${dayNames[new Date().getDay()]}
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
  </td></tr>` : ''}
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
      ai_referral_pct_14d:   aiReferral?.enoughData ? aiReferral.pct : null,
      ai_referral_verdict:   aiReferralVerdict,
      resend_id:             sendData.id,
    });

  } catch (err) {
    console.error('[morning-briefing] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
