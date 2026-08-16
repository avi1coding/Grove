import { config } from './config.js';

/**
 * Speech-to-text, so a video without captions is still usable material.
 *
 * Uses the OpenAI-compatible /audio/transcriptions endpoint — Groq serves
 * Whisper there, and it is fast and cheap enough to run on upload
 * (~1s per 3.5 minutes of audio, fractions of a cent per hour).
 */

// Groq caps uploads at 25MB on the free tier. Stay under it and say so clearly
// rather than letting the API reject a big file with an opaque error.
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const stamp = (sec) =>
  `[${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}]`;

/** Group Whisper segments into ~45s paragraphs, matching the caption format. */
function formatSegments(segments) {
  const paras = [];
  let cur = null;
  for (const s of segments) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    const t = Number(s.start || 0);
    if (!cur || t - cur.t > 45) {
      cur = { t, text };
      paras.push(cur);
    } else {
      cur.text += ' ' + text;
    }
  }
  return paras.map((p) => `${stamp(p.t)} ${p.text}`).join('\n\n');
}

export const transcriptionEnabled = () =>
  config.transcribe.enabled && Boolean(config.featherless.apiKey);

/**
 * @param {Buffer} buf     audio or video bytes
 * @param {string} name    filename (the API uses the extension to sniff format)
 * @param {string} [mime]
 * @returns {Promise<{text: string, meta: object}>}
 */
export async function transcribeAudio(buf, name = 'audio.m4a', mime = 'audio/mp4') {
  if (!transcriptionEnabled()) {
    throw new Error('Transcription is turned off — set GROVE_TRANSCRIBE=1 and an API key to enable it.');
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new Error(
      `That audio is ${(buf.length / 1e6).toFixed(0)}MB, over the ${Math.round(MAX_AUDIO_BYTES / 1e6)}MB transcription limit. Trim it or upload a smaller file.`,
    );
  }

  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), name);
  form.append('model', config.transcribe.model);
  form.append('response_format', 'verbose_json');   // segments give us timestamps
  form.append('temperature', '0');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.transcribe.timeoutMs);
  let res;
  try {
    res = await fetch(`${config.featherless.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.featherless.apiKey}` },
      body: form,
      signal: ac.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Transcription timed out.');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 404 || /model/i.test(detail)) {
      throw new Error(
        `Your provider has no transcription model at ${config.transcribe.model}. Set LLM_TRANSCRIBE_MODEL, or GROVE_TRANSCRIBE=0 to turn this off.`,
      );
    }
    throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 160)}`);
  }

  const data = await res.json();
  const text = Array.isArray(data.segments) && data.segments.length
    ? formatSegments(data.segments)
    : String(data.text || '').trim();

  if (!text) throw new Error('The transcription came back empty — there may be no speech in it.');

  return {
    text,
    meta: {
      transcribed: true,
      model: config.transcribe.model,
      seconds: Math.round(Number(data.duration) || 0),
    },
  };
}
