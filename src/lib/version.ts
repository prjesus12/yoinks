/** yt-dlp versions are dates, sometimes with a patch: 2026.08.19, 2026.08.19.1 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(part => Number.parseInt(part, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}
