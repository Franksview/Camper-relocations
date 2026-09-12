// RelocatePatagonia integration — read-only partner API.
// Standalone module: not wired into search.js/search-core.js or the EU search
// engine. Powers only the dedicated Patagonia page (public/patagonia.html).
// Data source: https://www.relocatepatagonia.com/api/partners/movacamper/*
// Auth key lives in RELOCATE_PATAGONIA_API_KEY (Vercel env var), never in code.

const BASE_URL = 'https://www.relocatepatagonia.com/api/partners/movacamper';
const PUBLIC_URL = 'https://www.relocatepatagonia.com/marketplace-publico';

async function fetchListings(endpoint, apiKey, timeoutMs = 8000) {
  try {
    const resp = await fetch(`${BASE_URL}/${endpoint}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      console.log(`RelocatePatagonia ${endpoint} fetch failed:`, resp.status);
      return [];
    }
    const data = await resp.json();
    return Array.isArray(data.listings) ? data.listings : [];
  } catch (err) {
    console.log(`RelocatePatagonia ${endpoint} fetch error:`, err.message);
    return [];
  }
}

// Formats a price using its ACTUAL currency — listings can be CLP or USD,
// never assume. Mislabeling a USD price as CLP understates it ~900x.
export function formatPrice(amount, currency) {
  if (typeof amount !== 'number') return 'unknown';
  if (amount === 0) return 'Free';
  const code = (currency || 'CLP').toUpperCase();
  const locale = code === 'USD' ? 'en-US' : 'es-CL';
  return `$${amount.toLocaleString(locale)} ${code}`;
}

export async function fetchVehicles(apiKey) {
  const listings = await fetchListings('vehiculos', apiKey);
  return listings.map(v => ({
    id: v.id,
    category: v.categoria || 'Vehicle',
    transmission: v.transmision || 'unknown',
    seats: v.asientos ?? null,
    beds: v.camas ?? null,
    fourByFour: !!v.traccion_4x4,
    origin: v.origen || 'unknown',
    destination: v.destino || 'unknown',
    dateFrom: v.fecha_desde || null,
    dateTo: v.fecha_hasta || null,
    price: formatPrice(v.precio, v.moneda),
    priceRaw: v.precio ?? null,
    currency: v.moneda || 'CLP',
    photo: Array.isArray(v.fotos) && v.fotos.length > 0 ? v.fotos[0] : null,
    company: v.empresa_nombre || 'unknown',
    url: `${PUBLIC_URL}/vehiculos/${v.id}`,
  }));
}

export async function fetchCamping(apiKey) {
  const listings = await fetchListings('camping', apiKey);
  return listings.map(c => ({
    id: c.id,
    name: c.nombre_camping || 'Campsite',
    location: c.ubicacion || 'unknown',
    pricePerNight: formatPrice(c.precio_noche, c.moneda),
    priceRaw: c.precio_noche ?? null,
    currency: c.moneda || 'CLP',
    services: Array.isArray(c.servicios) ? c.servicios : [],
    description: c.descripcion || '',
    photo: Array.isArray(c.fotos) && c.fotos.length > 0 ? c.fotos[0] : null,
    company: c.empresa_nombre || 'unknown',
    url: `${PUBLIC_URL}/camping/${c.id}`,
  }));
}

export async function fetchProDrivers(apiKey) {
  const listings = await fetchListings('prodrivers', apiKey);
  return listings.map(d => ({
    id: d.id,
    driverName: d.nombre_chofer || 'Driver',
    origin: d.origen || 'unknown',
    destination: d.destino || 'unknown',
    coverageArea: d.zona_cobertura || '',
    rate: formatPrice(d.tarifa, d.moneda),
    rateRaw: d.tarifa ?? null,
    rateUnit: d.tarifa_unidad || '',
    currency: d.moneda || 'CLP',
    company: d.empresa_nombre || 'unknown',
    url: `${PUBLIC_URL}/prodrivers/${d.id}`,
  }));
}

// Fetches all three in parallel. Never throws — each list independently
// degrades to [] on failure so a single endpoint outage doesn't blank the page.
export async function fetchAllPatagoniaListings(apiKey) {
  const [vehicles, camping, proDrivers] = await Promise.all([
    fetchVehicles(apiKey),
    fetchCamping(apiKey),
    fetchProDrivers(apiKey),
  ]);
  return { vehicles, camping, proDrivers };
}
