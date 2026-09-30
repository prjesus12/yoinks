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
  error?: string
}

const PRESET_FLAGS: Record<string, Preset> = {'--mp3': 'mp3', '--m4a': 'm4a', '--best': 'best'}

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
    } else if (arg.startsWith('-')) {
      return {...result, error: `unknown option “${arg}”`}
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) return {...result, error: 'expected a single url'}
  result.initialUrl = positional[0]
  return result
}
