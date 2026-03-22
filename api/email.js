// Movacamper Email Helper — Resend API
// Shared module for welcome emails, deal alerts, and broadcasts

import { createHmac } from 'crypto';

// ── Unsubscribe Tokens ──
const UNSUB_SECRET = process.env.UNSUB_SECRET || 'mc-unsub-default-secret-2026';

export function createUnsubToken(email) {
  return createHmac('sha256', UNSUB_SECRET).update(email.toLowerCase()).digest('hex').slice(0, 24);
}

export function verifyUnsubToken(email, token) {
  return createUnsubToken(email) === token;
}

export function getUnsubUrl(email) {
  const token = createUnsubToken(email);
  return `https://movacamper.com/api/subscribe?action=unsub&email=${encodeURIComponent(email)}&token=${token}`;
}

// ── Preferences Tokens (separate HMAC prefix to avoid token reuse with unsub) ──
export function createPrefsToken(email) {
  return createHmac('sha256', UNSUB_SECRET + ':prefs').update(email.toLowerCase()).digest('hex').slice(0, 24);
}

export function verifyPrefsToken(email, token) {
  return createPrefsToken(email) === token;
}

export function getPrefsUrl(email, source) {
  const token = createPrefsToken(email);
  const base = source === 'relocamp' ? 'https://www.movacamper.com' : 'https://movacamper.com';
  return `${base}/api/subscribe?action=preferences&email=${encodeURIComponent(email)}&token=${token}`;
}

// ── City → Language Mapping ──
const CITY_LANG = {
  // German
  'munich': 'de', 'berlin': 'de', 'hamburg': 'de', 'frankfurt': 'de', 'cologne': 'de',
  'dusseldorf': 'de', 'stuttgart': 'de', 'dortmund': 'de', 'essen': 'de', 'nuremberg': 'de',
  'hanover': 'de', 'leipzig': 'de', 'dresden': 'de', 'freiburg': 'de', 'bochum': 'de',
  'duisburg': 'de', 'karlsruhe': 'de', 'augsburg': 'de', 'gütersloh': 'de', 'gutersloh': 'de',
  'vienna': 'de', 'salzburg': 'de', 'innsbruck': 'de', 'graz': 'de', 'linz': 'de',
  'zurich': 'de', 'basel': 'de', 'bern': 'de', 'lucerne': 'de',
  // French
  'paris': 'fr', 'lyon': 'fr', 'marseille': 'fr', 'nice': 'fr', 'toulouse': 'fr',
  'bordeaux': 'fr', 'lille': 'fr', 'strasbourg': 'fr', 'montpellier': 'fr', 'nantes': 'fr',
  'geneva': 'fr', 'lausanne': 'fr', 'brussels': 'fr', 'grenoble': 'fr', 'rouen': 'fr',
  'orleans': 'fr', 'monaco': 'fr',
  // Spanish
  'barcelona': 'es', 'madrid': 'es', 'malaga': 'es', 'seville': 'es', 'valencia': 'es',
  'bilbao': 'es', 'zaragoza': 'es', 'granada': 'es', 'cordoba': 'es', 'toledo': 'es',
  // Portuguese
  'lisbon': 'pt', 'porto': 'pt', 'faro': 'pt',
  // Italian
  'milan': 'it', 'rome': 'it', 'venice': 'it', 'florence': 'it', 'naples': 'it',
  'bologna': 'it', 'turin': 'it', 'genoa': 'it', 'bari': 'it',
  // Dutch
  'amsterdam': 'nl', 'rotterdam': 'nl', 'utrecht': 'nl', 'eindhoven': 'nl', 'the-hague': 'nl',
  'antwerp': 'nl', 'ghent': 'nl',
  // Scandinavian
  'copenhagen': 'da', 'stockholm': 'sv', 'gothenburg': 'sv', 'malmo': 'sv',
  // Other EU
  'prague': 'cs', 'warsaw': 'pl', 'bratislava': 'sk', 'budapest': 'hu',
  'bucharest': 'ro', 'athens': 'el', 'dublin': 'en',
  // UK
  'london': 'en', 'manchester': 'en', 'birmingham': 'en', 'edinburgh': 'en',
  'glasgow': 'en', 'bristol': 'en', 'cambridge': 'en', 'newcastle': 'en', 'kiel': 'en',
};

// Non-EU cities (for detection)
const NON_EU_CITIES = new Set([
  'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'auckland', 'wellington',
  'new york', 'los angeles', 'chicago', 'san francisco', 'toronto', 'vancouver', 'montreal',
  'tokyo', 'osaka', 'bangkok', 'singapore', 'hong kong', 'dubai', 'mumbai', 'delhi',
  'cape town', 'johannesburg', 'nairobi', 'cairo', 'buenos aires', 'sao paulo', 'rio',
  'beijing', 'shanghai', 'seoul', 'taipei',
]);

export function detectLanguage(city) {
  if (!city || city === 'any') return 'en';
  const normalized = city.toLowerCase().trim().replace(/\s+/g, '-');
  return CITY_LANG[normalized] || CITY_LANG[normalized.replace(/-/g, '')] || 'en';
}

export function isNonEU(city) {
  if (!city || city === 'any') return false;
  const normalized = city.toLowerCase().trim();
  if (NON_EU_CITIES.has(normalized)) return true;
  // If city is in our EU mapping, it's EU
  const slug = normalized.replace(/\s+/g, '-');
  if (CITY_LANG[slug]) return false;
  // Unknown city — could be small EU town. Don't flag as non-EU.
  return false;
}

// ── Bilingual Translations ──
const TRANSLATIONS = {
  de: {
    welcome_subject: 'Willkommen bei Movacamper!',
    thanks: 'Danke für deine Anmeldung!',
    deals_from: 'Wir benachrichtigen dich, sobald wir Campervan-Relocation-Deals ab',
    deals_any: 'Wir benachrichtigen dich, sobald wir neue Campervan-Relocation-Deals in Europa finden.',
    tip: 'Tipp: Je genauer du Stadt und Reisedaten angibst, desto besser können wir passende Deals für dich finden!',
    found_deals: 'Wir haben Deals für dich gefunden!',
    deals_departing: 'Deals ab',
    around_date: 'um den',
    view_deal: 'Deal ansehen',
    hot_deals: 'Die besten Deals dieser Woche',
    unsub: 'Du willst keine E-Mails mehr? Kein Problem:',
    unsub_link: 'Abmelden',
    happy_travels: 'Gute Reise!',
  },
  fr: {
    welcome_subject: 'Bienvenue chez Movacamper !',
    thanks: 'Merci pour votre inscription !',
    deals_from: 'Nous vous préviendrons dès que nous trouverons des offres de relocation de camping-car au départ de',
    deals_any: 'Nous vous préviendrons dès que nous trouverons de nouvelles offres de relocation de camping-car en Europe.',
    tip: 'Conseil : Plus vous précisez votre ville et vos dates, mieux nous pourrons trouver des offres adaptées !',
    found_deals: 'Nous avons trouvé des offres pour vous !',
    deals_departing: 'Offres au départ de',
    around_date: 'autour du',
    view_deal: 'Voir l\'offre',
    hot_deals: 'Les meilleures offres de la semaine',
    unsub: 'Vous ne souhaitez plus recevoir nos e-mails ?',
    unsub_link: 'Se désinscrire',
    happy_travels: 'Bon voyage !',
  },
  es: {
    welcome_subject: '¡Bienvenido a Movacamper!',
    thanks: '¡Gracias por suscribirte!',
    deals_from: 'Te avisaremos cuando encontremos ofertas de reubicación de camper desde',
    deals_any: 'Te avisaremos cuando encontremos nuevas ofertas de reubicación de camper en Europa.',
    tip: 'Consejo: Cuanto más específicos sean tu ciudad y fechas, ¡mejor podremos encontrar ofertas para ti!',
    found_deals: '¡Hemos encontrado ofertas para ti!',
    deals_departing: 'Ofertas desde',
    around_date: 'alrededor del',
    view_deal: 'Ver oferta',
    hot_deals: 'Las mejores ofertas de la semana',
    unsub: '¿Ya no quieres recibir correos?',
    unsub_link: 'Cancelar suscripción',
    happy_travels: '¡Buen viaje!',
  },
  pt: {
    welcome_subject: 'Bem-vindo ao Movacamper!',
    thanks: 'Obrigado por se inscrever!',
    deals_from: 'Avisaremos quando encontrarmos ofertas de relocação de campervan a partir de',
    deals_any: 'Avisaremos quando encontrarmos novas ofertas de relocação de campervan na Europa.',
    tip: 'Dica: Quanto mais específica for a cidade e as datas, melhor conseguimos encontrar ofertas para si!',
    found_deals: 'Encontrámos ofertas para si!',
    deals_departing: 'Ofertas a partir de',
    around_date: 'por volta de',
    view_deal: 'Ver oferta',
    hot_deals: 'Melhores ofertas da semana',
    unsub: 'Não quer mais receber e-mails?',
    unsub_link: 'Cancelar inscrição',
    happy_travels: 'Boa viagem!',
  },
  nl: {
    welcome_subject: 'Welkom bij Movacamper!',
    thanks: 'Bedankt voor je aanmelding!',
    deals_from: 'We sturen je een bericht zodra we camper-relocatie-deals vinden vanuit',
    deals_any: 'We sturen je een bericht zodra we nieuwe camper-relocatie-deals in Europa vinden.',
    tip: 'Tip: Hoe specifieker je stad en reisdata, hoe beter we deals voor je kunnen vinden!',
    found_deals: 'We hebben deals voor je gevonden!',
    deals_departing: 'Deals vanuit',
    around_date: 'rond',
    view_deal: 'Bekijk deal',
    hot_deals: 'De beste deals van deze week',
    unsub: 'Wil je geen e-mails meer ontvangen?',
    unsub_link: 'Uitschrijven',
    happy_travels: 'Goede reis!',
  },
  it: {
    welcome_subject: 'Benvenuto su Movacamper!',
    thanks: 'Grazie per esserti iscritto!',
    deals_from: 'Ti avviseremo quando troveremo offerte di relocation di camper in partenza da',
    deals_any: 'Ti avviseremo quando troveremo nuove offerte di relocation di camper in Europa.',
    tip: 'Suggerimento: Più specifici sono la città e le date, meglio riusciremo a trovare offerte per te!',
    found_deals: 'Abbiamo trovato offerte per te!',
    deals_departing: 'Offerte in partenza da',
    around_date: 'intorno al',
    view_deal: 'Vedi offerta',
    hot_deals: 'Le migliori offerte della settimana',
    unsub: 'Non vuoi più ricevere email?',
    unsub_link: 'Cancella iscrizione',
    happy_travels: 'Buon viaggio!',
  },
};

function t(lang, key) {
  return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || key;
}

// ── Email Template ──
function emailWrapper(content, unsubUrl, prefsUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:24px 16px}
.header{text-align:center;padding:20px 0 16px;border-bottom:2px solid #2d6a4f}
.header h1{margin:0;font-size:22px;color:#2d6a4f;font-weight:700}
.header p{margin:4px 0 0;font-size:12px;color:#6b7280;letter-spacing:1px}
.body{padding:24px 0;color:#1f2937;font-size:15px;line-height:1.6}
.body h2{font-size:18px;color:#1f2937;margin:0 0 12px}
.tip{background:#fef3c7;border-left:3px solid #f59e0b;padding:12px 16px;margin:16px 0;font-size:13px;color:#92400e;border-radius:0 6px 6px 0}
.deal{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0}
.deal .route{font-size:16px;font-weight:600;color:#1f2937}
.deal .meta{font-size:13px;color:#6b7280;margin:4px 0}
.deal .price{font-size:15px;font-weight:700;color:#2d6a4f}
.deal a{display:inline-block;margin-top:8px;background:#2d6a4f;color:#fff;padding:8px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}
.deal a:hover{background:#1b4332}
.divider{border:0;border-top:1px dashed #d1d5db;margin:24px 0}
.local{background:#f9fafb;border-radius:8px;padding:16px;margin-top:16px;border:1px solid #e5e7eb}
.local h3{font-size:14px;color:#6b7280;margin:0 0 8px;font-weight:600}
.footer{text-align:center;padding:20px 0;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;margin-top:24px}
.footer a{color:#6b7280}
.btn{display:inline-block;background:#2d6a4f;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;margin:8px 0}
</style></head>
<body><div class="wrap">
<div class="header">
  <h1>Movacamper</h1>
  <p>CAMPERVAN RELOCATION DEALS</p>
</div>
<div class="body">
${content}
</div>
<div class="footer">
  <p>You're receiving this because you signed up at <a href="https://movacamper.com">movacamper.com</a></p>
  ${prefsUrl ? `<p>Dates or plans changed? <a href="${prefsUrl}">Update your preferences</a></p>` : ''}
  <p>Had enough adventure emails? No hard feelings: <a href="${unsubUrl}">unsubscribe</a></p>
  <p style="margin-top:8px">Happy travels! — Frank</p>
</div>
</div></body></html>`;
}

// ── Welcome Email ──
export function buildWelcomeEmail(subscriber) {
  const { email, city, date, flexibility, source } = subscriber;
  const lang = detectLanguage(city);
  const unsubUrl = getUnsubUrl(email);
  const prefsUrl = getPrefsUrl(email, source);
  const hasCity = city && city !== 'any';

  let enContent = '<h2>Thanks for signing up!</h2>\n';
  if (hasCity) {
    enContent += `<p>We'll keep an eye out for campervan relocation deals departing from <strong>${city}</strong>`;
    if (date) enContent += ` around <strong>${date}</strong> (±${flexibility || 7} days)`;
    enContent += '.</p>\n';
  } else {
    enContent += '<p>We\'ll notify you whenever we find cheap campervan relocation deals across Europe.</p>\n';
  }
  enContent += '<p>In the meantime, check out what\'s available right now:</p>\n';
  enContent += '<p><a href="https://movacamper.com" class="btn">Browse current deals</a></p>\n';
  enContent += '<div class="tip">💡 Tip: The more specific your city and dates, the better we can match deals for you. Reply to this email if you want to update your preferences!</div>\n';

  // Add local language version if not English
  let localContent = '';
  if (lang !== 'en' && TRANSLATIONS[lang]) {
    localContent = '<hr class="divider">\n<div class="local">\n';
    localContent += `<h3>🌍 ${TRANSLATIONS[lang].welcome_subject || ''}</h3>\n`;
    localContent += `<p>${t(lang, 'thanks')}</p>\n`;
    if (hasCity) {
      localContent += `<p>${t(lang, 'deals_from')} <strong>${city}</strong>`;
      if (date) localContent += ` ${t(lang, 'around_date')} <strong>${date}</strong>`;
      localContent += '.</p>\n';
    } else {
      localContent += `<p>${t(lang, 'deals_any')}</p>\n`;
    }
    localContent += `<p>💡 ${t(lang, 'tip')}</p>\n`;
    localContent += '</div>\n';
  }

  const html = emailWrapper(enContent + localContent, unsubUrl, prefsUrl);

  return {
    to: email,
    subject: 'Welcome to Movacamper — deal alerts activated! 🚐',
    html,
  };
}

// ── Non-EU Welcome Email ──
export function buildNonEUWelcomeEmail(subscriber) {
  const { email, city, source } = subscriber;
  const unsubUrl = getUnsubUrl(email);
  const prefsUrl = getPrefsUrl(email, source);

  const content = `<h2>Thanks for signing up!</h2>
<p>Great to see interest from <strong>${city}</strong>! 🌏</p>
<p>At the moment, Movacamper covers campervan relocation deals across <strong>Europe</strong> — think Portugal, Spain, France, Germany, Scandinavia, and more.</p>
<p>We don't have routes in your region yet, but we're actively looking into expanding. We'll keep your subscription and let you know the moment we do!</p>
<p>Planning a trip to Europe? You're already in the right place:</p>
<p><a href="https://movacamper.com" class="btn">Browse European deals</a></p>`;

  return {
    to: email,
    subject: 'Welcome to Movacamper — Europe for now, your region soon! 🌏',
    html: emailWrapper(content, unsubUrl, prefsUrl),
  };
}

// ── Deal Alert Email ──
export function buildDealAlertEmail(subscriber, deals) {
  const { email, city, date, source } = subscriber;
  const lang = detectLanguage(city);
  const unsubUrl = getUnsubUrl(email);
  const prefsUrl = getPrefsUrl(email, source);
  const hasCity = city && city !== 'any';

  let enContent = `<h2>We found ${deals.length} deal${deals.length > 1 ? 's' : ''} for you!</h2>\n`;
  if (hasCity && date) {
    enContent += `<p>Campervan relocation deals departing from <strong>${city}</strong> around <strong>${date}</strong>:</p>\n`;
  } else if (hasCity) {
    enContent += `<p>Campervan relocation deals departing from <strong>${city}</strong>:</p>\n`;
  }

  for (const deal of deals.slice(0, 5)) {
    enContent += `<div class="deal">
  <div class="route">${deal.from} → ${deal.to}</div>
  <div class="meta">${deal.date_range || 'Flexible dates'} · ${deal.vehicle || 'Campervan'}${deal.seats ? ' · ' + deal.seats + ' seats' : ''}${deal.transmission && deal.transmission !== 'unknown' ? ' · ' + deal.transmission : ''}</div>
  <div class="price">${deal.price || '€1/day'}</div>
  <a href="${deal.url}">View deal →</a>
</div>\n`;
  }

  if (deals.length > 5) {
    enContent += `<p style="color:#6b7280;font-size:13px">+ ${deals.length - 5} more deals available on <a href="https://movacamper.com">movacamper.com</a></p>\n`;
  }

  // Local language
  let localContent = '';
  if (lang !== 'en' && TRANSLATIONS[lang]) {
    localContent = '<hr class="divider">\n<div class="local">\n';
    localContent += `<h3>🌍 ${t(lang, 'found_deals')}</h3>\n`;
    if (hasCity) {
      localContent += `<p>${t(lang, 'deals_departing')} <strong>${city}</strong>`;
      if (date) localContent += ` ${t(lang, 'around_date')} <strong>${date}</strong>`;
      localContent += '.</p>\n';
    }
    localContent += `<p>${t(lang, 'happy_travels')}</p>\n`;
    localContent += '</div>\n';
  }

  const subject = hasCity
    ? `${deals.length} campervan deal${deals.length > 1 ? 's' : ''} from ${city} — Movacamper`
    : `${deals.length} new campervan deal${deals.length > 1 ? 's' : ''} — Movacamper`;

  return {
    to: email,
    subject,
    html: emailWrapper(enContent + localContent, unsubUrl, prefsUrl),
  };
}

// ── Weekly Digest Email ──
export function buildDigestEmail(subscriber, deals, stats) {
  const { email, source } = subscriber;
  const unsubUrl = getUnsubUrl(email);
  const prefsUrl = getPrefsUrl(email, source);

  let content = '<h2>This week\'s hot deals 🔥</h2>\n';
  content += `<p>We currently have <strong>${stats.totalDeals || 'several'}</strong> campervan relocation deals across Europe.</p>\n`;

  if (stats.topCity) {
    content += `<p>Most popular departure: <strong>${stats.topCity}</strong> (${stats.topCityCount} deals)</p>\n`;
  }

  for (const deal of deals.slice(0, 5)) {
    content += `<div class="deal">
  <div class="route">${deal.from} → ${deal.to}</div>
  <div class="meta">${deal.date_range || 'Flexible dates'} · ${deal.vehicle || 'Campervan'}</div>
  <div class="price">${deal.price || '€1/day'}</div>
  <a href="${deal.url}">View deal →</a>
</div>\n`;
  }

  content += '<div class="tip">🎯 Want alerts for a specific city? Just reply to this email with your preferred departure city and dates — we\'ll update your alert!</div>\n';

  return {
    to: email,
    subject: `This week's campervan deals across Europe — Movacamper`,
    html: emailWrapper(content, unsubUrl, prefsUrl),
  };
}

// ── Nearby Alert Email (deals from nearby cities, not exact match) ──
export function buildNearbyAlertEmail(subscriber, nearbyResults) {
  const { email, city, source } = subscriber;
  const lang = detectLanguage(city);
  const unsubUrl = getUnsubUrl(email);
  const prefsUrl = getPrefsUrl(email, source);
  const cityDisplay = city.charAt(0).toUpperCase() + city.slice(1);

  let content = `<h2>No deals from ${cityDisplay} right now — but close!</h2>\n`;
  content += `<p>We checked all providers and there are no campervan relocations departing from ${cityDisplay} today. But we found deals from nearby cities:</p>\n`;

  let totalDeals = 0;
  for (const group of nearbyResults.slice(0, 3)) {
    const transportTip = group.distance < 100
      ? `FlixBus ~€${Math.round(8 + group.distance * 0.04)}`
      : group.distance < 250
        ? `FlixBus ~€${Math.round(10 + group.distance * 0.05)}`
        : `Train ~€${Math.round(15 + group.distance * 0.06)}`;

    content += `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:12px 0">
  <div style="font-size:16px;font-weight:600;color:#1f2937">📍 ${group.city} <span style="font-size:13px;color:#6b7280;font-weight:400">(${group.distance}km away)</span></div>
  <div style="font-size:13px;color:#2d6a4f;margin:4px 0">🚌 Get there: ${transportTip} from ${cityDisplay}</div>
  <div style="font-size:13px;color:#6b7280;margin:4px 0">${group.deals.length} deal${group.deals.length > 1 ? 's' : ''} available</div>\n`;

    for (const deal of group.deals.slice(0, 2)) {
      content += `  <div class="deal" style="margin-top:8px">
    <div class="route">${deal.from} → ${deal.to}</div>
    <div class="meta">${deal.date_range || 'Flexible dates'} · ${deal.vehicle || 'Campervan'}</div>
    <div class="price">${deal.price || '€1/day'}</div>
    <a href="${deal.url}">View deal →</a>
  </div>\n`;
    }
    content += '</div>\n';
    totalDeals += group.deals.length;
  }

  content += `<div class="tip">🎯 A preferred travel date helps us match better! <a href="${prefsUrl}">Update your preferences</a></div>\n`;

  // Local language
  let localContent = '';
  if (lang !== 'en' && TRANSLATIONS[lang]) {
    localContent = '<hr class="divider">\n<div class="local">\n';
    localContent += `<h3>🌍 ${t(lang, 'found_deals')}</h3>\n`;
    localContent += `<p>${t(lang, 'happy_travels')}</p>\n`;
    localContent += '</div>\n';
  }

  return {
    to: email,
    subject: `Deals near ${cityDisplay} — ${totalDeals} option${totalDeals > 1 ? 's' : ''} from nearby cities`,
    html: emailWrapper(content + localContent, unsubUrl, prefsUrl),
  };
}

// ── No Match Email (nothing found anywhere nearby) ──
export function buildNoMatchEmail(subscriber) {
  const { email, city, source } = subscriber;
  const unsubUrl = getUnsubUrl(email);
  const prefsUrl = getPrefsUrl(email, source);
  const cityDisplay = city.charAt(0).toUpperCase() + city.slice(1);

  const content = `<h2>We're keeping an eye out for you!</h2>
<p>We checked all providers (Imoova, Roadsurfer, Indie Campers, Bunk Campers, Movacar) and there are no campervan relocation deals near <strong>${cityDisplay}</strong> right now.</p>
<p>But deals change daily — new routes pop up all the time. We'll send you an alert the moment something shows up.</p>
<div class="tip">🎯 <strong>Want better matches?</strong> Adding a preferred travel date helps us find deals that fit your schedule. <a href="${prefsUrl}">Update your preferences</a></div>
<p>In the meantime, check what's available across Europe:</p>
<p><a href="https://movacamper.com" class="btn">Browse all deals</a></p>`;

  return {
    to: email,
    subject: `No deals near ${cityDisplay} yet — we're watching!`,
    html: emailWrapper(content, unsubUrl, prefsUrl),
  };
}

// ── Send Email via Resend API ──
export async function sendEmail({ to, subject, html, fromName }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('Resend API key not configured — email not sent to', to);
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }

  const senderName = fromName || 'Movacamper';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: `${senderName} <frank@movacamper.com>`,
        to: [to],
        subject,
        html,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      console.log('Email sent to', to, '- id:', data.id);
      return { sent: true, messageId: data.id };
    } else {
      console.error('Resend error:', data);
      return { sent: false, reason: data.message || JSON.stringify(data) };
    }
  } catch (err) {
    console.error('Email send error:', err.message);
    return { sent: false, reason: err.message };
  }
}
