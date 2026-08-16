import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { chat } from './featherless.js';
import { parserForFile, handlerForUrl, htmlToText, parseFeedXml, looksLikeFeed } from './sources.js';
import { assertPublicUrl } from './safe-fetch.js';

const require = createRequire(import.meta.url);

const clean = (s) =>
  String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/* ------------------------------------------------------------------ PDF -- */

export async function parsePdfBuffer(buf, label = 'document.pdf') {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const parsed = await pdfParse(buf);
  const text = clean(parsed.text);
  if (!text) throw new Error(`No selectable text in "${label}" — it may be a scanned PDF.`);
  return { text, meta: { pages: parsed.numpages } };
}

export async function extractPdf(filePath, originalName) {
  // Import the library directly: pdf-parse's index.js runs a demo on its own
  // test fixture when it thinks it is the entry module.
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const buf = await fs.readFile(filePath);
  const parsed = await pdfParse(buf);
  const text = clean(parsed.text);
  if (!text) throw new Error(`No selectable text in "${originalName}" — it may be a scanned PDF.`);
  return { text, meta: { pages: parsed.numpages } };
}

/* ---------------------------------------------------------------- image -- */

async function ocrWithTesseract(filePath) {
  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch {
    return null;
  }
  const worker = await Tesseract.createWorker('eng');
  try {
    const { data } = await worker.recognize(filePath);
    return clean(data.text);
  } finally {
    await worker.terminate();
  }
}

async function ocrWithVisionModel(filePath, mimeType) {
  if (!config.featherless.visionModel) return null;
  const b64 = (await fs.readFile(filePath)).toString('base64');
  const out = await chat({
    role: 'vision',
    stage: 'ingest:image-ocr',
    temperature: 0,
    maxTokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcribe every piece of text visible in this image, in reading order. Output only the transcribed text. If there is no text, output NO_TEXT.',
          },
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${b64}` } },
        ],
      },
    ],
  });
  const text = clean(out);
  return text === 'NO_TEXT' ? '' : text;
}

export async function extractImage(filePath, originalName, mimeType) {
  let text = await ocrWithTesseract(filePath);
  let engine = 'tesseract.js';
  if (text == null) {
    text = await ocrWithVisionModel(filePath, mimeType);
    engine = 'featherless-vision';
  }
  if (text == null) {
    throw new Error(
      `Cannot read "${originalName}": install tesseract.js (npm i tesseract.js) or set FEATHERLESS_VISION_MODEL.`,
    );
  }
  if (!text) throw new Error(`No readable text found in "${originalName}".`);
  return { text, meta: { ocrEngine: engine } };
}

/* -------------------------------------------------------------- youtube -- */

export function youtubeId(url) {
  const m =
    String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** fetch with a hard deadline — a hung remote host must not hang the upload. */
async function fetchWithTimeout(url, opts = {}, ms = 20_000) {
  await assertPublicUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timed out after ${ms / 1000}s fetching ${new URL(url).host}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// Public InnerTube web key. The plain watch-page scrape is bot-gated now, so we
// ask the player endpoint as a mobile client, which still serves caption tracks.
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const YT_CLIENTS = [
  {
    ctx: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'en' },
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)',
  },
  {
    ctx: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' },
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
  },
];

async function fetchPlayer(videoId) {
  let lastStatus = 'unknown';
  for (const client of YT_CLIENTS) {
    try {
      const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.ua },
        body: JSON.stringify({
          context: { client: client.ctx },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });
      const data = await res.json();
      lastStatus = data?.playabilityStatus?.status || lastStatus;
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (tracks.length) {
        return { tracks, title: data?.videoDetails?.title || `YouTube ${videoId}`, ua: client.ua };
      }
    } catch {
      /* try the next client */
    }
  }
  // InnerTube gave us nothing. Some videos still expose captionTracks in the
  // watch page payload, so try that before giving up.
  try {
    const page = await fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    }, 20_000).then((r) => r.text());
    const m = page.match(/"captionTracks":(\[.*?\])/);
    if (m) {
      const tracks = JSON.parse(m[1].replace(/\\u0026/g, '&'));
      if (tracks.length) {
        const t = page.match(/"title":\s*"([^"]{1,200})"/);
        return { tracks, title: t ? decodeEntities(JSON.parse(`"${t[1]}"`)) : `YouTube ${videoId}`, ua: UA };
      }
    }
    if (/"status":"LOGIN_REQUIRED"/.test(page)) lastStatus = 'LOGIN_REQUIRED';
    else if (/"status":"UNPLAYABLE"/.test(page)) lastStatus = 'UNPLAYABLE';
  } catch {
    /* fall through to the empty result */
  }

  return { tracks: [], title: `YouTube ${videoId}`, ua: UA, status: lastStatus };
}

/** Captions come back as json3 or as timedtext XML depending on the client. */
function parseCaptions(raw) {
  try {
    const json = JSON.parse(raw);
    const segs = (json.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        t: Math.round((e.tStartMs || 0) / 1000),
        text: e.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim(),
      }))
      .filter((s) => s.text);
    if (segs.length) return segs;
  } catch {
    /* not json — fall through to XML */
  }

  const p = [...raw.matchAll(/<p\s+t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => ({
    t: Math.round(Number(m[1]) / 1000),
    text: decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
  }));
  if (p.length) return p.filter((s) => s.text);

  return [...raw.matchAll(/<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => ({
      t: Math.round(Number(m[1])),
      text: decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
    }))
    .filter((s) => s.text);
}

export async function extractYouTube(url) {
  const id = youtubeId(url);
  if (!id) throw new Error(`Not a YouTube link: ${url}`);

  const { tracks, title, ua, status } = await fetchPlayer(id);
  if (!tracks.length) {
    const why = {
      LOGIN_REQUIRED: 'it is private, members-only, or age-restricted',
      UNPLAYABLE: 'it is not playable (region-locked or removed)',
      ERROR: 'the video is unavailable',
    }[status] || 'captions are turned off for it';
    throw Object.assign(new Error(`No transcript for "${title}" — ${why}.`), { reason: status || 'NO_CAPTIONS' });
  }

  const track =
    tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find((t) => t.languageCode === 'en') ||
    tracks.find((t) => (t.languageCode || '').startsWith('en')) ||
    tracks[0];
  if (!track?.baseUrl) throw new Error(`No usable caption track for "${title}".`);

  const capUrl = `${track.baseUrl.replace(/\\u0026/g, '&')}&fmt=json3`;
  const raw = await fetchWithTimeout(capUrl, { headers: { 'User-Agent': ua } }).then((r) => r.text());
  const segments = parseCaptions(raw);

  if (!segments.length) throw new Error(`Transcript for "${title}" came back empty.`);

  // Group into ~45s paragraphs so chunks carry usable timestamps.
  const paras = [];
  let cur = null;
  for (const s of segments) {
    if (!cur || s.t - cur.t > 45) {
      cur = { t: s.t, text: s.text };
      paras.push(cur);
    } else {
      cur.text += ' ' + s.text;
    }
  }
  const stamp = (sec) =>
    `[${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}]`;

  return {
    text: clean(paras.map((p) => `${stamp(p.t)} ${p.text}`).join('\n\n')),
    title,
    meta: { videoId: id, language: track.languageCode, autoGenerated: track.kind === 'asr' },
  };
}

/* -------------------------------------------------------------- web url -- */

export async function extractWebPage(url) {
  const html = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 25_000).then((r) => r.text());

  if (looksLikeFeed(html)) {
    const feed = parseFeedXml(html, new URL(url).hostname);
    if (feed) return { text: feed.text, title: feed.name, meta: feed.meta };
  }

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url).trim();
  const text = htmlToText(html);
  if (text.length < 200) throw new Error(`Not enough readable text at ${url}.`);
  return { text, title: decodeEntities(title), meta: {} };
}

/* ------------------------------------------------------------- dispatch -- */

export function playlistId(url) {
  const m = String(url).match(/[?&]list=([\w-]+)/);
  return m && !/^(RD|UL|LL)/.test(m[1]) ? m[1] : null;
}

/** A playlist becomes one source per video, so each keeps its own citation. */
export async function extractPlaylist(url, limit = 12) {
  const id = playlistId(url);
  if (!id) throw new Error('No playlist id in that URL');
  const html = await fetchWithTimeout(`https://www.youtube.com/playlist?list=${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  }, 25_000).then((r) => r.text());

  const ids = [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map((m) => m[1]))].slice(0, limit);
  if (!ids.length) throw new Error('No videos found — the playlist may be private.');

  const out = [];
  const reasons = {};
  for (const vid of ids) {
    try {
      const r = await extractYouTube(`https://www.youtube.com/watch?v=${vid}`);
      out.push({ kind: 'youtube', name: r.title, text: r.text, meta: { ...r.meta, playlist: id } });
    } catch (err) {
      const key = err.reason || 'FETCH_FAILED';
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }

  if (!out.length) {
    const label = {
      NO_CAPTIONS: 'have captions turned off',
      LOGIN_REQUIRED: 'are private, members-only, or age-restricted',
      UNPLAYABLE: 'are region-locked or removed',
      FETCH_FAILED: 'could not be fetched',
    };
    const detail = Object.entries(reasons)
      .map(([k, n]) => `${n} ${label[k] || k}`)
      .join(', ');
    throw new Error(
      `None of the ${ids.length} videos in that playlist have a transcript Grove can read (${detail}). ` +
        `Open a video, use its transcript panel, and paste the text instead.`,
    );
  }
  return { items: out, skipped: Object.values(reasons).reduce((a, b) => a + b, 0) };
}

export async function ingestUrl(url) {
  if (youtubeId(url)) {
    const r = await extractYouTube(url);
    return { kind: 'youtube', name: r.title, text: r.text, meta: { ...r.meta, url } };
  }
  if (playlistId(url)) {
    const { items, skipped } = await extractPlaylist(url);
    return { multi: items.map((i) => ({ ...i, meta: { ...i.meta, url } })), skipped };
  }

  const handler = handlerForUrl(url);
  if (handler) {
    const r = await handler.fetch(new URL(url), { parsePdfBuffer });
    return { kind: handler.id, name: r.name || url, text: r.text, meta: { ...(r.meta || {}), url } };
  }

  const r = await extractWebPage(url);
  return { kind: 'web', name: r.title, text: r.text, meta: { ...r.meta, url } };
}

export async function ingestFile(file) {
  const mime = file.mimetype || '';
  const name = file.originalname;
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
    const r = await extractPdf(file.path, name);
    return { kind: 'pdf', name, text: r.text, meta: r.meta };
  }
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(name)) {
    const r = await extractImage(file.path, name, mime);
    return { kind: 'image', name, text: r.text, meta: r.meta };
  }
  const parser = parserForFile(name);
  if (parser) {
    const buf = await fs.readFile(file.path);
    const r = await parser.parse(buf);
    if (!r.text) throw new Error(`No readable text in "${name}".`);
    return { kind: parser.id, name, text: r.text, meta: r.meta || {} };
  }

  const text = clean(await fs.readFile(file.path, 'utf8'));
  if (!text) throw new Error(`"${name}" is empty.`);
  return { kind: 'text', name, text, meta: {} };
}
