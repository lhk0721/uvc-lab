/// <reference types="vite/client" />

// Hand-kept mirror of the preload surface (src/preload/index.ts) — the preload
// file itself cannot be imported here because it depends on Node/Electron types.

type RouteKind = 'usb' | 'mdns' | 'lan-scan' | 'tailscale' | 'manual'

interface Route {
  kind: RouteKind
  host: string
  name?: string
  relayed?: boolean
}

interface DiscoveredJetson {
  id: string
  identified: boolean
  routes: Route[]
}

type ProvisionPhase =
  | 'connect'
  | 'auth'
  | 'push'
  | 'bootstrap'
  | 'linger'
  | 'ready'
  | 'needs-auth'
  | 'needs-sudo'
  | 'failed'

interface ProvisionState {
  host: string
  phase: ProvisionPhase
  jetsonId?: string
  step?: string
  serverPort?: number
  error?: string
  manualCommand?: string
}

interface ProvisionRunOptions {
  host: string
  jetsonId?: string
  auth?: { user: string; password: string; sudoPassword?: string; save: boolean }
  forcePush?: boolean
}

interface ServerHealth {
  app?: string
  version?: string
  hostname?: string
}

interface TunnelInfo {
  jetsonId: string
  host: string
  localPort: number
  remotePort: number
  url: string
}

// ---- Jetson server payloads (relayed by main verbatim; shapes owned here) --

type ControlProfile = 'trigger-v1' | 'webcam-std' | 'unknown'

interface JetsonUsbDescriptor {
  vid_pid: string | null
  manufacturer: string | null
  product: string | null
  bcd_device: string | null
  serial: string | null
}

interface JetsonDevice {
  index: number
  camId: string | null
  idPath: string | null
  opened: boolean
  width: number
  height: number
  signature: string | null
  os_name: string | null
  os_name_is_heuristic: boolean
  controlProfile: ControlProfile | null
  usb: JetsonUsbDescriptor | null
}

interface RigCameraExpect {
  vidPid: string | null
  manufacturer: string | null
  product: string | null
  bcdDevice: string | null
  controlProfile: ControlProfile | null
}

interface RigCamera {
  /** null = unbound: planned before the hardware is plugged in (spec 6.3). */
  camId: string | null
  label: string
  mark?: string
  expect?: RigCameraExpect
  connector: string
  /** Declared, never observed — the app cannot see the wiring (spec 3.2). */
  wiring: Record<string, boolean>
}

interface RigGpioPin {
  gpioBoardPin: number
  name?: string
}

interface RigTrigger {
  source: RigGpioPin | null
  strobeReturn: RigGpioPin | null
  levelShift?: string | null
  verifiedAt?: string | null
}

interface Rig {
  rigVersion: number
  name: string
  createdAt: string
  host: { hostname: string; usbRoot: string | null }
  cameras: RigCamera[]
  trigger: RigTrigger
}

// ---- lab screen payloads (spec section 7) ---------------------------------

interface ModeOptions {
  resolutions: string[]
  fourccs: string[]
}

interface StreamMode {
  width: number
  height: number
  fourcc: string
  fps?: number | null
  driverFps?: number
}

interface StreamStats {
  active: boolean
  index?: number
  fps?: number
  signal?: { state: string; mean: number; max: number } | null
  error?: string | null
  /** What was asked for vs what the driver actually gave (spec 7.2). */
  requested?: StreamMode
  observed?: StreamMode
}

type ControlType = 'int' | 'bool' | 'menu'

interface JetsonControl {
  key: string
  id: number
  name: string
  type: ControlType
  /** The range comes from the device on every query, never hardcoded (7.3). */
  min: number
  max: number
  step: number
  default: number
  value: number | null
  readOnly: boolean
  menu?: { value: number; label: string }[]
}

interface ControlSet {
  index: number
  /** false = this box cannot report controls at all, which is not "none". */
  supported: boolean
  controls: JetsonControl[]
}

interface PresetParam {
  key: string
  label: string
  type: 'int' | 'float' | 'bool' | 'select' | 'multiselect' | 'numbers' | 'indices'
  default: unknown
  options?: string[]
  min?: number
  max?: number
}

interface Preset {
  id: string
  title: string
  question: string
  detail?: string
  duration_hint?: string
  params: PresetParam[]
}

// ---- test profiles (spec section 8) ---------------------------------------

interface ProfileMode {
  fourcc: string
  width: number
  height: number
  /** null = do not ask for a rate; the driver picks (spec 7.2). */
  fps: number | null
}

interface ProfileCamera {
  enabled: boolean
  mode: ProfileMode | null
  /** "hardware" makes this camera a trigger target (spec 8). */
  trigger: 'free' | 'hardware'
}

interface ProfileRequires {
  controlProfile?: ControlProfile | null
  trigger?: 'fsin-hardware' | null
}

interface TestProfile {
  id: string
  title: string
  preset: string
  requires?: ProfileRequires
  /** Keyed by camId — the port is the identity (spec 2.1). */
  cameras: Record<string, ProfileCamera>
  /** Preset parameters the camera block does not derive (seconds, etc.). */
  params?: Record<string, unknown>
}

interface RunResult {
  headline: string
  status: 'ok' | 'warn' | 'fail'
  tables?: { title: string; columns: string[]; rows: (string | number)[][] }[]
  notes?: string[]
  raw?: unknown
}

interface RunState {
  id: string
  preset: string
  title: string
  status: 'running' | 'done' | 'error'
  started: number
  finished?: number
  log: string[]
  result: RunResult | null
  error: string | null
  /** The rig state the run was started under (spec 5). */
  rigStatus?: string | null
  /** The test profile the run came from, if any (spec 8). */
  profileId?: string | null
}

interface Window {
  labDesk: {
    appInfo(): Promise<{ version: string; electron: string; node: string }>
    discovery: {
      list(): Promise<DiscoveredJetson[]>
      scan(): Promise<void>
      addManual(host: string): Promise<void>
      removeManual(host: string): Promise<void>
      onChanged(callback: (jetsons: DiscoveredJetson[]) => void): () => void
    }
    credentials: {
      canPersist(): Promise<boolean>
      has(jetsonId: string): Promise<{ user: string } | null>
      set(
        jetsonId: string,
        creds: { user: string; password: string; sudoPassword?: string }
      ): Promise<void>
      delete(jetsonId: string): Promise<void>
      setSudo(jetsonId: string, sudoPassword: string): Promise<void>
    }
    provision: {
      run(options: ProvisionRunOptions): Promise<ProvisionState>
      onChanged(callback: (state: ProvisionState) => void): () => void
    }
    server: {
      start(jetsonId: string, host: string, port: number): Promise<ServerHealth>
      stop(jetsonId: string, host: string): Promise<void>
    }
    devices: {
      list(jetsonId: string, host: string, serverPort: number): Promise<JetsonDevice[]>
    }
    rig: {
      get(jetsonId: string, host: string, serverPort: number): Promise<Rig | null>
      save(jetsonId: string, host: string, serverPort: number, rig: Rig): Promise<Rig>
    }
    lab: {
      modes(jetsonId: string, host: string, serverPort: number): Promise<ModeOptions>
      presets(jetsonId: string, host: string, serverPort: number): Promise<Preset[]>
      streams(
        jetsonId: string,
        host: string,
        serverPort: number
      ): Promise<{ streams: Record<string, StreamStats> }>
      controls(
        jetsonId: string,
        host: string,
        serverPort: number,
        index: number
      ): Promise<ControlSet>
      setControl(
        jetsonId: string,
        host: string,
        serverPort: number,
        change: { index: number; key: string; value: number }
      ): Promise<{ index: number; key: string; value: number }>
      profiles(jetsonId: string, host: string, serverPort: number): Promise<TestProfile[]>
      saveProfiles(
        jetsonId: string,
        host: string,
        serverPort: number,
        profiles: TestProfile[]
      ): Promise<TestProfile[]>
      runStart(
        jetsonId: string,
        host: string,
        serverPort: number,
        request: {
          preset: string
          params: Record<string, unknown>
          rigStatus?: string | null
          profileId?: string | null
        }
      ): Promise<{ run_id: string }>
      run(jetsonId: string, host: string, serverPort: number, runId: string): Promise<RunState>
    }
    tunnel: {
      open(jetsonId: string, host: string, remotePort: number): Promise<TunnelInfo>
      close(jetsonId: string): Promise<void>
      list(): Promise<TunnelInfo[]>
      onChanged(callback: (tunnels: TunnelInfo[]) => void): () => void
    }
    onLogLine(callback: (entry: { host: string; line: string }) => void): () => void
  }
}
