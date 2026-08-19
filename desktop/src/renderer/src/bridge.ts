import { labStore } from './store'

// IPC push subscriptions live at module level, not in React lifecycle:
// StrictMode double-mounts effects, and these must be exactly-once for the
// app's lifetime. Called from main.tsx before the first render.

let wired = false

export function initBridge(): void {
  if (wired) return
  wired = true
  const s = labStore.getState()
  window.labDesk.discovery.onChanged(s.setJetsons)
  window.labDesk.provision.onChanged(s.applyProvision)
  window.labDesk.tunnel.onChanged(s.setTunnels)
  window.labDesk.onLogLine(s.appendLog)
  // Seed with the current snapshots — pushes only cover changes from now on.
  void window.labDesk.discovery.list().then(s.setJetsons)
  void window.labDesk.tunnel.list().then(s.setTunnels)
}
