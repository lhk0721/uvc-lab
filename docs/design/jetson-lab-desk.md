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
│ main (Node)                        │        │   127.0.0.1:18100    │
│   SSH · 탐색 · 파일 · 프로비저닝   │──SSH──▶│ systemd --user       │
│   로컬 포워드 127.0.0.1:<포트> ────┼─터널──▶│   (HTTP는 터널 안으로)│
└────────────────────────────────────┘        └──────────────────────┘
```

Jetson 서버는 `127.0.0.1`에만 bind하고, 노트북은 SSH 터널을 통해서만 닿는다.
자세한 근거는 아래 "HTTP 접근" 절에 있다.

역할이 겹치지 않는다:

- **Jetson**: 진짜 백엔드. 카메라를 물고 있는 유일한 주체.
- **Electron main**: 로컬 특권 작업 전담. SSH·탐색·파일시스템은 전부 여기.
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
├─ SSH       ssh2              main 전용. 터널(forwardOut)도 여기서
└─ 발견      bonjour-service   mDNS, main 전용
             tailscale CLI     `tailscale status --json`, 있을 때만
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
   ├─ src/main/{index,discovery,ssh,tunnel,provision,credentials}.ts
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

그리고 한 대가 **동시에 여러 경로로 보인다.** 같은 Jetson이 WiFi에도 붙어 있고,
USB로도 꽂혀 있고, tailnet에도 있으면 후보가 3개 나온다. 경로를 단수 필드로 잡으면
같은 장비가 카드 3개로 뜨므로, 경로는 처음부터 목록이다.

```ts
type JetsonId = string           // 장비에서 직접 받은 hostname. 못 받으면 IP

type RouteKind = 'usb' | 'mdns' | 'lan-scan' | 'tailscale' | 'manual'

type Route = {
  kind: RouteKind
  host: string                   // 이 경로에서 쓰는 주소
  relayed?: boolean              // tailscale이 DERP relay를 타는 중인지
}

type Jetson = {
  id: JetsonId
  routes: Route[]                // 동시에 여러 개
  activeRoute: Route             // 실제로 SSH를 맺고 있는 경로
  user: string
  provisioning: ProvisionState
  serverPort: number             // Jetson의 loopback 포트 (기본 18100)
}
```

- 로컬 상태: `jetsons: Record<JetsonId, Jetson>` + `activeId`
- 서버 조회: query key에 항상 id 포함 — `['cameras', jetsonId]`
- SSH 세션: main에서 `Map<JetsonId, Client>`

경로 우선순위는 **USB > LAN/mDNS > Tailscale**이다. Tailscale은 어디서든 닿지만
WAN을 타고, direct 연결이 안 되어 DERP relay로 넘어가면 프리뷰 프레임레이트가
눈에 띄게 떨어진다. 여러 경로가 살아 있으면 위 순서로 고르고, 사용자가 카드에서
다른 경로로 바꿀 수 있게 한다.

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

### 실제로 쓰는 연결 형태 4가지

설계의 출발점은 이론이 아니라 실제로 써 온 배선이다.

| 경우 | 주소 | 탐색 방법 |
| --- | --- | --- |
| 같은 WiFi/LAN | DHCP 주소 | mDNS → 실패하면 서브넷 스캔 |
| USB 직결 | `192.168.55.1` 고정 | TCP 22 직접 확인 |
| LAN 포트 직결 | 보통 `169.254.x.x` (link-local) | mDNS (link-local에서도 동작) |
| 다른 네트워크 | `100.x.y.z` (tailnet) | **mDNS 불가.** tailscale CLI 조회 |

LAN 직결은 별도 코드가 거의 필요 없다. 양쪽 다 DHCP를 못 받으면 link-local로
떨어지고 avahi는 그 위에서도 mDNS를 그대로 광고하므로, 스캔 대상 인터페이스
목록에 link-local 대역만 포함시키면 된다.

### 탐색은 2단계다

경로마다 알아낼 수 있는 정보가 다르므로 한 번에 장비를 확정하지 못한다.

**1단계 — 후보 수집.** 네 경로를 병렬로 돌려 `(주소, 경로)` 목록을 만든다.

1. **USB** — `192.168.55.1`의 TCP 22만 확인. 가장 싸고 확실하다.
2. **mDNS** — `bonjour-service`로 `_ssh._tcp` 조회. Jetson(Ubuntu)은 avahi가
   기본으로 떠 있어 `<hostname>.local`이 잡힌다.
3. **Tailscale** — 노트북에 `tailscale` CLI가 있으면 `tailscale status --json`을
   읽는다. peer마다 hostname·IP·online 여부·OS·relay 여부가 다 들어 있어서
   스캔이 아니라 조회로 끝난다. sudo도 필요 없고, CLI가 있다는 것 자체가
   "이 노트북은 tailnet에 붙어 있다"는 판정이 된다. **tailnet 대역
   (100.64.0.0/10)은 절대 스캔하지 않는다** — 범위가 너무 넓다.
4. **서브넷 스캔** — 위에서 아무것도 안 나왔을 때만. 노트북이 붙은 /24와
   link-local 대역의 port 22를 훑고 SSH 배너로 Linux 장비를 추린다.

**2단계 — 정체 확인과 병합.** 각 후보에 붙어 `hostname`을 받고(설치되어 있으면
터널 너머 `/api/health`로 한 번에 얻는다), 같은 id끼리 하나의 `Jetson`으로 합친다.
mDNS 이름이나 tailscale 이름은 시스템 hostname과 다를 수 있으므로, id는 반드시
장비에서 직접 받은 값을 쓴다.

health가 응답하면 "이미 설치된 Jetson"으로 판정하고, 버전이 노트북 쪽과 다르면
재배포 대상으로 표시한다.

### 수동 추가는 반드시 있어야 한다

회사 WiFi는 multicast를 막는 경우가 많고 게스트망은 클라이언트끼리 격리한다.
그러면 mDNS도 스캔도 전부 실패한다. IP나 hostname을 직접 입력해 등록하는 경로
(`kind: 'manual'`)를 처음부터 넣는다. 탐색이 실패해도 앱이 막다른 길이 되지 않게
하는 안전장치다.

탐색은 앱 시작 시 + 주기적으로 반복한다. USB를 꽂으면 잠시 후 경로가 추가되고,
뽑으면 그 경로만 사라진다 — 다른 경로가 살아 있으면 장비 카드는 유지된다.

## 2. 인증 — 비밀번호

- 첫 접속 시 앱 안에서 비밀번호를 입력받는다. 터미널을 열게 하지 않는다.
- 비밀번호는 main 프로세스 밖으로 나가지 않는다. renderer는 값을 본 적이
  없어야 한다. IPC로는 "저장해줘 / 저장된 게 있나? / 지워줘"만 오간다.
- 원격 명령줄에 비밀번호를 넣지 않는다. Jetson의 `ps`에 그대로 보인다.
  sudo가 필요한 곳에서는 `sudo -S`로 stdin에 흘려넣는다.

### 어디에 저장되는가

`safeStorage`는 **저장소가 아니라 암복호화 함수**다. `encryptString()`이 돌려주는
버퍼를 파일에 쓰는 것은 앱의 몫이므로, 위치를 여기서 정해둔다.

```
app.getPath('userData')/credentials.json
→ Windows: %APPDATA%\uvc-lab-desk\credentials.json
→ macOS:   ~/Library/Application Support/uvc-lab-desk/credentials.json
```

파일에는 Jetson id별로 사용자명(평문)과 `encryptString()` 결과의 base64만 넣는다.
키는 파일에 없다. OS가 들고 있다 — Windows는 DPAPI로 **로그인한 Windows 계정에**
묶고, macOS는 키체인에 넣는다. 그래서 이 파일을 다른 PC나 같은 PC의 다른 계정으로
복사해도 복호화되지 않는다.

- 쓰기 전에 `safeStorage.isEncryptionAvailable()`을 확인한다. false면 **평문으로
  떨어뜨리지 않고** 저장 자체를 포기하고 매번 입력받는다.
- Linux에서 앱을 돌리는 경우 키링(kwallet/libsecret)이 없으면 하드코딩 키
  fallback으로 내려갈 수 있다. `getSelectedStorageBackend()`로 확인해서
  `basic_text`면 저장하지 않는다.
- DB는 두지 않는다. 저장할 것은 자격증명과 장비 설정뿐이라 JSON 파일 하나로 족하다.
  영상이나 벤치마크 이력을 남기게 되면 그때 다시 판단한다.

### sudo 비밀번호

앱에는 터미널이 없으므로 sudo 비밀번호도 앱 안에서 받는다. 다만 **따로 받는 것이
기본은 아니다.** 보통 SSH 계정과 sudo 계정이 같고, 그러면 SSH 비밀번호가 그대로
sudo 비밀번호다. 이미 갖고 있는 값을 한 번 더 물어볼 이유가 없다.

순서는 이렇다.

1. 저장된 SSH 비밀번호를 `sudo -k -S -p '' -v`의 stdin에 넣어 먼저 시도한다.
   `-k`로 캐시된 timestamp를 무효화해서 "지금 이 비밀번호가 맞는가"만 판정한다.
   `-p ''`로 프롬프트 문자열을 없애 stderr 파싱을 단순하게 만든다.
2. 통과하면 그대로 쓴다. 별도 입력도, 별도 저장도 없다.
3. 실패하면(계정이 다르거나 비밀번호가 다른 경우) 그때 앱에서 sudo 비밀번호를
   따로 입력받고, 같은 `credentials.json`에 같은 `safeStorage` 암호화로 넣는다.
   Jetson id별로 `sudoPassword` 필드를 선택적으로 둔다.

보안상 손해가 늘지 않는다는 점을 분명히 해둔다. sudo 권한이 있는 계정의 SSH
비밀번호를 이미 저장하고 있으므로, 같은 계정의 sudo 비밀번호는 **같은 비밀**이다.
다른 계정인 경우에만 새 비밀이 하나 늘고, 그건 사용자가 그렇게 구성했을 때뿐이다.

주의할 것 둘:

- **틀린 비밀번호로 반복 시도하지 않는다.** 실패 3회면 sudo가 경고를 남기고
  `auth.log`에 기록된다. 한 번 실패하면 멈추고 사용자에게 그대로 보고한다.
- **sudo 자체를 못 쓰는 경우가 있다.** `Defaults requiretty`가 걸려 있거나
  계정이 sudoers에 없으면 stdin 방식이 통하지 않는다. Ubuntu 기본값에서는 드물지만,
  이때는 실패를 감추지 말고 **`sudo loginctl enable-linger $USER` 한 줄을 화면에
  띄워 사용자가 직접 실행하게 한다.** 장비당 한 번이면 끝나는 일이라 이 수동
  탈출구로 충분하다.

## 3. HTTP 접근 — SSH 터널

`serve_uvc_lab.py`의 기본 bind는 `127.0.0.1`이다(`--host`로 바꿀 수 있다).
이걸 `0.0.0.0`으로 열지 않고, **loopback에 그대로 두고 SSH 터널로 접근한다.**

provisioning용으로 이미 SSH 세션을 잡고 있으므로, 거기에 local port forward를
얹는다. main이 노트북 loopback에 TCP 서버를 하나 띄우고, 들어온 연결을 `ssh2`의
`forwardOut`으로 Jetson의 `127.0.0.1:18100`에 이어준다. renderer는 언제나
`http://127.0.0.1:<로컬포트>`만 바라본다.

이유:

- **경로 4개가 하나로 합쳐진다.** USB든 WiFi든 LAN 직결이든 Tailscale이든,
  SSH만 되면 HTTP는 그 안으로 간다. Tailscale 경우가 특히 공짜로 해결된다.
- **Jetson 네트워크에 포트를 하나도 열지 않는다.** 이 장비는 전용이 아니므로
  같은 망의 다른 사람에게 18100을 노출할 이유가 없다. 방화벽 설정도 변수에서 빠진다.
- renderer가 보는 주소가 항상 고정이라 상태 관리가 단순해진다. 경로가 바뀌어도
  (USB를 뽑고 WiFi로 넘어가도) renderer 쪽 URL은 그대로다.

대가는 MJPEG 스트림이 SSH 암호화를 한 번 더 통과하는 것인데, 이 해상도·비트레이트
에서는 문제되지 않는 수준으로 본다. 실제로 걸리면 그때 같은 LAN에 한해 직접 접속
경로를 추가한다. `uvc_lab.html`을 브라우저로 직접 여는 비상 경로는 이 터널 포트를
그대로 쓰면 된다.

## 4. Provision (bootstrap.sh)

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
| 3. 환경 | `uname -m`, `/etc/os-release`, systemd 유무 | 지원 여부 판정 | — |
| 4. uv | `uv --version` | astral 설치 스크립트 (`$HOME`) | 불필요 |
| 5. python | `python3 --version` ≥ 3.10 | `uv python install` | 불필요 |
| 6. payload | `VERSION` vs 앱 버전 | tar push | 불필요 |
| 7. 의존성 | — | `uv sync` | 불필요 |
| 8. unit | 파일 존재 + 내용 일치 | user unit 설치 + `daemon-reload` | 불필요 |
| 9. linger | `loginctl show-user -p Linger` | `sudo -S loginctl enable-linger` | 1회 필요 |

6단계의 `VERSION` 파일이 멱등성의 핵심이다. 앱 버전과 같으면 전송을 건너뛴다.

**정상 경로에서 sudo는 9번 한 번뿐이고, 그마저 장비당 한 번이다.** `apt`를 아예
쓰지 않기 때문이다. 근거는 아래 OS 절에 있다.

### 대상 OS — Ubuntu on aarch64

Jetson은 JetPack(L4T) 기반이고 그 실체는 Ubuntu다. 여기서 나오는 전제가 넷 있다.

- **아키텍처는 `aarch64`다.** x86_64가 아니다. uv 설치 스크립트는 아키텍처를
  자동 판별하고, `opencv-python`·`numpy`도 `manylinux2014_aarch64` wheel이 있어
  소스 빌드로 떨어지지 않는다. 3단계에서 `uname -m`을 확인해 예상 밖이면 멈춘다.
- **python3 버전이 문제가 될 수 있다.** `pyproject.toml`은 `>=3.10`인데
  JetPack 5(Ubuntu 20.04)의 기본 python3는 3.8이다. JetPack 6(Ubuntu 22.04)은
  3.10이라 통과한다. 낮은 경우 `apt`로 올리지 않고 **`uv python install`로 uv가
  독립 python을 받아오게 한다** — 홈 안에서 끝나고 sudo가 필요 없으며, 시스템
  python을 건드리지 않으니 다른 사용자의 작업도 깨지 않는다. uv를 python보다
  먼저 설치하는 순서(4→5)가 여기서 나온다.
- **venv의 cv2가 JetPack의 시스템 cv2를 가린다.** JetPack은 CUDA로 빌드된 OpenCV를
  같이 깔아두는데, `.venv` 안의 `opencv-python`이 그 자리를 대신한다. 이 도구는
  V4L2로 UVC 카메라를 여는 것이 전부라 CUDA 가속이 필요 없으므로 문제되지 않는다.
  가속 경로가 필요해지면 그때 시스템 cv2를 쓰는 별도 판단을 한다.
- **avahi가 없을 수 있다.** 데스크톱 이미지에는 기본으로 있지만 server 계열
  이미지에는 빠져 있을 수 있고, 그러면 mDNS 경로만 조용히 사라진다. 3단계에서
  확인해 "mDNS 사용 불가"로 표시만 하고, 설치를 시도하지는 않는다(sudo가 필요하고,
  다른 경로가 이미 있다).

`v4l2-ctl`은 `uvc_devices.py`의 안내 문구에만 등장하고 실행하지는 않으므로
`v4l-utils`도 설치하지 않는다.

## 5. 서버 생명주기 — systemd user unit

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

unit의 `ExecStart`는 `--host 127.0.0.1 --port <포트>`로 loopback에 묶는다. 외부
인터페이스에는 열지 않는다(3절).

| 동작 | 노트북에서 일어나는 일 |
| --- | --- |
| Start | `systemctl --user start uvc-lab` → 터널 연결 → health 응답 대기 → Open Lab 활성화 |
| Stop | 터널 닫기 → `systemctl --user stop uvc-lab` → 카메라·포트 해제 확인 |
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

## 6. 다른 프로그램과의 공존

Jetson이 전용 장비가 아니므로 두 가지를 다뤄야 한다.

- **포트 충돌** — 아래 절에서 따로 다룬다.
- **카메라 선점** — 다른 프로세스가 `/dev/video*`를 잡고 있을 수 있다. 지금
  `serve_uvc_lab.py`는 프리뷰↔벤치마크만 중재하고 외부 프로세스는 모른다.
  장치 열기 실패를 "다른 프로세스가 사용 중"으로 구분해서 UI에 그대로 보여준다.

### 포트 번호 — Jetson `18100`

포트가 두 개 나온다. 서로 다른 기계의 포트이므로 따로 정한다.

| 위치 | 값 | 정하는 방법 |
| --- | --- | --- |
| Jetson loopback (서버 bind) | **18100** | 고정 기본값, 충돌 시 18109까지 증가 |
| 노트북 loopback (터널 입구) | 18101부터 | 장비마다 하나씩, 안 되면 OS에 위임 |

**왜 만번대인가.** 리눅스의 `net.ipv4.ip_local_port_range` 기본값이
`32768 60999`다. 이 대역은 나가는 연결이 임시로 집어가는 자리라, 여기에 고정
포트를 잡으면 평소엔 되다가 가끔 bind가 실패한다. 재현이 안 되는 종류의 사고라
제일 나쁘다. IANA가 dynamic이라 부르는 49152–65535도 이 함정에 걸리므로 **쓰지
않는다.** 임시 포트 대역 아래이면서 잘 알려진 포트들이 몰린 구간보다는 위인
10000번대가 맞고, 기존 8100의 꼬리를 남겨 `18100`으로 한다.

**Jetson 쪽.** 기동 전에 `ss -ltn` 결과에서 `127.0.0.1:18100`이 비었는지 확인하고,
차 있으면 18101, 18102 순으로 18109까지 올린다. 열 칸을 다 쓰면 실패로 보고한다
(그 시점엔 포트 문제가 아니라 다른 문제일 가능성이 높다). 고른 값은 Jetson
레코드의 `serverPort`에 저장하고, unit의 `--port` 인자와 터널 목적지에 같은 값을
쓴다. 여기는 loopback이므로 다른 사람의 8100번대 서비스와는 애초에 겹칠 일이
적지만, 확인 자체가 싸므로 건너뛰지 않는다.

**노트북 쪽.** 장비 순서대로 18101부터 하나씩 잡는다(장비 두 대면 18101, 18102).
`EADDRINUSE`가 나면 다음 번호로 넘어가고, 그마저 막히면 포트 0으로 bind해서 OS가
빈 포트를 고르게 한다. renderer는 이 주소를 IPC로 받으므로 값이 무엇이든 상관없다.
번호를 굳이 예측 가능하게 두는 이유는 **브라우저로 직접 붙는 비상 경로** 때문이다.
그래서 실제로 열린 URL을 장비 카드에 그대로 표시하고 복사할 수 있게 한다 — 값이
흔들려도 사람이 찾을 수 있어야 한다.

## 화면 구성

- **장비 목록/카드** — hostname, 설치된 버전, 서버 상태 표시등, 그리고 **살아 있는
  경로 전부**(USB/mDNS/스캔/Tailscale/수동)와 지금 쓰는 경로 표시. Tailscale이면
  direct인지 relay인지도 같이 보여준다 — 프리뷰가 느릴 때 원인이 여기서 바로
  드러난다. 버튼: Start / Stop / Open Lab / Reinstall. 목록 옆에 "IP로 직접 추가".
- **로그 패널** — provision·기동 중 bootstrap 출력이 실시간으로 흐른다. 막히면
  여기서 바로 보인다.
- **랩 화면** — 카메라·해상도·포맷·파라미터를 골라 Jetson 서버로 보내고,
  프리뷰와 벤치마크 결과를 본다. 기존 `uvc_lab.html`이 하던 일의 React 판.

## 알려진 제약

- `uv sync` 단계에서 Jetson이 PyPI에 닿아야 한다. 오프라인 fallback(노트북에서
  aarch64 wheel을 미리 받아 같이 push)은 만들지 않는다. 온라인 가정으로 단순하게
  시작하고, 실제로 필요해지면 그때 추가한다.
- **Tailscale 경로에서는 프리뷰가 느리다.** WAN을 타는 데다 direct 연결이 실패해
  DERP relay로 넘어가면 더 느려진다. 화질·프레임레이트를 낮추는 저대역폭 모드는
  지금 만들지 않고, 카드에 relay 여부만 표시해 원인을 알 수 있게 한다.
- SSH 터널을 쓰므로 서버가 떠 있어도 SSH가 끊기면 화면이 끊긴다. 재연결은 앱이
  맡고, 그동안 카드는 "연결 끊김"으로 둔다. Jetson 쪽 서버는 linger 덕분에 계속
  살아 있으므로 재연결하면 그대로 이어진다.
- Electron 배포 크기가 120MB+ 다. 랩 도구라 감수한다.

## 구현 순서 (커밋 단위 제안)

1. `serve_uvc_lab.py`에 `/api/health` 추가 — 단독으로 검증 가능.
2. `deploy/bootstrap.sh` + `deploy/uvc-lab.service` — 손 SSH로 먼저 검증.
   여기까지가 Electron 없이도 값이 나오는 구간이다.
3. `desktop/` 뼈대 — electron-vite + React + TS, main/preload/renderer 경계와
   빈 화면까지.
4. main: 탐색(`discovery.ts`) — 4경로 후보 수집 + 병합, 결과를 renderer에 push.
5. main: SSH + 프로비저닝(`ssh.ts`, `provision.ts`) — 9단계 상태 머신.
6. main: SSH 터널(`tunnel.ts`) — 로컬 포트 → Jetson loopback 포워드.
7. renderer: 장비 카드 + 로그 패널 — Start/Stop/Reinstall 동작.
8. renderer: 랩 화면 — 카메라 제어와 벤치마크.
9. 실제 Jetson으로 end-to-end 검증: 탐색 → provision → Start → 랩 → Stop.
   경로별로 한 번씩 (USB 직결 / 같은 WiFi / Tailscale).
