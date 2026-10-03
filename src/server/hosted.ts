import {startWebServer} from './server.js'

// the public web server — `node dist/server.js`, configured by environment
//   PORT             port to listen on (default 4455)
//   YOINKS_PASSWORD  require this password (HTTP basic auth) — strongly advised
//   YOINKS_MAX_JOBS  downloads at once (default 3)
//   YOINKS_FILE_TTL  minutes finished files are kept (default 15)

const int = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const url = await startWebServer({
  port: int(process.env.PORT, 4455),
  open: false,
  hosted: {
    password: process.env.YOINKS_PASSWORD || undefined,
    maxJobs: int(process.env.YOINKS_MAX_JOBS, 3),
    fileTtlMs: int(process.env.YOINKS_FILE_TTL, 15) * 60 * 1000,
  },
})
console.log(`yoinks (hosted) → ${url}${process.env.YOINKS_PASSWORD ? ' · password protected' : ' · NO PASSWORD SET'}`)
await new Promise(() => {})
