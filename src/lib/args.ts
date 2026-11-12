import {isThemeMode, type ThemeMode} from '../theme.js'

export type Preset = 'mp3' | 'm4a' | 'best'

export type CliArgs = {
  help: boolean
  version: boolean
  initialUrl?: string
  themeMode?: ThemeMode
  /** Skip the format picker and download this straight away. */
  preset?: Preset
  /** Where downloads go, as typed — resolved by the caller. */
  outDir?: string
  /** Serve the web app instead of the terminal UI. */
  web?: boolean
  port?: number
  /** Don't open a browser tab for --web. */
  noOpen?: boolean
  /** Interface for --web to listen on (default loopback only). */
  host?: string
  /** Require this password. Also switches --web to the public mode. */
  password?: string
  /** Downloads running at once in the public mode. */
  maxJobs?: number
  /** Run the public mode with no password, on purpose. */
  allowPublic?: boolean
  error?: string
}

const PRESET_FLAGS: Record<string, Preset> = {'--mp3': 'mp3', '--m4a': 'm4a', '--best': 'best'}

/**
 * Addresses that only reach this computer. Literals only, and only the one
 * IPv4 literal every platform actually binds — a textual `127.` prefix would
 * let a name like `127.evil.example` pass as loopback, and `127.0.0.2` binds on
 * Linux but not on macOS.
 */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']
const isLoopbackHost = (host: string) => LOOPBACK.includes(host.trim().toLowerCase())

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {help: false, version: false}
  const positional: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-h' || arg === '--help') {
      result.help = true
    } else if (arg === '-v' || arg === '--version') {
      result.version = true
    } else if (arg === '--theme') {
      const value = args[++index]
      if (!value) return {...result, error: '--theme needs a value: auto, light, or dark'}
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg.startsWith('--theme=')) {
      const value = arg.slice('--theme='.length)
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg in PRESET_FLAGS) {
      const preset = PRESET_FLAGS[arg]!
      if (result.preset && result.preset !== preset) {
        return {...result, error: 'pick one of --mp3, --m4a, or --best'}
      }
      result.preset = preset
    } else if (arg === '-o' || arg === '--out') {
      const value = args[++index]
      if (!value) return {...result, error: `${arg} needs a folder`}
      result.outDir = value
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length)
      if (!value) return {...result, error: '--out needs a folder'}
      result.outDir = value
    } else if (arg === '--web') {
      result.web = true
    } else if (arg === '--no-open') {
      result.noOpen = true
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? args[++index] : arg.slice('--port='.length)
      const port = Number(value)
      if (!value || !Number.isInteger(port) || port < 1 || port > 65535) {
        return {...result, error: '--port needs a number between 1 and 65535'}
      }
      result.port = port
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      const value = arg === '--host' ? args[++index] : arg.slice('--host='.length)
      if (!value) return {...result, error: '--host needs an address, like 127.0.0.1 or 0.0.0.0'}
      result.host = value
    } else if (arg === '--password' || arg.startsWith('--password=')) {
      const value = (arg === '--password' ? args[++index] : arg.slice('--password='.length))?.trim()
      // a space is not a password — the env path refuses one, and so does this
      if (!value) return {...result, error: '--password needs a value'}
      result.password = value
    } else if (arg === '--max-jobs' || arg.startsWith('--max-jobs=')) {
      const value = arg === '--max-jobs' ? args[++index] : arg.slice('--max-jobs='.length)
      const jobs = Number(value)
      if (!value || !Number.isInteger(jobs) || jobs < 1) {
        return {...result, error: '--max-jobs needs a whole number of downloads, like 3'}
      }
      result.maxJobs = jobs
    } else if (arg === '--allow-public') {
      result.allowPublic = true
    } else if (arg.startsWith('-')) {
      return {...result, error: `unknown option “${arg}”`}
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) return {...result, error: 'expected a single url'}
  result.initialUrl = positional[0]

  const exposing =
    result.host !== undefined || result.password !== undefined || result.maxJobs !== undefined || result.allowPublic
  if (exposing && !result.web) {
    return {...result, error: '--host, --password, --max-jobs and --allow-public only work with --web'}
  }
  if (result.host && !isLoopbackHost(result.host) && !result.password && !result.allowPublic) {
    return {
      ...result,
      error: `--host ${result.host} exposes yoinks to your network — add --password, or --allow-public if you really mean an open downloader`,
    }
  }
  // accepting this and then ignoring it would be a lie
  if (result.maxJobs !== undefined && !result.password && !result.allowPublic) {
    return {...result, error: '--max-jobs only applies to the public mode — add --password or --allow-public'}
  }
  return result
}
