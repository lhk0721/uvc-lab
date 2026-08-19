/// <reference types="vite/client" />

// Hand-kept mirror of the preload surface (src/preload/index.ts) — the preload
// file itself cannot be imported here because it depends on Node/Electron types.
interface Window {
  labDesk: {
    appInfo(): Promise<{ version: string; electron: string; node: string }>
  }
}
