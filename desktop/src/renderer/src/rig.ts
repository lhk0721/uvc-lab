// Rig logic for the registration screen: the spec section 5 match (seven
// states), the section 6 wiring rules, and the diagram's port arithmetic.
// Free of window/electron so it runs under plain Node for verification.

export const DEFAULT_CONNECTOR = 'jst-3p-strb-trg-gnd'

export interface SignalDef {
  key: string
  /** GND: follows the other signals, never toggled by hand (spec 6.4). */
  auto?: boolean
}

export interface ConnectorProfile {
  signals: SignalDef[]
}

// New connector models add an entry here; the screen renders whatever the
// profile lists, so the screen code stays untouched (spec 6.4).
export const CONNECTOR_PROFILES: Record<string, ConnectorProfile> = {
  'jst-3p-strb-trg-gnd': {
    signals: [{ key: 'TRG' }, { key: 'STRB' }, { key: 'GND', auto: true }]
  }
}

export function emptyWiring(connector: string): Record<string, boolean> {
  const wiring: Record<string, boolean> = {}
  for (const sig of CONNECTOR_PROFILES[connector]?.signals ?? []) wiring[sig.key] = false
  return wiring
}

/** Apply one checkbox change; auto signals (GND) follow the OR of the rest. */
export function toggleSignal(
  connector: string,
  wiring: Record<string, boolean>,
  key: string,
  value: boolean
): Record<string, boolean> {
  const profile = CONNECTOR_PROFILES[connector]
  const next = { ...wiring, [key]: value }
  for (const sig of profile?.signals ?? []) {
    if (sig.auto) {
      next[sig.key] = (profile?.signals ?? []).some((other) => !other.auto && next[other.key])
    }
  }
  return next
}

/**
 * TRG is checkable only when a trigger source pin exists (spec 3.2 — a
 * declaration with nowhere to pulse from is meaningless) and the camera's
 * control profile is not known to lack trigger firmware (spec 6.4). An
 * unknown profile (unbound camera planned ahead) is allowed — the check
 * re-runs when the camera binds.
 */
export function trgAllowed(
  profile: ControlProfile | null | undefined,
  source: RigGpioPin | null
): { allowed: boolean; reason?: string } {
  if (!source) return { allowed: false, reason: '트리거 출력 핀이 없습니다' }
  if (profile != null && profile !== 'trigger-v1') {
    return { allowed: false, reason: '트리거 펌웨어 없음' }
  }
  return { allowed: true }
}

function splitCamId(camId: string): { prefix: string; sep: string; suffix: string } {
  const i = Math.max(camId.lastIndexOf('.'), camId.lastIndexOf(':'))
  if (i < 0) return { prefix: '', sep: '', suffix: camId }
  return { prefix: camId.slice(0, i), sep: camId[i], suffix: camId.slice(i + 1) }
}

/** Sticker code from the port path: "usb-0:1.4" -> "P4" (spec 2.1). */
export function markOf(camId: string): string {
  return `P${splitCamId(camId).suffix}`
}

export function snapshotExpect(device: JetsonDevice): RigCameraExpect {
  return {
    vidPid: device.usb?.vid_pid ?? null,
    manufacturer: device.usb?.manufacturer ?? null,
    product: device.usb?.product ?? null,
    bcdDevice: device.usb?.bcd_device ?? null,
    controlProfile: device.controlProfile ?? null
  }
}

// Same shape the server splits by: ID_PATH minus the "<camId>:conf.iface"
// tail is the host controller, stored once as rig.host.usbRoot (spec 2.1).
const ID_PATH_RE = /^(.+)-usb-\d+:[\d.]+:\d+\.\d+$/

export function usbRootOf(devices: JetsonDevice[]): string | null {
  for (const device of devices) {
    const m = device.idPath ? ID_PATH_RE.exec(device.idPath) : null
    if (m) return m[1]
  }
  return null
}

/** Detected ports not claimed by any bound rig camera — what an unbound
 *  camera may bind to (spec 6.3). */
export function bindCandidates(cams: RigCamera[], devices: JetsonDevice[]): string[] {
  const bound = new Set(cams.map((c) => c.camId).filter(Boolean))
  return devices
    .map((d) => d.camId)
    .filter((id): id is string => !!id && !bound.has(id))
    .sort()
}

// ---- spec section 5: the seven-state match ---------------------------------

export type RigStatus =
  | 'ok'
  | 'missing'
  | 'unknown-device'
  | 'changed-device'
  | 'busy'
  | 'hub-moved'
  | 'no-rig'

export type MatchIssue =
  | { kind: 'missing'; camId: string; mark: string; label: string }
  | {
      kind: 'changed-device'
      camId: string
      mark: string
      label: string
      expected: string
      actual: string
    }
  | { kind: 'busy'; camId: string; mark: string; label: string }
  | { kind: 'unknown-device'; camId: string; mark: string; bindable: boolean }

export interface MatchResult {
  status: RigStatus
  issues: MatchIssue[]
  /** Set when the whole hub looks moved (spec 2.6): propose, don't fail. */
  hubMove?: { fromPrefix: string; toPrefix: string }
}

export function matchRig(rig: Rig | null, devices: JetsonDevice[]): MatchResult {
  if (!rig) return { status: 'no-rig', issues: [] }

  const bound = rig.cameras.filter((c): c is RigCamera & { camId: string } => !!c.camId)
  const unboundCount = rig.cameras.length - bound.length
  const byCam = new Map(
    devices.filter((d) => d.camId).map((d) => [d.camId as string, d] as const)
  )

  const issues: MatchIssue[] = []
  let missing = 0
  let changed = 0
  let busy = 0
  for (const cam of bound) {
    const device = byCam.get(cam.camId)
    const mark = cam.mark ?? markOf(cam.camId)
    if (!device) {
      issues.push({ kind: 'missing', camId: cam.camId, mark, label: cam.label })
      missing++
      continue
    }
    const wrongVid =
      cam.expect?.vidPid != null &&
      device.usb?.vid_pid != null &&
      cam.expect.vidPid !== device.usb.vid_pid
    const wrongProfile =
      cam.expect?.controlProfile != null &&
      device.controlProfile != null &&
      cam.expect.controlProfile !== device.controlProfile
    if (wrongVid || wrongProfile) {
      issues.push({
        kind: 'changed-device',
        camId: cam.camId,
        mark,
        label: cam.label,
        expected: wrongVid ? (cam.expect?.vidPid ?? '') : (cam.expect?.controlProfile ?? ''),
        actual: wrongVid ? (device.usb?.vid_pid ?? '') : (device.controlProfile ?? '')
      })
      changed++
      continue
    }
    if (!device.opened) {
      issues.push({ kind: 'busy', camId: cam.camId, mark, label: cam.label })
      busy++
    }
  }

  const boundIds = new Set(bound.map((c) => c.camId))
  const unmatched = devices.filter((d) => d.camId && !boundIds.has(d.camId))
  let bindableLeft = unboundCount
  let unknown = 0
  for (const device of unmatched) {
    const bindable = bindableLeft > 0
    if (bindable) bindableLeft--
    else unknown++
    issues.push({
      kind: 'unknown-device',
      camId: device.camId as string,
      mark: markOf(device.camId as string),
      bindable
    })
  }

  // Hub moved (spec 2.6): every bound camera gone, every device new, same
  // count, one consistent prefix change, per-port profiles all matching.
  if (bound.length > 0 && missing === bound.length && unmatched.length === bound.length) {
    const rigParts = bound.map((c) => ({ cam: c, ...splitCamId(c.camId) }))
    const devParts = unmatched.map((d) => ({ device: d, ...splitCamId(d.camId as string) }))
    const rigPrefix = rigParts[0].prefix
    const devPrefix = devParts[0].prefix
    const consistent =
      rigPrefix !== devPrefix &&
      rigParts.every((p) => p.prefix === rigPrefix) &&
      devParts.every((p) => p.prefix === devPrefix)
    if (consistent) {
      const devBySuffix = new Map(devParts.map((p) => [p.suffix, p.device]))
      const allMap = rigParts.every((p) => {
        const device = devBySuffix.get(p.suffix)
        if (!device) return false
        const expect = p.cam.expect?.controlProfile
        return expect == null || device.controlProfile == null || expect === device.controlProfile
      })
      if (allMap) {
        return {
          status: 'hub-moved',
          issues,
          hubMove: { fromPrefix: rigPrefix, toPrefix: devPrefix }
        }
      }
    }
  }

  const status: RigStatus =
    missing > 0
      ? 'missing'
      : changed > 0
        ? 'changed-device'
        : busy > 0
          ? 'busy'
          : unknown > 0
            ? 'unknown-device'
            : 'ok'
  return { status, issues }
}

/** Rewrite every bound camId under the accepted hub move, labels kept. */
export function applyHubMove(cameras: RigCamera[], fromPrefix: string, toPrefix: string): RigCamera[] {
  return cameras.map((cam) => {
    if (!cam.camId || !cam.camId.startsWith(fromPrefix)) return cam
    const camId = toPrefix + cam.camId.slice(fromPrefix.length)
    return { ...cam, camId, mark: markOf(camId) }
  })
}

// ---- diagram rows (spec 6.6) -----------------------------------------------

export interface PortSlot {
  kind: 'camera' | 'detected' | 'empty'
  camId: string
  port: string
  /** Index into the draft camera list, for 'camera' slots. */
  draftIndex?: number
  device?: JetsonDevice
}

/**
 * One row per port: draft cameras, detected-but-unregistered devices, and
 * the gaps between numeric ports drawn as empty (spec 6.6 — where a free
 * plug remains is information the wiring work needs). Unbound draft cameras
 * have no port and are rendered separately by the screen.
 */
export function portSlots(cams: RigCamera[], devices: JetsonDevice[]): PortSlot[] {
  const byCam = new Map(
    devices.filter((d) => d.camId).map((d) => [d.camId as string, d] as const)
  )
  const slots = new Map<string, PortSlot>()
  cams.forEach((cam, draftIndex) => {
    if (!cam.camId) return
    slots.set(cam.camId, {
      kind: 'camera',
      camId: cam.camId,
      port: splitCamId(cam.camId).suffix,
      draftIndex,
      device: byCam.get(cam.camId)
    })
  })
  for (const device of devices) {
    if (!device.camId || slots.has(device.camId)) continue
    slots.set(device.camId, {
      kind: 'detected',
      camId: device.camId,
      port: splitCamId(device.camId).suffix,
      device
    })
  }

  const byPrefix = new Map<string, { sep: string; ports: number[] }>()
  for (const camId of slots.keys()) {
    const { prefix, sep, suffix } = splitCamId(camId)
    const n = Number(suffix)
    if (!Number.isInteger(n)) continue
    const entry = byPrefix.get(prefix) ?? { sep, ports: [] }
    entry.ports.push(n)
    byPrefix.set(prefix, entry)
  }
  for (const [prefix, { sep, ports }] of byPrefix) {
    for (let n = 1; n <= Math.max(...ports); n++) {
      if (ports.includes(n)) continue
      const camId = prefix ? `${prefix}${sep}${n}` : String(n)
      slots.set(camId, { kind: 'empty', camId, port: String(n) })
    }
  }

  return Array.from(slots.values()).sort((a, b) => {
    const pa = splitCamId(a.camId)
    const pb = splitCamId(b.camId)
    if (pa.prefix !== pb.prefix) return pa.prefix < pb.prefix ? -1 : 1
    const na = Number(pa.suffix)
    const nb = Number(pb.suffix)
    if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb
    return pa.suffix < pb.suffix ? -1 : 1
  })
}
