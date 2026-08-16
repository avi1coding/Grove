import { config } from './config.js';

/**
 * Sentence-aware chunker. Chunks keep a hard link back to their source and the
 * exact character span they came from, which is what makes citation and
 * verification possible later.
 */
export function chunkText(text, { sourceId, sourceName, sourceKind }) {
  const size = config.pipeline.chunkChars;
  const overlap = config.pipeline.chunkOverlap;

  // Split on paragraph, then sentence, keeping offsets exact.
  const units = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n+|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (!raw.trim()) continue;
    units.push({ start: m.index, end: m.index + raw.length, text: raw });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (!units.length) units.push({ start: 0, end: text.length, text });

  const chunks = [];
  let cur = [];
  let curLen = 0;

  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start;
    const end = cur[cur.length - 1].end;
    const body = text.slice(start, end).trim();
    if (body.length > 40 || chunks.length === 0) {
      // start/end are the exact span of `body` in the source, so a citation can
      // always be located again in the original document.
      const lead = text.slice(start, end).length - text.slice(start, end).trimStart().length;
      chunks.push({
        id: `${sourceId}#${chunks.length}`,
        sourceId,
        sourceName,
        sourceKind,
        index: chunks.length,
        start: start + lead,
        end: start + lead + body.length,
        text: body,
      });
    }
    // Carry overlap into the next chunk.
    const keep = [];
    let kept = 0;
    for (let i = cur.length - 1; i >= 0 && kept < overlap; i--) {
      keep.unshift(cur[i]);
      kept += cur[i].text.length;
    }
    cur = keep;
    curLen = kept;
  };

  for (const u of units) {
    if (curLen + u.text.length > size && curLen > 0) flush();
    cur.push(u);
    curLen += u.text.length;
    // A single monstrous unit (no punctuation) still has to be cut. flush()
    // leaves an overlap tail behind, so clear it or the next flush re-emits
    // exactly the same span.
    if (curLen > size * 2) {
      flush();
      cur = [];
      curLen = 0;
    }
  }
  flush();
  return chunks;
}
