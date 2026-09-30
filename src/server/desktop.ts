import {spawn} from 'node:child_process'
import path from 'node:path'

// the bits of the web UI that need the desktop: a native folder dialog and
// "show in Finder". The server runs on the user's own machine, so these open
// right in front of them.

function run(cmd: string, args: string[]): Promise<{code: number | null; stdout: string}> {
  return new Promise(resolve => {
    let stdout = ''
    let child
    try {
      child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'ignore']})
    } catch {
      resolve({code: null, stdout})
      return
    }
    child.stdout.on('data', chunk => (stdout += chunk))
    child.on('error', () => resolve({code: null, stdout}))
    child.on('close', code => resolve({code, stdout}))
  })
}

const appleScriptString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const powershellString = (value: string) => `'${value.replace(/'/g, "''")}'`

export async function folderPickerAvailable(): Promise<boolean> {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return (await run('zenity', ['--version'])).code === 0
}

/** The folder the user picked, or undefined if they cancelled. */
export async function chooseFolder(current: string): Promise<string | undefined> {
  const prompt = 'Save downloads to'
  let result: {code: number | null; stdout: string}
  if (process.platform === 'darwin') {
    // shown by the frontmost app (the browser) so the dialog opens on top of
    // it, not behind; apps that can't host it fall back to osascript's own
    const choose = `choose folder with prompt ${appleScriptString(prompt)} default location (POSIX file ${appleScriptString(current)})`
    const script = [
      'set picked to missing value',
      'try',
      '  tell application (path to frontmost application as text)',
      '    activate',
      `    set picked to ${choose}`,
      '  end tell',
      'on error number errorNumber',
      '  if errorNumber is -128 then error number -128',
      '  activate',
      `  set picked to ${choose}`,
      'end try',
      'POSIX path of picked',
    ].join('\n')
    result = await run('osascript', ['-e', script])
  } else if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = ${powershellString(prompt)}`,
      `$d.SelectedPath = ${powershellString(current)}`,
      "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }",
    ].join('; ')
    result = await run('powershell', ['-NoProfile', '-STA', '-Command', script])
  } else {
    result = await run('zenity', ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${current}/`])
  }
  const picked = result.stdout.trim().replace(/[/\\]$/, '')
  return result.code === 0 && picked ? picked : undefined
}

/** Open the file manager at a download: select a file, open a folder. */
export function reveal(target: string, isFolder: boolean) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', isFolder ? [target] : ['-R', target]]
      : process.platform === 'win32'
        ? ['explorer', [isFolder ? target : `/select,${target}`]]
        : ['xdg-open', [isFolder ? target : path.dirname(target)]]
  spawn(cmd, args, {stdio: 'ignore', detached: true}).on('error', () => {}).unref()
}

export function revealLabel(): string {
  if (process.platform === 'darwin') return 'Show in Finder'
  if (process.platform === 'win32') return 'Show in Explorer'
  return 'Open folder'
}
