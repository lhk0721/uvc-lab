import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { Discovery } from './discovery'

// The renderer runs fully locked down; everything OS-facing (SSH, mDNS,
// filesystem, credentials) stays in this process and crosses only through
// the preload surface (spec section 9).
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => console.log('[main] window loaded'))

  // Any window.open / target=_blank goes to the OS browser, never to a new
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // ELECTRON_RENDERER_URL is set by `electron-vite dev` only.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Discovery result is main-owned push state: main sends, the renderer
// subscribes (`discovery:changed`). No identify hook yet — entries stay
// provisional (keyed by address) until ssh.ts lands in step 7.
const discovery = new Discovery({
  onUpdate: (jetsons) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('discovery:changed', jetsons)
    }
  }
})

app.whenReady().then(() => {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node
  }))

  ipcMain.handle('discovery:list', () => discovery.snapshot())
  ipcMain.handle('discovery:scan', () => discovery.scanNow())
  ipcMain.handle('discovery:addManual', (_event, host) => discovery.addManual(String(host)))
  ipcMain.handle('discovery:removeManual', (_event, host) => discovery.removeManual(String(host)))
  discovery.start()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => discovery.stop())
