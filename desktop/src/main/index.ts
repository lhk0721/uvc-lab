import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { join, resolve } from 'node:path'
import { Discovery } from './discovery.ts'
import { CredentialStore, type CredentialCipher } from './credentials.ts'
import { makeIdentify, SshPool, type SshSession } from './ssh.ts'
import { Provisioner, startServer, stopServer, type ProvisionRunOptions } from './provision.ts'
import { TunnelManager } from './tunnel.ts'
import { jetsonGet, jetsonPost, jetsonPut, JetsonHttpError } from './jetson-http.ts'

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

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// safeStorage is the cipher, CredentialStore owns the file. The design's
// no-plaintext rule: unavailable encryption (or Linux basic_text) means
// nothing is persisted and the app asks each run.
const cipher: CredentialCipher = {
  available: () => {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return false
    }
    return true
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (blob) => safeStorage.decryptString(blob)
}

app.whenReady().then(() => {
  const store = new CredentialStore(join(app.getPath('userData'), 'credentials.json'), cipher)
  const pool = new SshPool(store)

  // Discovery result is main-owned push state: main sends, the renderer
  // subscribes (`discovery:changed`). Phase 2 identity comes from the SSH
  // identify hook — the box's own hostname, tried with stored credentials.
  const discovery = new Discovery({
    onUpdate: (jetsons) => broadcast('discovery:changed', jetsons),
    identify: makeIdentify(store, pool)
  })

  // Payload source for `git archive`: the repo root, one level above
  // desktop/. Holds in dev; packaged builds are a later step.
  const provisioner = new Provisioner({
    store,
    pool,
    appVersion: app.getVersion(),
    repoRoot: resolve(app.getAppPath(), '..'),
    onState: (state) => broadcast('provision:changed', state),
    onLog: (host, line) => broadcast('log:line', { host, line })
  })

  // The tunnel entrance binds laptop loopback only; the renderer (and the
  // browser fallback) learns the live URL over IPC.
  const tunnels = new TunnelManager({
    pool,
    onChange: (list) => broadcast('tunnel:changed', list)
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node
  }))

  ipcMain.handle('discovery:list', () => discovery.snapshot())
  ipcMain.handle('discovery:scan', () => discovery.scanNow())
  ipcMain.handle('discovery:addManual', (_event, host) => discovery.addManual(String(host)))
  ipcMain.handle('discovery:removeManual', (_event, host) => discovery.removeManual(String(host)))

  // Credentials cross this boundary inward only: store / exists? / delete.
  // There is deliberately no channel that returns a password to the renderer.
  ipcMain.handle('credentials:canPersist', () => store.canPersist())
  ipcMain.handle('credentials:has', (_event, jetsonId) => store.has(String(jetsonId)))
  ipcMain.handle('credentials:set', (_event, jetsonId, creds) => {
    store.set(String(jetsonId), {
      user: String(creds.user),
      password: String(creds.password),
      ...(creds.sudoPassword !== undefined && { sudoPassword: String(creds.sudoPassword) })
    })
  })
  ipcMain.handle('credentials:delete', (_event, jetsonId) => store.delete(String(jetsonId)))
  // needs-sudo recovery: merge a sudo password into an existing entry. The
  // renderer never holds the stored SSH password, so this cannot be a set().
  ipcMain.handle('credentials:setSudo', (_event, jetsonId, sudoPassword) => {
    const id = String(jetsonId)
    const current = store.get(id)
    if (!current) throw new Error('no stored credentials to attach a sudo password to')
    store.set(id, { ...current, sudoPassword: String(sudoPassword) })
  })

  ipcMain.handle('provision:run', (_event, options: ProvisionRunOptions) =>
    provisioner.run(options)
  )

  ipcMain.handle('server:start', async (_event, jetsonId, host, port) => {
    const session = await pool.acquire(String(jetsonId), String(host))
    if (!session) throw new Error('no SSH session and no stored credentials')
    return startServer(session, Number(port))
  })
  ipcMain.handle('server:stop', async (_event, jetsonId, host) => {
    const session = await pool.acquire(String(jetsonId), String(host))
    if (!session) throw new Error('no SSH session and no stored credentials')
    return stopServer(session)
  })

  // Device/rig channels (spec section 9): main relays HTTP to the Jetson
  // server over the pooled SSH session — the renderer never learns which
  // transport carried the request.
  const jetsonSession = async (jetsonId: unknown, host: unknown): Promise<SshSession> => {
    const session = await pool.acquire(String(jetsonId), String(host))
    if (!session) throw new Error('no SSH session and no stored credentials')
    return session
  }
  ipcMain.handle('devices:list', async (_event, jetsonId, host, port) =>
    jetsonGet(await jetsonSession(jetsonId, host), Number(port), '/api/devices')
  )
  ipcMain.handle('rig:get', async (_event, jetsonId, host, port) => {
    try {
      return await jetsonGet(await jetsonSession(jetsonId, host), Number(port), '/api/rig')
    } catch (err) {
      // 404 is a state, not a failure: the box has no rig yet (spec section 5).
      if (err instanceof JetsonHttpError && err.status === 404) return null
      throw err
    }
  })
  ipcMain.handle('rig:save', async (_event, jetsonId, host, port, rig) =>
    jetsonPut(await jetsonSession(jetsonId, host), Number(port), '/api/rig', rig)
  )

  // Lab screen channels (spec section 7), same relay as above: the renderer
  // never reaches the box itself, so every URL is built here from typed
  // arguments rather than passed through.
  const deviceIndex = (raw: unknown): number => {
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid device index: ${raw}`)
    return index
  }
  ipcMain.handle('lab:modes', async (_event, jetsonId, host, port) =>
    jetsonGet(await jetsonSession(jetsonId, host), Number(port), '/api/modes')
  )
  ipcMain.handle('lab:presets', async (_event, jetsonId, host, port) =>
    jetsonGet(await jetsonSession(jetsonId, host), Number(port), '/api/presets')
  )
  ipcMain.handle('lab:streams', async (_event, jetsonId, host, port) =>
    jetsonGet(await jetsonSession(jetsonId, host), Number(port), '/api/streams')
  )
  ipcMain.handle('lab:controls', async (_event, jetsonId, host, port, index) =>
    jetsonGet(
      await jetsonSession(jetsonId, host),
      Number(port),
      `/api/controls?index=${deviceIndex(index)}`
    )
  )
  ipcMain.handle('lab:setControl', async (_event, jetsonId, host, port, change) =>
    jetsonPost(await jetsonSession(jetsonId, host), Number(port), '/api/controls', {
      index: deviceIndex(change?.index),
      key: String(change?.key ?? ''),
      value: Number(change?.value)
    })
  )
  ipcMain.handle('lab:profiles', async (_event, jetsonId, host, port) => {
    const answer = (await jetsonGet(
      await jetsonSession(jetsonId, host),
      Number(port),
      '/api/profiles'
    )) as { profiles?: unknown[] }
    return answer?.profiles ?? []
  })
  ipcMain.handle('lab:saveProfiles', async (_event, jetsonId, host, port, profiles) => {
    if (!Array.isArray(profiles)) throw new Error('profiles must be a list')
    const answer = (await jetsonPut(
      await jetsonSession(jetsonId, host),
      Number(port),
      '/api/profiles',
      { profiles }
    )) as { profiles?: unknown[] }
    return answer?.profiles ?? []
  })
  ipcMain.handle('lab:runStart', async (_event, jetsonId, host, port, request) =>
    jetsonPost(await jetsonSession(jetsonId, host), Number(port), '/api/runs', {
      preset: String(request?.preset ?? ''),
      params: request?.params ?? {},
      // Spec section 5: the rig state a run was started under travels with it.
      rigStatus: request?.rigStatus ?? null,
      // Spec section 8: so does the profile it came from.
      profileId: request?.profileId ?? null
    })
  )
  ipcMain.handle('lab:run', async (_event, jetsonId, host, port, runId) => {
    const id = String(runId)
    if (!/^[0-9a-f]{1,32}$/.test(id)) throw new Error(`invalid run id: ${id}`)
    return jetsonGet(await jetsonSession(jetsonId, host), Number(port), `/api/runs/${id}`)
  })

  ipcMain.handle('tunnel:open', (_event, jetsonId, host, remotePort) =>
    tunnels.open(String(jetsonId), String(host), Number(remotePort))
  )
  ipcMain.handle('tunnel:close', (_event, jetsonId) => tunnels.close(String(jetsonId)))
  ipcMain.handle('tunnel:list', () => tunnels.list())

  discovery.start()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('will-quit', () => {
    discovery.stop()
    void tunnels.closeAll()
    pool.closeAll()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
