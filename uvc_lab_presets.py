"""Named test presets for the browser-based UVC camera lab.

Each preset is one question with a default configuration, so a check can be
run without remembering which script takes which flags. They reuse the
measurement functions from the CLI scripts rather than reimplementing them —
the same code path produces the same numbers whether it is driven from a
terminal or from the browser.

Every runner returns the same shape so the page can render any preset without
knowing what it does:

    {"headline": str,              # the one-line answer
     "status": "ok"|"warn"|"fail",
     "tables": [{"title", "columns", "rows"}],
     "notes": [str],
     "raw": {...}}                 # full detail, for the JSON pane
"""

from __future__ import annotations

from typing import Callable

import cv2

from bench_uvc_capture import (
    bench_decode,
    bench_read,
    interpret,
    probe_blocking_call,
    warmup,
)
from experiment_uvc_exposure import AUTO_OFF, AUTO_ON
from experiment_uvc_exposure import measure as measure_exposure
from experiment_uvc_modes import FPS_FLOOR, measure_mode
from experiment_uvc_sync import measure_concurrent, measure_solo
from uvc_devices import (
    FOURCC_CANDIDATES,
    MODE_CANDIDATES,
    describe_signal,
    find_index,
    frame_signal,
    list_devices,
    open_capture,
)

Log = Callable[[str], None]


def _auto_index(params: dict) -> int:
    """Resolve an explicit index, or find the highest-resolution camera."""
    index = params.get("index")
    if index is not None and index >= 0:
        return int(index)
    found = find_index((int(params.get("width", 1920)), int(params.get("height", 1200))))
    if found is None:
        devices = list_devices(max_index=5)
        if not devices:
            raise RuntimeError("no camera opened — check the cable and that no other app holds it")
        found = devices[-1].index
    return found


# --------------------------------------------------------------------------
# runners
# --------------------------------------------------------------------------

def run_identify(params: dict, log: Log) -> dict:
    log("enumerating cameras and probing each one's maximum resolution...")
    with_modes = bool(params.get("full_modes", False))
    devices = list_devices(max_index=int(params.get("max_index", 5)), with_modes=with_modes)
    if not devices:
        return {"headline": "no cameras opened", "status": "fail",
                "tables": [], "notes": ["Check the cable, and that no other app holds the device."],
                "raw": {}}

    rows = [[d.index, f"{d.width}x{d.height}", d.signature or "unknown",
             (d.os_name or "-") + (" [heuristic]" if d.os_name_is_heuristic else "")]
            for d in devices]
    tables = [{"title": "cameras", "columns": ["index", "max resolution", "signature", "OS name"],
               "rows": rows}]
    if with_modes:
        mode_rows = [[d.index, m["fourcc"], f"{m['width']}x{m['height']}", f"{m['driver_fps']:.0f}"]
                     for d in devices for m in d.modes]
        tables.append({"title": "supported modes",
                       "columns": ["index", "fourcc", "resolution", "driver fps"],
                       "rows": mode_rows})
    return {
        "headline": f"{len(devices)} camera(s) available",
        "status": "ok",
        "tables": tables,
        "notes": ["OS-reported names are attached by enumeration order and are often wrong. "
                  "The capability signature (max resolution / aspect) is the reliable identifier."],
        "raw": {"devices": [vars(d) for d in devices]},
    }


def run_health(params: dict, log: Log) -> dict:
    """Fastest useful check: is there an image, and does the rate hold?"""
    index = _auto_index(params)
    width, height = int(params["width"]), int(params["height"])
    fourcc, seconds = params["fourcc"], float(params["seconds"])

    log(f"opening index {index} at {width}x{height} {fourcc}...")
    cap = open_capture(index, width, height, fourcc, int(params.get("fps", 60)))
    try:
        warmup(cap, 30)
        signal = frame_signal(cap.read()[1])
        log(f"signal: {signal['state']} (mean {signal['mean']}, peak {signal['max']})")
        log(f"measuring throughput for {seconds:.0f}s...")
        read = bench_read(cap, seconds)
        driver_fps = cap.get(cv2.CAP_PROP_FPS)
    finally:
        cap.release()

    fps = read.get("mean_fps", 0.0)
    ok_signal = signal["state"] == "ok"
    ok_rate = fps >= FPS_FLOOR
    status = "ok" if (ok_signal and ok_rate) else ("warn" if ok_signal or ok_rate else "fail")
    headline = (f"{fps:.1f} fps, image {signal['state']}"
                if ok_signal else f"{fps:.1f} fps but NO USABLE IMAGE ({signal['state']})")

    notes = [describe_signal(signal)]
    if not ok_rate:
        notes.append(f"{fps:.1f} fps is below the {FPS_FLOOR:.0f} fps floor — "
                     f"fast motion will alias.")
    if not ok_signal:
        notes.append("Throughput on frames without an image is not throughput. "
                     "Fix the image before reading the rate.")
    return {
        "headline": headline, "status": status,
        "tables": [{"title": "result",
                    "columns": ["metric", "value"],
                    "rows": [["index", index],
                             ["mode", f"{width}x{height} {fourcc}"],
                             ["driver claims", f"{driver_fps:.0f} fps"],
                             ["achieved", f"{fps:.1f} fps"],
                             ["interval p95", f"{read.get('interval_ms', {}).get('p95', 0)} ms"],
                             ["long gaps", f"{read.get('long_gap_pct', 0)}%"],
                             ["signal", f"{signal['state']} (mean {signal['mean']}, peak {signal['max']})"]]}],
        "notes": notes,
        "raw": {"signal": signal, "read": read, "driver_fps": driver_fps},
    }


def run_stages(params: dict, log: Log) -> dict:
    """Where the missing frames go: transfer, decode, or draw."""
    index = _auto_index(params)
    width, height = int(params["width"]), int(params["height"])
    fourcc, seconds = params["fourcc"], float(params["seconds"])

    cap = open_capture(index, width, height, fourcc, int(params.get("fps", 60)))
    try:
        warmup(cap, 30)
        signal = frame_signal(cap.read()[1])
        driver_fps = cap.get(cv2.CAP_PROP_FPS)
        log("probing which call blocks (grab vs retrieve)...")
        blocking = probe_blocking_call(cap, driver_fps)
        log(f"  -> {blocking['blocking_call']}() absorbs the wait")
        log(f"measuring read() throughput for {seconds:.0f}s...")
        read = bench_read(cap, seconds)
        log("timing decode in isolation...")
        decode = bench_decode(cap)
    finally:
        cap.release()

    notes = interpret(blocking, read, None, decode, driver_fps)
    if signal["state"] != "ok":
        notes.insert(0, describe_signal(signal))
    fps = read.get("mean_fps", 0.0)
    status = "ok" if (signal["state"] == "ok" and fps >= driver_fps * 0.95) else "warn"
    return {
        "headline": f"read() sustains {fps:.1f} of {driver_fps:.0f} advertised fps",
        "status": status,
        "tables": [{"title": "stages", "columns": ["stage", "p50 ms", "p95 ms"],
                    "rows": [["grab", blocking["grab_ms"].get("p50"), blocking["grab_ms"].get("p95")],
                             ["retrieve", blocking["retrieve_ms"].get("p50"), blocking["retrieve_ms"].get("p95")],
                             ["decode (imdecode)", decode.get("p50"), decode.get("p95")],
                             ["frame period", blocking["frame_period_ms"], "-"]]}],
        "notes": notes,
        "raw": {"signal": signal, "blocking": blocking, "read": read, "decode": decode},
    }


def run_format_duel(params: dict, log: Log) -> dict:
    """MJPG vs YUY2 at one resolution, with the image content checked.

    Encodes the two failures this rig actually produced: a format can be
    reverted silently by set() ordering, and a format can stream full-rate
    frames that contain nothing. Either one makes a naive comparison pick the
    wrong winner.
    """
    index = _auto_index(params)
    width, height = int(params["width"]), int(params["height"])
    seconds = float(params["seconds"])

    rows, raw = [], {}
    for fourcc in ("MJPG", "YUY2"):
        log(f"measuring {fourcc} at {width}x{height}...")
        res = measure_mode(index, width, height, fourcc, seconds, int(params.get("fps", 60)))
        if res is None:
            rows.append([fourcc, "not supported", "-", "-", "-"])
            continue
        rows.append([fourcc, f"{res['achieved_fps']:.1f} fps", res["signal"]["state"],
                     res["signal"]["mean"], "yes" if res["usable"] else "no"])
        raw[fourcc] = res
        log(f"  {res['achieved_fps']:.1f} fps, signal {res['signal']['state']}")

    usable = {k: v for k, v in raw.items() if v["usable"]}
    if not usable:
        headline = "neither format is usable at this resolution"
        status = "fail"
    else:
        winner = max(usable.values(), key=lambda r: r["achieved_fps"])
        headline = f"{winner['fourcc']} wins: {winner['achieved_fps']:.1f} fps with a real image"
        status = "ok"

    notes = []
    dead = [k for k, v in raw.items() if v["signal"]["state"] == "dead"]
    if dead:
        notes.append(f"{', '.join(dead)} streamed all-zero frames. Its frame rate counts empty "
                     f"buffers and must not be compared against a format that carries an image.")
    dark = [k for k, v in raw.items() if v["signal"]["state"] == "dark"]
    if dark:
        notes.append(f"{', '.join(dark)} carries signal but almost no light — check the lens cap "
                     f"and lighting before trusting any image-quality judgement.")
    return {"headline": headline, "status": status,
            "tables": [{"title": f"{width}x{height}",
                        "columns": ["fourcc", "achieved", "signal", "mean level", "usable"],
                        "rows": rows}],
            "notes": notes, "raw": raw}


def run_mode_sweep(params: dict, log: Log) -> dict:
    """Every resolution x format combination the device honours."""
    index = _auto_index(params)
    seconds = float(params["seconds"])
    formats = params.get("fourcc_list") or list(FOURCC_CANDIDATES)

    results = []
    total = len(formats) * len(MODE_CANDIDATES)
    done = 0
    for fourcc in formats:
        for (w, h) in MODE_CANDIDATES:
            done += 1
            log(f"[{done}/{total}] {fourcc} {w}x{h}")
            res = measure_mode(index, w, h, fourcc, seconds, int(params.get("fps", 60)))
            if res:
                results.append(res)
                log(f"    {res['achieved_fps']:.1f} fps, signal {res['signal']['state']}")

    rows = [[r["fourcc"], f"{r['width']}x{r['height']}", f"{r['achieved_fps']:.1f}",
             f"{r['driver_fps']:.0f}", r["signal"]["state"],
             "yes" if r["usable"] else "no"]
            for r in sorted(results, key=lambda x: (-x["megapixels"], x["fourcc"]))]

    usable = [r for r in results if r["usable"]]
    if usable:
        best = max(usable, key=lambda r: (r["megapixels"], r["achieved_fps"]))
        headline = (f"best usable: {best['fourcc']} {best['width']}x{best['height']} "
                    f"@ {best['achieved_fps']:.1f} fps")
        status = "ok"
    else:
        headline = "no usable mode — nothing held the rate floor with a real image"
        status = "fail"

    notes = []
    dead = [r for r in results if r["signal"]["state"] == "dead"]
    if dead:
        formats_dead = sorted({r["fourcc"] for r in dead})
        notes.append(f"{len(dead)} mode(s) in {', '.join(formats_dead)} delivered all-zero "
                     f"frames; those rates are not throughput.")
    notes.append(f"'usable' requires a real image AND at least {FPS_FLOOR:.0f} fps.")
    return {"headline": headline, "status": status,
            "tables": [{"title": "modes",
                        "columns": ["fourcc", "resolution", "achieved", "claimed", "signal", "usable"],
                        "rows": rows}],
            "notes": notes, "raw": {"results": results}}


def run_exposure(params: dict, log: Log) -> dict:
    """Does exposure length cap the frame rate, and what does it cost in light?"""
    index = _auto_index(params)
    width, height = int(params["width"]), int(params["height"])
    seconds = float(params["seconds"])
    values = params.get("values") or [-4, -6, -8]

    cap = open_capture(index, width, height, params["fourcc"], int(params.get("fps", 60)))
    rows, raw = [], []
    try:
        log("measuring auto exposure...")
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, AUTO_ON)
        auto_summary, auto_brightness = measure_exposure(cap, seconds)
        rows.append(["auto", f"{auto_summary.get('mean_fps', 0):.1f}", f"{auto_brightness:.1f}"])
        raw.append({"mode": "auto", "fps": auto_summary.get("mean_fps"), "brightness": auto_brightness})

        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, AUTO_OFF)
        for value in values:
            log(f"measuring manual exposure {value}...")
            cap.set(cv2.CAP_PROP_EXPOSURE, float(value))
            summary, brightness = measure_exposure(cap, seconds)
            rows.append([str(value), f"{summary.get('mean_fps', 0):.1f}", f"{brightness:.1f}"])
            raw.append({"mode": "manual", "requested": value,
                        "fps": summary.get("mean_fps"), "brightness": brightness})
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, AUTO_ON)  # leave the device as we found it
    finally:
        cap.release()

    manual = [r for r in raw if r["mode"] == "manual" and r["fps"]]
    spread = (max(r["fps"] for r in manual) - min(r["fps"] for r in manual)) if manual else 0.0
    if spread >= 5.0:
        headline = f"exposure is a lever — {spread:.1f} fps between shortest and longest"
        status = "warn"
        notes = ["Shorter exposure buys frame rate and cuts motion blur, at the cost of light. "
                 "Pick the shortest exposure that still lights the subject."]
    else:
        headline = f"exposure is not the bottleneck (only {spread:.1f} fps across the sweep)"
        status = "ok"
        notes = ["Rate is flat across the sweep, so the ceiling is elsewhere — "
                 "run the stage attribution preset."]
    notes.append("Exposure units are driver-defined: log2 seconds on DirectShow, "
                 "100us ticks on V4L2.")
    return {"headline": headline, "status": status,
            "tables": [{"title": "exposure sweep",
                        "columns": ["setting", "fps", "mean level /255"], "rows": rows}],
            "notes": notes, "raw": {"results": raw}}


def run_sync(params: dict, log: Log) -> dict:
    """Multi-camera skew and bandwidth contention — the #91 open item."""
    indices = params.get("indices") or []
    if len(indices) < 2:
        raise RuntimeError("select at least two cameras")
    width, height = int(params["width"]), int(params["height"])
    fourcc, fps, seconds = params["fourcc"], int(params["fps"]), float(params["seconds"])

    solo = {}
    if params.get("solo_baseline", True):
        for index in indices:
            log(f"solo baseline for camera {index}...")
            solo[index] = measure_solo(index, width, height, fourcc, fps, seconds)
            log(f"  {solo[index].get('mean_fps', 0):.1f} fps")

    log(f"running {len(indices)} cameras concurrently...")
    caps = []
    try:
        for index in indices:
            caps.append(open_capture(index, width, height, fourcc, fps))
        concurrent = measure_concurrent(caps, seconds)
    finally:
        for cap in caps:
            cap.release()

    rate_rows = []
    for i, index in enumerate(indices):
        together = concurrent["per_camera"][i].get("mean_fps", 0.0)
        alone = solo.get(index, {}).get("mean_fps")
        drop = f"{(together / alone - 1) * 100:+.0f}%" if alone else "-"
        rate_rows.append([index, f"{alone:.1f}" if alone else "-", f"{together:.1f}", drop])

    period_ms = 1000.0 / fps
    skew_rows, worst_p95 = [], 0.0
    for pair, skew in concurrent["pairwise_skew_ms"].items():
        if not skew:
            continue
        left, right = (int(x) for x in pair.split("-"))
        skew_rows.append([f"{indices[left]} <-> {indices[right]}", skew["p50"],
                          skew["p95"], skew["max"], skew["samples"]])
        worst_p95 = max(worst_p95, skew["p95"])

    error_rows = [[f"{speed} m/s", f"{speed * worst_p95 / 1000 * 100:.2f} cm"]
                  for speed in (0.5, 1.0, 1.5, 2.0)] if worst_p95 else []

    headline = (f"skew p95 {worst_p95:.1f} ms — {1.5 * worst_p95 / 1000 * 100:.2f} cm of error "
                f"at 1.5 m/s" if worst_p95 else "skew unmeasured")
    status = "warn" if worst_p95 and (1.5 * worst_p95 / 1000 * 100) > 2.87 else "ok"
    return {
        "headline": headline, "status": status,
        "tables": [
            {"title": "per-camera rate", "columns": ["index", "solo", "concurrent", "change"],
             "rows": rate_rows},
            {"title": "pairwise skew (ms)",
             "columns": ["pair", "p50", "p95", "max", "pairs"], "rows": skew_rows},
            {"title": "positional error implied by p95 skew",
             "columns": ["subject speed", "displacement"], "rows": error_rows},
        ],
        "notes": [
            f"Free-running cameras have no phase lock, so pairing error is bounded by half a "
            f"frame period ({period_ms / 2:.1f} ms at {fps} fps) at best.",
            "Skew shifts a moving joint along its direction of travel — a bias, not noise. "
            "Averaging over frames will not remove it. Compare against the 2.87 cm best-pair "
            "accuracy from #95.",
            "Arrival timestamps sit after transfer and decode, so this is an upper bound. "
            "The LED flash check in experiment_uvc_sync.py is the ground truth.",
        ],
        "raw": {"solo": {str(k): v for k, v in solo.items()}, "concurrent": concurrent},
    }


# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------

def _p(key, label, type_, default, **extra):
    return {"key": key, "label": label, "type": type_, "default": default, **extra}


RESOLUTION_OPTIONS = [f"{w}x{h}" for (w, h) in sorted(MODE_CANDIDATES, key=lambda m: -m[0] * m[1])]

PRESETS = [
    {
        "id": "identify",
        "title": "장치 식별",
        "question": "어떤 카메라가 연결되어 있고, OpenCV 인덱스는 무엇인가?",
        "detail": "장치명은 신뢰할 수 없으므로 최대 해상도·종횡비로 판별한다.",
        "duration_hint": "5~40초",
        "params": [
            _p("max_index", "탐색할 최대 인덱스", "int", 5, min=1, max=10),
            _p("full_modes", "지원 모드 전체 탐색 (느림)", "bool", False),
        ],
        "runner": run_identify,
    },
    {
        "id": "health",
        "title": "빠른 상태 점검",
        "question": "영상이 실제로 들어오고, 프레임레이트가 유지되는가?",
        "detail": "가장 먼저 돌릴 검사. 신호 없는 프레임을 빠르다고 착각하지 않도록 내용까지 검증한다.",
        "duration_hint": "약 10초",
        "params": [
            _p("index", "카메라 인덱스 (-1 = 자동)", "int", -1, min=-1, max=9),
            _p("resolution", "해상도", "select", "1920x1200", options=RESOLUTION_OPTIONS),
            # YUY2 default: measured on this rig, it is the format that holds
            # 60 fps at full resolution (MJPG decode caps out near 30).
            _p("fourcc", "픽셀 포맷", "select", "YUY2", options=["MJPG", "YUY2"]),
            _p("seconds", "측정 시간(초)", "float", 5.0, min=1, max=60),
        ],
        "runner": run_health,
    },
    {
        "id": "stages",
        "title": "단계 귀속",
        "question": "광고된 fps에 못 미친다면, 전송·디코드·표시 중 어디서 잃는가?",
        "detail": "어느 호출이 블로킹하는지 먼저 판별한 뒤, 디코드 비용을 독립으로 측정한다.",
        "duration_hint": "약 15초",
        "params": [
            _p("index", "카메라 인덱스 (-1 = 자동)", "int", -1, min=-1, max=9),
            _p("resolution", "해상도", "select", "1920x1200", options=RESOLUTION_OPTIONS),
            _p("fourcc", "픽셀 포맷", "select", "MJPG", options=["MJPG", "YUY2"]),
            _p("seconds", "측정 시간(초)", "float", 8.0, min=2, max=60),
        ],
        "runner": run_stages,
    },
    {
        "id": "format-duel",
        "title": "포맷 대결 (MJPG vs YUY2)",
        "question": "이 해상도에서 어느 픽셀 포맷을 써야 하는가?",
        "detail": "죽은 포맷이 빈 프레임을 최고 속도로 흘려 이기는 일이 없도록 영상 내용을 함께 검증한다.",
        "duration_hint": "약 20초",
        "params": [
            _p("index", "카메라 인덱스 (-1 = 자동)", "int", -1, min=-1, max=9),
            _p("resolution", "해상도", "select", "1920x1200", options=RESOLUTION_OPTIONS),
            _p("seconds", "포맷당 측정 시간(초)", "float", 5.0, min=2, max=30),
        ],
        "runner": run_format_duel,
    },
    {
        "id": "mode-sweep",
        "title": "전체 모드 스윕",
        "question": "해상도와 프레임레이트를 어떻게 교환할 수 있는가?",
        "detail": "모든 해상도x포맷 조합의 실효 fps 매트릭스. 사양표가 아니라 실측으로 모드를 고르기 위한 것.",
        "duration_hint": "2~5분",
        "params": [
            _p("index", "카메라 인덱스 (-1 = 자동)", "int", -1, min=-1, max=9),
            _p("seconds", "모드당 측정 시간(초)", "float", 3.0, min=1, max=15),
            _p("fourcc_list", "검사할 포맷", "multiselect", ["MJPG", "YUY2"],
               options=["MJPG", "YUY2"]),
        ],
        "runner": run_mode_sweep,
    },
    {
        "id": "exposure",
        "title": "노출 스윕",
        "question": "노출 시간이 프레임레이트를 떨구는가?",
        "detail": "어두운 실내에서 자동 노출이 길어지면 센서가 스스로 속도를 낮춘다. 모션블러와의 교환도 함께 본다.",
        "duration_hint": "약 30초",
        "params": [
            _p("index", "카메라 인덱스 (-1 = 자동)", "int", -1, min=-1, max=9),
            _p("resolution", "해상도", "select", "1920x1200", options=RESOLUTION_OPTIONS),
            _p("fourcc", "픽셀 포맷", "select", "MJPG", options=["MJPG", "YUY2"]),
            _p("seconds", "설정당 측정 시간(초)", "float", 4.0, min=2, max=20),
            _p("values", "수동 노출값 (드라이버 단위)", "numbers", [-4, -6, -8]),
        ],
        "runner": run_exposure,
    },
    {
        "id": "sync",
        "title": "다중 카메라 동기",
        "question": "여러 대를 동시에 돌릴 때 서로 얼마나 어긋나고, 대역폭은 버티는가?",
        "detail": "#91의 미검증 항목. skew는 삼각측량에 편향으로 들어가므로 평균으로 지워지지 않는다.",
        "duration_hint": "약 40초",
        "params": [
            _p("indices", "카메라 (2대 이상)", "indices", []),
            _p("resolution", "해상도", "select", "1280x720", options=RESOLUTION_OPTIONS),
            _p("fourcc", "픽셀 포맷", "select", "MJPG", options=["MJPG", "YUY2"]),
            _p("fps", "요청 fps", "int", 30, min=5, max=120),
            _p("seconds", "측정 시간(초)", "float", 6.0, min=2, max=60),
            _p("solo_baseline", "단독 기준선도 측정", "bool", True),
        ],
        "runner": run_sync,
    },
]

PRESETS_BY_ID = {p["id"]: p for p in PRESETS}


def public_presets() -> list[dict]:
    """Registry without the runner callables, for JSON transport."""
    return [{k: v for k, v in p.items() if k != "runner"} for p in PRESETS]


def normalise_params(preset: dict, incoming: dict) -> dict:
    """Fill defaults, and expand 'WxH' into width/height the runners expect."""
    params = {spec["key"]: spec["default"] for spec in preset["params"]}
    params.update({k: v for k, v in (incoming or {}).items() if v is not None})
    if "resolution" in params and isinstance(params["resolution"], str):
        width, height = params["resolution"].split("x")
        params["width"], params["height"] = int(width), int(height)
    params.setdefault("width", 1920)
    params.setdefault("height", 1200)
    params.setdefault("fps", 60)
    if params.get("index") is not None and int(params.get("index", -1)) < 0:
        params["index"] = None
    return params
