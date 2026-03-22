// Subscriber conversation history — event log per subscriber
// Stores in Redis list: history:{email}, max 100 entries, newest first

export async function logEvent(redis, email, type, details = {}) {
  if (!redis || !email) return;
  try {
    const entry = JSON.stringify({
      type,
      timestamp: new Date().toISOString(),
      details,
    });
    await redis.lpush(`history:${email}`, entry);
    await redis.ltrim(`history:${email}`, 0, 99); // Keep max 100
  } catch (e) {
    console.error('History log error:', e.message);
  }
}

export async function getHistory(redis, email, limit = 50) {
  if (!redis || !email) return [];
  try {
    const raw = await redis.lrange(`history:${email}`, 0, limit - 1);
    return raw.map(entry => {
      try { return typeof entry === 'string' ? JSON.parse(entry) : entry; }
      catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error('History read error:', e.message);
    return [];
  }
}
