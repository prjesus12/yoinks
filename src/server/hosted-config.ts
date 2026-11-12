/**
 * The hosted server's configuration, read once from the environment and
 * checked before anything listens. A public downloader with no password is an
 * open relay for anyone who finds the port, so a missing password is a
 * startup failure unless the operator says out loud that they mean it.
 */

export type HostedConfig = {
  password?: string
  /** Set only when the operator deliberately runs without a password. */
  allowPublic: boolean
  port: number
  maxJobs: number
  fileTtlMs: number
  maxPlaylist: number
  /** Probes one visitor may start per minute. */
  probeLimit: number
  /** Downloads one visitor may start per minute. */
  downloadLimit: number
  /** Probes running at once, across all visitors. */
  maxProbes: number
  /** Trust `x-forwarded-for` — only behind a proxy you control. */
  trustProxy: boolean
  cookiesFile?: string
  proxy?: string
  warnings: string[]
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const flag = (value: string | undefined): boolean => value === '1' || value?.toLowerCase() === 'true'

const MIN_PASSWORD = 8

export function hostedConfigFromEnv(env: Record<string, string | undefined>): HostedConfig {
  const password = env.YOINKS_PASSWORD?.trim() || undefined
  const allowPublic = flag(env.YOINKS_ALLOW_PUBLIC)
  if (!password && !allowPublic) {
    throw new Error(
      'YOINKS_PASSWORD is required — an open downloader gets abused fast. ' +
        'Set it, or set YOINKS_ALLOW_PUBLIC=1 if you really mean to run without one.',
    )
  }

  const warnings: string[] = []
  if (!password) warnings.push('no password set: anyone who finds this server can download through it')
  else if (password.length < MIN_PASSWORD) warnings.push(`that password is short — use at least ${MIN_PASSWORD} characters`)

  return {
    password,
    allowPublic,
    port: positiveInt(env.PORT, 4455),
    maxJobs: positiveInt(env.YOINKS_MAX_JOBS, 3),
    fileTtlMs: positiveInt(env.YOINKS_FILE_TTL, 15) * 60 * 1000,
    maxPlaylist: positiveInt(env.YOINKS_MAX_PLAYLIST, 50),
    probeLimit: positiveInt(env.YOINKS_PROBE_LIMIT, 12),
    downloadLimit: positiveInt(env.YOINKS_DOWNLOAD_LIMIT, 6),
    maxProbes: positiveInt(env.YOINKS_MAX_PROBES, 4),
    trustProxy: flag(env.YOINKS_TRUST_PROXY),
    cookiesFile: env.YOINKS_COOKIES || undefined,
    proxy: env.YOINKS_PROXY || undefined,
    warnings,
  }
}
