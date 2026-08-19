import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Bonjour, type Browser, type Service } from 'bonjour-service'

// Discovery, phase 1 of the design's two-phase model: collect (address, route)
// candidates over the four real wiring cases (USB direct, mDNS, Tailscale,
// subnet-scan fallback) plus the manual escape hatch, and merge them into
// DiscoveredJetson entries. Phase 2 (asking the box for its hostname over SSH /
// /api/health) belongs to ssh.ts (step 7), which plugs in via `identify`; until
// then entries stay provisional, keyed by address. This module deliberately
// never imports electron so its logic runs under plain Node for verification.

export type RouteKind = 'usb' | 'mdns' | 'lan-scan' | 'tailscale' | 'manual'

export interface Route {
  kind: RouteKind
  host: string
  // mDNS service name / tailscale hostname. Display only — the design forbids
  // using it as the identity, since both can differ from the real hostname.
  name?: string
  relayed?: boolean
}

export interface DiscoveredJetson {
  // Hostname reported by the box itself once identified; the address until then.
  id: string
  identified: boolean
  routes: Route[]
}

// Resolves a route to the hostname the box itself reports, or null if it could
// not be reached/authenticated. Supplied by ssh.ts in step 7.
export type Identify = (route: Route) => Promise<string | null>

export interface DiscoveryOptions {
  onUpdate: (jetsons: DiscoveredJetson[]) => void
  identify?: Identify
  intervalMs?: number
}

const USB_HOST = '192.168.55.1'
const SSH_PORT = 22
const DEFAULT_INTERVAL_MS = 10_000
const PROBE_TIMEOUT_MS = 1_500
const SCAN_TIMEOUT_MS = 400
const SCAN_CONCURRENCY = 256

// Route preference: USB > LAN/mDNS > Tailscale (WAN, may ride a DERP relay).
// Manual sits between: user-asserted, but nothing confirmed its path quality.
const KIND_ORDER: Record<RouteKind, number> = {
  usb: 0,
  mdns: 1,
  'lan-scan': 2,
  manual: 3,
  tailscale: 4
}

function routeKey(kind: RouteKind, host: string): string {
  return `${kind}:${host}`
}

/** TCP connect probe; true if the port accepted the connection. */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout: timeoutMs })
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    // `on`, not `once`: a second error (e.g. RST while tearing down) must never
    // become an unhandled 'error' that takes the whole main process down.
    sock.on('error', () => done(false))
  })
}

/** Connect and read the server's identification line; null unless it is SSH. */
export function readSshBanner(
  host: string,
  port: number,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout: timeoutMs })
    let buf = ''
    let settled = false
    const done = (banner: string | null): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(banner)
    }
    // The server speaks first (RFC 4253 section 4.2), so just read.
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      const line = buf.split('\r')[0].split('\n')[0]
      if (line.startsWith('SSH-')) done(line)
      else if (buf.length > 256) done(null)
    })
    sock.once('timeout', () => done(null))
    // See tcpProbe: never let a late error escape as unhandled.
    sock.on('error', () => done(null))
  })
}

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i])
    }
  })
  await Promise.all(lanes)
  return results
}

interface TailscalePeerish {
  HostName?: string
  TailscaleIPs?: string[] | null
  Online?: boolean
  OS?: string
  CurAddr?: string
}

/**
 * Extract candidate routes from `tailscale status --json` output. The tailnet
 * is never scanned — peers come from this query alone. Only online Linux peers
 * qualify; the backend must actually be Running (a logged-out CLI reports
 * BackendState "NoState" with Peer null).
 */
export function parseTailscaleStatus(json: string): Route[] {
  let status: { BackendState?: string; Peer?: Record<string, TailscalePeerish> | null }
  try {
    status = JSON.parse(json)
  } catch {
    return []
  }
  if (status.BackendState !== 'Running' || !status.Peer) return []
  const routes: Route[] = []
  for (const peer of Object.values(status.Peer)) {
    if (!peer.Online || peer.OS !== 'linux') continue
    const ip = peer.TailscaleIPs?.find((a) => !a.includes(':'))
    if (!ip) continue
    // CurAddr is empty until a direct path is established, i.e. traffic would
    // ride a DERP relay — worth surfacing because it visibly drops preview fps.
    routes.push({ kind: 'tailscale', host: ip, name: peer.HostName, relayed: !peer.CurAddr })
  }
  return routes
}

/**
 * Enumerate fallback-scan targets from the machine's own interfaces: the /24
 * around each routable IPv4, and the link-local /16 when an interface actually
 * sits in it (without a 169.254.x.x address there is no link into that band).
 */
export function scanTargets(
  ifaces: Record<string, { address: string; family: string; internal: boolean }[] | undefined>
): string[] {
  const targets = new Set<string>()
  const own = new Set<string>()
  let linkLocal = false
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4') continue
      own.add(a.address)
      if (a.address.startsWith('169.254.')) {
        linkLocal = true
        continue
      }
      const prefix = a.address.split('.').slice(0, 3).join('.')
      for (let h = 1; h <= 254; h++) targets.add(`${prefix}.${h}`)
    }
  }
  if (linkLocal) {
    for (let b = 0; b <= 255; b++) {
      for (let h = 1; h <= 254; h++) targets.add(`169.254.${b}.${h}`)
    }
  }
  for (const self of own) targets.delete(self)
  return [...targets]
}

interface TrackedRoute extends Route {
  // Cycle stamp of the last confirmation; mdns/manual routes never expire here.
  seenCycle: number
}

export class Discovery {
  private readonly opts: Required<Pick<DiscoveryOptions, 'onUpdate' | 'intervalMs'>> &
    Pick<DiscoveryOptions, 'identify'>
  private readonly routes = new Map<string, TrackedRoute>()
  private readonly ids = new Map<string, string>() // host -> identified hostname
  private cycleNo = 0
  private bonjour?: Bonjour
  private browser?: Browser
  private timer?: ReturnType<typeof setInterval>
  private cycling = false
  private scanning = false
  private stopped = false

  constructor(options: DiscoveryOptions) {
    this.opts = {
      onUpdate: options.onUpdate,
      identify: options.identify,
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS
    }
  }

  start(): void {
    this.bonjour = new Bonjour()
    // A persistent browser gets goodbye packets, so unplug/shutdown removes the
    // route without waiting for the next cycle. Covers same-LAN and link-local
    // direct alike — avahi advertises _ssh._tcp on both.
    this.browser = this.bonjour.find({ type: 'ssh' })
    this.browser.on('up', (svc) => this.onMdnsUp(svc))
    this.browser.on('down', (svc) => this.onMdnsDown(svc))

    void this.cycle().then(() => {
      // The subnet scan is a last resort (multicast-blocking or client-isolating
      // networks): run it only when the cheap routes came up completely empty,
      // at startup and on explicit rescan — never on the periodic timer.
      if (this.routes.size === 0) void this.fallbackScan()
    })
    this.timer = setInterval(() => void this.cycle(), this.opts.intervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.browser?.stop()
    this.bonjour?.destroy()
  }

  /** User-triggered rescan: one full cycle, then the fallback if still empty. */
  async scanNow(): Promise<void> {
    await this.cycle()
    if (this.routes.size === 0) await this.fallbackScan()
  }

  addManual(host: string): void {
    const trimmed = host.trim()
    if (!trimmed || /\s/.test(trimmed)) return
    this.routes.set(routeKey('manual', trimmed), {
      kind: 'manual',
      host: trimmed,
      seenCycle: Infinity
    })
    void this.identifyNew().then(() => this.emit())
  }

  removeManual(host: string): void {
    if (this.routes.delete(routeKey('manual', host.trim()))) this.emit()
  }

  snapshot(): DiscoveredJetson[] {
    const groups = new Map<string, DiscoveredJetson>()
    for (const route of this.routes.values()) {
      const identified = this.ids.get(route.host)
      const id = identified ?? route.host
      let entry = groups.get(id)
      if (!entry) {
        entry = { id, identified: identified !== undefined, routes: [] }
        groups.set(id, entry)
      }
      entry.identified = entry.identified || identified !== undefined
      entry.routes.push({
        kind: route.kind,
        host: route.host,
        ...(route.name !== undefined && { name: route.name }),
        ...(route.relayed !== undefined && { relayed: route.relayed })
      })
    }
    const list = [...groups.values()]
    for (const entry of list) {
      entry.routes.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    }
    list.sort((a, b) => a.id.localeCompare(b.id))
    return list
  }

  /** One periodic pass over the probe-able routes; mDNS runs continuously. */
  private async cycle(): Promise<void> {
    if (this.cycling || this.stopped) return
    this.cycling = true
    const cycle = ++this.cycleNo
    try {
      this.browser?.update()
      await Promise.all([this.probeUsb(cycle), this.queryTailscale(cycle), this.reprobeLan(cycle)])
      this.expire(cycle)
      await this.identifyNew()
      this.emit()
    } finally {
      this.cycling = false
    }
  }

  private async probeUsb(cycle: number): Promise<void> {
    if (await tcpProbe(USB_HOST, SSH_PORT, PROBE_TIMEOUT_MS)) {
      this.routes.set(routeKey('usb', USB_HOST), { kind: 'usb', host: USB_HOST, seenCycle: cycle })
    }
  }

  private queryTailscale(cycle: number): Promise<void> {
    return new Promise((resolve) => {
      execFile('tailscale', ['status', '--json'], { timeout: 5_000 }, (err, stdout) => {
        if (err && !stdout) {
          // CLI absent (no tailnet on this laptop) or query failed: nothing to
          // report this cycle, so existing tailscale routes expire below.
          resolve()
          return
        }
        for (const route of parseTailscaleStatus(stdout)) {
          this.routes.set(routeKey('tailscale', route.host), { ...route, seenCycle: cycle })
        }
        resolve()
      })
    })
  }

  /** Re-confirm previously scan-found hosts so a powered-off box drops out. */
  private async reprobeLan(cycle: number): Promise<void> {
    const lanHosts = [...this.routes.values()]
      .filter((r) => r.kind === 'lan-scan')
      .map((r) => r.host)
    await mapPool(lanHosts, 16, async (host) => {
      if (await tcpProbe(host, SSH_PORT, PROBE_TIMEOUT_MS)) {
        this.routes.set(routeKey('lan-scan', host), { kind: 'lan-scan', host, seenCycle: cycle })
      }
    })
  }

  private async fallbackScan(): Promise<void> {
    if (this.scanning || this.stopped) return
    this.scanning = true
    try {
      const ifaces = networkInterfaces() as Parameters<typeof scanTargets>[0]
      const targets = scanTargets(ifaces)
      const cycle = this.cycleNo
      await mapPool(targets, SCAN_CONCURRENCY, async (host) => {
        if (this.stopped) return
        // The banner filters out non-SSH port-22 listeners; anything SSH-shaped
        // stays a candidate until phase 2 identifies it.
        const banner = await readSshBanner(host, SSH_PORT, SCAN_TIMEOUT_MS)
        if (banner) {
          this.routes.set(routeKey('lan-scan', host), { kind: 'lan-scan', host, seenCycle: cycle })
        }
      })
      await this.identifyNew()
      this.emit()
    } finally {
      this.scanning = false
    }
  }

  /** Drop routes their source stopped reporting; a card with other live routes survives. */
  private expire(cycle: number): void {
    for (const [key, route] of this.routes) {
      if (route.kind === 'mdns' || route.kind === 'manual') continue
      if (route.seenCycle < cycle) this.routes.delete(key)
    }
  }

  private async identifyNew(): Promise<void> {
    const identify = this.opts.identify
    if (!identify) return
    const pending = [...this.routes.values()].filter((r) => !this.ids.has(r.host))
    await mapPool(pending, 4, async (route) => {
      const hostname = await identify(route).catch(() => null)
      if (hostname) this.ids.set(route.host, hostname)
    })
  }

  private onMdnsUp(svc: Service): void {
    for (const addr of svc.addresses ?? []) {
      if (addr.includes(':')) continue
      this.routes.set(routeKey('mdns', addr), {
        kind: 'mdns',
        host: addr,
        name: svc.name,
        seenCycle: Infinity
      })
    }
    void this.identifyNew().then(() => this.emit())
  }

  private onMdnsDown(svc: Service): void {
    let changed = false
    for (const [key, route] of this.routes) {
      if (route.kind === 'mdns' && route.name === svc.name) {
        this.routes.delete(key)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private emit(): void {
    if (!this.stopped) this.opts.onUpdate(this.snapshot())
  }
}
