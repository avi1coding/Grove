import { config, hasFeatherlessKey } from './config.js';

/**
 * Thin OpenAI-compatible client for Featherless.ai with a two-tier model router.
 *
 *   role: 'big'   -> tree extraction, quiz authoring, micro-lessons, boss synthesis
 *   role: 'small' -> grounding verification, short-answer grading, hints
 *
 * Every call is recorded so the UI can show the pipeline actually routed across
 * models instead of pretending to.
 */

const callLog = [];
export const getCallLog = (limit = 60) => callLog.slice(-limit);

function record(entry) {
  callLog.push({ ...entry, at: new Date().toISOString() });
  if (callLog.length > 500) callLog.splice(0, callLog.length - 500);
}

export class FeatherlessError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'FeatherlessError';
    this.status = status;
  }
}

function modelFor(role) {
  if (role === 'small') return config.featherless.smallModel;
  if (role === 'verify') return config.featherless.verifyModel;
  if (role === 'vision') return config.featherless.visionModel || config.featherless.bigModel;
  return config.featherless.bigModel;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {'big'|'small'|'vision'} opts.role
 * @param {Array<{role:string, content:any}>} opts.messages
 * @param {string} [opts.stage] label for the call log
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {boolean} [opts.json] ask for a JSON object back
 */
export async function chat({
  role = 'big',
  messages,
  stage = 'unlabelled',
  temperature = 0.3,
  maxTokens = 2048,
  json = false,
}) {
  if (!hasFeatherlessKey()) {
    throw new FeatherlessError(
      'FEATHERLESS_API_KEY is not set. Copy .env.example to .env and add your Featherless.ai key.',
      401,
    );
  }

  const model = modelFor(role);
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 1; attempt <= config.featherless.maxRetries; attempt++) {
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.featherless.timeoutMs);
    try {
      const res = await fetch(`${config.featherless.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.featherless.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 4xx other than rate limiting is not worth retrying.
        if (res.status !== 429 && res.status < 500) {
          record({ stage, role, model, ms: Date.now() - started, ok: false, status: res.status });
          throw new FeatherlessError(`Featherless ${res.status}: ${text.slice(0, 400)}`, res.status);
        }
        lastErr = new FeatherlessError(`Featherless ${res.status}: ${text.slice(0, 200)}`, res.status);
        record({ stage, role, model, ms: Date.now() - started, ok: false, status: res.status, retrying: true });
        // Rate limit responses say exactly how long to wait; guessing wastes
        // the attempt and burns the budget again.
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000 + 250, 30_000)
          : 700 * attempt * attempt;
        await sleep(wait);
        continue;
      }

      const data = await res.json();
      const msg = data?.choices?.[0]?.message ?? {};
      // Reasoning models sometimes spend the whole budget in `reasoning` and
      // leave `content` empty; the answer is still in there to be salvaged.
      const content = msg.content || msg.reasoning_content || msg.reasoning || '';
      record({
        stage,
        role,
        model,
        ms: Date.now() - started,
        ok: true,
        tokens: data?.usage?.total_tokens ?? null,
      });
      return content;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof FeatherlessError && err.status && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
      record({ stage, role, model, ms: Date.now() - started, ok: false, error: String(err.message || err) });
      if (attempt < config.featherless.maxRetries) await sleep(700 * attempt * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new FeatherlessError(String(lastErr), 500);
}

/** Pull the first balanced JSON object/array out of a model response. */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('Model returned no text');
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to scanning */
  }

  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = cleaned.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = cleaned.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`Could not parse JSON from model output: ${cleaned.slice(0, 200)}`);
}

/** chat() + extractJson(), with one repair round if the model returns junk. */
export async function chatJson(opts) {
  const first = await chat({ ...opts, json: true });
  try {
    return extractJson(first);
  } catch (err) {
    const repaired = await chat({
      ...opts,
      stage: `${opts.stage || 'unlabelled'}:repair`,
      temperature: 0,
      json: true,
      messages: [
        ...opts.messages,
        { role: 'assistant', content: String(first).slice(0, 4000) },
        {
          role: 'user',
          content: 'That was not valid JSON. Reply with the corrected JSON only — no prose, no code fences.',
        },
      ],
    });
    return extractJson(repaired);
  }
}
