import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useStore } from 'zustand'
import { labStore } from './store'
import { DeviceCard } from './DeviceCard'
import { LogPanel } from './LogPanel'

// Discovery state is main-owned push state: bridge.ts seeds and follows
// `discovery:changed`; this component only renders the store.
export function Home() {
  const info = useQuery({ queryKey: ['app:info'], queryFn: () => window.labDesk.appInfo() })
  const jetsons = useStore(labStore, (s) => s.jetsons)
  const [manualHost, setManualHost] = useState('')
  const [scanning, setScanning] = useState(false)

  const rescan = (): void => {
    setScanning(true)
    void window.labDesk.discovery.scan().finally(() => setScanning(false))
  }

  const addManual = (event: FormEvent): void => {
    event.preventDefault()
    const host = manualHost.trim()
    if (!host) return
    void window.labDesk.discovery.addManual(host)
    setManualHost('')
  }

  return (
    <main>
      <h1>Lab Desk</h1>

      {jetsons.length === 0 ? (
        <p>발견된 장비가 없습니다. 네트워크를 살펴보는 중…</p>
      ) : (
        <ul className="jetson-list">
          {jetsons.map((jetson) => (
            <DeviceCard key={jetson.id} jetson={jetson} />
          ))}
        </ul>
      )}

      <div className="discovery-actions">
        <button type="button" onClick={rescan} disabled={scanning}>
          {scanning ? '탐색 중…' : '다시 탐색'}
        </button>
        <form onSubmit={addManual}>
          <input
            value={manualHost}
            onChange={(event) => setManualHost(event.target.value)}
            placeholder="IP 또는 hostname 직접 추가"
          />
          <button type="submit">추가</button>
        </form>
      </div>

      <LogPanel />

      <footer>
        {info.data
          ? `v${info.data.version} · Electron ${info.data.electron} · Node ${info.data.node}`
          : info.isError
            ? 'main process에 연결하지 못했습니다'
            : '…'}
      </footer>
    </main>
  )
}
