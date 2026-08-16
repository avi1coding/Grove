import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_DIR, UPLOAD_DIR, DATA_DIR } from './config.js';

export const newId = (prefix = '') =>
  `${prefix}${crypto.randomBytes(6).toString('hex')}`;

export async function ensureDirs() {
  for (const d of [DATA_DIR, SESSION_DIR, UPLOAD_DIR]) {
    await fs.mkdir(d, { recursive: true });
  }
}

const filePath = (id) => path.join(SESSION_DIR, `${id}.json`);

// Serialise writes per session so concurrent requests can't clobber each other.
const locks = new Map();

export function createSession(name = '') {
  const id = newId('s_');
  return {
    id,
    name: String(name || '').slice(0, 80),
    createdAt: new Date().toISOString(),
    sources: [],
    chunks: [],
    index: null,
    tree: null,
    gaps: [],
    progress: {}, // nodeId -> { state, attempts, best, missedConcepts[], lastQuiz, masteredAt, srs }
    boss: null,
    quizzes: {}, // quizId -> quiz (with answers, server-side only)
    events: [],
  };
}

export async function saveSession(session) {
  await ensureDirs();
  session.updatedAt = new Date().toISOString();
  const tmp = `${filePath(session.id)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session));
  await fs.rename(tmp, filePath(session.id));
  return session;
}

export async function loadSession(id) {
  if (!/^s_[a-f0-9]{12}$/.test(id)) throw Object.assign(new Error('Bad session id'), { status: 400 });
  try {
    return JSON.parse(await fs.readFile(filePath(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw Object.assign(new Error('Session not found'), { status: 404 });
    throw err;
  }
}

/** Read-modify-write a session under a per-session lock. */
export async function withSession(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const gate = new Promise((r) => (release = r));
  const chained = prev.then(() => gate);
  locks.set(id, chained);
  await prev;
  try {
    const session = await loadSession(id);
    const result = await fn(session);
    await saveSession(session);
    return result;
  } finally {
    release();
    // `chained` is what we stored, not `gate` — comparing against gate never matched.
    if (locks.get(id) === chained) locks.delete(id);
  }
}

export function logEvent(session, type, detail = {}) {
  session.events.push({ type, at: new Date().toISOString(), ...detail });
  if (session.events.length > 400) session.events.splice(0, session.events.length - 400);
}

/** The client-safe view: no answer keys, no vectors, no raw chunk dump. */
export function publicView(session) {
  return {
    id: session.id,
    name: session.name || '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || session.createdAt,
    sources: session.sources.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      chars: s.chars,
      chunkCount: s.chunkCount,
      meta: s.meta,
      error: s.error,
    })),
    chunkCount: session.chunks.length,
    carriedOver: session.carriedOver || 0,
    tree: session.tree,
    gaps: session.gaps,
    progress: session.progress,
    boss: session.boss
      ? {
          unlocked: session.boss.unlocked,
          passed: session.boss.passed,
          attempts: session.boss.attempts,
          best: session.boss.best,
          needed: session.boss.needed ?? null,
          missedConcepts: session.boss.missedConcepts || [],
          // Without this the client cannot offer the review that unlocks a retry.
          remediation: session.boss.remediation || null,
        }
      : null,
    events: session.events.slice(-40),
  };
}

/** Remove a space and its stored work. */
export async function deleteSession(id) {
  if (!/^s_[a-f0-9]{12}$/.test(id)) throw Object.assign(new Error('Bad session id'), { status: 400 });
  await fs.rm(filePath(id), { force: true });
  locks.delete(id);
}
