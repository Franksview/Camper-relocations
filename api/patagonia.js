// Temporary test endpoint for the RelocatePatagonia fetch module (step 3).
// Not linked from any page yet — curl-only until public/patagonia.html exists.
import { fetchAllPatagoniaListings } from './_lib/patagonia.js';

export default async function handler(req, res) {
  const apiKey = process.env.RELOCATE_PATAGONIA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RELOCATE_PATAGONIA_API_KEY not set' });
  }

  try {
    const listings = await fetchAllPatagoniaListings(apiKey);
    return res.status(200).json({
      ok: true,
      counts: {
        vehicles: listings.vehicles.length,
        camping: listings.camping.length,
        proDrivers: listings.proDrivers.length,
      },
      ...listings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
