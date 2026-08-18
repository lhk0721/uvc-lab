# uvc-lab

실물 UVC 카메라를 브라우저에서 확인하고 측정하는 도구 모음.
헤드리스 장비(예: Jetson)에 서버를 띄우고, 노트북 브라우저로 접속해서
라이브 프리뷰와 프리셋 벤치마크를 돌린다.

## 빠른 시작

```bash
uv sync
uv run python serve_uvc_lab.py --host 0.0.0.0 --port 8100
```

브라우저에서 `http://<서버 주소>:8100` 접속.

## 구성

| 파일 | 역할 |
| --- | --- |
| `serve_uvc_lab.py` | 브라우저 랩 서버 — 라이브 프리뷰 + 프리셋 벤치마크. 프리뷰와 벤치마크의 장치 선점을 중재한다. |
| `uvc_lab.html` | 랩 페이지 (서버가 서빙) |
| `uvc_lab_presets.py` | 브라우저에서 실행하는 이름 붙은 테스트 프리셋 |
| `uvc_devices.py` | 장치 식별(인덱스↔실물 매핑)과 공용 캡처 헬퍼. 단독 실행 시 장치 목록 출력 |
| `view_uvc_camera.py` | 로컬 프리뷰 창 (GUI 환경 전용) |
| `bench_uvc_capture.py` | 단계별(transfer/decode/present) 캡처 벤치마크 |
| `experiment_uvc_modes.py` | 해상도×픽셀포맷 스윕 — 표기 fps vs 실측 fps |
| `experiment_uvc_exposure.py` | auto-exposure가 프레임레이트를 깎는지 실험 |
| `experiment_uvc_sync.py` | 다중 카메라 skew·USB 대역 경합 측정 (`--flash-check` 포함) |

## CLI 사용 예

```bash
uv run python uvc_devices.py --modes          # 장치 식별 + 지원 모드 프로브
uv run python bench_uvc_capture.py --fourcc YUY2
uv run python experiment_uvc_modes.py --seconds 5
uv run python experiment_uvc_sync.py --indices 0 1 --flash-check
```

플랫폼: Windows(DirectShow/MSMF)와 Linux(V4L2, Jetson 포함) 지원.
측정 결과 JSON과 스냅샷은 `tmp/` 아래에 쌓인다 (git 미추적).

## 에이전트 워크플로

이 레포는 [agent-workflow-kit](https://github.com/lhk0721/agent-workflow-kit)을 사용한다.
클론 후 `claude`를 실행하고 "run onboarding"이라고 말하면 된다.
