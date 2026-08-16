import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.GROVE_DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const SESSION_DIR = path.join(DATA_DIR, 'sessions');

/**
 * Any OpenAI-compatible chat-completions endpoint works: Featherless.ai (the
 * default), Groq, OpenRouter, Together, or a local Ollama / LM Studio server.
 * LLM_* wins if set; FEATHERLESS_* is kept so existing setups keep working.
 */
const pick = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return '';
};

export const config = {
  port: Number(process.env.PORT || 3000),

  featherless: {
    // Local servers ignore the key but the header still has to be present.
    apiKey:
      pick('LLM_API_KEY', 'FEATHERLESS_API_KEY') ||
      (/localhost|127\.0\.0\.1|\[::1\]/.test(pick('LLM_BASE_URL', 'FEATHERLESS_BASE_URL')) ? 'local' : ''),
    baseUrl: (pick('LLM_BASE_URL', 'FEATHERLESS_BASE_URL') || 'https://api.featherless.ai/v1').replace(/\/$/, ''),
    // Big model: topic-tree extraction, quiz authoring, micro-lessons, boss synthesis.
    bigModel: pick('LLM_BIG_MODEL', 'FEATHERLESS_BIG_MODEL') || 'moonshotai/Kimi-K2-Instruct',
    // Small fast model: grounding verification, short-answer grading, hints.
    smallModel: pick('LLM_SMALL_MODEL', 'FEATHERLESS_SMALL_MODEL') || 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    // Verification runs on its own model. Providers meter each model
    // separately, so keeping the checker off the authoring model roughly
    // doubles the throughput before rate limits bite.
    verifyModel: pick('LLM_VERIFY_MODEL') || pick('LLM_SMALL_MODEL', 'FEATHERLESS_SMALL_MODEL') || 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    // Optional vision model for reading text off images when tesseract.js is unavailable.
    visionModel: pick('LLM_VISION_MODEL', 'FEATHERLESS_VISION_MODEL'),
    timeoutMs: Number(pick('LLM_TIMEOUT_MS', 'FEATHERLESS_TIMEOUT_MS') || 300_000),
    maxRetries: Number(pick('LLM_MAX_RETRIES', 'FEATHERLESS_MAX_RETRIES') || 4),
  },

  transcribe: {
    // Speech-to-text for audio/video and for YouTube videos with no captions.
    enabled: (process.env.GROVE_TRANSCRIBE ?? '1') !== '0',
    model: pick('LLM_TRANSCRIBE_MODEL') || 'whisper-large-v3-turbo',
    timeoutMs: Number(pick('LLM_TRANSCRIBE_TIMEOUT_MS') || 180_000),
    // Guardrails so one long lecture cannot eat the whole budget.
    maxMinutes: Number(process.env.GROVE_TRANSCRIBE_MAX_MINUTES || 90),
    maxPlaylistMinutes: Number(process.env.GROVE_TRANSCRIBE_PLAYLIST_MINUTES || 120),
  },

  embeddings: {
    // 'local'  -> deterministic TF-IDF vector store, no network calls
    // 'api'    -> OpenAI-compatible /embeddings endpoint on the Featherless base URL
    provider: process.env.GROVE_EMBED_PROVIDER || 'local',
    model: process.env.GROVE_EMBED_MODEL || 'BAAI/bge-large-en-v1.5',
  },

  pipeline: {
    chunkChars: Number(process.env.GROVE_CHUNK_CHARS || 900),
    chunkOverlap: Number(process.env.GROVE_CHUNK_OVERLAP || 150),
    retrieveK: Number(process.env.GROVE_RETRIEVE_K || 8),
    quizSize: 5,
    bossMin: 15,
    bossMax: 20,
    passMark: 5, // 5/5 to light a node
    bossPassRatio: 0.8,
    // How many author -> verify rounds a single question may go through.
    verifyRounds: Number(process.env.GROVE_VERIFY_ROUNDS || 3),
    // Coverage below this flags a subtopic as a gap in your source material.
    gapCoverageFloor: Number(process.env.GROVE_GAP_FLOOR || 0.34),
  },

  // Spaced repetition (days) after a node is mastered.
  srsIntervals: [1, 3, 7, 16, 35],
};

export const hasFeatherlessKey = () => Boolean(config.featherless.apiKey);
