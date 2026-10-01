import {app, BrowserWindow, dialog, nativeTheme, shell} from 'electron'
import {activeDownloads, startWebServer} from '../server/server.js'

// The desktop app is the web UI in its own window: the same local server
// runs inside the app, and the window loads it. Native dialogs replace the
// scripted ones the browser version uses.

app.setName('yoinks')

let win: BrowserWindow | undefined
let baseUrl = ''

// one app, one server — a second launch just focuses the first
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

function openExternal(url: string) {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url)
}

async function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 840,
    minWidth: 420,
    minHeight: 560,
    title: 'yoinks',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#fafafa',
    // macOS: content runs under the traffic lights; the page's header is the drag area
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false},
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = undefined))

  // the window only ever shows yoinks; anything else opens in the browser
  win.webContents.setWindowOpenHandler(({url}) => {
    openExternal(url)
    return {action: 'deny'}
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(baseUrl)) return
    event.preventDefault()
    openExternal(url)
  })

  await win.loadURL(`${baseUrl}/?shell=${process.platform}`)
}

app.on('before-quit', event => {
  const running = activeDownloads()
  if (running === 0) return
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Quit', 'Keep downloading'],
    defaultId: 1,
    cancelId: 1,
    message: running === 1 ? 'A download is still running.' : `${running} downloads are still running.`,
    detail: 'Quitting stops it. Files that already finished stay where they are.',
  })
  if (choice === 1) event.preventDefault()
})

app.on('window-all-closed', () => {
  // macOS apps stay in the dock (downloads keep going); elsewhere closing quits
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (baseUrl && BrowserWindow.getAllWindows().length === 0) void createWindow()
})

void app.whenReady().then(async () => {
  try {
    baseUrl = await startWebServer({
      port: 0, // any free port — never clashes with `yoinks --web`
      open: false,
      preferManagedYtDlp: true,
      desktop: {
        canChooseFolder: true,
        revealLabel:
          process.platform === 'darwin' ? 'Show in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Open folder',
        chooseFolder: async current => {
          const options = {
            title: 'Save downloads to',
            buttonLabel: 'Choose',
            defaultPath: current,
            properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
          }
          const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
          return result.canceled ? undefined : result.filePaths[0]
        },
        reveal: (target, isFolder) => {
          if (isFolder) void shell.openPath(target)
          else shell.showItemInFolder(target)
        },
      },
    })
    await createWindow()
  } catch (error) {
    dialog.showErrorBox('yoinks couldn’t start', error instanceof Error ? error.message : String(error))
    app.quit()
  }
})
