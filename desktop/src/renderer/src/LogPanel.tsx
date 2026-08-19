import { useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { labStore } from './store'

// Bootstrap/provision output streams here live (design: the log panel is
// where a stuck install becomes visible). Lines arrive over `log:line`.
export function LogPanel() {
  const logs = useStore(labStore, (s) => s.logs)
  const clearLogs = labStore.getState().clearLogs
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <section className="log-panel">
      <header>
        <span>로그</span>
        <button type="button" onClick={clearLogs} disabled={logs.length === 0}>
          지우기
        </button>
      </header>
      <div className="log-body" ref={bodyRef}>
        {logs.length === 0 ? (
          <p className="dim-note">설치·기동 출력이 여기에 흐릅니다.</p>
        ) : (
          logs.map((entry, index) => (
            <div key={index} className="log-line">
              <span className="log-host">{entry.host}</span> {entry.line}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
