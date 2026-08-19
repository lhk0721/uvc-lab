import type { RigStatus } from './rig'

// Lab screen logic (spec section 7): preview URLs, the requested-vs-observed
// mode comparison, control clamping against device-reported ranges, preset
// parameter handling, and run-log bookkeeping. Free of React and of
// window/electron so it runs under plain Node for verification.

export interface PreviewMode {
  resolution: string
  fourcc: string
  /** null = do not ask for a rate; the driver picks (spec 7.2). */
  fps: number | null
  quality: number
}

export const DEFAULT_PREVIEW: PreviewMode = {
  resolution: '1280x720',
  fourcc: 'MJPG',
  fps: null,
  quality: 60
}

export function parseResolution(text: string): { width: number; height: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(text.trim())
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/**
 * MJPEG source for one camera. The nonce is what makes a mode change take:
 * the browser would otherwise keep the open multipart response and never ask
 * for the new query string.
 */
export function streamUrl(
  base: string,
  index: number,
  mode: PreviewMode,
  nonce: number | string
): string {
  const params = new URLSearchParams({
    index: String(index),
    resolution: mode.resolution,
    fourcc: mode.fourcc,
    quality: String(mode.quality),
    t: String(nonce)
  })
  if (mode.fps != null) params.set('fps', String(mode.fps))
  return `${base.replace(/\/$/, '')}/stream.mjpg?${params.toString()}`
}

export interface ModeDelta {
  field: string
  requested: string
  observed: string
}

/**
 * Where the driver silently gave something other than what was asked for.
 * Spec 7.2: the screen shows the observed mode, and this is what turns the
 * difference into a visible line instead of a quiet substitution.
 */
export function modeDeltas(stats: StreamStats | undefined): ModeDelta[] {
  const want = stats?.requested
  const got = stats?.observed
  if (!want || !got) return []
  const deltas: ModeDelta[] = []
  if (want.width !== got.width || want.height !== got.height) {
    deltas.push({
      field: '해상도',
      requested: `${want.width}x${want.height}`,
      observed: `${got.width}x${got.height}`
    })
  }
  if (want.fourcc !== got.fourcc) {
    deltas.push({ field: '포맷', requested: want.fourcc, observed: got.fourcc })
  }
  // A requested rate is compared against the driver's own answer, not against
  // the measured rate — a busy link legitimately runs below the negotiated fps.
  if (want.fps != null && got.driverFps != null && Math.abs(want.fps - got.driverFps) >= 0.5) {
    deltas.push({ field: 'fps', requested: String(want.fps), observed: String(got.driverFps) })
  }
  return deltas
}

export function describeMode(mode: StreamMode | undefined): string {
  if (!mode) return '-'
  const rate = mode.driverFps != null ? ` ${mode.driverFps}fps` : mode.fps != null ? ` ${mode.fps}fps` : ''
  return `${mode.width}x${mode.height} ${mode.fourcc}${rate}`
}

/** Snap to the device's own step and clamp to its own range (spec 7.3). */
export function clampControl(control: JetsonControl, value: number): number {
  const step = control.step > 0 ? control.step : 1
  const snapped = control.min + Math.round((value - control.min) / step) * step
  return Math.min(control.max, Math.max(control.min, snapped))
}

// Display names only; nothing here decides what a control can do.
export const CONTROL_LABELS: Record<string, string> = {
  exposure_auto: '노출 모드',
  exposure_absolute: '노출 시간',
  exposure_auto_priority: '자동 노출 fps 양보',
  gain: '게인',
  brightness: '밝기',
  contrast: '대비',
  saturation: '채도',
  gamma: '감마',
  sharpness: '샤프니스',
  backlight_compensation: '백라이트 보정 (trigger-v1: 트리거 모드)',
  hue: '색조 (trigger-v1: 트리거 주파수)',
  auto_white_balance: '자동 화이트밸런스',
  white_balance_temperature: '색온도',
  power_line_frequency: '전원 주파수'
}

export function controlLabel(control: JetsonControl): string {
  return CONTROL_LABELS[control.key] ?? control.name ?? control.key
}

// ---- preset parameters ------------------------------------------------------

export function presetDefaults(preset: Preset): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const spec of preset.params) params[spec.key] = spec.default
  return params
}

export function parseNumberList(text: string): number[] {
  // Empty pieces are dropped BEFORE Number(): Number('') is 0, so an empty
  // camera list would otherwise mean "camera 0" rather than "none".
  return text
    .split(/[,\s]+/)
    .filter((part) => part !== '')
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n))
}

/** One form field's raw value turned into what the preset runner expects. */
export function coerceParam(spec: PresetParam, raw: string | boolean | string[]): unknown {
  switch (spec.type) {
    case 'int':
      return Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : spec.default
    case 'float':
      return Number.isFinite(Number(raw)) ? Number(raw) : spec.default
    case 'bool':
      return !!raw
    case 'multiselect':
      return Array.isArray(raw) ? raw : []
    case 'numbers':
    case 'indices':
      return parseNumberList(String(raw))
    default:
      return String(raw)
  }
}

export function formatParam(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value)
}

// ---- runs -------------------------------------------------------------------

export function runFinished(run: RunState | undefined): boolean {
  return run?.status === 'done' || run?.status === 'error'
}

/** Lines of a run's log not yet handed to the log panel (spec 7.6). */
export function newLogLines(log: string[] | undefined, seen: number): string[] {
  if (!log || log.length <= seen) return []
  return log.slice(seen)
}

// ---- the section 5 gate ------------------------------------------------------

/**
 * Spec 5: anything but `ok` blocks the lab screen, and the way past it is an
 * explicit "무시하고 진행" — never a silent pass. The status travels with the
 * run afterwards so no number is left without the configuration it came from.
 */
export function labBlocked(status: RigStatus, override: boolean): boolean {
  return status !== 'ok' && !override
}

/** What a run must record: null while the rig matched, the status otherwise. */
export function runRigStatus(status: RigStatus): string | null {
  return status === 'ok' ? null : status
}
