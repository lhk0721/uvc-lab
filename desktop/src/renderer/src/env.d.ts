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
  auth?: { user: string; password: string; save: boolean }
  forcePush?: boolean
}

interface ServerHealth {
  app?: string
  version?: string
  hostname?: string
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
    }
    provision: {
      run(options: ProvisionRunOptions): Promise<ProvisionState>
      onChanged(callback: (state: ProvisionState) => void): () => void
    }
    server: {
      start(jetsonId: string, host: string, port: number): Promise<ServerHealth>
      stop(jetsonId: string, host: string): Promise<void>
    }
    onLogLine(callback: (entry: { host: string; line: string }) => void): () => void
  }
}
