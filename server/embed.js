import { config } from './config.js';

/**
 * Vector store.
 *
 * provider 'local': deterministic sparse TF-IDF vectors, cosine similarity,
 *   blended with a BM25-style term score. No network, no key, works offline.
 * provider 'api':   OpenAI-compatible /embeddings on the Featherless base URL.
 *
 * Both produce the same interface: index(chunks) -> store, retrieve(store, q, k).
 */

const STOP = new Set(
  `a an the and or but if then than that this these those of in on at to for from by with without as is are was were be been being it its it's into over under about above below up down out off again further once here there when where why how all any both each few more most other some such no nor not only own same so too very can will just do does did doing have has had having i you he she they we me him her them my your his their our us also which who whom what while during before after between within upon per via`.split(
    /\s+/,
  ),
);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    // Keep any letter or digit, not just ASCII — a non-Latin corpus used to
    // tokenise to nothing and retrieve nothing.
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length > 1 && t.length < 30 && !STOP.has(t))
    .map(stem);
}

// Very light suffix stripper — enough to match "embedding"/"embeddings".
function stem(t) {
  if (t.length > 5 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('es') && !t.endsWith('ses')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  return t;
}

function tf(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

function normalize(vec) {
  let norm = 0;
  for (const v of vec.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = {};
  for (const [k, v] of vec) out[k] = v / norm;
  return out;
}

async function apiEmbed(texts) {
  const res = await fetch(`${config.featherless.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.featherless.apiKey}`,
    },
    body: JSON.stringify({ model: config.embeddings.model, input: texts }),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

/**
 * Build (or rebuild) the index over every chunk in the session.
 * Returns { provider, df, docCount, avgLen, vectors: {chunkId: sparse|dense} }.
 */
export async function buildIndex(chunks) {
  if (config.embeddings.provider === 'api') {
    const vectors = {};
    for (let i = 0; i < chunks.length; i += 64) {
      const batch = chunks.slice(i, i + 64);
      const embs = await apiEmbed(batch.map((c) => c.text));
      batch.forEach((c, j) => {
        vectors[c.id] = embs[j];
      });
    }
    return { provider: 'api', dense: true, vectors, docCount: chunks.length };
  }

  const df = Object.create(null);
  const tfs = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    const toks = tokenize(c.text);
    totalLen += toks.length;
    const counts = tf(toks);
    tfs.set(c.id, counts);
    for (const term of counts.keys()) df[term] = (df[term] || 0) + 1;
  }
  // Keep the term counts: retrieve() needs them and recomputing per query means
  // re-tokenising the entire corpus on every single search.
  const termCounts = {};
  for (const [id, counts] of tfs) termCounts[id] = Object.fromEntries(counts);

  const N = Math.max(1, chunks.length);
  const vectors = {};
  const lengths = {};
  for (const c of chunks) {
    const counts = tfs.get(c.id);
    lengths[c.id] = [...counts.values()].reduce((a, b) => a + b, 0);
    const vec = new Map();
    for (const [term, n] of counts) {
      const idf = Math.log(1 + N / (1 + (df[term] || 0)));
      vec.set(term, (1 + Math.log(n)) * idf);
    }
    vectors[c.id] = normalize(vec);
  }

  return {
    provider: 'local',
    dense: false,
    df,
    docCount: N,
    avgLen: totalLen / N,
    lengths,
    termCounts,
    vectors,
  };
}

function cosineSparse(a, b) {
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  let dot = 0;
  for (const k in small) if (k in large) dot += small[k] * large[k];
  return dot;
}

function cosineDense(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Retrieve the top-k chunks for a query.
 * @returns {Array<{chunk, score}>}
 */
export async function retrieve(index, chunks, query, k = 8, { excludeIds = [] } = {}) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const skip = new Set(excludeIds);
  let scored;

  if (index.dense) {
    const [qv] = await apiEmbed([query]);
    scored = Object.entries(index.vectors)
      .filter(([id]) => !skip.has(id) && byId.has(id))
      .map(([id, v]) => ({ chunk: byId.get(id), score: cosineDense(qv, v) }));
  } else {
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];
    const qCounts = tf(qTokens);
    const N = index.docCount;
    const qVec = new Map();
    for (const [term, n] of qCounts) {
      const idf = Math.log(1 + N / (1 + (index.df[term] || 0)));
      qVec.set(term, (1 + Math.log(n)) * idf);
    }
    const qNorm = normalize(qVec);

    // BM25 component for lexical precision on top of the cosine signal.
    const k1 = 1.5;
    const b = 0.75;
    scored = Object.entries(index.vectors)
      .filter(([id]) => !skip.has(id) && byId.has(id))
      .map(([id, v]) => {
        const cos = cosineSparse(qNorm, v);
        const chunk = byId.get(id);
        const stored = index.termCounts?.[id];
        const counts = stored ? new Map(Object.entries(stored)) : tf(tokenize(chunk.text));
        const len = index.lengths?.[id] || 1;
        let bm = 0;
        for (const term of qCounts.keys()) {
          const f = counts.get(term) || 0;
          if (!f) continue;
          const idf = Math.log(1 + (N - (index.df[term] || 0) + 0.5) / ((index.df[term] || 0) + 0.5));
          bm += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / (index.avgLen || len)));
        }
        return { chunk, score: cos, bm };
      });

    // Normalise BM25 by a fixed saturation rather than the per-query maximum,
    // so a score means the same thing across queries. assessCoverage compares
    // these numbers against an absolute threshold.
    scored = scored.map((s) => ({
      chunk: s.chunk,
      score: 0.65 * s.score + 0.35 * (s.bm / (s.bm + 6)),
    }));
  }

  // Drop chunks with no lexical connection at all, so callers can actually
  // detect "nothing in the corpus matches this".
  scored = scored.filter((s) => s.score > 0.001);
  scored.sort((a, b) => b.score - a.score);

  // Light source diversification: don't let one upload monopolise the context.
  const out = [];
  const perSource = new Map();
  const cap = Math.max(2, Math.ceil(k / 2));
  for (const s of scored) {
    const used = perSource.get(s.chunk.sourceId) || 0;
    if (used >= cap && out.length < k) continue;
    perSource.set(s.chunk.sourceId, used + 1);
    out.push(s);
    if (out.length >= k) break;
  }
  if (out.length < k) {
    const taken = new Set(out.map((s) => s.chunk.id));
    for (const s of scored) {
      if (taken.has(s.chunk.id)) continue;
      out.push(s);
      taken.add(s.chunk.id);
      if (out.length >= k) break;
    }
  }
  return out;
}
