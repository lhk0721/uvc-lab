import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { labStore } from './store'
import { LogPanel } from './LogPanel'
import { ProfilePanel } from './ProfilePanel'
import { issueMessage, markOf, matchRig, STATUS_LABEL } from './rig'
import {
  clampControl,
  coerceParam,
  controlLabel,
  DEFAULT_PREVIEW,
  describeMode,
  formatParam,
  labBlocked,
  modeDeltas,
  newLogLines,
  presetDefaults,
  runFinished,
  runRigStatus,
  streamUrl,
  type PreviewMode
} from './lab'

const DEFAULT_SERVER_PORT = 18100
const STREAM_POLL_MS = 2000
const RUN_POLL_MS = 800

export function LabScreen() {
  const { jetsonId } = useParams({ from: '/lab/$jetsonId' })
  const queryClient = useQueryClient()

  const jetson = useStore(labStore, (s) => s.jetsons.find((j) => j.id === jetsonId))
  const chosenHost = useStore(labStore, (s) => s.activeHosts[jetsonId])
  // Same fallback as the rig screen: a provision knows the box's id before
  // discovery's next identify cycle files the card under it.
  const provisioned = useStore(labStore, (s) =>
    Object.values(s.provisions).find((p) => p.jetsonId === jetsonId)
  )
  const host =
    chosenHost && jetson?.routes.some((r) => r.host === chosenHost)
      ? chosenHost
      : (jetson?.routes[0]?.host ?? provisioned?.host)
  const provision = useStore(labStore, (s) => (host ? s.provisions[host] : undefined))
  const tunnel = useStore(labStore, (s) => s.tunnels.find((t) => t.jetsonId === jetsonId))
  const serverPort = provision?.serverPort ?? tunnel?.remotePort ?? DEFAULT_SERVER_PORT

  const devices = useQuery<JetsonDevice[]>({
    queryKey: ['devices', jetsonId],
    queryFn: () => window.labDesk.devices.list(jetsonId, host as string, serverPort),
    enabled: !!host,
    retry: false
  })
  const rig = useQuery<Rig | null>({
    queryKey: ['rig', jetsonId],
    queryFn: () => window.labDesk.rig.get(jetsonId, host as string, serverPort),
    enabled: !!host,
    retry: false
  })
  const modeOptions = useQuery<ModeOptions>({
    queryKey: ['modes', jetsonId],
    queryFn: () => window.labDesk.lab.modes(jetsonId, host as string, serverPort),
    enabled: !!host,
    retry: false,
    staleTime: Infinity
  })
  const presets = useQuery<Preset[]>({
    queryKey: ['presets', jetsonId],
    queryFn: () => window.labDesk.lab.presets(jetsonId, host as string, serverPort),
    enabled: !!host,
    retry: false,
    staleTime: Infinity
  })

  const [override, setOverride] = useState(false)
  const [previews, setPreviews] = useState<Record<number, PreviewMode>>({})
  const [applied, setApplied] = useState<Record<number, { mode: PreviewMode; nonce: number }>>({})
  const [controlIndex, setControlIndex] = useState<number | null>(null)
  const [controlError, setControlError] = useState('')
  const [presetId, setPresetId] = useState('')
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [runId, setRunId] = useState<string | null>(null)
  const [startError, setStartError] = useState('')
  const seenLogRef = useRef(0)

  const match = useMemo(
    () => matchRig(rig.data ?? null, devices.data ?? []),
    [rig.data, devices.data]
  )
  const blocked = labBlocked(match.status, override)
  const openDevices = useMemo(
    () => (devices.data ?? []).filter((d) => d.opened),
    [devices.data]
  )

  const run = useQuery<RunState>({
    queryKey: ['run', jetsonId, runId],
    queryFn: () => window.labDesk.lab.run(jetsonId, host as string, serverPort, runId as string),
    enabled: !!host && !!runId,
    retry: false,
    refetchInterval: (query) => (runFinished(query.state.data) ? false : RUN_POLL_MS),
    // A measurement runs on the box, not in this window. Without this the
    // poll stops the moment the operator switches to another window and the
    // run sits at "running" until they come back — measured against a real
    // run that had already finished on the Jetson.
    refetchIntervalInBackground: true
  })
  const running = run.data?.status === 'running'

  const streams = useQuery<{ streams: Record<string, StreamStats> }>({
    queryKey: ['streams', jetsonId],
    queryFn: () => window.labDesk.lab.streams(jetsonId, host as string, serverPort),
    // A run owns the device exclusively; polling stream stats through it would
    // only report the previews it just preempted.
    enabled: !!host && !blocked && !running && Object.keys(applied).length > 0,
    retry: false,
    refetchInterval: STREAM_POLL_MS
  })

  const controls = useQuery<ControlSet>({
    queryKey: ['controls', jetsonId, controlIndex],
    queryFn: () =>
      window.labDesk.lab.controls(jetsonId, host as string, serverPort, controlIndex as number),
    enabled: !!host && controlIndex !== null,
    retry: false
  })

  // Preview settings start from the defaults and then belong to the user.
  useEffect(() => {
    if (openDevices.length === 0) return
    setPreviews((current) => {
      const next = { ...current }
      let changed = false
      for (const device of openDevices) {
        if (!(device.index in next)) {
          next[device.index] = { ...DEFAULT_PREVIEW }
          changed = true
        }
      }
      return changed ? next : current
    })
    setControlIndex((current) => (current === null ? openDevices[0].index : current))
  }, [openDevices])

  useEffect(() => {
    if (presetId || !presets.data?.length) return
    setPresetId(presets.data[0].id)
    setParams(presetDefaults(presets.data[0]))
  }, [presetId, presets.data])

  // Run output joins the same panel as provision/start output (spec 7.6).
  useEffect(() => {
    const lines = newLogLines(run.data?.log, seenLogRef.current)
    if (lines.length === 0) return
    seenLogRef.current += lines.length
    const append = labStore.getState().appendLog
    for (const line of lines) append({ host: host ?? jetsonId, line })
  }, [run.data?.log, host, jetsonId])

  // A finished run releases the cameras it preempted; the previews that were
  // showing have to be told to reconnect, an <img> will not do it by itself.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) {
      setApplied((current) => {
        const next: typeof current = {}
        for (const [index, entry] of Object.entries(current)) {
          next[Number(index)] = { mode: entry.mode, nonce: entry.nonce + 1 }
        }
        return next
      })
      void queryClient.invalidateQueries({ queryKey: ['devices', jetsonId] })
    }
    wasRunning.current = running
  }, [running, queryClient, jetsonId])

  const setPreview = (index: number, patch: Partial<PreviewMode>): void => {
    setPreviews((current) => ({
      ...current,
      [index]: { ...(current[index] ?? DEFAULT_PREVIEW), ...patch }
    }))
  }

  const applyMode = (index: number): void => {
    const mode = previews[index] ?? DEFAULT_PREVIEW
    setApplied((current) => ({
      ...current,
      [index]: { mode: { ...mode }, nonce: (current[index]?.nonce ?? 0) + 1 }
    }))
  }

  const stopPreview = (index: number): void => {
    setApplied((current) => {
      const next = { ...current }
      delete next[index]
      return next
    })
  }

  const setControl = (control: JetsonControl, raw: number): void => {
    if (controlIndex === null || !host) return
    const value = clampControl(control, raw)
    setControlError('')
    window.labDesk.lab
      .setControl(jetsonId, host, serverPort, { index: controlIndex, key: control.key, value })
      .then((answer) => {
        // The driver's value, not the requested one (spec 7.3 / 7.2).
        queryClient.setQueryData<ControlSet>(['controls', jetsonId, controlIndex], (current) =>
          current
            ? {
                ...current,
                controls: current.controls.map((c) =>
                  c.key === answer.key ? { ...c, value: answer.value } : c
                )
              }
            : current
        )
      })
      .catch((err: Error) => setControlError(err.message))
  }

  // One entry point for both the bench panel and a test profile (spec 8), so
  // a run is started the same way whatever picked its parameters.
  const startRun = (request: {
    preset: string
    params: Record<string, unknown>
    profileId?: string | null
  }): void => {
    if (!host || !request.preset) return
    setStartError('')
    seenLogRef.current = 0
    window.labDesk.lab
      .runStart(jetsonId, host, serverPort, {
        ...request,
        // Spec 5: a run past a mismatch carries the status it ran under.
        rigStatus: runRigStatus(match.status)
      })
      .then((answer) => setRunId(answer.run_id))
      .catch((err: Error) => setStartError(err.message))
  }

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['devices', jetsonId] })
    void queryClient.invalidateQueries({ queryKey: ['rig', jetsonId] })
    if (controlIndex !== null) {
      void queryClient.invalidateQueries({ queryKey: ['controls', jetsonId, controlIndex] })
    }
  }

  if (!host) {
    return (
      <main className="lab-screen">
        <p>이 장비가 목록에 없습니다. 탐색 화면으로 돌아가 다시 선택하세요.</p>
        <Link to="/">← 장비 목록</Link>
      </main>
    )
  }

  const connectError = devices.isError || rig.isError
  const loading = devices.isPending || rig.isPending
  const preset = presets.data?.find((p) => p.id === presetId)
  const streamOf = (index: number): StreamStats | undefined => streams.data?.streams[String(index)]
  const nameOf = (device: JetsonDevice): string => {
    const cam = rig.data?.cameras.find((c) => c.camId && c.camId === device.camId)
    const mark = device.camId ? `${markOf(device.camId)} · ` : ''
    return `${mark}${cam?.label || device.usb?.product || `video${device.index}`}`
  }

  return (
    <main className="lab-screen">
      <header className="rig-header">
        <Link to="/">← 장비 목록</Link>
        <h1>랩 — {jetsonId}</h1>
        <Link className="button-link" to="/rig/$jetsonId" params={{ jetsonId }}>
          구성
        </Link>
        <button type="button" onClick={refresh} disabled={loading}>
          다시 감지
        </button>
      </header>

      {connectError && (
        <p className="provision-line failed">
          Jetson 서버에 연결하지 못했습니다 — 장비 카드에서 서버를 먼저 시작하세요.
          {devices.error ? ` (${(devices.error as Error).message})` : ''}
        </p>
      )}

      {!connectError && !loading && (
        <section className={`rig-status ${match.status}`}>
          <strong>{STATUS_LABEL[match.status]}</strong>
          {match.issues.length > 0 && (
            <ul>
              {match.issues.map((issue, i) => (
                <li key={`${issue.kind}:${issue.camId}:${i}`}>{issueMessage(issue)}</li>
              ))}
            </ul>
          )}
          {blocked && (
            <div className="gate-actions">
              <Link className="button-link" to="/rig/$jetsonId" params={{ jetsonId }}>
                구성 화면에서 고치기
              </Link>
              <button type="button" onClick={() => setOverride(true)}>
                무시하고 진행
              </button>
              <span className="dim-note">
                진행하면 실행 결과에 `{match.status}`가 함께 기록됩니다 — 어떤 구성에서 나온
                숫자인지 남기기 위해서입니다.
              </span>
            </div>
          )}
          {override && match.status !== 'ok' && (
            <span className="dim-note">
              무시하고 진행 중 — 이 상태(`{match.status}`)로 실행 결과가 기록됩니다.
            </span>
          )}
        </section>
      )}

      {!blocked && !connectError && (
        <>
          <section className="lab-cameras">
            <h2>프리뷰 · 모드</h2>
            {!tunnel && (
              <p className="dim-note">
                프리뷰는 터널이 열려 있어야 나옵니다 — 장비 카드에서 시작을 누르세요. 모드·파라미터
                설정은 터널 없이도 동작합니다.
              </p>
            )}
            {running && (
              <p className="dim-note">
                벤치마크가 카메라를 독점하는 동안 프리뷰는 멈춥니다. 끝나면 자동으로 다시
                연결됩니다.
              </p>
            )}
            <div className="camera-grid">
              {openDevices.map((device) => {
                const mode = previews[device.index] ?? DEFAULT_PREVIEW
                const live = applied[device.index]
                const stats = streamOf(device.index)
                const deltas = modeDeltas(stats)
                return (
                  <article key={device.index} className="camera-panel">
                    <header>
                      <strong>{nameOf(device)}</strong>
                      {device.controlProfile && (
                        <span className="badge">{device.controlProfile}</span>
                      )}
                    </header>

                    {tunnel && live && !running ? (
                      <img
                        className="preview"
                        alt={nameOf(device)}
                        src={streamUrl(tunnel.url, device.index, live.mode, live.nonce)}
                      />
                    ) : (
                      <div className="preview placeholder">
                        {tunnel ? '정지' : '터널 없음'}
                      </div>
                    )}

                    <div className="mode-form">
                      <label>
                        해상도
                        <select
                          value={mode.resolution}
                          onChange={(e) => setPreview(device.index, { resolution: e.target.value })}
                        >
                          {(modeOptions.data?.resolutions ?? [mode.resolution]).map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        포맷
                        <select
                          value={mode.fourcc}
                          onChange={(e) => setPreview(device.index, { fourcc: e.target.value })}
                        >
                          {(modeOptions.data?.fourccs ?? [mode.fourcc]).map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        요청 fps
                        <input
                          className="fps-input"
                          type="number"
                          min={1}
                          placeholder="자동"
                          value={mode.fps ?? ''}
                          onChange={(e) =>
                            setPreview(device.index, {
                              fps: e.target.value === '' ? null : Number(e.target.value)
                            })
                          }
                        />
                      </label>
                      <button type="button" onClick={() => applyMode(device.index)}>
                        {live ? '다시 적용' : '프리뷰 시작'}
                      </button>
                      {live && (
                        <button type="button" onClick={() => stopPreview(device.index)}>
                          정지
                        </button>
                      )}
                    </div>

                    <div className="observed">
                      <span>요청 {describeMode(stats?.requested)}</span>
                      <span> → 관측 {describeMode(stats?.observed)}</span>
                      {stats?.active && stats.fps != null && (
                        <span className="dim-note"> · 실측 {stats.fps}fps</span>
                      )}
                    </div>
                    {deltas.length > 0 && (
                      <p className="mode-delta">
                        드라이버가 다른 값을 줬습니다 —{' '}
                        {deltas
                          .map((d) => `${d.field} ${d.requested} → ${d.observed}`)
                          .join(', ')}
                      </p>
                    )}
                    {stats?.error && <p className="mode-delta">{stats.error}</p>}
                  </article>
                )
              })}
              {openDevices.length === 0 && (
                <p className="dim-note">열 수 있는 카메라가 없습니다.</p>
              )}
            </div>
          </section>

          <section className="lab-controls">
            <h2>파라미터</h2>
            <div className="control-head">
              <select
                value={controlIndex ?? ''}
                onChange={(e) => setControlIndex(Number(e.target.value))}
              >
                {openDevices.map((device) => (
                  <option key={device.index} value={device.index}>
                    {nameOf(device)}
                  </option>
                ))}
              </select>
              <span className="dim-note">
                범위·기본값은 장치에서 직접 읽습니다 — 같은 모델이라도 다릅니다.
              </span>
            </div>
            {controls.isError && (
              <p className="provision-line failed">
                컨트롤을 읽지 못했습니다 — {(controls.error as Error).message}
              </p>
            )}
            {controls.data && !controls.data.supported && (
              <p className="dim-note">이 장비에서는 V4L2 컨트롤을 조회할 수 없습니다.</p>
            )}
            {controlError && <p className="provision-line failed">{controlError}</p>}
            <ul className="control-list">
              {(controls.data?.controls ?? []).map((control) => (
                <li key={control.key} className={control.readOnly ? 'control-row dim' : 'control-row'}>
                  <span className="control-name">{controlLabel(control)}</span>
                  {control.type === 'menu' ? (
                    <select
                      value={control.value ?? control.default}
                      disabled={control.readOnly}
                      onChange={(e) => setControl(control, Number(e.target.value))}
                    >
                      {(control.menu ?? []).map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  ) : control.type === 'bool' ? (
                    <input
                      type="checkbox"
                      checked={!!control.value}
                      disabled={control.readOnly}
                      onChange={(e) => setControl(control, e.target.checked ? 1 : 0)}
                    />
                  ) : (
                    <>
                      <input
                        type="range"
                        min={control.min}
                        max={control.max}
                        step={control.step}
                        value={control.value ?? control.default}
                        disabled={control.readOnly}
                        onChange={(e) => setControl(control, Number(e.target.value))}
                      />
                      <input
                        className="control-value"
                        type="number"
                        min={control.min}
                        max={control.max}
                        step={control.step}
                        value={control.value ?? control.default}
                        disabled={control.readOnly}
                        onChange={(e) => setControl(control, Number(e.target.value))}
                      />
                    </>
                  )}
                  <span className="dim-note">
                    {control.min}..{control.max} step {control.step} · 기본 {control.default}
                    {control.readOnly ? ' · 지금은 쓸 수 없음' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="lab-bench">
            <h2>벤치마크</h2>
            <div className="bench-head">
              <select
                value={presetId}
                onChange={(e) => {
                  const next = presets.data?.find((p) => p.id === e.target.value)
                  setPresetId(e.target.value)
                  if (next) setParams(presetDefaults(next))
                }}
              >
                {(presets.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => startRun({ preset: presetId, params })}
                disabled={!preset || running}
              >
                {running ? '실행 중…' : '실행'}
              </button>
              {preset?.duration_hint && <span className="dim-note">{preset.duration_hint}</span>}
            </div>
            {preset && <p className="dim-note">{preset.question}</p>}
            {startError && <p className="provision-line failed">{startError}</p>}
            {run.isError && (
              // Without this a failed poll looks like a run that produced
              // nothing, which is the one thing it must not look like.
              <p className="provision-line failed">
                실행 상태를 읽지 못했습니다 — {(run.error as Error).message}
              </p>
            )}

            <div className="bench-params">
              {(preset?.params ?? []).map((spec) => (
                <label key={spec.key}>
                  {spec.label}
                  {spec.type === 'bool' ? (
                    <input
                      type="checkbox"
                      checked={!!params[spec.key]}
                      onChange={(e) =>
                        setParams({ ...params, [spec.key]: coerceParam(spec, e.target.checked) })
                      }
                    />
                  ) : spec.type === 'select' ? (
                    <select
                      value={String(params[spec.key] ?? '')}
                      onChange={(e) =>
                        setParams({ ...params, [spec.key]: coerceParam(spec, e.target.value) })
                      }
                    >
                      {(spec.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : spec.type === 'multiselect' ? (
                    <span className="multi">
                      {(spec.options ?? []).map((option) => {
                        const current = (params[spec.key] as string[]) ?? []
                        return (
                          <label key={option}>
                            <input
                              type="checkbox"
                              checked={current.includes(option)}
                              onChange={(e) =>
                                setParams({
                                  ...params,
                                  [spec.key]: e.target.checked
                                    ? [...current, option]
                                    : current.filter((v) => v !== option)
                                })
                              }
                            />
                            {option}
                          </label>
                        )
                      })}
                    </span>
                  ) : (
                    <input
                      type={spec.type === 'int' || spec.type === 'float' ? 'number' : 'text'}
                      value={formatParam(params[spec.key])}
                      onChange={(e) =>
                        setParams({ ...params, [spec.key]: coerceParam(spec, e.target.value) })
                      }
                    />
                  )}
                </label>
              ))}
            </div>

            {run.data && (
              <div className={`run-result ${run.data.status}`}>
                <header>
                  <strong>{run.data.title}</strong>
                  <span className="badge">{run.data.status}</span>
                  {run.data.rigStatus && (
                    <span className="badge warn">rig: {run.data.rigStatus}</span>
                  )}
                  {run.data.profileId && (
                    <span className="badge">프로필: {run.data.profileId}</span>
                  )}
                </header>
                {run.data.error && <p className="provision-line failed">{run.data.error}</p>}
                {run.data.result && (
                  <>
                    <p className={`headline ${run.data.result.status}`}>
                      {run.data.result.headline}
                    </p>
                    {(run.data.result.tables ?? []).map((table) => (
                      <table key={table.title} className="result-table">
                        <caption>{table.title}</caption>
                        <thead>
                          <tr>
                            {table.columns.map((column) => (
                              <th key={column}>{column}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {table.rows.map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, j) => (
                                <td key={j}>{String(cell)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ))}
                    {(run.data.result.notes ?? []).map((note, i) => (
                      <p key={i} className="dim-note">
                        {note}
                      </p>
                    ))}
                  </>
                )}
              </div>
            )}
          </section>

          <ProfilePanel
            jetsonId={jetsonId}
            host={host}
            serverPort={serverPort}
            devices={devices.data ?? []}
            rig={rig.data ?? null}
            presets={presets.data ?? []}
            modeOptions={modeOptions.data}
            running={running}
            onRun={startRun}
          />
        </>
      )}

      <LogPanel />
    </main>
  )
}
