import { contextBridge, ipcRenderer } from 'electron'
import type { DiscoveredJetson } from '../main/discovery.ts'
import type { ProvisionRunOptions, ProvisionState, ServerHealth } from '../main/provision.ts'
import type { TunnelInfo } from '../main/tunnel.ts'

// The renderer sees exactly this object and nothing else. Device/rig channels
// (spec section 9) are added here as their main modules land; the
// renderer-side mirror of this type lives in src/renderer/src/env.d.ts.

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const labDesk = {
  appInfo: (): Promise<{ version: string; electron: string; node: string }> =>
    ipcRenderer.invoke('app:info'),

  discovery: {
    list: (): Promise<DiscoveredJetson[]> => ipcRenderer.invoke('discovery:list'),
    scan: (): Promise<void> => ipcRenderer.invoke('discovery:scan'),
    addManual: (host: string): Promise<void> => ipcRenderer.invoke('discovery:addManual', host),
    removeManual: (host: string): Promise<void> =>
      ipcRenderer.invoke('discovery:removeManual', host),
    onChanged: (callback: (jetsons: DiscoveredJetson[]) => void): (() => void) =>
      subscribe('discovery:changed', callback)
  },

  // Passwords travel inward only: nothing here can read one back out.
  credentials: {
    canPersist: (): Promise<boolean> => ipcRenderer.invoke('credentials:canPersist'),
    has: (jetsonId: string): Promise<{ user: string } | null> =>
      ipcRenderer.invoke('credentials:has', jetsonId),
    set: (
      jetsonId: string,
      creds: { user: string; password: string; sudoPassword?: string }
    ): Promise<void> => ipcRenderer.invoke('credentials:set', jetsonId, creds),
    delete: (jetsonId: string): Promise<void> => ipcRenderer.invoke('credentials:delete', jetsonId),
    setSudo: (jetsonId: string, sudoPassword: string): Promise<void> =>
      ipcRenderer.invoke('credentials:setSudo', jetsonId, sudoPassword)
  },

  provision: {
    run: (options: ProvisionRunOptions): Promise<ProvisionState> =>
      ipcRenderer.invoke('provision:run', options),
    onChanged: (callback: (state: ProvisionState) => void): (() => void) =>
      subscribe('provision:changed', callback)
  },

  server: {
    start: (jetsonId: string, host: string, port: number): Promise<ServerHealth> =>
      ipcRenderer.invoke('server:start', jetsonId, host, port),
    stop: (jetsonId: string, host: string): Promise<void> =>
      ipcRenderer.invoke('server:stop', jetsonId, host)
  },

  // Device/rig payloads pass through main untouched (JSON from the Jetson
  // server); their shapes are owned by the renderer-side mirror in env.d.ts.
  devices: {
    list: (jetsonId: string, host: string, serverPort: number): Promise<unknown> =>
      ipcRenderer.invoke('devices:list', jetsonId, host, serverPort)
  },

  rig: {
    get: (jetsonId: string, host: string, serverPort: number): Promise<unknown> =>
      ipcRenderer.invoke('rig:get', jetsonId, host, serverPort),
    save: (jetsonId: string, host: string, serverPort: number, rig: unknown): Promise<unknown> =>
      ipcRenderer.invoke('rig:save', jetsonId, host, serverPort, rig)
  },

  tunnel: {
    open: (jetsonId: string, host: string, remotePort: number): Promise<TunnelInfo> =>
      ipcRenderer.invoke('tunnel:open', jetsonId, host, remotePort),
    close: (jetsonId: string): Promise<void> => ipcRenderer.invoke('tunnel:close', jetsonId),
    list: (): Promise<TunnelInfo[]> => ipcRenderer.invoke('tunnel:list'),
    onChanged: (callback: (tunnels: TunnelInfo[]) => void): (() => void) =>
      subscribe('tunnel:changed', callback)
  },

  onLogLine: (callback: (entry: { host: string; line: string }) => void): (() => void) =>
    subscribe('log:line', callback)
}

contextBridge.exposeInMainWorld('labDesk', labDesk)
