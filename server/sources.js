import fs from 'node:fs/promises';
import { readZipEntries, xmlToText } from './zip.js';
import { assertPublicUrl } from './safe-fetch.js';

/**
 * The source catalogue: every kind of material Grove can ingest.
 *
 * Two engines do the real work — a file parser and a URL fetcher — and each
 * entry here adds the format- or site-specific handling on top.
 */

const clean = (s) =>
  String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function get(url, { headers = {}, ms = 20_000 } = {}) {
  await assertPublicUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ac.signal });
    if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timed out fetching ${new URL(url).host}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const decodeEntities = (s) =>
  String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

export function htmlToText(html) {
  return clean(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((l) => decodeEntities(l).replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n'),
  );
}

/* ══════════════════════════════════════════════════ file parsers ══════ */

const stripTimecodes = (t) =>
  clean(
    t
      .replace(/^WEBVTT.*$/gm, '')
      .replace(/^\d+$/gm, '')
      .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->.*$/gm, '')
      .replace(/<[^>]+>/g, ''),
  );

export const FILE_PARSERS = [
  {
    id: 'srt', label: 'Subtitles', ext: ['.srt', '.vtt'],
    parse: async (b) => ({ text: stripTimecodes(b.toString('utf8')) }),
  },
  {
    id: 'docx', label: 'Word', ext: ['.docx'],
    parse: async (b) => {
      const e = readZipEntries(b, (n) => n === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(n));
      const doc = e.get('word/document.xml');
      if (!doc) throw new Error('No document body found in this .docx');
      return { text: xmlToText(doc.toString('utf8')) };
    },
  },
  {
    id: 'pptx', label: 'PowerPoint', ext: ['.pptx'],
    parse: async (b) => {
      const e = readZipEntries(b, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      const slides = [...e.entries()]
        .sort((a, x) => Number(a[0].match(/\d+/)[0]) - Number(x[0].match(/\d+/)[0]))
        .map(([n, buf], i) => `Slide ${i + 1}\n${xmlToText(buf.toString('utf8'))}`);
      if (!slides.length) throw new Error('No slides found in this .pptx');
      return { text: clean(slides.join('\n\n')), meta: { slides: slides.length } };
    },
  },
  {
    id: 'xlsx', label: 'Excel', ext: ['.xlsx'],
    parse: async (b) => {
      const e = readZipEntries(b, (n) => n === 'xl/sharedStrings.xml');
      const shared = e.get('xl/sharedStrings.xml');
      if (!shared) throw new Error('No text content found in this spreadsheet');
      const cells = [...shared.toString('utf8').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]));
      return { text: clean(cells.join('\n')), meta: { cells: cells.length } };
    },
  },
  {
    id: 'epub', label: 'EPUB', ext: ['.epub'],
    parse: async (b) => {
      const e = readZipEntries(b, (n) => /\.x?html?$/i.test(n));
      const parts = [...e.entries()].sort((a, x) => a[0].localeCompare(x[0], undefined, { numeric: true }));
      const text = clean(parts.map(([, buf]) => htmlToText(buf.toString('utf8'))).join('\n\n'));
      if (!text) throw new Error('No readable chapters in this EPUB');
      return { text, meta: { chapters: parts.length } };
    },
  },
  {
    id: 'html', label: 'HTML file', ext: ['.html', '.htm'],
    parse: async (b) => ({ text: htmlToText(b.toString('utf8')) }),
  },
  {
    id: 'csv', label: 'CSV', ext: ['.csv', '.tsv'],
    parse: async (b) => {
      const rows = b.toString('utf8').split('\n').filter(Boolean);
      const sep = rows[0].includes('\t') ? '\t' : ',';
      const head = rows[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ''));
      // Turn rows into sentences so retrieval and quoting behave sensibly.
      const body = rows.slice(1, 4000).map((r) => {
        const cells = r.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
        return head.map((h, i) => `${h}: ${cells[i] ?? ''}`).join('; ');
      });
      return { text: clean([head.join(' | '), ...body].join('\n')), meta: { rows: body.length } };
    },
  },
  {
    id: 'json', label: 'JSON', ext: ['.json'],
    parse: async (b) => {
      const flat = [];
      const walk = (v, path = '') => {
        if (v && typeof v === 'object') {
          for (const [k, val] of Object.entries(v)) walk(val, path ? `${path}.${k}` : k);
        } else if (v != null && String(v).trim()) {
          flat.push(`${path}: ${v}`);
        }
      };
      walk(JSON.parse(b.toString('utf8')));
      return { text: clean(flat.join('\n')), meta: { fields: flat.length } };
    },
  },
  {
    id: 'code', label: 'Code', ext: ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.rb', '.sql', '.sh'],
    parse: async (b) => ({ text: clean(b.toString('utf8')) }),
  },
];

export function parserForFile(name) {
  const lower = String(name).toLowerCase();
  return FILE_PARSERS.find((p) => p.ext.some((e) => lower.endsWith(e))) || null;
}

/* ══════════════════════════════════════════════════ url handlers ══════ */

export const URL_HANDLERS = [
  {
    id: 'wikipedia', label: 'Wikipedia',
    match: (u) => /(^|\.)wikipedia\.org$/.test(u.hostname),
    fetch: async (u) => {
      const rawTitle = u.pathname.split('/wiki/')[1] || '';
      let title;
      try {
        title = decodeURIComponent(rawTitle).replace(/_/g, ' ');
      } catch {
        throw new Error('That Wikipedia URL is malformed.');
      }
      if (!title) throw new Error('That does not look like a Wikipedia article URL');
      const api = `https://${u.hostname}/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${encodeURIComponent(title)}`;
      const data = await (await get(api)).json();
      const page = Object.values(data.query.pages)[0];
      if (!page?.extract) throw new Error(`No Wikipedia article found for "${title}"`);
      return { name: page.title, text: clean(page.extract) };
    },
  },
  {
    id: 'arxiv', label: 'arXiv',
    match: (u) => /arxiv\.org$/.test(u.hostname),
    fetch: async (u) => {
      const id = (u.pathname.match(/(?:abs|pdf)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?$/) || [])[1];
      if (!id) throw new Error('Could not read an arXiv id from that URL');
      const xml = await (await get(`http://export.arxiv.org/api/query?id_list=${id}`)).text();
      const title = decodeEntities((xml.match(/<title>([\s\S]*?)<\/title>/g) || [])[1]?.replace(/<\/?title>/g, '') || id);
      const summary = decodeEntities((xml.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '');
      const authors = [...xml.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]).join(', ');
      if (!summary.trim()) throw new Error(`arXiv returned nothing for ${id}`);
      return {
        name: clean(title),
        text: clean(`${title}\n\nAuthors: ${authors}\n\nAbstract\n${summary}`),
        meta: { arxivId: id, abstractOnly: true },
      };
    },
  },
  {
    id: 'github', label: 'GitHub',
    match: (u) => u.hostname === 'github.com' || u.hostname === 'raw.githubusercontent.com',
    fetch: async (u) => {
      if (u.hostname === 'raw.githubusercontent.com') {
        return { name: u.pathname.split('/').pop(), text: clean(await (await get(u.href)).text()) };
      }
      const [, owner, repo, kind, ...rest] = u.pathname.split('/');
      if (!owner || !repo) throw new Error('That is not a GitHub repo or file URL');
      if (kind === 'blob') {
        const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`;
        return { name: `${repo}/${rest.slice(1).join('/')}`, text: clean(await (await get(raw)).text()) };
      }
      const meta = await (await get(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: { Accept: 'application/vnd.github.raw' },
      })).text();
      return { name: `${owner}/${repo} README`, text: clean(meta) };
    },
  },
  {
    id: 'reddit', label: 'Reddit',
    match: (u) => /(^|\.)reddit\.com$/.test(u.hostname),
    fetch: async (u) => {
      const path = `${u.pathname.replace(/\/$/, '')}.json?limit=200`;
      let json = null;
      let blocked = false;
      for (const host of ['https://old.reddit.com', 'https://www.reddit.com']) {
        try {
          json = await (await get(host + path)).json();
          break;
        } catch (err) {
          if (/ returned 40[13]/.test(err.message)) blocked = true;
        }
      }
      if (!json && blocked) {
        throw new Error('Reddit is blocking automated access — open the thread and paste its text instead.');
      }
      const post = json?.[0]?.data?.children?.[0]?.data;
      if (!post) throw new Error('Could not read that Reddit thread');
      const comments = (json[1]?.data?.children || [])
        .map((c) => c.data?.body)
        .filter((b) => b && b !== '[deleted]')
        .slice(0, 120);
      return {
        name: post.title,
        text: clean([post.title, post.selftext, ...comments].filter(Boolean).join('\n\n')),
        meta: { subreddit: post.subreddit, comments: comments.length },
      };
    },
  },
  {
    id: 'hackernews', label: 'Hacker News',
    match: (u) => /news\.ycombinator\.com$/.test(u.hostname) && !/rss/i.test(u.pathname),
    fetch: async (u) => {
      const id = u.searchParams.get('id');
      if (!id) throw new Error('That URL has no Hacker News item id');
      const item = await (await get(`https://hn.algolia.com/api/v1/items/${id}`)).json();
      const out = [];
      const walk = (n, d = 0) => {
        if (n.title) out.push(n.title);
        if (n.text) out.push(htmlToText(n.text));
        (n.children || []).slice(0, 200).forEach((c) => walk(c, d + 1));
      };
      walk(item);
      return { name: item.title || `HN ${id}`, text: clean(out.join('\n\n')) };
    },
  },
  {
    id: 'stackoverflow', label: 'Stack Overflow',
    match: (u) => /(stackoverflow|superuser|serverfault|askubuntu)\.com$/.test(u.hostname) || /stackexchange\.com$/.test(u.hostname),
    fetch: async (u) => {
      const id = (u.pathname.match(/\/questions\/(\d+)/) || [])[1];
      if (!id) throw new Error('That is not a Stack Exchange question URL');
      const site = u.hostname.replace(/\.com$/, '').replace('.stackexchange', '');
      const base = `https://api.stackexchange.com/2.3`;
      const q = await (await get(`${base}/questions/${id}?site=${site}&filter=withbody`)).json();
      const a = await (await get(`${base}/questions/${id}/answers?site=${site}&filter=withbody&sort=votes&pagesize=10`)).json();
      const question = q.items?.[0];
      if (!question) throw new Error('Question not found');
      const answers = (a.items || []).map((x, i) => `Answer ${i + 1}${x.is_accepted ? ' (accepted)' : ''}\n${htmlToText(x.body)}`);
      return {
        name: decodeEntities(question.title),
        text: clean([decodeEntities(question.title), htmlToText(question.body), ...answers].join('\n\n')),
        meta: { answers: answers.length },
      };
    },
  },
  {
    id: 'rss', label: 'RSS / Atom',
    match: (u) =>
      /\.(rss|atom|xml)$/i.test(u.pathname) ||
      /(^|\/)(feed|rss|atom|frontpage)\/?$/i.test(u.pathname) ||
      /(^|\.)(hnrss|feeds?)\./i.test(u.hostname),
    fetch: async (u) => {
      const xml = await (await get(u.href)).text();
      const items = [...xml.matchAll(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/g)].slice(0, 40).map((m) => {
        const b = m[0];
        const t = decodeEntities((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '');
        const c = (b.match(/<(?:description|summary|content[^>]*)>([\s\S]*?)<\/(?:description|summary|content)>/) || [])[1] || '';
        return `${t}\n${htmlToText(c.replace(/<!\[CDATA\[|\]\]>/g, ''))}`;
      });
      if (!items.length) throw new Error('No entries found in that feed');
      return { name: decodeEntities((xml.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || u.hostname), text: clean(items.join('\n\n')), meta: { entries: items.length } };
    },
  },
  {
    id: 'gdocs', label: 'Google Docs',
    match: (u) => u.hostname === 'docs.google.com',
    fetch: async (u) => {
      const id = (u.pathname.match(/\/d\/(?:e\/)?([\w-]+)/) || [])[1];
      if (!id) throw new Error('Could not read a document id from that URL');
      const res = await get(`https://docs.google.com/document/d/${id}/export?format=txt`);
      const text = clean(await res.text());
      if (!text || /^<!DOCTYPE/i.test(text)) {
        throw new Error('That Google Doc is not publicly shared — set link sharing to "anyone with the link".');
      }
      return { name: 'Google Doc', text };
    },
  },
  {
    id: 'plaintext', label: 'Plain text URL',
    match: (u) => /\.(txt|md|markdown)$/i.test(u.pathname),
    fetch: async (u) => ({ name: u.pathname.split('/').pop(), text: clean(await (await get(u.href)).text()) }),
  },
  {
    id: 'pdfurl', label: 'PDF link',
    match: (u) => /\.pdf$/i.test(u.pathname),
    fetch: async (u, { parsePdfBuffer }) => {
      const buf = Buffer.from(await (await get(u.href, { ms: 40_000 })).arrayBuffer());
      const { text, meta } = await parsePdfBuffer(buf, u.pathname.split('/').pop());
      return { name: u.pathname.split('/').pop(), text, meta };
    },
  },
];

/** Parse feed XML that arrived from a URL we did not recognise up front. */
export function parseFeedXml(xml, fallbackName) {
  const items = [...xml.matchAll(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/g)].slice(0, 40).map((m) => {
    const b = m[0];
    const t = decodeEntities((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '');
    const c = (b.match(/<(?:description|summary|content[^>]*)>([\s\S]*?)<\/(?:description|summary|content)>/) || [])[1] || '';
    return `${t}\n${htmlToText(c.replace(/<!\[CDATA\[|\]\]>/g, ''))}`;
  });
  if (!items.length) return null;
  return {
    name: decodeEntities((xml.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || fallbackName),
    text: clean(items.join('\n\n')),
    meta: { entries: items.length },
  };
}

export function looksLikeFeed(body) {
  const head = body.slice(0, 600);
  return /<\?xml/i.test(head) && /<(rss|feed)[\s>]/i.test(body.slice(0, 4000));
}

export function handlerForUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return URL_HANDLERS.find((h) => h.match(u)) || null;
}

/* The catalogue the UI renders. Every entry maps to real handling above. */
export const CATALOGUE = [
  { id: 'paste', label: 'Paste text', input: 'text', hint: 'Notes, transcript, anything' },
  { id: 'pdf', label: 'PDF', input: 'file', accept: '.pdf' },
  { id: 'image', label: 'Image (OCR)', input: 'file', accept: '.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff' },
  { id: 'docx', label: 'Word', input: 'file', accept: '.docx' },
  { id: 'pptx', label: 'Slides', input: 'file', accept: '.pptx' },
  { id: 'xlsx', label: 'Spreadsheet', input: 'file', accept: '.xlsx' },
  { id: 'epub', label: 'EPUB', input: 'file', accept: '.epub' },
  { id: 'txt', label: 'Text / MD', input: 'file', accept: '.txt,.md' },
  { id: 'csv', label: 'CSV', input: 'file', accept: '.csv,.tsv' },
  { id: 'json', label: 'JSON', input: 'file', accept: '.json' },
  { id: 'htmlfile', label: 'HTML file', input: 'file', accept: '.html,.htm' },
  { id: 'srt', label: 'Subtitles', input: 'file', accept: '.srt,.vtt' },
  { id: 'code', label: 'Code file', input: 'file', accept: '.js,.ts,.py,.java,.c,.cpp,.go,.rs,.rb,.sql,.sh' },
  { id: 'audio', label: 'Audio', input: 'file', accept: '.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac', hint: 'transcribed with Whisper' },
  { id: 'video', label: 'Video', input: 'file', accept: '.mp4,.mov,.m4v,.webm,.mkv', hint: 'audio is transcribed' },
  { id: 'youtube', label: 'YouTube', input: 'url', hint: 'captions, or transcribed if it has none' },
  { id: 'playlist', label: 'YT playlist', input: 'url', hint: 'youtube.com/playlist?list=…' },
  { id: 'wikipedia', label: 'Wikipedia', input: 'url', hint: 'wikipedia.org/wiki/…' },
  { id: 'arxiv', label: 'arXiv', input: 'url', hint: 'arxiv.org/abs/…' },
  { id: 'github', label: 'GitHub', input: 'url', hint: 'repo or file URL' },
  { id: 'gdocs', label: 'Google Doc', input: 'url', hint: 'shared link' },
  { id: 'reddit', label: 'Reddit', input: 'url', hint: 'thread URL' },
  { id: 'hackernews', label: 'Hacker News', input: 'url', hint: 'item?id=…' },
  { id: 'stackoverflow', label: 'Stack Overflow', input: 'url', hint: 'question URL' },
  { id: 'rss', label: 'RSS feed', input: 'url', hint: 'feed or .xml URL' },
  { id: 'pdfurl', label: 'PDF link', input: 'url', hint: 'direct .pdf URL' },
  { id: 'article', label: 'Any article', input: 'url', hint: 'blog, docs, news' },
];

export { clean, get, decodeEntities };
