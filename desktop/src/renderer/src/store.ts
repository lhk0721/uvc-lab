import { createStore } from 'zustand/vanilla'

// Mirror of main-owned push state (design: provisioning state is pushed over
// IPC, never queried) plus the card state that must survive an unmount. Kept
// free of window/electron so the logic runs under plain Node.

export const LOG_LIMIT = 500

export interface LogEntry {
  host: string
  line: string
}

export type ServerPhase = 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export interface ServerState {
  phase: ServerPhase
  health?: ServerHealth
  error?: string
}

export interface LabState {
  jetsons: DiscoveredJetson[]
  /** Last provision state per host — provision runs are addressed by host. */
  provisions: Record<string, ProvisionState>
  tunnels: TunnelInfo[]
  logs: LogEntry[]
  /** What this app session knows about the server, per Jetson id. */
  servers: Record<string, ServerState>
  /** Route (host) the user picked on the card, per Jetson id. */
  activeHosts: Record<string, string>
  setJetsons(jetsons: DiscoveredJetson[]): void
  setTunnels(tunnels: TunnelInfo[]): void
  applyProvision(state: ProvisionState): void
  appendLog(entry: LogEntry): void
  clearLogs(): void
  setServer(jetsonId: string, state: ServerState): void
  setActiveHost(jetsonId: string, host: string): void
}

export const labStore = createStore<LabState>()((set) => ({
  jetsons: [],
  provisions: {},
  tunnels: [],
  logs: [],
  servers: {},
  activeHosts: {},
  setJetsons: (jetsons) => set({ jetsons }),
  setTunnels: (tunnels) => set({ tunnels }),
  applyProvision: (state) =>
    set((s) => ({ provisions: { ...s.provisions, [state.host]: state } })),
  appendLog: (entry) => set((s) => ({ logs: [...s.logs, entry].slice(-LOG_LIMIT) })),
  clearLogs: () => set({ logs: [] }),
  setServer: (jetsonId, state) =>
    set((s) => ({ servers: { ...s.servers, [jetsonId]: state } })),
  setActiveHost: (jetsonId, host) =>
    set((s) => ({ activeHosts: { ...s.activeHosts, [jetsonId]: host } }))
}))

/** Phases with a provision run in flight — card buttons stay disabled. */
export function provisionBusy(phase: ProvisionPhase | undefined): boolean {
  return (
    phase === 'connect' ||
    phase === 'auth' ||
    phase === 'push' ||
    phase === 'bootstrap' ||
    phase === 'linger'
  )
}
