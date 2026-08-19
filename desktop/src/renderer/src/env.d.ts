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
  }
}
