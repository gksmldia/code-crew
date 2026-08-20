# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

프로젝트 개요·기술 스택·파일별 역할·작업 규칙·검증 명령은 Codex와 공유하는 단일 원본에 있습니다.
아래 import가 그 내용을 그대로 불러오므로, 공통 내용은 `AGENTS.md` 한 곳만 고칩니다.
이 파일에는 **여러 파일을 같이 읽어야 보이는 아키텍처**만 덧붙입니다(내용 중복 금지).

@AGENTS.md

---

## 이벤트 파이프라인 — 입구는 둘, 깔때기는 하나

```
Claude Code ──hook 프로세스 실행──▶ code-crew-hook ──POST /event──┐
                                                                 ├─▶ Event enum ──mpsc──▶ Tauri emit ──▶ store.applyEvent
Codex       ──rollout JSONL 폴링(1.5s)──▶ codex_monitor ──────────┘
```

- hook은 이벤트마다 **새 프로세스**로 뜬다. 위젯이 꺼져 있으면 `/health`를 300ms 안에 못 받고 조용히 끝낸다 (`src-tauri/src/bin/hook.rs:437`).
- 서버 포트는 고정이 아니다. `127.0.0.1:0`에 바인딩한 실제 포트를 `~/.code-crew/server.port`에 쓰고(`src-tauri/src/server.rs:287`), hook이 그 파일을 읽는다(`src-tauri/src/bin/hook.rs:9`). 못 읽을 때만 19876 폴백(`hook.rs:14`) — `README.md:43`의 하드코딩 curl 예시는 이 폴백에 기대는 것이다.
- Rust `Event`(`src-tauri/src/events.rs:6`)와 TS `Event`(`src/types.ts:99`)는 **손으로 맞춘 미러**다. 한쪽만 고치면 조용히 어긋난다.
- `PostToolUseFailure`는 별도 variant가 아니라 `PostToolUse { success: false }`로 접힌다(`events.rs:226`).
- `applyEvent`(`src/store.ts:173`)가 유일한 리듀서다. 세션 상태 변화는 전부 여기를 지난다.

## 권한 요청 — 응답 경로가 둘이고 서로 경쟁한다

`PermissionRequest` hook은 `/permission`에 붙어 최대 600초 **블로킹**된다. 그동안 두 스레드가 경쟁한다.

1. 위젯 스레드 — 카드에서 누른 결정을 `/permission-response/:id`로 받음
2. tty 스레드 — 터미널에서 `y` / `n` / `a`를 직접 읽음 (`hook.rs:296`, Windows에는 없음)

먼저 끝난 쪽이 이긴다. 그래서 **"항상 허용" 규칙 JSON이 두 곳에 각각 있고 바이트 단위로 같아야 한다** — `hook.rs`의 `a` 분기와 `src/components/PermissionInline.tsx`의 `synthesizeRule`. 한쪽만 고치면 어디서 답했는지에 따라 규칙이 달라진다.
hook 프로세스가 죽으면 `PermissionCleanup`의 Drop이 `PermissionCancel`을 쏴서 카드 대기를 푼다(`src-tauri/src/server.rs:71`).
Codex 권한 요청은 위젯에서 **답할 수 없다** — 터미널 포커스만 시킨다.

## 세션 생명주기 — "끝났다"를 한 신호로 판정하지 않는다

Stop 하나로는 종료가 아니다. Claude Code의 팀/백그라운드 Agent는 메인 Stop 뒤에도 계속 돈다(`src/types.ts:79-83`의 `mainStopped`).

- `setIdle`은 `pendingPermissions`가 남아 있으면 재우지 않는다(`src/store.ts:562`). 답변 대기 중 카드가 잠들던 버그의 방지선.
- 실제 정리는 5초마다 도는 sweep이 한다(`src/hooks/useIdleSweep.ts`). PID 생존·transcript 갱신 시각·Codex 유휴 시간을 조합해 `workingVerdict()`가 `sleep`/`keep`/`fallback`을 낸다(`useIdleSweep.ts:67`).
- 백그라운드 쉘(`run_in_background: true`) 종료는 hook으로 오지 않는다. transcript의 `<task-notification>`으로만 알 수 있어(`src-tauri/src/transcript.rs`) sweep이 지운다. 그래서 메인이 멈춰도 백그라운드가 남았으면 펫은 `sleeping`이 아니라 `waiting`이다(`src/lib/petState.ts:24`).
- `SessionStart`는 `pidChain[0]`이 같은 이전 세션을 제거한다 — `/clear`가 SessionEnd 없이 새 세션 ID를 만들어 카드가 쌓이는 문제(claude-code#6428) 대응(`src/store.ts:180-183`).

## 저장·복원

프로젝트 키는 `git remote.origin.url` → `rev-parse --show-toplevel` → cwd 순으로 정하고 SHA256 앞 8바이트로 줄인다(`src-tauri/src/project_key.rs`). **같은 레포의 여러 워크트리는 같은 키**가 된다 — 의도된 동작.
메시지 상한 200은 프론트(`src/store.ts:96` `pushMessage`)와 백엔드(`src-tauri/src/storage.rs:6`)에 **각각 따로** 있다. 한쪽만 바꾸면 재시작 뒤 개수가 달라진다.

## 창 포커스

카드 더블클릭 → 그 세션을 띄운 터미널·IDE 창을 앞으로 꺼낸다. hook이 올려준 `pid_chain`을 순서대로 시도하고, 필요하면 `expand_pid_chain`으로 조상 PID까지 올라간다(`src-tauri/src/lib.rs:381`) — Codex는 `lsof`로 찾은 비GUI PID 하나만 알기 때문이다.
macOS는 JXA/CoreGraphics + System Events AXRaise, Windows는 Win32 `EnumWindows`/`SetForegroundWindow`. 진단 로그는 macOS `/tmp/code-crew-focus.log`, Windows는 temp 디렉터리(`src-tauri/src/lib.rs:360`).

## 플랫폼 차이 (실수하기 쉬운 곳)

- **hook 바이너리 경로 해석이 OS별로 다르다.** macOS는 `current_exe()`의 부모를 쓴다 — Resource 디렉터리로 해석하면 실행 권한(+x)이 사라지기 때문. Windows는 `BaseDirectory::Resource`를 쓴다(`src-tauri/src/lib.rs:162-182`).
- 창 닫기는 가로채서 숨긴다(`prevent_close` + `hide`). 정상 종료하면 LaunchAgent가 "사용자가 껐다"로 보고 재시작하지 않는다(`src-tauri/src/lib.rs:1051-1058`). 진짜 종료는 트레이 메뉴뿐.
- Windows 전용 설정은 `src-tauri/tauri.windows.conf.json`에 따로 있다(NSIS, `installerHooks`, 시작 시 창 숨김).

## 빌드·릴리즈에서 놓치기 쉬운 것

- 번들은 반드시 `npm run tauri build`. `beforeBundleCommand`가 `scripts/copy-hook.sh`를 돌려 hook 바이너리를 `src-tauri/binaries/`로 갱신하는데(`src-tauri/tauri.conf.json:10`), 이 단계를 건너뛰면 **옛날 hook이 패키징**된다.
- macOS 릴리즈는 ad-hoc이 아니라 임시 키체인의 자체서명 인증서로 서명한다. ad-hoc은 빌드마다 cdhash가 바뀌어 접근성 권한이 매번 초기화된다(`.github/workflows/release.yml`).
- 버전 문자열은 `package.json`과 `src-tauri/tauri.conf.json` **두 곳**에 있다.
