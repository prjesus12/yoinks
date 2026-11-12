import {EXTRA_ARGS} from '../lib/ytdlp.js'
import {hostedConfigFromEnv} from './hosted-config.js'
import {startWebServer} from './server.js'

// the public web server — `node dist/server.js`, configured by environment
//   PORT                  port to listen on (default 4455)
//   YOINKS_PASSWORD       required (HTTP basic auth); YOINKS_ALLOW_PUBLIC=1 skips it on purpose
//   YOINKS_MAX_JOBS       downloads at once (default 3)
//   YOINKS_FILE_TTL       minutes finished files are kept (default 15)
//   YOINKS_COOKIES        starting cookies.txt (otherwise upload one from the page)
//   YOINKS_PROXY          proxy for yt-dlp, e.g. http://user:pass@host:port (residential works best)
//   YOINKS_MAX_PLAYLIST   longest playlist accepted (default 50)
//   YOINKS_PROBE_LIMIT    probes one visitor may start per minute (default 12)
//   YOINKS_DOWNLOAD_LIMIT downloads one visitor may start per minute (default 6)
//   YOINKS_MAX_PROBES     probes running at once, all visitors together (default 4)
//   YOINKS_TRUST_PROXY    set to 1 behind a proxy you control, so limits key off x-forwarded-for

const config = readConfig()

/** Refuse to start rather than run an open downloader. */
function readConfig(): ReturnType<typeof hostedConfigFromEnv> {
  try {
    return hostedConfigFromEnv(process.env)
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

for (const warning of config.warnings) console.error(`! ${warning}`)
if (config.proxy) EXTRA_ARGS.push('--proxy', config.proxy)

const {url} = await startWebServer({
  port: config.port,
  open: false,
  hosted: {
    password: config.password,
    maxJobs: config.maxJobs,
    fileTtlMs: config.fileTtlMs,
    maxPlaylist: config.maxPlaylist,
    probeLimit: config.probeLimit,
    downloadLimit: config.downloadLimit,
    maxProbes: config.maxProbes,
    trustProxy: config.trustProxy,
    cookiesFile: config.cookiesFile,
  },
})
console.log(`yoinks (hosted) → ${url}${config.password ? ' · password protected' : ' · NO PASSWORD SET'}`)
await new Promise(() => {})
