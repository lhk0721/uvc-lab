import { markOf } from './rig'
import { presetDefaults } from './lab'

// Test profiles (spec section 8): the grip for "각 테스트마다 카메라 상태를
// 다르게". The part that matters is the `requires` gate — it is evaluated when
// a profile is *shown*, not when the run button is pressed, so an impossible
// combination is refused with a reason instead of producing numbers. Free of
// React and of window/electron so it runs under plain Node for verification.

/** Ids land in run records, so they stay short and machine-safe. */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export const DEFAULT_PROFILE_MODE: ProfileMode = {
  fourcc: 'MJPG',
  width: 1280,
  height: 720,
  fps: 30
}

export function formatMode(mode: ProfileMode | null): string {
  return mode ? `${mode.width}x${mode.height}` : ''
}

export function withResolution(mode: ProfileMode | null, text: string): ProfileMode {
  const m = /^(\d+)x(\d+)$/.exec(text.trim())
  const base = mode ?? DEFAULT_PROFILE_MODE
  return m ? { ...base, width: Number(m[1]), height: Number(m[2]) } : { ...base }
}

export function emptyProfileCamera(): ProfileCamera {
  return { enabled: false, mode: { ...DEFAULT_PROFILE_MODE }, trigger: 'free' }
}

export function nextProfileId(preset: string, existing: TestProfile[]): string {
  const taken = new Set(existing.map((p) => p.id))
  const base = PROFILE_ID_RE.test(preset) ? preset : 'profile'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * A new profile starts from what is plugged in right now: every detected
 * camera, enabled. Editing it down is easier than typing port paths, and the
 * port paths are the one thing nobody should have to retype.
 */
export function newProfile(preset: string, camIds: string[], existing: TestProfile[]): TestProfile {
  const cameras: Record<string, ProfileCamera> = {}
  for (const camId of camIds) cameras[camId] = { ...emptyProfileCamera(), enabled: true }
  return {
    id: nextProfileId(preset, existing),
    title: `${preset} 프로필`,
    preset,
    requires: {},
    cameras,
    params: {}
  }
}

export function profileIdError(id: string, others: TestProfile[]): string | null {
  if (!PROFILE_ID_RE.test(id)) return 'id는 영소문자·숫자·하이픈만 쓸 수 있습니다'
  if (others.some((p) => p.id === id)) return '같은 id가 이미 있습니다'
  return null
}

// ---- the requires gate ------------------------------------------------------

export type ProfileBlocker =
  | { kind: 'unknown-preset'; preset: string }
  | { kind: 'no-cameras' }
  | { kind: 'single-camera-preset'; count: number }
  | { kind: 'missing'; camId: string; mark: string; label: string }
  | { kind: 'busy'; camId: string; mark: string; label: string }
  | {
      kind: 'control-profile'
      camId: string
      mark: string
      label: string
      expected: string
      actual: string
    }
  | { kind: 'trigger-unsupported'; camId: string; mark: string; label: string; actual: string }
  | { kind: 'trigger-unwired'; camId: string; mark: string; label: string }
  | { kind: 'no-rig' }
  | { kind: 'no-trigger-source' }
  | { kind: 'trigger-unimplemented' }
  | { kind: 'mixed-mode'; fields: string[] }

export interface ProfilePlan {
  /** Non-empty = the run button is disabled and these are the reasons. */
  blockers: ProfileBlocker[]
  /** What the run would not honour, said out loud rather than dropped. */
  warnings: string[]
  /** OpenCV indices of the enabled cameras, in camId order. */
  indices: number[]
  /** What the run would be started with. */
  params: Record<string, unknown>
}

const FIELD_LABEL: Record<string, string> = {
  resolution: '해상도',
  fourcc: '포맷',
  fps: 'fps'
}

/**
 * Everything the screen needs to show a profile: whether it can run at all,
 * what would be dropped if it did, and the preset parameters it becomes.
 * Nothing here mutates; the screen calls it on every render, which is what
 * makes the check happen at display time (spec 8).
 */
export function planProfile(
  profile: TestProfile,
  preset: Preset | undefined,
  devices: JetsonDevice[],
  rig: Rig | null
): ProfilePlan {
  const blockers: ProfileBlocker[] = []
  const warnings: string[] = []
  if (!preset) {
    return {
      blockers: [{ kind: 'unknown-preset', preset: profile.preset }],
      warnings,
      indices: [],
      params: {}
    }
  }

  const byCam = new Map(devices.filter((d) => d.camId).map((d) => [d.camId as string, d] as const))
  const enabled = Object.entries(profile.cameras)
    .filter(([, cam]) => cam.enabled)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const nameOf = (camId: string): { mark: string; label: string } => ({
    mark: markOf(camId),
    label: rig?.cameras.find((c) => c.camId === camId)?.label ?? ''
  })

  const indices: number[] = []
  let triggerTargets = 0
  let missingRig = false
  for (const [camId, cam] of enabled) {
    const where = nameOf(camId)
    const device = byCam.get(camId)
    if (!device) {
      blockers.push({ kind: 'missing', camId, ...where })
      continue
    }
    if (!device.opened) {
      blockers.push({ kind: 'busy', camId, ...where })
      continue
    }
    indices.push(device.index)

    const want = profile.requires?.controlProfile
    if (want && device.controlProfile && device.controlProfile !== want) {
      blockers.push({
        kind: 'control-profile',
        camId,
        ...where,
        expected: want,
        actual: device.controlProfile
      })
    }
    if (cam.trigger === 'hardware') {
      triggerTargets++
      // The spec's own example is refused right here: port 4 carries
      // `webcam-std`, which has no trigger firmware at all (spec 1.5).
      if (device.controlProfile && device.controlProfile !== 'trigger-v1') {
        blockers.push({ kind: 'trigger-unsupported', camId, ...where, actual: device.controlProfile })
        continue
      }
      if (!rig) {
        missingRig = true
        continue
      }
      // Wiring is a declaration (spec 3.2); an undeclared line means the
      // pulse has nowhere to arrive, whatever the firmware supports.
      if (rig.cameras.find((c) => c.camId === camId)?.wiring?.TRG !== true) {
        blockers.push({ kind: 'trigger-unwired', camId, ...where })
      }
    }
  }
  if (missingRig) blockers.push({ kind: 'no-rig' })

  const needsSource = triggerTargets > 0 || profile.requires?.trigger === 'fsin-hardware'
  if (needsSource && rig && !rig.trigger?.source) blockers.push({ kind: 'no-trigger-source' })
  if (profile.requires?.trigger === 'fsin-hardware' && triggerTargets === 0) {
    // Runnable, but the numbers would come from free-running cameras under a
    // name that says otherwise — which is exactly what spec 8 exists to stop.
    warnings.push(
      'requires에 fsin-hardware를 적어놓고 트리거 대상 카메라가 없습니다 — 자유 구동 결과가 나옵니다'
    )
  }
  if (triggerTargets > 0) {
    // Honest refusal: nothing in this app can drive the FSIN line yet, so a
    // hardware-trigger profile would quietly measure a free-running camera
    // and call it a trigger result (spec 7.4 is the step that opens this).
    blockers.push({ kind: 'trigger-unimplemented' })
  }

  // ---- preset parameters ----------------------------------------------------
  const keys = new Set(preset.params.map((p) => p.key))
  const params: Record<string, unknown> = { ...presetDefaults(preset), ...(profile.params ?? {}) }

  if (keys.has('indices')) {
    if (enabled.length === 0) blockers.push({ kind: 'no-cameras' })
    params.indices = indices
  } else if (keys.has('index')) {
    if (enabled.length === 0) blockers.push({ kind: 'no-cameras' })
    else if (enabled.length > 1) {
      blockers.push({ kind: 'single-camera-preset', count: enabled.length })
    } else if (indices.length === 1) params.index = indices[0]
  } else if (enabled.length > 0) {
    warnings.push('이 프리셋은 카메라를 인자로 받지 않습니다 — 선택한 카메라는 실행에 쓰이지 않습니다')
  }

  const modes = enabled.map(([, cam]) => cam.mode).filter((m): m is ProfileMode => !!m)
  const distinct = (values: (string | number | null)[]): (string | number | null)[] =>
    Array.from(new Set(values.map((v) => JSON.stringify(v)))).map((v) => JSON.parse(v))
  const fields: Record<string, (string | number | null)[]> = {
    resolution: distinct(modes.map((m) => `${m.width}x${m.height}`)),
    fourcc: distinct(modes.map((m) => m.fourcc)),
    fps: distinct(modes.map((m) => m.fps))
  }
  const mixed: string[] = []
  for (const [key, values] of Object.entries(fields)) {
    if (values.length === 0) continue
    if (!keys.has(key)) {
      // Said out loud rather than dropped: the preset simply has no such
      // knob (format-duel measures both formats, health has no fps).
      warnings.push(
        `이 프리셋에는 ${FIELD_LABEL[key]} 인자가 없어 프로필의 값(${values.join(', ')})은 적용되지 않습니다`
      )
      continue
    }
    if (values.length > 1) {
      mixed.push(FIELD_LABEL[key])
      continue
    }
    if (values[0] != null) params[key] = values[0]
  }
  if (mixed.length > 0) blockers.push({ kind: 'mixed-mode', fields: mixed })

  return { blockers, warnings, indices, params }
}

/** Reads the same way as the rig screen's issue lines (spec 5 / 8). */
export function blockerMessage(blocker: ProfileBlocker): string {
  const who = (b: { label: string; mark: string; camId: string }): string =>
    `${b.label || b.camId} 카메라(${b.mark})`
  switch (blocker.kind) {
    case 'unknown-preset':
      return `이 Jetson에 \`${blocker.preset}\` 프리셋이 없습니다`
    case 'no-cameras':
      return '실행할 카메라가 선택되지 않았습니다'
    case 'single-camera-preset':
      return `이 프리셋은 카메라 한 대만 실행합니다 — ${blocker.count}대가 선택됐습니다`
    case 'missing':
      return `${who(blocker)}가 안 보입니다`
    case 'busy':
      return `${who(blocker)}를 다른 프로세스가 쓰고 있습니다`
    case 'control-profile':
      return `${who(blocker)}의 컨트롤 프로파일이 \`${blocker.actual}\`입니다 — 이 프로필은 \`${blocker.expected}\`를 요구합니다`
    case 'trigger-unsupported':
      return `${who(blocker)}는 트리거 모드를 지원하지 않습니다 (컨트롤 프로파일 \`${blocker.actual}\`). 트리거 대상에서 빼거나 \`trigger-v1\` 카메라로 교체하세요`
    case 'trigger-unwired':
      return `${who(blocker)}의 TRG 배선이 rig에 선언되어 있지 않습니다 — 구성 화면에서 체크하세요`
    case 'no-rig':
      return 'rig이 없어 트리거 배선을 확인할 수 없습니다 — 구성을 먼저 등록하세요'
    case 'no-trigger-source':
      return 'rig에 트리거 출력 핀이 없습니다 — 펄스를 낼 곳이 없습니다'
    case 'trigger-unimplemented':
      return '트리거 모드로 실행하는 경로가 아직 없습니다 — GPIO 펄스 생성(명세 7.4)이 들어와야 열립니다'
    case 'mixed-mode':
      return `카메라마다 ${blocker.fields.join('·')}이(가) 달라 이 프리셋으로는 실행할 수 없습니다 — 하나로 맞추세요`
  }
}
