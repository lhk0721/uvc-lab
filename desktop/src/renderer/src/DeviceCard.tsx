import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { labStore, provisionBusy, type ServerPhase } from './store'

const ROUTE_LABEL: Record<RouteKind, string> = {
  usb: 'USB',
  mdns: 'mDNS',
  'lan-scan': 'LAN 스캔',
  tailscale: 'Tailscale',
  manual: '수동'
}

const PHASE_LABEL: Record<ProvisionPhase, string> = {
  connect: '접속 중…',
  auth: '인증 중…',
  push: '코드 전송 중…',
  bootstrap: '설치 실행 중…',
  linger: 'linger 설정 중…',
  ready: '설치 완료',
  'needs-auth': '로그인이 필요합니다',
  'needs-sudo': 'sudo 비밀번호가 필요합니다',
  failed: '설치 실패'
}

const SERVER_LABEL: Record<ServerPhase, string> = {
  unknown: '서버 상태 미확인',
  starting: '서버 시작 중…',
  running: '서버 실행 중',
  stopping: '서버 정지 중…',
  stopped: '서버 정지됨',
  error: '서버 동작 실패'
}

// The Jetson's default loopback port; the real value comes from provision
// state (or an already-open tunnel) once known.
const DEFAULT_SERVER_PORT = 18100

export function DeviceCard({ jetson }: { jetson: DiscoveredJetson }) {
  const queryClient = useQueryClient()
  const chosenHost = useStore(labStore, (s) => s.activeHosts[jetson.id])
  const host =
    chosenHost && jetson.routes.some((r) => r.host === chosenHost)
      ? chosenHost
      : (jetson.routes[0]?.host ?? jetson.id)
  const provision = useStore(labStore, (s) => s.provisions[host])
  // Provision learns the box's real id before discovery re-identifies the
  // card, so anything keyed by Jetson id prefers it.
  const effectiveId = provision?.jetsonId ?? jetson.id
  const server = useStore(labStore, (s) => s.servers[effectiveId]) ?? { phase: 'unknown' as const }
  const tunnel = useStore(labStore, (s) => s.tunnels.find((t) => t.jetsonId === effectiveId))
  const { setActiveHost, setServer, applyProvision } = labStore.getState()

  const stored = useQuery({
    queryKey: ['credentials', effectiveId],
    queryFn: () => window.labDesk.credentials.has(effectiveId)
  })
  const canPersist = useQuery({
    queryKey: ['credentials:canPersist'],
    queryFn: () => window.labDesk.credentials.canPersist()
  })

  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [sudoPassword, setSudoPassword] = useState('')
  const [save, setSave] = useState(true)
  const [copied, setCopied] = useState(false)

  const busy =
    provisionBusy(provision?.phase) || server.phase === 'starting' || server.phase === 'stopping'
  const installed = provision?.phase === 'ready' || server.phase === 'running'
  const serverPort = provision?.serverPort ?? tunnel?.remotePort ?? DEFAULT_SERVER_PORT

  const runProvision = (opts: {
    auth?: ProvisionRunOptions['auth']
    forcePush?: boolean
  } = {}): void => {
    const jetsonId = jetson.identified ? jetson.id : provision?.jetsonId
    void window.labDesk.provision
      .run({
        host,
        ...(jetsonId && { jetsonId }),
        ...(opts.auth && { auth: opts.auth }),
        ...(opts.forcePush && { forcePush: true })
      })
      .then((state) => {
        applyProvision(state)
        void queryClient.invalidateQueries({ queryKey: ['credentials'] })
      })
      .catch((err: Error) => applyProvision({ host, phase: 'failed', error: err.message }))
  }

  const submitAuth = (event: FormEvent): void => {
    event.preventDefault()
    if (!user.trim() || !password) return
    runProvision({
      auth: { user: user.trim(), password, save: save && canPersist.data === true }
    })
    setPassword('')
  }

  const submitSudo = (event: FormEvent): void => {
    event.preventDefault()
    if (!sudoPassword) return
    if (stored.data) {
      // The stored SSH password never reaches the renderer, so the sudo
      // password is merged main-side and the run restarts from storage.
      void window.labDesk.credentials
        .setSudo(effectiveId, sudoPassword)
        .then(() => runProvision())
        .catch((err: Error) => applyProvision({ host, phase: 'failed', error: err.message }))
    } else {
      if (!user.trim() || !password) return
      runProvision({
        auth: {
          user: user.trim(),
          password,
          sudoPassword,
          save: save && canPersist.data === true
        }
      })
      setPassword('')
    }
    setSudoPassword('')
  }

  const start = (): void => {
    setServer(effectiveId, { phase: 'starting' })
    void (async () => {
      try {
        const health = await window.labDesk.server.start(effectiveId, host, serverPort)
        await window.labDesk.tunnel.open(effectiveId, host, serverPort)
        setServer(effectiveId, { phase: 'running', health })
      } catch (err) {
        setServer(effectiveId, { phase: 'error', error: (err as Error).message })
      }
    })()
  }

  const stop = (): void => {
    setServer(effectiveId, { phase: 'stopping' })
    void (async () => {
      try {
        await window.labDesk.tunnel.close(effectiveId)
        await window.labDesk.server.stop(effectiveId, host)
        setServer(effectiveId, { phase: 'stopped' })
      } catch (err) {
        setServer(effectiveId, { phase: 'error', error: (err as Error).message })
      }
    })()
  }

  const copyUrl = (): void => {
    if (!tunnel) return
    void navigator.clipboard.writeText(tunnel.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const authFields = (
    <>
      <input
        placeholder="SSH 사용자"
        value={user}
        onChange={(event) => setUser(event.target.value)}
      />
      <input
        type="password"
        placeholder="SSH 비밀번호"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {canPersist.data === true ? (
        <label className="save-label">
          <input
            type="checkbox"
            checked={save}
            onChange={(event) => setSave(event.target.checked)}
          />
          저장
        </label>
      ) : (
        <span className="dim-note">이 OS에선 암호화 저장이 안 됩니다 — 이번만 사용</span>
      )}
    </>
  )

  return (
    <li className="device-card">
      <header className="card-header">
        <span className={`dot ${server.phase}`} title={SERVER_LABEL[server.phase]} />
        <strong>{jetson.id}</strong>
        {!jetson.identified && <span className="badge dim">미확인</span>}
        {server.health?.version && <span className="badge">v{server.health.version}</span>}
        {stored.data && <span className="dim-note">{stored.data.user} 계정 저장됨</span>}
      </header>

      <ul className="route-list">
        {jetson.routes.map((route) => (
          <li key={`${route.kind}:${route.host}`}>
            <button
              type="button"
              className={`route-pick${route.host === host ? ' active' : ''}`}
              onClick={() => setActiveHost(jetson.id, route.host)}
            >
              <span className="badge">{ROUTE_LABEL[route.kind]}</span> {route.host}
              {route.name ? ` (${route.name})` : ''}
              {route.relayed ? ' · relay 경유' : ''}
              {route.host === host ? ' · 사용 중' : ''}
            </button>
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

      {provision && (
        <p className={`provision-line ${provision.phase}`}>
          {PHASE_LABEL[provision.phase]}
          {provision.step ? ` · ${provision.step}` : ''}
          {provision.phase === 'ready' && provision.serverPort
            ? ` · 서버 포트 ${provision.serverPort}`
            : ''}
          {provision.error ? ` — ${provision.error}` : ''}
        </p>
      )}
      {server.phase === 'error' && (
        <p className="provision-line failed">
          {SERVER_LABEL.error}
          {server.error ? ` — ${server.error}` : ''}
        </p>
      )}

      {provision?.phase === 'needs-auth' && (
        <form className="auth-form" onSubmit={submitAuth}>
          {authFields}
          <button type="submit" disabled={busy}>
            로그인 후 계속
          </button>
        </form>
      )}

      {provision?.phase === 'needs-sudo' && (
        <div className="sudo-block">
          {provision.manualCommand && (
            <p className="dim-note">
              직접 실행해도 됩니다: <code>{provision.manualCommand}</code>
            </p>
          )}
          <form className="auth-form" onSubmit={submitSudo}>
            {!stored.data && authFields}
            <input
              type="password"
              placeholder="sudo 비밀번호"
              value={sudoPassword}
              onChange={(event) => setSudoPassword(event.target.value)}
            />
            <button type="submit" disabled={busy}>
              sudo 설정 후 계속
            </button>
          </form>
        </div>
      )}

      {tunnel && (
        <p className="tunnel-line">
          <code>{tunnel.url}</code>
          <button type="button" onClick={copyUrl}>
            {copied ? '복사됨' : '복사'}
          </button>
        </p>
      )}

      <div className="card-actions">
        <button type="button" disabled={busy} onClick={() => runProvision({ forcePush: installed })}>
          {installed ? '재설치' : '설치'}
        </button>
        <button type="button" disabled={busy || server.phase === 'running'} onClick={start}>
          시작
        </button>
        <button type="button" disabled={busy} onClick={stop}>
          정지
        </button>
        <Link className="button-link" to="/rig/$jetsonId" params={{ jetsonId: effectiveId }}>
          구성
        </Link>
      </div>
    </li>
  )
}
