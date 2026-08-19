import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { coerceParam, formatParam } from './lab'
import { markOf } from './rig'
import {
  blockerMessage,
  emptyProfileCamera,
  formatMode,
  newProfile,
  planProfile,
  profileIdError,
  withResolution
} from './profiles'

// Test profiles (spec section 8). The editor is deliberately thin — a profile
// is the detected cameras with a state each, not a form to fill in — and the
// `requires` gate below it re-runs on every render, so an impossible
// combination is refused while it is being looked at, not when it is run.

// The camera block is the authority for these; showing them again as free
// parameters would let the two disagree.
const DERIVED_PARAMS = new Set(['index', 'indices', 'resolution', 'fourcc', 'fps'])

interface ProfilePanelProps {
  jetsonId: string
  host: string
  serverPort: number
  devices: JetsonDevice[]
  rig: Rig | null
  presets: Preset[]
  modeOptions: ModeOptions | undefined
  running: boolean
  onRun: (request: {
    preset: string
    params: Record<string, unknown>
    profileId: string
  }) => void
}

interface Editing {
  /** null = never saved yet, so saving appends instead of replacing. */
  originalId: string | null
  draft: TestProfile
}

export function ProfilePanel(props: ProfilePanelProps): React.JSX.Element {
  const { jetsonId, host, serverPort, devices, rig, presets, modeOptions, running, onRun } = props
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)

  const profiles = useQuery<TestProfile[]>({
    queryKey: ['profiles', jetsonId],
    queryFn: () => window.labDesk.lab.profiles(jetsonId, host, serverPort),
    retry: false
  })
  const saved = profiles.data ?? []

  const detected = useMemo(
    () =>
      devices
        .map((d) => d.camId)
        .filter((id): id is string => !!id)
        .sort(),
    [devices]
  )

  // Show something as soon as there is something to show; after that the
  // selection belongs to the user.
  useEffect(() => {
    if (editing || saved.length === 0) return
    setEditing({ originalId: saved[0].id, draft: structuredClone(saved[0]) })
  }, [editing, saved])

  const draft = editing?.draft
  const preset = presets.find((p) => p.id === draft?.preset)
  const plan = useMemo(
    () => (draft ? planProfile(draft, preset, devices, rig) : null),
    [draft, preset, devices, rig]
  )
  const others = saved.filter((p) => p.id !== editing?.originalId)
  const idError = draft ? profileIdError(draft.id, others) : null
  const storedVersion = saved.find((p) => p.id === editing?.originalId)
  const dirty = !storedVersion || JSON.stringify(storedVersion) !== JSON.stringify(draft)

  const patch = (change: Partial<TestProfile>): void => {
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...change } } : current))
  }
  const patchCamera = (camId: string, change: Partial<ProfileCamera>): void => {
    setEditing((current) => {
      if (!current) return current
      const cameras = { ...current.draft.cameras }
      cameras[camId] = { ...(cameras[camId] ?? emptyProfileCamera()), ...change }
      return { ...current, draft: { ...current.draft, cameras } }
    })
  }

  const write = (list: TestProfile[], keep: Editing | null): void => {
    setSaving(true)
    setSaveError('')
    window.labDesk.lab
      .saveProfiles(jetsonId, host, serverPort, list)
      .then((answer) => {
        queryClient.setQueryData(['profiles', jetsonId], answer)
        setEditing(keep)
      })
      .catch((err: Error) => setSaveError(err.message))
      .finally(() => setSaving(false))
  }

  const save = (): void => {
    if (!editing || !draft || idError) return
    const list = editing.originalId
      ? saved.map((p) => (p.id === editing.originalId ? draft : p))
      : [...saved, draft]
    write(list, { originalId: draft.id, draft })
  }

  const remove = (): void => {
    if (!editing?.originalId) return
    write(
      saved.filter((p) => p.id !== editing.originalId),
      null
    )
  }

  const create = (): void => {
    if (presets.length === 0) return
    setEditing({ originalId: null, draft: newProfile(presets[0].id, detected, saved) })
  }

  const camRows = draft
    ? Array.from(new Set([...Object.keys(draft.cameras), ...detected])).sort()
    : []

  return (
    <section className="lab-profiles">
      <h2>테스트 프로필</h2>
      <div className="profile-head">
        <select
          value={editing?.originalId ?? ''}
          onChange={(e) => {
            const found = saved.find((p) => p.id === e.target.value)
            if (found) setEditing({ originalId: found.id, draft: structuredClone(found) })
          }}
        >
          <option value="">{editing && !editing.originalId ? '(새 프로필)' : '프로필 선택'}</option>
          {saved.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || p.id}
            </option>
          ))}
        </select>
        <button type="button" onClick={create} disabled={presets.length === 0}>
          새 프로필
        </button>
        {editing?.originalId && (
          <button type="button" onClick={remove} disabled={saving}>
            삭제
          </button>
        )}
        <span className="dim-note">프로필은 Jetson에 저장됩니다 — 포트 경로는 이 장비의 사실입니다.</span>
      </div>

      {profiles.isError && (
        <p className="provision-line failed">
          프로필을 읽지 못했습니다 — {(profiles.error as Error).message}
        </p>
      )}
      {saveError && <p className="provision-line failed">{saveError}</p>}
      {!draft && !profiles.isPending && (
        <p className="dim-note">저장된 프로필이 없습니다 — 새 프로필을 만드세요.</p>
      )}

      {draft && plan && (
        <div className="profile-editor">
          <div className="profile-meta">
            <label>
              id
              <input value={draft.id} onChange={(e) => patch({ id: e.target.value.trim() })} />
            </label>
            <label>
              이름
              <input value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
            </label>
            <label>
              프리셋
              <select value={draft.preset} onChange={(e) => patch({ preset: e.target.value, params: {} })}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              요구 프로파일
              <select
                value={draft.requires?.controlProfile ?? ''}
                onChange={(e) =>
                  patch({
                    requires: {
                      ...draft.requires,
                      controlProfile: (e.target.value || null) as ControlProfile | null
                    }
                  })
                }
              >
                <option value="">없음</option>
                <option value="trigger-v1">trigger-v1</option>
                <option value="webcam-std">webcam-std</option>
              </select>
            </label>
            <label>
              요구 트리거
              <select
                value={draft.requires?.trigger ?? ''}
                onChange={(e) =>
                  patch({
                    requires: {
                      ...draft.requires,
                      trigger: (e.target.value || null) as 'fsin-hardware' | null
                    }
                  })
                }
              >
                <option value="">없음</option>
                <option value="fsin-hardware">fsin-hardware</option>
              </select>
            </label>
          </div>
          {idError && <p className="provision-line failed">{idError}</p>}

          <ul className="profile-cameras">
            {camRows.map((camId) => {
              const cam = draft.cameras[camId] ?? emptyProfileCamera()
              const device = devices.find((d) => d.camId === camId)
              const label = rig?.cameras.find((c) => c.camId === camId)?.label ?? ''
              // "사용 중" and "응답 없음" send the user to different places:
              // one waits for the other consumer, the other is a cable.
              const state = !device
                ? '안 보임'
                : device.opened
                  ? ''
                  : device.probeError === 'timeout'
                    ? '응답 없음'
                    : '사용 중'
              return (
                <li key={camId} className="profile-camera">
                  <label className="profile-camera-name">
                    <input
                      type="checkbox"
                      checked={cam.enabled}
                      onChange={(e) => patchCamera(camId, { enabled: e.target.checked })}
                    />
                    <strong>
                      {markOf(camId)}
                      {label ? ` · ${label}` : ''}
                    </strong>
                    <span className="dim-note">{camId}</span>
                  </label>
                  {device?.controlProfile && <span className="badge">{device.controlProfile}</span>}
                  {state && <span className="badge warn">{state}</span>}
                  <select
                    value={formatMode(cam.mode)}
                    disabled={!cam.enabled}
                    onChange={(e) => patchCamera(camId, { mode: withResolution(cam.mode, e.target.value) })}
                  >
                    {(modeOptions?.resolutions ?? [formatMode(cam.mode)]).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <select
                    value={cam.mode?.fourcc ?? 'MJPG'}
                    disabled={!cam.enabled}
                    onChange={(e) =>
                      patchCamera(camId, {
                        mode: { ...withResolution(cam.mode, formatMode(cam.mode)), fourcc: e.target.value }
                      })
                    }
                  >
                    {(modeOptions?.fourccs ?? ['MJPG', 'YUY2']).map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <input
                    className="fps-input"
                    type="number"
                    min={1}
                    placeholder="자동"
                    disabled={!cam.enabled}
                    value={cam.mode?.fps ?? ''}
                    onChange={(e) =>
                      patchCamera(camId, {
                        mode: {
                          ...withResolution(cam.mode, formatMode(cam.mode)),
                          fps: e.target.value === '' ? null : Number(e.target.value)
                        }
                      })
                    }
                  />
                  <select
                    className="trigger-select"
                    value={cam.trigger}
                    disabled={!cam.enabled}
                    onChange={(e) =>
                      patchCamera(camId, { trigger: e.target.value as 'free' | 'hardware' })
                    }
                  >
                    <option value="free">자유 구동</option>
                    <option value="hardware">하드웨어 트리거</option>
                  </select>
                </li>
              )
            })}
          </ul>

          <div className="bench-params">
            {(preset?.params ?? [])
              .filter((spec) => !DERIVED_PARAMS.has(spec.key))
              .map((spec) => {
                const value = draft.params?.[spec.key] ?? spec.default
                const setParam = (raw: string | boolean | string[]): void =>
                  patch({ params: { ...draft.params, [spec.key]: coerceParam(spec, raw) } })
                return (
                  <label key={spec.key}>
                    {spec.label}
                    {spec.type === 'bool' ? (
                      <input
                        type="checkbox"
                        checked={!!value}
                        onChange={(e) => setParam(e.target.checked)}
                      />
                    ) : spec.type === 'select' ? (
                      <select value={String(value ?? '')} onChange={(e) => setParam(e.target.value)}>
                        {(spec.options ?? []).map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : spec.type === 'multiselect' ? (
                      <span className="multi">
                        {(spec.options ?? []).map((option) => {
                          const current = (value as string[]) ?? []
                          return (
                            <label key={option}>
                              <input
                                type="checkbox"
                                checked={current.includes(option)}
                                onChange={(e) =>
                                  setParam(
                                    e.target.checked
                                      ? [...current, option]
                                      : current.filter((v) => v !== option)
                                  )
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
                        value={formatParam(value)}
                        onChange={(e) => setParam(e.target.value)}
                      />
                    )}
                  </label>
                )
              })}
          </div>

          {plan.blockers.length > 0 ? (
            <div className="profile-gate blocked">
              <strong>실행할 수 없습니다</strong>
              <ul>
                {plan.blockers.map((blocker, i) => (
                  <li key={`${blocker.kind}:${i}`}>{blockerMessage(blocker)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="profile-gate ok">
              실행 가능 — 카메라 인덱스 {plan.indices.join(', ') || '없음'}
            </p>
          )}
          {plan.warnings.map((warning, i) => (
            <p key={i} className="dim-note">
              {warning}
            </p>
          ))}

          <div className="profile-actions">
            <button type="button" onClick={save} disabled={!!idError || saving || !dirty}>
              저장
            </button>
            <button
              type="button"
              onClick={() => onRun({ preset: draft.preset, params: plan.params, profileId: draft.id })}
              disabled={plan.blockers.length > 0 || running || dirty}
            >
              {running ? '실행 중…' : '이 프로필로 실행'}
            </button>
            {dirty && (
              <span className="dim-note">
                저장해야 실행할 수 있습니다 — 결과에 프로필 id가 기록되므로 저장된 내용과 달라지면
                안 됩니다.
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
