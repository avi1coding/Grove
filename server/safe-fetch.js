import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF guard. Every URL Grove fetches comes from the user, so a request must
 * never be allowed to reach loopback, link-local, or private address space —
 * that is how a study app becomes a proxy into someone's internal network.
 */

const BLOCKED_PORTS = new Set([22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017]);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||            // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||  // CGNAT
      a >= 224                                // multicast / reserved
    );
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    // IPv4-mapped. The URL parser normalises ::ffff:127.0.0.1 into the hex
    // form ::ffff:7f00:1, so both spellings have to be unpacked.
    const dotted = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = s.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true; // unparseable — refuse
}

export async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${String(rawUrl).slice(0, 80)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http and https links are supported (got ${u.protocol.replace(':', '')}).`);
  }
  if (u.port && BLOCKED_PORTS.has(Number(u.port))) {
    throw new Error(`Port ${u.port} is not allowed.`);
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('That address is on a private network.');
    return u;
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new Error('That address is on a private network.');
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve ${host}.`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That address resolves to a private network.');
  }
  return u;
}

/** Cap how much of a response we are willing to read into memory. */
export async function readCapped(res, maxBytes = 12 * 1024 * 1024, what = 'response') {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new Error(`That ${what} is too large (${(declared / 1e6).toFixed(1)}MB).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`That ${what} is too large (${(buf.length / 1e6).toFixed(1)}MB).`);
  return buf;
}
