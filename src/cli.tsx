import React from 'react'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {render} from 'ink'
import {App, type Outcome} from './app.js'
import {captureFrames} from './lib/click-map.js'
import {parseArgs} from './lib/args.js'
import {loadConfig, resolveOptions, type Config} from './lib/config.js'
import {readClipboard} from './lib/clipboard.js'
import {isProbablyUrl} from './lib/platforms.js'

// read at runtime from the shipped package.json so npm version bumps
// can't drift from a hardcoded constant
const VERSION: string = createRequire(import.meta.url)('../package.json').version

const HELP = `
  yoinks — yoink any video. paste. yoink. done.

  Usage
    $ yoinks [options] [url]

  Examples
    $ yoinks https://youtu.be/dQw4w9WgXcQ
    $ yoinks https://x.com/user/status/123456
    $ yoinks --mp3 https://youtube.com/playlist?list=…   (every track, no questions)
    $ yoinks --m4a -o ~/Music https://youtu.be/dQw4w9WgXcQ
    $ yoinks                 (prompts for a url)

  Options
    --mp3           skip the picker: audio as mp3
    --m4a           skip the picker: audio as m4a (AAC, no re-encoding)
    --best          skip the picker: highest-resolution mp4
    -o, --out <dir> save here instead of ~/Downloads
    --web           open yoinks in your browser instead (runs locally)
    --port <n>      port for --web (default 4455)
    --host <addr>   --web: listen here (default 127.0.0.1). Anything but
                    loopback needs --password
    --password <pw> --web: require this password. Also switches to the public
                    mode, where files go to the browser instead of ~/Downloads
    --max-jobs <n>  --web: downloads at once in that mode (default 3)
    --allow-public  --web: expose it with no password, on purpose
    --template <t>  name downloads with a yt-dlp template (needs %(ext)s)
    --config <path> read settings from here instead of ~/.config/yoinks
    --theme <mode>  use auto, light, or dark for this run
    -h, --help      show this help
    -v, --version   show version

  With a url and --mp3, --m4a or --best, yoinks downloads, prints the
  path and exits — handy in scripts. Playlists go in an "Artist - Album"
  folder; audio comes with square cover art and clean title/artist tags.
  Powered by yt-dlp — YouTube, X, Instagram, Threads, TikTok & 1800+ sites.
`

const args = parseArgs(process.argv.slice(2))

if (args.error) {
  console.error(`yoinks: ${args.error}\nTry “yoinks --help” for usage.`)
  process.exit(1)
}

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

if (args.version) {
  console.log(VERSION)
  process.exit(0)
}

const expandHome = (dir: string) => (dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir)

// a broken config file is worth stopping for: it names the problem
let config: Config
try {
  config = args.configPath
    ? await loadConfig(path.resolve(expandHome(args.configPath)), {mustExist: true})
    : await loadConfig()
} catch (error) {
  console.error(`yoinks: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
// flags win over the config file, the config file over the defaults
const options = resolveOptions(
  {outDir: args.outDir, template: args.template, themeMode: args.themeMode, preset: args.preset},
  config,
)
const outDir = options.outDir ? path.resolve(expandHome(options.outDir)) : undefined

if (args.web) {
  // lazy: the terminal UI shouldn't pay for loading the server
  const {startWebServer} = await import('./server/server.js')
  const {hostedOptionsFromFlags} = await import('./server/hosted-config.js')
  // --password or --allow-public means the public mode: files go to the browser
  const publicMode = Boolean(args.password || args.allowPublic)
  if (args.password && args.password.length < 8) {
    console.error('! that password is short — use at least 8 characters')
  }
  const {url} = await startWebServer({
    port: args.port,
    open: !args.noOpen,
    outDir,
    // the hosted server defaults to every interface, which is right for
    // `node dist/server.js` and wrong for a flag the help calls loopback
    host: args.host ?? '127.0.0.1',
    template: options.template,
    hosted: publicMode ? hostedOptionsFromFlags({password: args.password, maxJobs: args.maxJobs}) : undefined,
  })
  console.log(
    `yoinks web → ${url}${publicMode ? (args.password ? ' · password protected' : ' · NO PASSWORD SET') : ''}\n\n` +
      (publicMode ? 'Serving your network. Press ^c to stop.' : 'Running on this computer only. Press ^c to stop.'),
  )
  // keep serving until ^c
  await new Promise(() => {})
}

const initialUrl = args.initialUrl
const initialThemeMode = options.themeMode

const isTTY = Boolean(process.stdout.isTTY)

// no url given — offer the clipboard url (⇥ to paste) when it already holds one
let clipboardUrl: string | undefined
if (!initialUrl && isTTY) {
  const clipped = readClipboard().trim()
  // reject multi-line clipboard content — new URL() silently strips newlines
  if (clipped && !/\s/.test(clipped) && isProbablyUrl(clipped)) clipboardUrl = clipped
}
const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H')
// also switch mouse tracking off — a crash can skip React effect cleanup
const leaveAltScreen = () => process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')

if (isTTY) {
  enterAltScreen()
  process.on('exit', leaveAltScreen)
  // restore the terminal BEFORE a crash prints, or the stack trace is
  // wiped along with the alternate screen and the app looks like it
  // silently quit
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      leaveAltScreen()
      console.error(error)
      process.exit(1)
    })
  }
}

let outcome: Outcome = {}
const {waitUntilExit} = render(
  <App
    initialUrl={initialUrl}
    clipboardUrl={clipboardUrl}
    initialThemeMode={initialThemeMode}
    preset={options.preset}
    outDir={outDir}
    template={options.template}
    onOutcome={result => (outcome = result)}
  />,
  // keep a copy of every frame so clicks can be hit-tested against it
  {stdout: captureFrames(process.stdout)},
)

await waitUntilExit()

if (isTTY) leaveAltScreen()
if (outcome.filepath) {
  console.log(`✓ yoinked → ${outcome.filepath}`)
} else if (outcome.error) {
  console.error(`yoinks: ${outcome.error}`)
  process.exitCode = 1
}
