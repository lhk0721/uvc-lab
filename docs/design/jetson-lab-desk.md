# Jetson 자동 배포 + Lab Desk 컨트롤 앱 — 설계 문서

- Issue: #2 (umbrella #1)
- Status: 설계 확정, 구현 전

## 배경과 목표

uvc-lab 서버(`serve_uvc_lab.py`)는 헤드리스 Jetson에 띄우고 노트북에서 접속하는
구조다. 지금은 Jetson에 손으로 SSH 접속해서 의존성을 깔고 서버를 띄워야 한다.
이 과정을 노트북 앱 하나로 끝내는 것이 목표다:

1. 노트북이 연결된 Jetson을 자동으로 찾는다.
2. 처음 보는 Jetson이면 필요한 것을 자동으로 설치한다 (provision).
3. 서버 시작/정지를 노트북에서 제어한다 — 사람이 명령어를 치지 않고,
   Docker Desktop처럼 창에서 버튼으로.
4. 카메라·해상도·파라미터를 노트북에서 골라 Jetson 서버로 보내 간접 제어한다.

### 명시적 비목표

- **Jetson 부팅 시 자동 시작은 하지 않는다.** Jetson은 카메라 테스트 전용
  장비가 아니다. 서버는 노트북에서 Start를 누른 동안만 떠 있고, Stop을 누르면
  카메라 장치와 포트를 완전히 놓아준다.
- **시스템 전역을 건드리지 않는다.** 설치물은 사용자 홈 아래에만 놓는다.
  이유는 위와 같다 — 이 장비는 우리 것만이 아니다.
- cloud-init userdata 방식은 쓰지 않는다. Jetson에서 userdata는 이미지를 다시
  플래시해야 적용되므로, 이미 세팅된 장비에는 SSH push가 현실적인 대체다.
- CLI는 만들지 않는다. 진입점은 Lab Desk 앱 하나다.
- 오프라인(폐쇄망) 설치는 지원하지 않는다. Jetson이 인터넷에 닿는다고 가정한다.

## 전체 구조 — 3계층

```
노트북                                          Jetson
┌────────────────────────────────────┐        ┌──────────────────────┐
│ renderer (React SPA)               │        │ serve_uvc_lab.py     │
│   화면만. Node 접근 없음           │        │   FastAPI            │
│        ↕ contextBridge (좁은 IPC)  │        │   카메라·스트림·벤치 │
│ main (Node)                        │──SSH──▶│ systemd --user       │
│   SSH · mDNS · 파일 · 프로비저닝   │──HTTP─▶│                      │
└────────────────────────────────────┘        └──────────────────────┘
```

역할이 겹치지 않는다:

- **Jetson**: 진짜 백엔드. 카메라를 물고 있는 유일한 주체.
- **Electron main**: 로컬 특권 작업 전담. SSH·mDNS·파일시스템은 전부 여기.
- **renderer**: 화면만. `nodeIntegration: false`, `contextIsolation: true`.
  preload의 `contextBridge`로 노출한 함수 외에는 아무것도 못 부른다.

renderer에서 `ssh2`를 직접 부르고 싶어지는 순간이 오는데, 한 번 뚫으면
Electron 보안 모델이 통째로 무너지므로 예외를 두지 않는다.

## 스택

```
Electron + React + TypeScript
├─ 빌드      electron-vite
├─ 패키징    electron-builder
├─ 라우팅    TanStack Router   파일 기반 + 타입 안전. SPA 전용이라 Electron에서 그대로 동작
├─ 서버상태  TanStack Query    Jetson 조회
├─ 로컬상태  Zustand           UI 선택값
├─ SSH       ssh2              main 전용
└─ 발견      bonjour-service   mDNS, main 전용
```

### 메타 프레임워크를 쓰지 않는 이유

Next.js 같은 메타 프레임워크가 채우는 자리는 서버 자리인데, 이 구조에는 서버가
이미 둘(Jetson, Electron main) 있다. SSR·Server Component·API Routes는 전부 쓸 수
없고, Electron에서는 정적 export가 강제되어 파일 기반 라우팅만 남는다. 그 하나는
TanStack Router로 얻는다. 게다가 export 모드에서 서버 기능을 실수로 쓰면 빌드는
통과하고 런타임에 깨지므로, 얻는 것보다 지뢰가 많다.

### Electron을 고른 이유 (Tauri 대비)

- SSH·SFTP·mDNS가 전부 Node 생태계에 성숙해 있다. Tauri였다면 Rust로 직접 짠다.
- Chromium을 내장하므로 영상 재생 동작이 OS별로 갈리지 않는다. 지금은 MJPEG를
  `<img>`로 받지만 나중에 저지연 H.264/WebRTC로 옮길 여지를 남긴다.
- 대가는 배포 크기(120MB+)인데, 랩 도구라 문제되지 않는다.

## 디렉터리

```
uvc-lab/
├─ serve_uvc_lab.py, uvc_devices.py, ...   Jetson payload (현행 유지)
├─ uvc_lab.html                            브라우저 직접 접속용 (유지)
├─ deploy/
│  ├─ bootstrap.sh                         Jetson에서 도는 idempotent 설치 스크립트
│  └─ uvc-lab.service                      systemd user unit 템플릿
└─ desktop/                                Electron 앱
   ├─ src/main/{index,discovery,ssh,provision}.ts
   ├─ src/preload/index.ts
   ├─ src/renderer/                        React SPA
   └─ electron.vite.config.ts
```

`uvc_lab.html`을 남기는 이유는 앱이 깨졌을 때 브라우저로 직접 붙을 길을
열어두기 위해서다. renderer 빌드 결과물은 정적 파일 묶음이므로, 나중에 Jetson의
Python 서버가 같은 빌드를 서빙하게 만들 수도 있다.

기존 코드 변경은 하나뿐이다: `serve_uvc_lab.py`에 `/api/health` 추가
(버전 + hostname 응답).

## 여러 대 전제

지금은 Jetson 한 대만 쓰지만, 탐색은 태생적으로 목록을 만든다. 한 대로 가정하고
짜면 그 목록을 억지로 하나로 눌러놓는 코드가 되고 나중에 전부 뜯게 되므로,
처음부터 모든 상태에 Jetson id를 붙인다.

```ts
type JetsonId = string           // hostname 기준, 없으면 IP

type Jetson = {
  id: JetsonId
  host: string
  user: string
  route: 'usb' | 'mdns' | 'scan'
  provisioning: ProvisionState
  serverPort: number
}
```

- 로컬 상태: `jetsons: Record<JetsonId, Jetson>` + `activeId`
- 서버 조회: query key에 항상 id 포함 — `['cameras', jetsonId]`
- SSH 세션: main에서 `Map<JetsonId, Client>`

UI는 당분간 한 대만 보여줘도 된다. 목록 화면은 나중에 화면 추가로 끝난다.

## 상태 세 종류

섞으면 나중에 제일 크게 아픈 지점이라 처음부터 나눈다.

| 종류 | 예 | 소유자 | 전달 방식 |
| --- | --- | --- | --- |
| 프로비저닝 상태 | SSH 연결됨, 전송 70%, 서버 기동됨 | main | `webContents.send()` → renderer 구독 |
| Jetson 런타임 상태 | 카메라 목록, 현재 fps, 실행 중 벤치마크 | Jetson | TanStack Query (HTTP/WS) |
| 로컬 UI 상태 | 고른 카메라, 입력 중인 파라미터 | renderer | Zustand |

프로비저닝 상태를 TanStack Query로 다루면 어긋난다. 조회하는 게 아니라 main이
진행 상황을 밀어주는 것이기 때문이다.

## 1. 탐색 (main/discovery.ts)

싼 것부터 순서대로 시도한다:

1. **`192.168.55.1`** — Jetson을 USB device mode로 직결하면 항상 이 IP다.
   TCP 22 체크만 하면 되니 가장 싸고 확실하다.
2. **mDNS** — `bonjour-service`로 `_ssh._tcp` 조회. Jetson(Ubuntu)은 avahi가
   기본으로 떠 있어 `<hostname>.local`이 잡힌다.
3. **서브넷 SSH 스캔** — 노트북이 붙은 서브넷에서 port 22를 훑고 SSH 배너로
   Linux 장비를 추린다. 후보가 여러 개면 목록으로 보여주고 사용자가 고른다.

각 후보에서 `http://<ip>:<port>/api/health`가 응답하면 "이미 설치된 Jetson"으로
판정한다. health의 버전이 노트북 쪽과 다르면 재배포 대상으로 표시한다.

탐색은 앱 시작 시 + 주기적으로 반복한다. USB를 꽂으면 잠시 후 카드가 나타나고,
뽑으면 "연결 끊김"으로 바뀐다.

## 2. 인증 — 비밀번호

- 첫 접속 시 앱 안에서 비밀번호를 입력받는다. 터미널을 열게 하지 않는다.
- 저장은 Electron `safeStorage` (Windows DPAPI / macOS 키체인에 위임).
  localStorage나 평문 파일은 쓰지 않는다.
- 비밀번호는 main 프로세스 밖으로 나가지 않는다. renderer는 값을 본 적이
  없어야 한다. IPC로는 "저장해줘 / 저장된 게 있나?"만 오간다.
- 원격 명령줄에 비밀번호를 넣지 않는다. Jetson의 `ps`에 그대로 보인다.
  sudo가 필요한 곳에서는 `sudo -S`로 stdin에 흘려넣는다.

## 3. Provision (bootstrap.sh)

### 설치 위치 — 홈 안에서 끝낸다

```
~/.uvc-lab/repo/                        코드 (payload)
~/.uvc-lab/VERSION                      버전 마커
~/.uvc-lab/repo/.venv/                  uv가 만드는 가상환경
~/.config/systemd/user/uvc-lab.service  user unit
```

### 코드 전달

`git archive`로 tar를 만들어 `ssh2`의 exec stream stdin으로 흘리고, 원격에서
`tar -x`로 받는다. git 미추적 파일(`__pycache__`, `tmp/`)이 자연히 제외되고,
Windows에 rsync가 없어도 동작한다.

### 각 단계는 "확인 → 실행 → 검증"

멱등성은 단계마다 확인부터 하는 것으로 얻는다.

| 단계 | 확인 | 없으면 | sudo |
| --- | --- | --- | --- |
| 1. 접속 | TCP 22 | 실패 처리 | — |
| 2. 인증 | SSH 로그인 | 비밀번호 재요청 | — |
| 3. 환경 | `uname -m`, JetPack 버전 | 지원 여부 판정 | — |
| 4. python3 | `python3 --version` | `apt install python3` | 필요 |
| 5. uv | `uv --version` | astral 설치 스크립트 (`$HOME`) | 불필요 |
| 6. payload | `VERSION` vs 앱 버전 | tar push | 불필요 |
| 7. 의존성 | — | `uv sync` | 불필요 |
| 8. unit | 파일 존재 + 내용 일치 | user unit 설치 + `daemon-reload` | 불필요 |
| 9. linger | `loginctl show-user -p Linger` | `sudo -S loginctl enable-linger` | 1회 필요 |

6단계의 `VERSION` 파일이 멱등성의 핵심이다. 앱 버전과 같으면 전송을 건너뛴다.

sudo는 4번과 9번에서만 쓰인다. 4번은 JetPack에 python3가 기본 포함이라 실제로는
거의 걸리지 않는다. `v4l2-ctl`은 `uvc_devices.py`의 안내 문구에만 등장하고
실행하지는 않으므로 `v4l-utils`도 설치하지 않는다. 즉 정상 경로에서 sudo는 9번
한 번뿐이고, 그마저 장비당 한 번이다.

## 4. 서버 생명주기 — systemd user unit

system unit(`/etc/systemd/system/`)이 아니라 user unit을 쓴다.

| | system unit | user unit (채택) |
| --- | --- | --- |
| sudo | 설치·start·stop마다 필요 | 불필요 |
| 시스템 오염 | 있음 | 없음 (홈 안에서 끝) |
| 로그 | `journalctl` | `journalctl --user -u uvc-lab` |

nohup 대신 systemd를 끼우는 이유는 그대로다: Stop이 확실해서 좀비 프로세스가
`/dev/video*`를 물고 남는 사고가 없고, `is-active`로 상태를 정확히 알 수 있고,
crash 로그가 남는다.

enable은 하지 않는다. unit은 노트북이 쏘는 start/stop의 대상일 뿐이라 Jetson을
재부팅해도 서버는 저절로 뜨지 않는다.

| 동작 | 노트북에서 일어나는 일 |
| --- | --- |
| Start | `systemctl --user start uvc-lab` → health 응답 대기 → Open Lab 활성화 |
| Stop | `systemctl --user stop uvc-lab` → 카메라·포트 해제 확인 |
| 상태 | `systemctl --user is-active uvc-lab` |
| Reinstall | tar push → bootstrap 재실행 → 떠 있었다면 restart |

### user unit의 함정 두 가지 (반드시 처리)

1. **`XDG_RUNTIME_DIR`** — non-interactive SSH에는 이 변수가 없어
   `systemctl --user`가 D-Bus를 못 찾고 실패한다. 모든 원격 명령 앞에
   `XDG_RUNTIME_DIR=/run/user/$(id -u)`를 붙인다.
2. **linger** — linger가 꺼져 있으면 SSH 세션이 끊길 때 user manager가 함께
   내려가면서 서버도 죽는다. 앱은 명령만 쏘고 연결을 끊는 구조이므로
   `loginctl enable-linger`가 한 번 필요하다(9단계). linger는 user manager를
   살려둘 뿐 서비스를 자동 기동하지는 않으므로, "부팅 자동시작 없음" 원칙과
   충돌하지 않는다.

### 앱이 죽었을 때

user unit이므로 Jetson 쪽 서버는 그대로 떠 있다. 앱을 다시 켜면 탐색 후
`is-active`로 "이미 돌고 있음"을 알아내고 그 상태로 복귀한다. PID 파일 방식보다
회수가 깔끔하다.

## 5. 다른 프로그램과의 공존

Jetson이 전용 장비가 아니므로 두 가지를 다뤄야 한다.

- **포트 충돌** — 8100이 이미 쓰이고 있을 수 있다. 기동 전에 확인하고, 포트를
  unit 파일의 인자로 바꿀 수 있게 한다. 선택한 포트는 Jetson 레코드에 저장해서
  health 조회에도 같은 값을 쓴다.
- **카메라 선점** — 다른 프로세스가 `/dev/video*`를 잡고 있을 수 있다. 지금
  `serve_uvc_lab.py`는 프리뷰↔벤치마크만 중재하고 외부 프로세스는 모른다.
  장치 열기 실패를 "다른 프로세스가 사용 중"으로 구분해서 UI에 그대로 보여준다.

## 화면 구성

- **장비 목록/카드** — hostname, IP, 연결 경로(USB/mDNS/스캔), 설치된 버전,
  서버 상태 표시등. 버튼: Start / Stop / Open Lab / Reinstall.
- **로그 패널** — provision·기동 중 bootstrap 출력이 실시간으로 흐른다. 막히면
  여기서 바로 보인다.
- **랩 화면** — 카메라·해상도·포맷·파라미터를 골라 Jetson 서버로 보내고,
  프리뷰와 벤치마크 결과를 본다. 기존 `uvc_lab.html`이 하던 일의 React 판.

## 알려진 제약

- `uv sync` 단계에서 Jetson이 PyPI에 닿아야 한다. 오프라인 fallback(노트북에서
  aarch64 wheel을 미리 받아 같이 push)은 만들지 않는다. 온라인 가정으로 단순하게
  시작하고, 실제로 필요해지면 그때 추가한다.
- Electron 배포 크기가 120MB+ 다. 랩 도구라 감수한다.

## 구현 순서 (커밋 단위 제안)

1. `serve_uvc_lab.py`에 `/api/health` 추가 — 단독으로 검증 가능.
2. `deploy/bootstrap.sh` + `deploy/uvc-lab.service` — 손 SSH로 먼저 검증.
   여기까지가 Electron 없이도 값이 나오는 구간이다.
3. `desktop/` 뼈대 — electron-vite + React + TS, main/preload/renderer 경계와
   빈 화면까지.
4. main: 탐색(`discovery.ts`) — 3단계, 결과를 renderer에 push.
5. main: SSH + 프로비저닝(`ssh.ts`, `provision.ts`) — 9단계 상태 머신.
6. renderer: 장비 카드 + 로그 패널 — Start/Stop/Reinstall 동작.
7. renderer: 랩 화면 — 카메라 제어와 벤치마크.
8. 실제 Jetson으로 end-to-end 검증: 탐색 → provision → Start → 랩 → Stop.
