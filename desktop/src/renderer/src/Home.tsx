import { useEffect, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'

const ROUTE_LABEL: Record<RouteKind, string> = {
  usb: 'USB',
  mdns: 'mDNS',
  'lan-scan': 'LAN 스캔',
  tailscale: 'Tailscale',
  manual: '수동'
}

// Placeholder listing until step 9 turns entries into real device cards.
// Discovery state is main-owned push state: seed with `list`, then follow
// `discovery:changed`.
export function Home() {
  const info = useQuery({ queryKey: ['app:info'], queryFn: () => window.labDesk.appInfo() })
  const [jetsons, setJetsons] = useState<DiscoveredJetson[]>([])
  const [manualHost, setManualHost] = useState('')
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    const unsubscribe = window.labDesk.discovery.onChanged(setJetsons)
    void window.labDesk.discovery.list().then(setJetsons)
    return unsubscribe
  }, [])

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
            <li key={jetson.id}>
              <strong>{jetson.id}</strong>
              {!jetson.identified && <span className="badge dim">미확인</span>}
              <ul className="route-list">
                {jetson.routes.map((route) => (
                  <li key={`${route.kind}:${route.host}`}>
                    <span className="badge">{ROUTE_LABEL[route.kind]}</span> {route.host}
                    {route.name ? ` (${route.name})` : ''}
                    {route.relayed ? ' · relay 경유' : ''}
                    {route.kind === 'manual' && (
                      <button
                        type="button"
                        onClick={() => void window.labDesk.discovery.removeManual(route.host)}
                      >
                        제거
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
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
