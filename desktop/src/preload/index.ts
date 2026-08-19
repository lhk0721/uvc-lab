import { contextBridge, ipcRenderer } from 'electron'

// The renderer sees exactly this object and nothing else. Device/rig/provision
// channels (spec section 9) are added here as their main modules land; the
// renderer-side mirror of this type lives in src/renderer/src/env.d.ts.
const labDesk = {
  appInfo: (): Promise<{ version: string; electron: string; node: string }> =>
    ipcRenderer.invoke('app:info')
}

contextBridge.exposeInMainWorld('labDesk', labDesk)
