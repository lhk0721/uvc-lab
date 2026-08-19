import { createConnection, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'

// Link-local (169.254.0.0/16) reachability, i.e. the design's "LAN 포트 직결"
// route. Measured on the real laptop: a plain connect to the Jetson's
// 169.254.203.230:22 times out while the box answers instantly one cable away.
// Cause is route selection, not the box — every adapter holding an APIPA
// address contributes an on-link 169.254.0.0/16 route, and Windows takes the
// lowest interface metric. A Tailscale adapter that is installed but logged out
// sits on APIPA at metric 5 and swallows the whole band (the ethernet adapter
// is 25). Binding the source address picks the link instead, so every
// link-local connection here races the machine's own link-local addresses and
// remembers the one that answered.

export function isLinkLocal(host: string): boolean {
  return host.startsWith('169.254.')
}

/** This machine's own link-local IPv4 addresses — one candidate link each. */
export function linkLocalSources(
  ifaces: Record<string, { address: string; family: string; internal: boolean }[] | undefined> = networkInterfaces() as never
): string[] {
  const sources: string[] = []
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4' || !isLinkLocal(a.address)) continue
      sources.push(a.address)
    }
  }
  return sources
}

// host -> source address that reached it; null means the plain route worked.
const learned = new Map<string, string | null>()

interface Attempt {
  socket: Socket | null
  /** The host answered with RST: the link works even though the port is shut. */
  refused: boolean
}

function connectFrom(
  host: string,
  port: number,
  timeoutMs: number,
  localAddress: string | null
): Promise<Attempt> {
  return new Promise((resolve) => {
    const sock = createConnection({
      host,
      port,
      timeout: timeoutMs,
      ...(localAddress !== null && { localAddress })
    })
    let settled = false
    const fail = (refused: boolean): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve({ socket: null, refused })
    }
    sock.once('connect', () => {
      if (settled) return
      settled = true
      sock.setTimeout(0)
      resolve({ socket: sock, refused: false })
    })
    sock.once('timeout', () => fail(false))
    // `on`, not `once` (same lesson as discovery's probe sockets): a late error
    // while tearing down must never become an unhandled 'error'.
    sock.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED/ECONNRESET came from the box itself, so this source is the
      // right one — only an unreachable link means "try another source".
      fail(err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')
    })
  })
}

/**
 * Connected socket, or null. Ordinary addresses connect once; a link-local
 * address races the plain route against every local link-local source and
 * keeps the winner for next time. The caller owns the returned socket.
 */
export async function openSocket(
  host: string,
  port: number,
  timeoutMs: number
): Promise<Socket | null> {
  if (!isLinkLocal(host)) return (await connectFrom(host, port, timeoutMs, null)).socket

  const known = learned.get(host)
  if (known !== undefined) {
    const attempt = await connectFrom(host, port, timeoutMs, known)
    // A refusal is the box answering, so the source stays learned and only the
    // port is at fault; anything else means the link moved and has to re-race.
    if (attempt.socket || attempt.refused) return attempt.socket
    learned.delete(host)
  }

  const sources: (string | null)[] = [null, ...linkLocalSources()]
  const attempts = await Promise.all(
    sources.map((src) => connectFrom(host, port, timeoutMs, src))
  )
  let winner: Socket | null = null
  let refusedBy: string | null | undefined
  for (const [i, attempt] of attempts.entries()) {
    if (attempt.refused && refusedBy === undefined) refusedBy = sources[i]
    if (!attempt.socket) continue
    if (winner) {
      attempt.socket.destroy()
      continue
    }
    winner = attempt.socket
    learned.set(host, sources[i])
  }
  // Nothing accepted, but a refusal still identifies the link for next time.
  if (!winner && refusedBy !== undefined) learned.set(host, refusedBy)
  return winner
}

/**
 * Source address to bind for `host`, or undefined for the plain route. Probes
 * once when nothing is known yet — ssh2 opens its own socket, so it needs the
 * answer rather than a socket.
 */
export async function sourceFor(
  host: string,
  port: number,
  timeoutMs: number
): Promise<string | undefined> {
  if (!isLinkLocal(host)) return undefined
  if (!learned.has(host)) {
    const sock = await openSocket(host, port, timeoutMs)
    sock?.destroy()
  }
  return learned.get(host) ?? undefined
}

/** Test seam — drops what earlier races learned. */
export function forgetSources(): void {
  learned.clear()
}
