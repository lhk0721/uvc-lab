import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { labStore } from './store'
import {
  applyHubMove,
  bindCandidates,
  CONNECTOR_PROFILES,
  DEFAULT_CONNECTOR,
  emptyWiring,
  issueMessage,
  markOf,
  matchRig,
  portSlots,
  snapshotExpect,
  STATUS_LABEL,
  toggleSignal,
  trgAllowed,
  usbRootOf
} from './rig'

const DEFAULT_SERVER_PORT = 18100

// The two defaults come from rack-tracker's FSIN wiring doc (spec 6.2); any
// other pin is legal and simply has no conventional name.
const PIN_NAMES: Record<number, string> = { 7: 'GPIO09', 11: 'GPIO17' }

interface Draft {
  name: string
  cameras: RigCamera[]
  trigger: RigTrigger
}

// A camera can enumerate, open, and still send nothing — measured on this
// hardware, where one camera came back from a USB fault answering every query
// but producing no frames. An <img> in that state stays blank forever and
// fires no error, so the tile has to notice by itself: MJPEG never fires
// onLoad, but a decoded first frame gives the element a size.
const PREVIEW_FIRST_FRAME_MS = 6_000

function PreviewTile({ src, caption }: { src: string; caption: string }) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    setStalled(false)
    const started = Date.now()
    // Keep looking rather than judging once: a slow camera on this hardware
    // took longer than the deadline and then streamed fine, so a late first
    // frame has to clear the warning instead of leaving a false alarm up.
    const timer = setInterval(() => {
      const gotFrame = (imgRef.current?.naturalWidth ?? 0) > 0
      setStalled(!gotFrame && Date.now() - started > PREVIEW_FIRST_FRAME_MS)
      if (gotFrame) clearInterval(timer)
    }, 1_000)
    return () => clearInterval(timer)
  }, [src])
  return (
    <figure>
      <img ref={imgRef} className="preview" alt={caption} src={src} />
      {stalled && <p className="preview-stalled">프레임 없음 — 카메라가 응답하지 않습니다</p>}
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

export function RigScreen() {
  const { jetsonId } = useParams({ from: '/rig/$jetsonId' })
  const queryClient = useQueryClient()

  const jetson = useStore(labStore, (s) => s.jetsons.find((j) => j.id === jetsonId))
  const chosenHost = useStore(labStore, (s) => s.activeHosts[jetsonId])
  // A provision learns the box's real id before discovery's next identify
  // cycle renames the card, so the route can be known here while the card is
  // still filed under its address (same rule as DeviceCard's effectiveId).
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

  // Re-probing takes the cameras from any live preview, so it happens only
  // when the user presses 다시 감지 — every other fetch is happy with the
  // box's last inventory. The flag rides a ref rather than the query key so
  // both answers stay one cache entry.
  const forceProbe = useRef(false)
  const devices = useQuery<JetsonDevice[]>({
    queryKey: ['devices', jetsonId],
    queryFn: () => {
      const probe = forceProbe.current
      forceProbe.current = false
      return window.labDesk.devices.list(jetsonId, host as string, serverPort, probe)
    },
    enabled: !!host,
    retry: false
  })
  const rig = useQuery<Rig | null>({
    queryKey: ['rig', jetsonId],
    queryFn: () => window.labDesk.rig.get(jetsonId, host as string, serverPort),
    enabled: !!host,
    retry: false
  })

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')
  const [voltWarn, setVoltWarn] = useState(false)
  const voltWarnedRef = useRef(false)

  // The draft starts from the saved rig once, then belongs to the user.
  useEffect(() => {
    if (draft !== null || !rig.isSuccess) return
    const saved = rig.data
    setDraft(
      saved
        ? {
            name: saved.name,
            cameras: saved.cameras.map((c) => ({ ...c, wiring: { ...c.wiring } })),
            trigger: {
              source: saved.trigger?.source ?? null,
              strobeReturn: saved.trigger?.strobeReturn ?? null,
              levelShift: saved.trigger?.levelShift ?? null,
              verifiedAt: saved.trigger?.verifiedAt ?? null
            }
          }
        : {
            name: '',
            cameras: [],
            trigger: {
              source: { gpioBoardPin: 7, name: 'GPIO09' },
              strobeReturn: { gpioBoardPin: 11, name: 'GPIO17' },
              levelShift: null,
              verifiedAt: null
            }
          }
    )
  }, [draft, rig.isSuccess, rig.data])

  const match = useMemo(
    () => matchRig(rig.data ?? null, devices.data ?? []),
    [rig.data, devices.data]
  )
  const issueByCam = useMemo(
    () => new Map(match.issues.map((issue) => [issue.camId, issue.kind])),
    [match]
  )
  const slots = useMemo(
    () => portSlots(draft?.cameras ?? [], devices.data ?? []),
    [draft, devices.data]
  )
  const candidates = useMemo(
    () => (draft ? bindCandidates(draft.cameras, devices.data ?? []) : []),
    [draft, devices.data]
  )

  const bindCamera = (index: number, camId: string): void => {
    const device = devices.data?.find((d) => d.camId === camId)
    setDraft((d) => {
      if (!d) return d
      const cameras = d.cameras.map((cam, i) => {
        if (i !== index) return cam
        const expect = device ? snapshotExpect(device) : cam.expect
        let wiring = cam.wiring
        // A plan can declare TRG; a bound webcam-std cannot keep it (spec 6.4).
        if (wiring.TRG && !trgAllowed(expect?.controlProfile, d.trigger.source).allowed) {
          wiring = toggleSignal(cam.connector, wiring, 'TRG', false)
        }
        return { ...cam, camId, mark: markOf(camId), expect, wiring }
      })
      return { ...d, cameras }
    })
  }

  // Spec 6.3: exactly one unbound camera and exactly one free port — bind by
  // itself. Anything more ambiguous is the user's call (spec 1.1 leaves the
  // app no basis to decide).
  useEffect(() => {
    if (!draft || !devices.data) return
    const unbound = draft.cameras.map((cam, i) => ({ cam, i })).filter(({ cam }) => !cam.camId)
    if (unbound.length !== 1 || candidates.length !== 1) return
    bindCamera(unbound[0].i, candidates[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, devices.data, candidates])

  const warnVoltageOnce = (key: string, value: boolean): void => {
    if (!value || key === 'GND' || voltWarnedRef.current) return
    voltWarnedRef.current = true
    setVoltWarn(true)
  }

  const setSignal = (index: number, key: string, value: boolean): void => {
    warnVoltageOnce(key, value)
    setDraft((d) =>
      d
        ? {
            ...d,
            cameras: d.cameras.map((cam, i) =>
              i === index ? { ...cam, wiring: toggleSignal(cam.connector, cam.wiring, key, value) } : cam
            )
          }
        : d
    )
  }

  const setLabel = (index: number, label: string): void => {
    setDraft((d) =>
      d ? { ...d, cameras: d.cameras.map((cam, i) => (i === index ? { ...cam, label } : cam)) } : d
    )
  }

  const removeCamera = (index: number): void => {
    setDraft((d) => (d ? { ...d, cameras: d.cameras.filter((_, i) => i !== index) } : d))
  }

  const addDetected = (device: JetsonDevice): void => {
    const camId = device.camId
    if (!camId) return
    setDraft((d) =>
      d
        ? {
            ...d,
            cameras: [
              ...d.cameras,
              {
                camId,
                label: '',
                mark: markOf(camId),
                expect: snapshotExpect(device),
                connector: DEFAULT_CONNECTOR,
                wiring: emptyWiring(DEFAULT_CONNECTOR)
              }
            ]
          }
        : d
    )
  }

  const importDetected = (): void => {
    for (const device of devices.data ?? []) {
      if (device.camId && !draft?.cameras.some((c) => c.camId === device.camId)) {
        addDetected(device)
      }
    }
  }

  const addUnbound = (): void => {
    setDraft((d) =>
      d
        ? {
            ...d,
            cameras: [
              ...d.cameras,
              {
                camId: null,
                label: '',
                connector: DEFAULT_CONNECTOR,
                wiring: emptyWiring(DEFAULT_CONNECTOR)
              }
            ]
          }
        : d
    )
  }

  const setPin = (which: 'source' | 'strobeReturn', raw: string): void => {
    const n = raw.trim() === '' ? null : Number(raw)
    setDraft((d) => {
      if (!d) return d
      const pin: RigGpioPin | null =
        n !== null && Number.isInteger(n) && n > 0
          ? { gpioBoardPin: n, ...(PIN_NAMES[n] && { name: PIN_NAMES[n] }) }
          : null
      let cameras = d.cameras
      if (which === 'source' && !pin) {
        // No pulse source, no TRG declarations (spec 3.2).
        cameras = cameras.map((cam) =>
          cam.wiring.TRG ? { ...cam, wiring: toggleSignal(cam.connector, cam.wiring, 'TRG', false) } : cam
        )
      }
      return { ...d, cameras, trigger: { ...d.trigger, [which]: pin } }
    })
  }

  const acceptHubMove = (): void => {
    if (!match.hubMove || !draft) return
    const { fromPrefix, toPrefix } = match.hubMove
    setDraft({ ...draft, cameras: applyHubMove(draft.cameras, fromPrefix, toPrefix) })
  }

  const refresh = (): void => {
    forceProbe.current = true
    void queryClient.invalidateQueries({ queryKey: ['devices', jetsonId] })
    void queryClient.invalidateQueries({ queryKey: ['rig', jetsonId] })
  }

  const save = (): void => {
    if (!draft || !host) return
    const built: Rig = {
      rigVersion: 1,
      name: draft.name.trim() || jetsonId,
      createdAt: rig.data?.createdAt ?? new Date().toISOString(),
      host: {
        hostname: jetsonId,
        usbRoot: usbRootOf(devices.data ?? []) ?? rig.data?.host?.usbRoot ?? null
      },
      cameras: draft.cameras,
      trigger: draft.trigger
    }
    setSaveState('saving')
    setSaveError('')
    window.labDesk.rig
      .save(jetsonId, host, serverPort, built)
      .then((saved) => {
        queryClient.setQueryData(['rig', jetsonId], saved)
        setSaveState('saved')
      })
      .catch((err: Error) => {
        setSaveState('error')
        setSaveError(err.message)
      })
  }

  if (!host) {
    return (
      <main className="rig-screen">
        <p>이 장비가 목록에 없습니다. 탐색 화면으로 돌아가 다시 선택하세요.</p>
        <Link to="/">← 장비 목록</Link>
      </main>
    )
  }

  const connectError = devices.isError || rig.isError
  // 409 is the box saying the cameras are held, which is a different thing to
  // fix than an unreachable server — telling the user to start the server
  // would send them the wrong way.
  const busyError = [devices.error, rig.error].some((err) =>
    err ? /answered 409/.test((err as Error).message) : false
  )
  const loading = devices.isPending || rig.isPending
  const triggerSource = draft?.trigger.source ?? null
  const detectedNew = (devices.data ?? []).filter(
    (d) => d.camId && !draft?.cameras.some((c) => c.camId === d.camId)
  )
  const unboundCams = draft
    ? draft.cameras.map((cam, i) => ({ cam, i })).filter(({ cam }) => !cam.camId)
    : []

  return (
    <main className="rig-screen">
      <header className="rig-header">
        <Link to="/">← 장비 목록</Link>
        <h1>rig 구성 — {jetsonId}</h1>
        <button type="button" onClick={refresh} disabled={loading}>
          다시 감지
        </button>
      </header>

      {connectError && (
        <p className="provision-line failed">
          {busyError
            ? '카메라를 다른 쪽이 잡고 있습니다 — 실행 중인 측정이나 다른 프로그램이 놓을 때까지 기다리세요.'
            : 'Jetson 서버에 연결하지 못했습니다 — 장비 카드에서 서버를 먼저 시작하세요.'}
          {devices.error ? ` (${(devices.error as Error).message})` : ''}
          {rig.error ? ` (${(rig.error as Error).message})` : ''}
        </p>
      )}

      {!connectError && !loading && (
        <section className={`rig-status ${match.status}`}>
          <strong>{STATUS_LABEL[match.status]}</strong>
          {match.status === 'ok' && (
            <Link className="button-link" to="/lab/$jetsonId" params={{ jetsonId }}>
              랩 화면으로
            </Link>
          )}
          {match.hubMove && (
            <button type="button" onClick={acceptHubMove}>
              매핑을 통째로 옮기기 ({match.hubMove.fromPrefix}.x → {match.hubMove.toPrefix}.x)
            </button>
          )}
          {match.issues.length > 0 && (
            <ul>
              {match.issues.map((issue, i) => (
                <li key={`${issue.kind}:${issue.camId}:${i}`}>{issueMessage(issue)}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {voltWarn && (
        <section className="volt-warning">
          <strong>1.8V 신호 도메인 주의</strong> — TRG·STRB에 3.3V를 직접 넣으면 카메라 핀이
          파손됩니다. 레벨 시프터(예: BSS138)를 거쳐 배선하세요. 앱은 변환 여부를 확인할 수
          없습니다.
          <button type="button" onClick={() => setVoltWarn(false)}>
            닫기
          </button>
        </section>
      )}

      {draft && !connectError && (
        <>
          <section className="rig-diagram">
            <div className="jetson-node">
              <strong>{jetsonId}</strong>
              <label>
                트리거 출력 BOARD
                <input
                  className="pin-input"
                  type="number"
                  min={1}
                  value={draft.trigger.source?.gpioBoardPin ?? ''}
                  onChange={(e) => setPin('source', e.target.value)}
                />
                {draft.trigger.source?.name && <span className="dim-note">{draft.trigger.source.name}</span>}
              </label>
              <label>
                STROBE 입력 BOARD
                <input
                  className="pin-input"
                  type="number"
                  min={1}
                  value={draft.trigger.strobeReturn?.gpioBoardPin ?? ''}
                  onChange={(e) => setPin('strobeReturn', e.target.value)}
                />
                {draft.trigger.strobeReturn?.name && (
                  <span className="dim-note">{draft.trigger.strobeReturn.name}</span>
                )}
              </label>
              {!triggerSource && (
                <span className="dim-note">트리거 출력 핀이 없으면 TRG를 선언할 수 없습니다</span>
              )}
            </div>
            <div className="trunk-label">│ USB — hub</div>

            <ul className="port-list">
              {slots.map((slot) => {
                if (slot.kind === 'empty') {
                  return (
                    <li key={slot.camId} className="port-row empty">
                      ├── P{slot.port} ○ (비어 있음)
                    </li>
                  )
                }
                if (slot.kind === 'detected') {
                  const d = slot.device as JetsonDevice
                  return (
                    <li key={slot.camId} className="port-row detected">
                      ├── P{slot.port} ● {d.usb?.product ?? d.os_name ?? '카메라'} · 등록 안 됨
                      <button type="button" onClick={() => addDetected(d)}>
                        rig에 추가
                      </button>
                    </li>
                  )
                }
                const cam = draft.cameras[slot.draftIndex as number]
                const device = slot.device
                const profile = device?.controlProfile ?? cam.expect?.controlProfile
                const gate = trgAllowed(profile, triggerSource)
                const declared = (CONNECTOR_PROFILES[cam.connector]?.signals ?? [])
                  .filter((s) => !s.auto && cam.wiring[s.key])
                  .map((s) => s.key)
                const issueKind = issueByCam.get(slot.camId)
                return (
                  <li
                    key={slot.camId}
                    className={`port-row camera${device ? '' : ' absent'}${issueKind ? ` issue-${issueKind}` : ''}`}
                  >
                    <div className="port-main">
                      ├── {cam.mark ?? markOf(slot.camId)} {device ? '●' : '◌'}
                      <input
                        className="label-input"
                        placeholder="라벨 (예: 좌)"
                        value={cam.label}
                        onChange={(e) => setLabel(slot.draftIndex as number, e.target.value)}
                      />
                      <span className="dim-note">
                        {(device?.usb?.manufacturer ?? cam.expect?.manufacturer) || ''}
                        {device ? ` video${device.index}` : ' (미검출)'}
                      </span>
                      {profile && <span className="badge">{profile}</span>}
                      <span className="signal-checks">
                        {(CONNECTOR_PROFILES[cam.connector]?.signals ?? []).map((sig) => {
                          const disabled = sig.auto || (sig.key === 'TRG' && !gate.allowed)
                          return (
                            <label key={sig.key} className={disabled ? 'dim' : ''}>
                              <input
                                type="checkbox"
                                checked={!!cam.wiring[sig.key]}
                                disabled={disabled}
                                onChange={(e) =>
                                  setSignal(slot.draftIndex as number, sig.key, e.target.checked)
                                }
                              />
                              {sig.key}
                            </label>
                          )
                        })}
                      </span>
                      <button type="button" onClick={() => removeCamera(slot.draftIndex as number)}>
                        제거
                      </button>
                    </div>
                    {!gate.allowed && gate.reason === '트리거 펌웨어 없음' && (
                      <div className="decl-line dim">│&nbsp;&nbsp;&nbsp;&nbsp;└ 트리거 펌웨어 없음 — TRG 배선 불가</div>
                    )}
                    {declared.length > 0 && (
                      <div className="decl-line">
                        ┆&nbsp;&nbsp;&nbsp;{declared.join(', ')}{' '}
                        {draft.trigger.verifiedAt
                          ? `(검증됨 ${draft.trigger.verifiedAt})`
                          : '(선언, 미검증)'}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {unboundCams.length > 0 && (
              <ul className="port-list">
                {unboundCams.map(({ cam, i }) => (
                  <li key={`unbound-${i}`} className="port-row camera unbound">
                    <div className="port-main">
                      ┄┄ P? ◌
                      <input
                        className="label-input"
                        placeholder="라벨 (예: 좌)"
                        value={cam.label}
                        onChange={(e) => setLabel(i, e.target.value)}
                      />
                      <span className="dim-note">미바인딩 — 장치가 나타나면 포트를 정합니다</span>
                      <span className="signal-checks">
                        {(CONNECTOR_PROFILES[cam.connector]?.signals ?? []).map((sig) => {
                          const gate = trgAllowed(cam.expect?.controlProfile, triggerSource)
                          const disabled = sig.auto || (sig.key === 'TRG' && !gate.allowed)
                          return (
                            <label key={sig.key} className={disabled ? 'dim' : ''}>
                              <input
                                type="checkbox"
                                checked={!!cam.wiring[sig.key]}
                                disabled={disabled}
                                onChange={(e) => setSignal(i, sig.key, e.target.checked)}
                              />
                              {sig.key}
                            </label>
                          )
                        })}
                      </span>
                      {candidates.length > 0 && (
                        <select
                          value=""
                          onChange={(e) => e.target.value && bindCamera(i, e.target.value)}
                        >
                          <option value="">포트에 바인딩…</option>
                          {candidates.map((camId) => (
                            <option key={camId} value={camId}>
                              {markOf(camId)} ({camId})
                            </option>
                          ))}
                        </select>
                      )}
                      <button type="button" onClick={() => removeCamera(i)}>
                        제거
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="rig-add-actions">
              <button type="button" onClick={importDetected} disabled={detectedNew.length === 0}>
                탐지된 것 불러오기{detectedNew.length > 0 ? ` (${detectedNew.length})` : ''}
              </button>
              <button type="button" onClick={addUnbound}>
                카메라 추가 (미바인딩)
              </button>
            </div>
            <p className="dim-note">
              같은 표시(P1·P2·P4)끼리만 꽂으세요 — 같은 모델 두 대를 서로 바꿔 꽂은 것은 앱이
              영원히 감지할 수 없습니다. 마킹은 앱의 대체재가 아니라 앱이 못 하는 부분의
              담당입니다.
            </p>
          </section>

          <section className="rig-previews">
            <h2>프리뷰</h2>
            {tunnel && (devices.data ?? []).some((d) => d.opened) ? (
              <div className="preview-grid">
                {(devices.data ?? [])
                  .filter((d) => d.opened)
                  .map((d) => {
                    const cam = draft.cameras.find((c) => c.camId && c.camId === d.camId)
                    return (
                      <PreviewTile
                        key={d.index}
                        src={`${tunnel.url}/stream.mjpg?index=${d.index}&resolution=640x480&quality=60&t=${devices.dataUpdatedAt}`}
                        caption={`${d.camId ? `${markOf(d.camId)} · ` : ''}${
                          cam?.label || d.usb?.product || `video${d.index}`
                        }`}
                      />
                    )
                  })}
              </div>
            ) : (
              <p className="dim-note">
                프리뷰는 터널이 열려 있어야 나옵니다 — 장비 카드에서 시작을 누르세요. 손으로
                렌즈를 가려 어느 칸이 어느 카메라인지 확인하고 라벨을 붙이세요.
              </p>
            )}
          </section>

          <section className="rig-save">
            <input
              className="rig-name"
              placeholder="rig 이름 (예: 레일 3카메라)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <button type="button" onClick={save} disabled={saveState === 'saving'}>
              {saveState === 'saving' ? '저장 중…' : '이 구성을 기준으로 저장'}
            </button>
            {saveState === 'saved' && <span className="save-ok">저장됨 — 이 구성이 기준입니다</span>}
            {saveState === 'error' && <span className="save-fail">저장 실패 — {saveError}</span>}
          </section>
        </>
      )}
    </main>
  )
}
