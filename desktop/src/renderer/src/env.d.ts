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
    tunnel: {
      open(jetsonId: string, host: string, remotePort: number): Promise<TunnelInfo>
      close(jetsonId: string): Promise<void>
      list(): Promise<TunnelInfo[]>
      onChanged(callback: (tunnels: TunnelInfo[]) => void): () => void
    }
    onLogLine(callback: (entry: { host: string; line: string }) => void): () => void
  }
}
