/**
 * Splits a growing text/event-stream body into `data:` payloads. Feed it the
 * whole body so far; it returns only the events it hasn't returned before.
 */
export function sseReader() {
  let seen = 0
  return (body: string): string[] => {
    const out: string[] = []
    let end: number
    while ((end = body.indexOf('\n\n', seen)) !== -1) {
      const data = body
        .slice(seen, end)
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data) out.push(data)
      seen = end + 2
    }
    return out
  }
}
