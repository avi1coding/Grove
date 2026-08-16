/**
 * Rate limiting.
 *
 * Grove's interesting endpoints spend money on someone else's API key. On a
 * public deployment that is an open wallet, so every route is capped per client
 * and the expensive ones are capped harder and serialised.
 */

const buckets = new Map();   // key -> { hits: number[], }

function hit(key, windowMs, max) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { hits: [] };
    buckets.set(key, b);
  }
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= max) {
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - b.hits[0])) / 1000) };
  }
  b.hits.push(now);
  return { ok: true };
}

// Keep the map from growing without bound on a long-lived server.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (!b.hits.length || now - b.hits[b.hits.length - 1] > 900_000) buckets.delete(key);
  }
}, 300_000).unref?.();

const clientKey = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

/**
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max
 * @param {string} opts.name  bucket namespace, so limits don't share counters
 */
export function rateLimit({ windowMs, max, name }) {
  return (req, res, next) => {
    const { ok, retryAfter } = hit(`${name}:${clientKey(req)}`, windowMs, max);
    if (ok) return next();
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: `Too many requests — try again in ${retryAfter}s.` });
  };
}

/**
 * Cap how many model-backed requests run at once, process-wide. Without this a
 * handful of clients can fan out into dozens of concurrent LLM calls.
 */
export function concurrencyLimit(max = 4) {
  let active = 0;
  const queue = [];

  const release = () => {
    active--;
    const nextFn = queue.shift();
    if (nextFn) {
      active++;
      nextFn();
    }
  };

  return (req, res, next) => {
    const run = () => {
      res.on('finish', release);
      res.on('close', release);
      next();
    };
    if (active < max) {
      active++;
      run();
    } else if (queue.length > 40) {
      res.status(503).json({ error: 'Busy right now — try again in a moment.' });
    } else {
      queue.push(run);
    }
  };
}
