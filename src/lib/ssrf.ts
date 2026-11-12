/**
 * The hosted server runs yt-dlp on whatever a visitor pastes, from its own
 * network position — which is the shape of an SSRF hole: point it at
 * 169.254.169.254 or 10.0.0.5 and the answer comes back to the visitor.
 * These helpers refuse anything that isn't a public http(s) link.
 *
 * Only the host as written is checked, so a public name that resolves to a
 * private address still gets through. Resolving here would just move the
 * race somewhere less visible; a resolver-level guard is the real fix.
 */

import {lookup} from 'node:dns/promises'

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the cloud metadata endpoint
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
]

/** Suffixes that only ever resolve inside a private network. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.corp', '.home.arpa', '.intranet']

function parseIpv4(host: string): number | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

/** 16-bit groups of an IPv6 literal, `::` expanded. */
function expandIpv6(host: string): number[] | undefined {
  const halves = host.split('::')
  if (halves.length > 2) return undefined
  const groups = (part: string): string[] => {
    if (!part) return []
    const out = part.split(':')
    // a trailing dotted IPv4 stands for the last two groups
    const last = out.at(-1)
    if (last && last.includes('.')) {
      const v4 = parseIpv4(last)
      if (v4 === undefined) return []
      out.splice(-1, 1, ((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16))
    }
    return out
  }
  const head = groups(halves[0] ?? '')
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined
  const full = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail]
  const parsed = full.map(group => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN))
  return parsed.every(group => Number.isInteger(group)) ? parsed : undefined
}

function isPrivateIpv6(host: string): boolean {
  const groups = expandIpv6(host)
  // a malformed literal is not something to fetch from either
  if (!groups) return true
  const leading = groups.slice(0, 5).every(group => group === 0)
  if (leading && groups[5] === 0 && groups[6] === 0 && groups[7] === 0) return true // ::
  if (leading && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true // ::1
  if (leading && groups[5] === 0xffff) {
    // ::ffff:a.b.c.d — an IPv4 address wearing a hat
    return isPrivateIpv4((((groups[6] ?? 0) << 16) | (groups[7] ?? 0)) >>> 0)
  }
  const first = groups[0] ?? 0
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // multicast
  return false
}

function isPrivateIpv4(value: number): boolean {
  return PRIVATE_V4.some(([network, prefix]) => {
    const base = parseIpv4(network)!
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (value & mask) >>> 0 === (base & mask) >>> 0
  })
}

/** True for anything a public server must never fetch on a visitor's behalf. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!host) return true
  if (host.includes(':')) return isPrivateIpv6(host)
  const v4 = parseIpv4(host)
  if (v4 !== undefined) return isPrivateIpv4(v4)
  if (host === 'localhost') return true
  if (PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) return true
  // a single label has no public meaning — the resolver fills it in locally
  if (!host.includes('.')) return true
  return false
}

/**
 * Validate a visitor-supplied link for the hosted server. Throws with a
 * message meant for the person who pasted it.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('That doesn’t look like a link — paste a full URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https links work here.')
  }
  if (url.username || url.password) {
    throw new Error('Links with a username or password in them are not allowed.')
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error('That link points to a private or local address — paste a public link.')
  }
  return url
}

export function isPublicUrl(raw: string): boolean {
  try {
    assertPublicUrl(raw)
    return true
  } catch {
    return false
  }
}

export type HostResolver = (hostname: string) => Promise<string[]>

const resolveWithDns: HostResolver = async hostname => {
  const records = await lookup(hostname, {all: true, verbatim: true})
  return records.map(record => record.address)
}

/**
 * The guard above only sees the host as written, and a public-looking name can
 * resolve straight back inside (`127.0.0.1.nip.io` is a working example). So
 * resolve it first and check every address it lands on.
 *
 * This narrows the window rather than closing it: yt-dlp resolves the name
 * again itself, and a redirect it follows afterwards is out of reach here.
 * Pinning the address would mean fetching through our own resolver, which is a
 * much bigger change than this guard.
 */
export async function assertPublicUrlResolved(raw: string, resolve: HostResolver = resolveWithDns): Promise<URL> {
  const url = assertPublicUrl(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // a literal address was already checked; only names need a lookup
  if (host.includes(':') || parseIpv4(host) !== undefined) return url
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    // it doesn't resolve at all — let yt-dlp say so in its own words
    return url
  }
  if (addresses.some(address => isPrivateHost(address))) {
    throw new Error('That link points to a private or local address — paste a public link.')
  }
  return url
}
