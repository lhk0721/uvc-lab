import { contextBridge, ipcRenderer } from 'electron'
import type { DiscoveredJetson } from '../main/discovery'

// The renderer sees exactly this object and nothing else. Device/rig/provision
// channels (spec section 9) are added here as their main modules land; the
// renderer-side mirror of this type lives in src/renderer/src/env.d.ts.
const labDesk = {
  appInfo: (): Promise<{ version: string; electron: string; node: string }> =>
    ipcRenderer.invoke('app:info'),

  discovery: {
    list: (): Promise<DiscoveredJetson[]> => ipcRenderer.invoke('discovery:list'),
    scan: (): Promise<void> => ipcRenderer.invoke('discovery:scan'),
    addManual: (host: string): Promise<void> => ipcRenderer.invoke('discovery:addManual', host),
    removeManual: (host: string): Promise<void> =>
      ipcRenderer.invoke('discovery:removeManual', host),
    onChanged: (callback: (jetsons: DiscoveredJetson[]) => void): (() => void) => {
      const listener = (_event: unknown, jetsons: DiscoveredJetson[]): void => callback(jetsons)
      ipcRenderer.on('discovery:changed', listener)
      return () => {
        ipcRenderer.removeListener('discovery:changed', listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('labDesk', labDesk)
