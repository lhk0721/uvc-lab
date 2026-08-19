import { spawn } from 'node:child_process'
import { tcpProbe } from './discovery.ts'
import { SshAuthError, SshSession, type SshPool } from './ssh.ts'
import type { CredentialStore } from './credentials.ts'

// Provisioning, design section 4: the app-side half of the 9-step install.
// Steps 1-2 (reach, authenticate) and the step-6 push decision live here;
// steps 3-9 are bootstrap.sh running ON the box, streamed back line by line.
// Exit 3 from bootstrap means everything is installed except linger — the one
// sudo on the normal path — which this module then runs over `sudo -S` with
// the stored password on stdin (never on the command line, where ps shows it).
// This module never imports electron; index.ts injects version and repo root.

export type ProvisionPhase =
  | 'connect'
  | 'auth'
  | 'push'
  | 'bootstrap'
  | 'linger'
  | 'ready'
  // Terminal, but recoverable by the user: retry with a password / run the
  // printed command by hand. Distinct from 'failed' so the renderer knows to
  // prompt instead of showing an error wall.
  | 'needs-auth'
  | 'needs-sudo'
  | 'failed'

export interface ProvisionState {
  host: string
  phase: ProvisionPhase
  jetsonId?: string
  /** Bootstrap's own step marker while it runs, e.g. "[7/9] dependencies". */
  step?: string
  serverPort?: number
  error?: string
  /** The one-line escape hatch shown when sudo is unusable (design sec. 2). */
  manualCommand?: string
}

export interface ProvisionRunOptions {
  host: string
  /** Known Jetson id (identified entries) — resolves stored credentials. */
  jetsonId?: string
  /** First-contact path: explicit credentials, stored on success if `save`. */
  auth?: { user: string; password: string; sudoPassword?: string; save: boolean }
  forcePush?: boolean
}

export interface ProvisionerOptions {
  store: CredentialStore
  pool: SshPool
  appVersion: string
  /** Repo root that `git archive` runs in — the payload source. */
  repoRoot: string
  onState: (state: ProvisionState) => void
  onLog: (host: string, line: string) => void
}

const SSH_PORT = 22
const PORT_RANGE_START = 18100
const PORT_RANGE_END = 18109
// User-unit trap #1 (design section 5): non-interactive SSH has no
// XDG_RUNTIME_DIR, and without it systemctl --user cannot find the user D-Bus.
const XDG = 'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";'

export class Provisioner {
  private readonly running = new Set<string>()

  constructor(private readonly opts: ProvisionerOptions) {}

  async run(options: ProvisionRunOptions): Promise<ProvisionState> {
    if (this.running.has(options.host)) {
      return { host: options.host, phase: 'failed', error: 'already provisioning this host' }
    }
    this.running.add(options.host)
    try {
      return await this.runInner(options)
    } finally {
      this.running.delete(options.host)
    }
  }

  private async runInner(options: ProvisionRunOptions): Promise<ProvisionState> {
    const { host } = options
    const state: ProvisionState = { host, phase: 'connect' }
    const push = (partial: Partial<ProvisionState>): ProvisionState => {
      Object.assign(state, partial)
      this.opts.onState({ ...state })
      return state
    }
    const log = (line: string): void => this.opts.onLog(host, line)

    // --- 1/9 connect --------------------------------------------------------
    push({ phase: 'connect' })
    if (!(await tcpProbe(host, SSH_PORT, 3_000))) {
      return push({ phase: 'failed', error: `TCP ${SSH_PORT} unreachable on ${host}` })
    }

    // --- 2/9 auth -----------------------------------------------------------
    push({ phase: 'auth' })
    const creds =
      options.auth ?? (options.jetsonId ? this.opts.store.get(options.jetsonId) : null)
    if (!creds) {
      return push({ phase: 'needs-auth', error: 'no stored credentials for this box' })
    }
    let session: SshSession
    try {
      session = await SshSession.connect({ host, user: creds.user, password: creds.password })
    } catch (err) {
      if (err instanceof SshAuthError) {
        return push({ phase: 'needs-auth', error: 'SSH authentication failed' })
      }
      return push({ phase: 'failed', error: `SSH connect failed: ${(err as Error).message}` })
    }
    const jetsonId = await session.hostname()
    if (!jetsonId) {
      session.close()
      return push({ phase: 'failed', error: 'box did not report a hostname' })
    }
    push({ jetsonId })
    log(`connected to ${jetsonId} (${host}) as ${creds.user}`)
    if (options.auth?.save) {
      this.opts.store.set(jetsonId, {
        user: creds.user,
        password: creds.password,
        ...(creds.sudoPassword !== undefined && { sudoPassword: creds.sudoPassword })
      })
    }
    this.opts.pool.adopt(jetsonId, session)

    // --- 6/9 payload: the push-or-skip decision is the app's ---------------
    push({ phase: 'push' })
    const remote = await session.exec('cat ~/.uvc-lab/VERSION 2>/dev/null')
    const remoteVersion = remote.stdout.trim()
    if (remoteVersion === this.opts.appVersion && !options.forcePush) {
      log(`payload up to date (version ${remoteVersion}) — push skipped`)
    } else {
      log(
        remoteVersion
          ? `payload version ${remoteVersion} != app ${this.opts.appVersion} — pushing`
          : 'no payload on the box — pushing'
      )
      const pushError = await this.pushPayload(session)
      if (pushError) return push({ phase: 'failed', error: pushError })
      log('payload pushed')
    }

    // --- pick the server port before bootstrap renders the unit with it ----
    let serverPort: number
    try {
      serverPort = await pickServerPort(session)
    } catch (err) {
      return push({ phase: 'failed', error: (err as Error).message })
    }
    push({ serverPort })

    // --- 3-9/9: bootstrap.sh on the box, streamed back ---------------------
    push({ phase: 'bootstrap' })
    let lastFail = ''
    const result = await session.exec(
      `bash ~/.uvc-lab/repo/deploy/bootstrap.sh --version ${this.opts.appVersion} --port ${serverPort}`,
      {
        onLine: (line, source) => {
          log(line)
          const step = /^(\[\d\/9\] \S+)/.exec(line)
          if (step && source === 'stdout') push({ step: step[1] })
          if (line.startsWith('FAIL:')) lastFail = line
        }
      }
    )
    if (result.code === 0) {
      return push({ phase: 'ready', step: undefined })
    }
    if (result.code !== 3) {
      return push({
        phase: 'failed',
        error: lastFail || `bootstrap exited with code ${result.code}`
      })
    }

    // --- 9/9 linger: the one sudo, run app-side over sudo -S ---------------
    push({ phase: 'linger', step: undefined })
    return this.enableLinger(session, creds, options.jetsonId ?? jetsonId, push, log)
  }

  /** Local `git archive HEAD` streamed into `tar -x` on the box. */
  private pushPayload(session: SshSession): Promise<string | null> {
    return new Promise((resolve) => {
      const git = spawn('git', ['-C', this.opts.repoRoot, 'archive', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let gitErr = ''
      git.stderr.on('data', (chunk: Buffer) => (gitErr += chunk.toString()))
      git.on('error', (err) => resolve(`git archive failed to start: ${err.message}`))
      const remote = session.exec('mkdir -p ~/.uvc-lab/repo && tar -x -C ~/.uvc-lab/repo', {
        stdin: git.stdout
      })
      void remote.then((result) => {
        if (git.exitCode !== 0 && git.exitCode !== null) {
          resolve(`git archive failed: ${gitErr.trim() || `exit ${git.exitCode}`}`)
        } else if (result.code !== 0) {
          resolve(`remote tar extract failed: ${result.stderr.trim() || `exit ${result.code}`}`)
        } else {
          resolve(null)
        }
      })
    })
  }

  private async enableLinger(
    session: SshSession,
    creds: { password: string; sudoPassword?: string },
    jetsonId: string,
    push: (partial: Partial<ProvisionState>) => ProvisionState,
    log: (line: string) => void
  ): Promise<ProvisionState> {
    const manualCommand = `sudo loginctl enable-linger ${session.user}`
    // The SSH password is normally the sudo password too, so it goes first;
    // a separately stored sudoPassword (different-account case) is the one
    // fallback. Each candidate is tried exactly once — repeated failures put
    // warnings in the box's auth.log (design section 2).
    const stored = this.opts.store.get(jetsonId)
    const candidates = [creds.password]
    const sudoPassword = creds.sudoPassword ?? stored?.sudoPassword
    if (sudoPassword && !candidates.includes(sudoPassword)) candidates.push(sudoPassword)

    let validated = false
    for (const password of candidates) {
      // -k ignores any cached timestamp so this judges the password itself;
      // -p '' keeps the prompt string out of stderr.
      const check = await session.exec(`sudo -k -S -p '' -v`, { stdin: password + '\n' })
      if (check.code === 0) {
        validated = true
        break
      }
      log('sudo password check failed')
    }
    if (!validated) {
      return push({
        phase: 'needs-sudo',
        error: 'stored password is not valid for sudo',
        manualCommand
      })
    }
    // -n rides the timestamp the -v validation just cached.
    const enable = await session.exec(`sudo -n loginctl enable-linger ${session.user}`)
    if (enable.code !== 0) {
      return push({
        phase: 'needs-sudo',
        error: `enable-linger failed: ${enable.stderr.trim() || `exit ${enable.code}`}`,
        manualCommand
      })
    }
    const verify = await session.exec(
      `loginctl show-user ${session.user} --property=Linger --value`
    )
    if (verify.stdout.trim() !== 'yes') {
      return push({ phase: 'needs-sudo', error: 'linger still reports off', manualCommand })
    }
    log('linger enabled')
    return push({ phase: 'ready' })
  }
}

/**
 * Server port on the box (design section 6): keep the installed unit's port
 * when it is ours or still free, otherwise walk 18100-18109 past loopback
 * listeners from `ss -ltn`. Chosen before bootstrap because the unit file is
 * rendered with it.
 */
export async function pickServerPort(session: SshSession): Promise<number> {
  const unitOut = await session.exec(
    `sed -n 's/.*--port \\([0-9]*\\).*/\\1/p' ~/.config/systemd/user/uvc-lab.service 2>/dev/null`
  )
  const unitPort = Number(unitOut.stdout.trim()) || null
  if (unitPort) {
    const active = await session.exec(`${XDG} systemctl --user is-active uvc-lab`)
    // An active unit holds its own port — that listener is us, keep it.
    if (active.stdout.trim() === 'active') return unitPort
  }
  const ss = await session.exec('ss -ltn')
  const used = new Set<number>()
  for (const match of ss.stdout.matchAll(/127\.0\.0\.1:(\d+)\s/g)) {
    used.add(Number(match[1]))
  }
  if (unitPort && !used.has(unitPort)) return unitPort
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!used.has(port)) return port
  }
  throw new Error(`no free port in ${PORT_RANGE_START}-${PORT_RANGE_END} on the box`)
}

export interface ServerHealth {
  app?: string
  version?: string
  hostname?: string
}

/** `systemctl --user start` + health check on the box's own loopback. */
export async function startServer(session: SshSession, port: number): Promise<ServerHealth> {
  const start = await session.exec(`${XDG} systemctl --user start uvc-lab`)
  if (start.code !== 0) {
    throw new Error(`systemctl start failed: ${start.stderr.trim() || `exit ${start.code}`}`)
  }
  // The tunnel (step 8) is not required to verify: curl runs ON the box.
  for (let attempt = 0; attempt < 10; attempt++) {
    const health = await session.exec(`curl -s -m 2 http://127.0.0.1:${port}/api/health`)
    if (health.code === 0 && health.stdout.trim()) {
      try {
        return JSON.parse(health.stdout) as ServerHealth
      } catch {
        throw new Error(`health endpoint returned non-JSON: ${health.stdout.slice(0, 120)}`)
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('server started but /api/health never answered')
}

export async function stopServer(session: SshSession): Promise<void> {
  const stop = await session.exec(`${XDG} systemctl --user stop uvc-lab`)
  if (stop.code !== 0) {
    throw new Error(`systemctl stop failed: ${stop.stderr.trim() || `exit ${stop.code}`}`)
  }
}
