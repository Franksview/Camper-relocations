// api/morning-briefing.js
// Daily 8:30 AM briefing email — Movacamper + Relocamp
// Trigger: GET /api/morning-briefing?token=mc-dash-9xK7qW3p
//
// Required env vars (all already set in your Vercel project):
//   RESEND_API_KEY      — your Resend API key
//   DASHBOARD_TOKEN     — optional override, defaults to mc-dash-9xK7qW3p
//   BRIEFING_FROM       — from address, e.g. briefing@movacamper.com (must be verified in Resend)
//   BRIEFING_TO         — recipient, defaults to snelders.f@gmail.com

const TOKEN    = process.env.DASHBOARD_TOKEN || 'mc-dash-9xK7qW3p';
const FROM     = process.env.BRIEFING_FROM   || 'Movacamper Dashboard <frank@movacamper.com>';
const TO       = process.env.BRIEFING_TO     || 'snelders.f@gmail.com';
const BASE     = 'https://www.movacamper.com';

export default async function handler(req, res) {
  if (req.query.token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // ── 1. Fetch all data in parallel ────────────────────────────────────────
    const [statsRes, subsRes, logRes] = await Promise.all([
      fetch(`${BASE}/api/stats?token=${TOKEN}&days=60`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=subscribers`),
      fetch(`${BASE}/api/stats?token=${TOKEN}&action=auto-sent-log&limit=200`),
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
    const cronRanYesterday = sentYesterday > 0;

    // ── 4. Rotating marketing tip (based on day of week) ────────────────────
    const tips = [
      {
        emoji: '📋', title: 'Review your pending drafts',
        body: `You have ${subscribersTotal} active subscribers and a backlog of pending draft emails. Approving them takes 10 minutes and is your single highest-leverage action this week — each approved draft is a potential affiliate click.`,
      },
      {
        emoji: '🔍', title: 'Add UTM tracking to every affiliate link',
        body: `You've had 150-200 deal clicks per 2 weeks → 1 booking ever. Without UTM params you can't see where the drop-off is. Add ?utm_source=movacamper&utm_medium=deal-alert&utm_campaign=imoova to all Imoova links today — takes 20 minutes, permanently fixes your blind spot.`,
      },
      {
        emoji: '🏙️', title: 'Build a /munich landing page',
        body: `Munich is your #1 searched city. A dedicated /munich page with meta title "Campervan Relocations from Munich — Free & €1/day Deals" will rank fast for long-tail keywords and funnel exactly the visitors most likely to book.`,
      },
      {
        emoji: '📧', title: 'Send a full-list broadcast today',
        body: `${subscribersTotal} warm subscribers are waiting. A simple "Top 5 deals this week across Europe" broadcast takes 20 minutes and is your fastest path to a second affiliate booking.`,
      },
      {
        emoji: '⚡', title: 'Add urgency signals to deal cards',
        body: `Your funnel: visitors → deal clicks (33%) → ~0 bookings. Add "X people viewed this deal today" or a countdown near your Imoova links. Urgency + social proof increases affiliate click-through by 20–40% with zero new traffic needed.`,
      },
      {
        emoji: '🌱', title: 'Cross-link Relocamp from Movacamper',
        body: `Relocamp is running at ~20% of Movacamper's traffic. Add 3–5 contextual internal links from your highest-traffic Movacamper pages to Relocamp. Free SEO equity that compounds over months.`,
      },
      {
        emoji: '📩', title: 'Add an exit-intent subscribe prompt',
        body: `Only 2% of deal-clickers subscribe. An exit-intent modal — "Get notified when this deal returns 🔔" — catches warm visitors leaving without converting. Conservative estimate: +30–50% subscriber growth rate.`,
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

    const cronBadge = cronRanYesterday
      ? `<span style="color:#4ade80;font-weight:700">✓ Ran yesterday (${sentYesterday} emails)</span>`
      : `<span style="color:#fbbf24;font-weight:700">⚠ No emails logged yesterday — check cron</span>`;

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
      ${tip.emoji} Marketing tip — ${['Zon','Ma','Di','Wo','Do','Vr','Za'][new Date().getDay()]}
    </p>
    <p style="margin:0 0 8px;color:#fff;font-size:15px;font-weight:700">${tip.title}</p>
    <p style="margin:0;color:#86efac;font-size:13px;line-height:1.65">${tip.body}</p>
  </td></tr>
  <tr><td style="height:20px"></td></tr>
  <tr><td style="text-align:center">
    <p style="margin:0;color:#334155;font-size:11px">
      <a href="${BASE}/dashboard?token=${TOKEN}" style="color:#38bdf8;text-decoration:none">Open dashboard</a>
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
