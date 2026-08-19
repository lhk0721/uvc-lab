import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { SshPool } from './ssh.ts'

// SSH tunnel, design section 3: the renderer (and the browser fallback path)
// talks only to http://127.0.0.1:<localPort>; main pipes each connection
// through the pooled SSH session into the Jetson's own loopback with
// forwardOut. All four wiring routes collapse into this one path and the
// Jetson never opens a port on its network. This module never imports
// electron so it runs under plain Node for verification.

export const TUNNEL_PORT_START = 18101
export const TUNNEL_PORT_END = 18109

export interface TunnelInfo {
  jetsonId: string
  host: string
  /** Laptop-side entrance — the live URL shown on the device card. */
  localPort: number
  /** The Jetson server's loopback port (provision's serverPort). */
  remotePort: number
  url: string
}

interface ActiveTunnel extends TunnelInfo {
  server: Server
  sockets: Set<Socket>
}

export interface TunnelManagerOptions {
  pool: SshPool
  /** Fired on open/close with the full snapshot, for `tunnel:changed`. */
  onChange?: (tunnels: TunnelInfo[]) => void
}

const publicInfo = ({ jetsonId, host, localPort, remotePort, url }: ActiveTunnel): TunnelInfo => ({
  jetsonId,
  host,
  localPort,
  remotePort,
  url
})

export class TunnelManager {
  private readonly tunnels = new Map<string, ActiveTunnel>()

  constructor(private readonly options: TunnelManagerOptions) {}

  list(): TunnelInfo[] {
    return [...this.tunnels.values()].map(publicInfo)
  }

  /**
   * One tunnel per Jetson. Reopening with the same target is a no-op so the
   * renderer can call it idly; a changed host or server port replaces the
   * tunnel. The SSH session is looked up per incoming connection, so a
   * dropped session reconnects from stored credentials on the next request
   * instead of leaving a dead tunnel behind.
   */
  async open(jetsonId: string, host: string, remotePort: number): Promise<TunnelInfo> {
    const existing = this.tunnels.get(jetsonId)
    if (existing) {
      if (existing.host === host && existing.remotePort === remotePort) {
        return publicInfo(existing)
      }
      await this.close(jetsonId)
    }
    const tunnel: ActiveTunnel = {
      jetsonId,
      host,
      remotePort,
      localPort: 0,
      url: '',
      server: createServer((socket) => void this.relay(tunnel, socket)),
      sockets: new Set()
    }
    tunnel.localPort = await listenOnFreePort(tunnel.server)
    tunnel.url = `http://127.0.0.1:${tunnel.localPort}`
    this.tunnels.set(jetsonId, tunnel)
    this.options.onChange?.(this.list())
    return publicInfo(tunnel)
  }

  async close(jetsonId: string): Promise<void> {
    const tunnel = this.tunnels.get(jetsonId)
    if (!tunnel) return
    this.tunnels.delete(jetsonId)
    for (const socket of tunnel.sockets) socket.destroy()
    await new Promise<void>((resolve) => tunnel.server.close(() => resolve()))
    this.options.onChange?.(this.list())
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.tunnels.keys()].map((id) => this.close(id)))
  }

  private async relay(tunnel: ActiveTunnel, socket: Socket): Promise<void> {
    tunnel.sockets.add(socket)
    socket.on('error', () => {
      /* teardown happens via close */
    })
    socket.on('close', () => tunnel.sockets.delete(socket))
    // A live pooled session, or a reconnect from stored credentials. Neither
    // -> drop the connection; the renderer's fetch fails and the card shows
    // the disconnect (step 9).
    const session = await this.options.pool.acquire(tunnel.jetsonId, tunnel.host)
    if (!session || this.tunnels.get(tunnel.jetsonId) !== tunnel) {
      socket.destroy()
      return
    }
    let stream
    try {
      stream = await session.forward(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        '127.0.0.1',
        tunnel.remotePort
      )
    } catch {
      socket.destroy()
      return
    }
    if (socket.destroyed || this.tunnels.get(tunnel.jetsonId) !== tunnel) {
      stream.destroy()
      socket.destroy()
      return
    }
    socket.pipe(stream)
    stream.pipe(socket)
    stream.on('error', () => socket.destroy())
    stream.on('close', () => socket.destroy())
    socket.on('close', () => stream.destroy())
  }
}

/**
 * The design's laptop-side rule: predictable ports first (18101-18109, one
 * per device) so the browser fallback URL stays guessable, then let the OS
 * pick — the renderer gets the real value over IPC either way.
 */
async function listenOnFreePort(server: Server): Promise<number> {
  for (let port = TUNNEL_PORT_START; port <= TUNNEL_PORT_END; port++) {
    const got = await tryListen(server, port)
    if (got !== null) return got
  }
  const fallback = await tryListen(server, 0)
  if (fallback !== null) return fallback
  throw new Error('no local port available for the tunnel')
}

function tryListen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      // EACCES: Windows reports reserved/excluded port ranges this way.
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null)
      else reject(err)
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve((server.address() as AddressInfo).port)
    })
  })
}
