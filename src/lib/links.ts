/** Every http(s) link in pasted text — one per line, or separated by spaces. Duplicates are dropped. */
export function splitLinks(text: string): string[] {
  const links = text
    .split(/\s+/)
    .map(part => part.trim())
    .filter(part => /^https?:\/\/\S+$/i.test(part))
  return [...new Set(links)]
}

/** Run `run` over every item, at most `limit` at a time. Resolves once all are over. */
export async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!
      try {
        await run(item)
      } catch {
        // one failure never stops the others
      }
    }
  }
  await Promise.all(Array.from({length: Math.max(0, Math.min(limit, items.length))}, worker))
}
