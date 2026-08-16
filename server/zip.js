import zlib from 'node:zlib';

/**
 * Minimal ZIP reader — enough to pull text out of the OOXML/EPUB family
 * (.docx, .pptx, .xlsx, .epub) without pulling in a dependency.
 * Reads the central directory, then inflates only the entries asked for.
 */
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;   // one member
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;   // whole archive

export function readZipEntries(buf, wantPath = () => true) {
  let inflatedTotal = 0;
  // End of central directory record: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid zip archive');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count && ptr + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!wantPath(name)) continue;

    // Refuse before inflating: the central directory already declares the size.
    if (uncompSize > MAX_ENTRY_BYTES || inflatedTotal + uncompSize > MAX_TOTAL_BYTES) {
      throw Object.assign(
        new Error('That archive expands to too much data and was rejected.'),
        { status: 413 },
      );
    }

    // Local header tells us where the data actually starts.
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    // A 40MB upload can inflate to gigabytes; refuse rather than exhaust memory.
    try {
      const data =
        method === 0
          ? raw
          : zlib.inflateRawSync(raw, {
              maxOutputLength: Math.max(1, Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - inflatedTotal)),
            });
      inflatedTotal += data.length;
      if (inflatedTotal > MAX_TOTAL_BYTES) {
        throw Object.assign(new Error('That archive expands to too much data and was rejected.'), { zipBomb: true });
      }
      out.set(name, data);
    } catch (err) {
      // Propagate refusals; skip merely-corrupt members.
      if (err.zipBomb || err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too much data/i.test(String(err.message))) {
        throw Object.assign(new Error('That archive expands to too much data and was rejected.'), { status: 413 });
      }
    }
  }
  return out;
}

/** Strip XML tags, keeping paragraph and line breaks as newlines. */
export function xmlToText(xml, { breakTags = ['w:p', 'a:p', 'p', 'br', 'div', 'li', 'h1', 'h2', 'h3'] } = {}) {
  let s = String(xml);
  for (const t of breakTags) {
    s = s.replace(new RegExp(`</${t}>`, 'gi'), '\n');
    s = s.replace(new RegExp(`<${t}/>`, 'gi'), '\n');
  }
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
