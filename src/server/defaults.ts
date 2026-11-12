/**
 * The hosted server's defaults, in one place.
 *
 * Three callers start from these numbers: the environment parser
 * (`hosted-config.ts`), the `--web --password` flags (same file) and the state
 * factory (`state.ts`, which builds the rate limiters). They used to be copied
 * into two modules that happened to agree; the whole point of this file is that
 * they cannot drift.
 */
export const HOSTED_DEFAULTS = {
  port: 4455,
  maxJobs: 3,
  fileTtlMs: 15 * 60 * 1000,
  maxPlaylist: 50,
  /** Probes one visitor may start per minute. */
  probeLimit: 12,
  /** Downloads one visitor may start per minute. */
  downloadLimit: 6,
  /** Probes running at once, across all visitors. */
  maxProbes: 4,
  /** Only the environment can turn this on: the flag path never trusts a header it cannot see. */
  trustProxy: false,
} as const
