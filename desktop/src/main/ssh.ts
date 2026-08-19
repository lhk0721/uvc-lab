import type { Duplex, Readable } from 'node:stream'
import { Client } from 'ssh2'
import type { Identify, Route } from './discovery.ts'
import type { CredentialStore } from './credentials.ts'
import { sourceFor } from './link-local.ts'

// SSH session layer, design sections 1-2. Everything the app does on the box
// (identify, provision, systemctl, tunnel in step 8) goes through SshSession.
// Passwords come in from the credential store and go out only as ssh2 auth or
// `sudo -S` stdin — never onto a remote command line, where the Jetson's `ps`
// would show them. This module never imports electron so it runs under plain
// Node for verification.

export interface SshConnectOptions {
  host: string
  port?: number
  user: string
  password: string
  timeoutMs?: number
}

export interface ExecOptions {
  /** Written (string) or piped (stream) to the command's stdin, then closed. */
  stdin?: string | Readable
  /** Called per complete output line as it arrives — for log streaming. */
  onLine?: (line: string, source: 'stdout' | 'stderr') => void
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Authentication failed — the password/user is wrong, not the network. */
export class SshAuthError extends Error {
  constructor(host: string) {
    super(`SSH authentication failed for ${host}`)
    this.name = 'SshAuthError'
  }
}

export class SshSession {
  private closeCallbacks: (() => void)[] = []

  private constructor(
    private readonly client: Client,
    readonly host: string,
    readonly user: string
  ) {}

  static async connect(options: SshConnectOptions): Promise<SshSession> {
    const port = options.port ?? 22
    const timeoutMs = options.timeoutMs ?? 10_000
    // A link-local box is only reachable from the address on its own link
    // (see link-local.ts); ssh2 opens its own socket, so it needs the source.
    const localAddress = await sourceFor(options.host, port, timeoutMs)
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      client.once('ready', () => {
        settled = true
        const session = new SshSession(client, options.host, options.user)
        client.on('close', () => {
          for (const cb of session.closeCallbacks) cb()
        })
        resolve(session)
      })
      // `on`, not `once` (same lesson as discovery's probe sockets): a late
      // socket error after settling must never become an unhandled 'error'.
      client.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err.level === 'client-authentication' ? new SshAuthError(options.host) : err)
      })
      // Some sshd configs serve password logins via keyboard-interactive only.
      client.on('keyboard-interactive', (_name, _inst, _lang, prompts, finish) => {
        finish(prompts.map(() => options.password))
      })
      client.connect({
        host: options.host,
        port,
        username: options.user,
        password: options.password,
        ...(localAddress !== undefined && { localAddress }),
        tryKeyboard: true,
        readyTimeout: timeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3
      })
    })
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        let stdout = ''
        let stderr = ''
        let code: number | null = null
        const lineBuf = { stdout: '', stderr: '' }
        const onChunk = (source: 'stdout' | 'stderr', chunk: Buffer): void => {
          const text = chunk.toString('utf8')
          if (source === 'stdout') stdout += text
          else stderr += text
          if (!options.onLine) return
          lineBuf[source] += text
          let idx: number
          while ((idx = lineBuf[source].indexOf('\n')) >= 0) {
            options.onLine(lineBuf[source].slice(0, idx).replace(/\r$/, ''), source)
            lineBuf[source] = lineBuf[source].slice(idx + 1)
          }
        }
        stream.on('data', (chunk: Buffer) => onChunk('stdout', chunk))
        stream.stderr.on('data', (chunk: Buffer) => onChunk('stderr', chunk))
        stream.on('exit', (exitCode: number | null) => {
          code = exitCode
        })
        stream.on('close', () => {
          if (options.onLine) {
            if (lineBuf.stdout) options.onLine(lineBuf.stdout, 'stdout')
            if (lineBuf.stderr) options.onLine(lineBuf.stderr, 'stderr')
          }
          resolve({ code, stdout, stderr })
        })
        stream.on('error', () => {
          /* surfaced via close */
        })
        if (options.stdin === undefined) {
          stream.end()
        } else if (typeof options.stdin === 'string') {
          stream.end(options.stdin)
        } else {
          options.stdin.pipe(stream)
        }
      })
    })
  }

  /** The box's own answer — the only thing allowed to become a Jetson id. */
  async hostname(): Promise<string | null> {
    const result = await this.exec('hostname')
    const name = result.stdout.trim()
    return result.code === 0 && name ? name : null
  }

  /**
   * One forwarded TCP connection (design section 3): the returned channel is
   * wired to dstHost:dstPort on the box's side of the session. The src
   * values are informational, for sshd's logs.
   */
  forward(srcHost: string, srcPort: number, dstHost: string, dstPort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut(srcHost, srcPort, dstHost, dstPort, (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      })
    })
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback)
  }

  close(): void {
    this.client.end()
  }
}

/**
 * Keeps at most one live session per Jetson id, so provision, server
 * lifecycle, and (step 8) the tunnel share a connection instead of piling up
 * logins. A dropped session removes itself; the next acquire reconnects.
 */
export class SshPool {
  private readonly sessions = new Map<string, SshSession>()

  constructor(private readonly store: CredentialStore) {}

  adopt(jetsonId: string, session: SshSession): void {
    const existing = this.sessions.get(jetsonId)
    if (existing && existing !== session) existing.close()
    this.sessions.set(jetsonId, session)
    session.onClose(() => {
      if (this.sessions.get(jetsonId) === session) this.sessions.delete(jetsonId)
    })
  }

  /** Live session, or a fresh one from stored credentials; null without both. */
  async acquire(jetsonId: string, host: string): Promise<SshSession | null> {
    const existing = this.sessions.get(jetsonId)
    if (existing) return existing
    const creds = this.store.get(jetsonId)
    if (!creds) return null
    try {
      const session = await SshSession.connect({
        host,
        user: creds.user,
        password: creds.password
      })
      this.adopt(jetsonId, session)
      return session
    } catch {
      return null
    }
  }

  get(jetsonId: string): SshSession | null {
    return this.sessions.get(jetsonId) ?? null
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}

const IDENTIFY_TIMEOUT_MS = 4_000
const IDENTIFY_FAIL_TTL_MS = 5 * 60_000

/**
 * Discovery's phase 2 (design: "identify over SSH and merge by the hostname
 * the box reports"): try every stored credential set against the candidate
 * address and ask the box its hostname. A host that rejects them all is
 * remembered for a while — discovery re-runs identify every cycle, and
 * retrying a foreign box's sshd every 10 seconds would spray its auth.log.
 * The cache entry is keyed to the credential ids that were tried, so storing
 * new credentials retries immediately.
 */
export function makeIdentify(store: CredentialStore, pool: SshPool): Identify {
  const failed = new Map<string, { at: number; tried: string }>()
  return async (route: Route): Promise<string | null> => {
    const ids = store.list().sort()
    const tried = ids.join('\n')
    const prior = failed.get(route.host)
    if (prior && prior.tried === tried && Date.now() - prior.at < IDENTIFY_FAIL_TTL_MS) {
      return null
    }
    for (const id of ids) {
      const creds = store.get(id)
      if (!creds) continue
      let session: SshSession | null = null
      try {
        session = await SshSession.connect({
          host: route.host,
          user: creds.user,
          password: creds.password,
          timeoutMs: IDENTIFY_TIMEOUT_MS
        })
        const hostname = await session.hostname()
        if (hostname) {
          // Keep the authenticated session — provision/tunnel will want one.
          pool.adopt(hostname, session)
          failed.delete(route.host)
          return hostname
        }
        session.close()
      } catch {
        session?.close()
      }
    }
    failed.set(route.host, { at: Date.now(), tried })
    return null
  }
}
