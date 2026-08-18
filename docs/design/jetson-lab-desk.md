# Jetson 자동 배포 + Lab Desk 컨트롤 앱 — 설계 문서

- Issue: #2 (umbrella #1)
- Status: 설계 확정, 구현 전

## 배경과 목표

uvc-lab 서버(`serve_uvc_lab.py`)는 헤드리스 Jetson에 띄우고 노트북 브라우저로
접속하는 구조다. 지금은 Jetson에 손으로 SSH 접속해서 의존성을 깔고 서버를
띄워야 한다. 이 과정을 노트북에서 앱 하나로 끝내는 것이 목표다:

1. 노트북이 연결된 Jetson을 자동으로 찾는다.
2. 처음 보는 Jetson이면 필요한 것을 자동으로 설치한다 (provision).
3. 서버 시작/정지를 노트북에서 제어한다 — 사람이 명령어를 치지 않고,
   Docker Desktop처럼 창에서 버튼으로.

### 명시적 비목표

- **Jetson 부팅 시 자동 시작은 하지 않는다.** Jetson은 카메라 테스트 전용
  장비가 아니다. 서버는 노트북에서 Start를 누른 동안만 떠 있고, Stop을
  누르면 카메라 장치와 포트를 완전히 놓아준다. Jetson을 재부팅해도 서버는
  저절로 뜨지 않는다.
- cloud-init userdata 방식은 쓰지 않는다. Jetson에서 userdata는 이미지를
  다시 플래시해야 적용되므로, 이미 세팅된 장비에는 SSH push가 현실적인
  대체다.
- CLI는 만들지 않는다. 진입점은 Lab Desk 앱 하나다.

## 전체 구조

```
deploy/
├── lab_desk.py        # 노트북에서 도는 컨트롤 앱 (FastAPI, localhost 전용)
├── lab_desk.html      # 컨트롤 패널 UI (lab_desk.py가 서빙)
├── find_jetson.py     # Jetson 탐색 로직 (lab_desk가 백그라운드에서 사용)
├── bootstrap.sh       # Jetson 위에서 실행되는 idempotent 설치 스크립트
└── uvc-lab.service    # systemd unit 템플릿 — 설치만 하고 enable은 안 함
```

기존 코드 변경은 하나뿐이다: `serve_uvc_lab.py`에 `/api/health` endpoint
추가 (버전 + hostname 응답). 탐색기가 "이미 설치된 Jetson인지, 버전이
노트북 코드와 같은지"를 이걸로 판단한다.

스택은 레포의 기존 패턴(FastAPI + HTML 한 장)을 그대로 따른다.

## 1. Lab Desk 앱 (노트북)

### 실행

바탕화면 바로가기(`lab-desk.bat`) 더블클릭:

1. `lab_desk.py`가 localhost(예: 8090)에 뜬다.
2. Chrome `--app=http://localhost:8090` 모드로 창을 연다 — 주소창 없는
   단독 창이라 데스크톱 앱처럼 보인다. Chrome이 없으면 Edge로 fallback.
   (둘 다 같은 `--app` 기능이라 코드는 여는 명령 한 줄만 다르다.)

### 화면 구성

- **상단**: 탐색 상태. "Jetson 찾는 중…" → 찾으면 장비 카드 표시:
  hostname, IP, 연결 경로(USB/LAN), 설치된 버전, 서버 상태 표시등.
- **카드 버튼**: Start / Stop / Open Lab / Reinstall.
- **하단**: 로그 패널. provision이나 시작 중일 때 bootstrap 출력이
  실시간으로 흐른다 — 막히면 여기서 바로 보인다.

### 내부 동작

- 버튼 → lab_desk.py가 백그라운드 스레드에서 SSH 작업 수행, UI는 상태를
  폴링해서 갱신.
- 탐색은 앱 시작 시 + 주기적으로 자동 반복. USB를 꽂으면 잠시 후 카드가
  나타나고, 뽑으면 "연결 끊김"으로 바뀐다.
- Start 성공 시 Open Lab 활성화 → 누르면 `http://<jetson>:8100` 랩 페이지.
- 첫 provision에 필요한 SSH 비밀번호는 터미널이 아니라 컨트롤 패널 안에서
  입력받는다. 입력 후 노트북의 SSH 공개키를 Jetson `authorized_keys`에
  등록해서 두 번째부터는 묻지 않는다 (Windows에는 ssh-copy-id가 없으므로
  이 단계를 직접 구현).

## 2. 탐색 (find_jetson.py)

싼 것부터 순서대로 시도한다:

1. **`192.168.55.1`** — Jetson을 USB device mode로 직결하면 항상 이 IP다.
   TCP 22 체크만 하면 되니 가장 싸고 확실하다.
2. **mDNS** — `jetson.local` 류 hostname 조회.
3. **서브넷 SSH 스캔** — 노트북이 붙은 서브넷에서 port 22를 스캔하고 SSH
   배너로 Linux 장비를 추린다. 후보가 여러 개면 카드 목록으로 보여주고
   사용자가 고른다.

각 후보에서 `http://<ip>:8100/api/health`가 응답하면 "이미 설치된
Jetson"으로 판정한다. health의 버전이 노트북 쪽 코드와 다르면 재배포
대상으로 표시한다.

## 3. Provision (bootstrap.sh, SSH push)

### 코드 전달

- Windows에 rsync가 기본으로 없으므로, `git archive`로 tar를 만들어
  `ssh 'tar -x'`로 스트리밍한다. Windows 내장 OpenSSH만으로 동작하고,
  `__pycache__`·`tmp/` 같은 git 미추적 파일은 자연히 제외된다.

### bootstrap.sh — 몇 번을 다시 돌려도 안전하게 (idempotent)

1. apt로 시스템 패키지 설치 (`v4l-utils` 등; 이미 있으면 skip).
2. uv 설치 (astral 설치 스크립트).
3. 전달받은 repo에서 `uv sync` — opencv-python은 aarch64 wheel이 있어
   V4L2/UVC 용도로는 그대로 동작한다.
4. `uvc-lab.service`를 systemd에 설치. **`enable`은 하지 않는다** —
   unit은 노트북이 쏘는 `systemctl start/stop`의 대상일 뿐이다.

재실행하면 코드 업데이트 + 서비스 재시작만 일어난다.

### systemd를 끼우는 이유 (nohup 대비)

- 죽었을 때 로그가 `journalctl`에 남는다.
- 떠 있는 동안만 crash 시 자동 재시작된다.
- Stop이 확실하다 — 프로세스가 좀비로 남아 `/dev/video*`를 물고 있는
  사고가 안 난다.
- "지금 떠 있나?"를 `systemctl is-active`로 정확히 알 수 있다.

## 4. 서버 생명주기

| 동작 | 노트북에서 일어나는 일 |
| --- | --- |
| Start | SSH로 `systemctl start uvc-lab` → health 응답 대기 → Open Lab 활성화 |
| Stop | SSH로 `systemctl stop uvc-lab` → 카메라·포트 해제 확인 |
| Reinstall | tar push → bootstrap.sh 재실행 → (떠 있었다면) restart |

## 알려진 제약

- `uv sync` 단계에서 Jetson이 PyPI에 접근할 수 있어야 한다 (wheel
  다운로드). USB 직결이라 Jetson에 인터넷이 없는 경우를 위한 오프라인
  fallback(노트북에서 aarch64 wheel을 미리 받아 같이 push)은 **처음엔
  만들지 않는다.** 온라인 가정으로 단순하게 시작하고, 실제로 오프라인
  상황이 생기면 그때 추가한다.

## 구현 순서 (커밋 단위 제안)

1. `serve_uvc_lab.py`에 `/api/health` 추가.
2. `find_jetson.py` — 탐색 3단계, 단독 실행으로도 검증 가능하게.
3. `bootstrap.sh` + `uvc-lab.service` + push 로직 — SSH로 수동 검증.
4. `lab_desk.py` + `lab_desk.html` — 위 조각들을 UI로 묶기.
5. 실제 Jetson으로 end-to-end 검증: 탐색 → provision → Start →
   랩 페이지 → Stop.
