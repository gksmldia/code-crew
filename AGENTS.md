# code-crew 작업 메모

## 프로젝트 개요
- code-crew는 Claude Code / Codex 세션을 데스크탑 위젯 카드로 보여주는 Tauri 앱이다.
- 세션 1개가 카드 1장으로 표시되고, 단일 에이전트와 서브에이전트 작업 상태, 도구 사용, 권한 요청을 UI에 반영한다.
- Claude Code는 설치된 hook 바이너리로 이벤트와 권한 요청을 전달하고, Codex는 `~/.codex/sessions` JSONL을 폴링해서 이벤트로 변환한다.
- 프로젝트별 대화 이력은 `~/.code-crew/projects/{hash}.json`에 저장하며, 최근 메시지를 복원한다.
- 배포 대상은 macOS와 Windows이며, Tauri updater와 GitHub Releases 기반 업데이트를 사용한다.

## 기술 스택
- Frontend: React 19, TypeScript, Vite, Zustand, Tailwind CSS, Framer Motion.
- Desktop/Backend: Tauri 2, Rust 2021, Tokio, Axum, Serde, Reqwest.
- 테스트: `npm test`는 Vitest, `cd src-tauri && cargo test`는 Rust 테스트.
- 패키징: `src-tauri/tauri.conf.json`, `scripts/copy-hook.sh`, Tauri bundle/updater 설정.

## 주요 구조
- `src/App.tsx`: Tauri 이벤트 구독, 프로젝트 이력 복원, 업데이트 확인, 카드 목록 렌더링.
- `src/store.ts`: 세션 상태, 메시지, 서브에이전트, 권한 요청, Codex/Claude 이벤트 반영의 중심.
- `src/components/`: 카드, 펫, 말풍선, 권한 UI 등 화면 컴포넌트.
- `src/lib/`: 메시지 변환, 펫 선택, 상태 계산 같은 순수 로직과 테스트.
- `src-tauri/src/lib.rs`: Tauri command, hook 설치, 앱 초기화와 창/서버 연결.
- `src-tauri/src/server.rs`: 로컬 Axum 서버. `127.0.0.1:0` 동적 포트에 바인딩하고 실제 포트를 `~/.code-crew/server.port`에 기록한다(hook이 이 파일을 읽어 접속). 라우트: `/health`, `/event`, `/permission`, `/permission-response/:id`.
- `src-tauri/src/codex_monitor.rs`: Codex JSONL 세션 폴링과 이벤트 매핑.
- `src-tauri/src/bin/hook.rs`: Claude Code가 실행하는 hook 바이너리.
- `src-tauri/src/hook_install.rs`: `~/.claude/settings.json` hook 등록과 기존 hook 정리.
- `src-tauri/src/storage.rs`, `src-tauri/src/project_key.rs`: 프로젝트 키 계산과 이력 저장.

## 작업 규칙
- 답변과 작업 요약은 한국어로 작성한다.
- 먼저 현재 파일과 설정을 읽고 판단한다. 과거 기억이나 추측만으로 결론내리지 않는다.
- 수정은 최소 범위로 하고, 코드가 덕지덕지 붙지 않게 기존 구조와 책임 경계를 따라 정리한다.
- 새 분기, 새 라이브러리, 큰 리팩터링은 사용자가 명시하지 않으면 만들지 않는다.
- 세션 관련 변경은 Claude hook 경로와 Codex JSONL 경로를 둘 다 확인한다.
- 플랫폼 관련 변경은 macOS와 Windows 차이를 둘 다 확인한다. 특히 hook 바이너리 위치, 경로 정규화, bundle 설정을 같이 본다.
- 권한 요청 변경은 UI 상태, `server.rs`, `hook.rs`, Claude 응답 형식, Codex permission cancel 흐름을 함께 확인한다.
- 이벤트 매핑 변경은 `events.rs`, `store.ts`, `codex_monitor.rs`, 관련 테스트를 함께 확인한다.
- 저장/복원 변경은 `storage.rs`, `project_key.rs`, `App.tsx`, 메시지 제한 정책을 함께 확인한다.
- 확인 결과를 중간중간 길게 보고하지 않는다. 필요한 진행 알림만 짧게 하고, 최종 답변에서 20줄 이내로 요약한다.
- 하지 않은 일을 반복해서 보고하지 않는다. 지금 하는 작업과 무관한 내용은 오류가 아닌 한 보고하지 않는다.

## 검증 기준
- TypeScript/UI 변경 후 기본 확인: `npm test` (단일 파일: `npx vitest run <파일>`, 이름 패턴: `npm test -- -t "패턴"`).
- Rust/Tauri 변경 후 기본 확인: `cd src-tauri && cargo test` (단일: `cargo test <name>`).
- 빌드나 패키징 설정 변경 후 확인: `npm run build` 및 필요한 경우 `npm run tauri build`. release 번들은 반드시 `npm run tauri build`로 만든다(bare `cargo build`면 webview가 빈 화면).
- hook 설치나 권한 요청 변경 후 가능하면 `/health`, `/event`, `/permission` 흐름을 실제로 확인한다.
- macOS 전용 변경은 `#[cfg(target_os = "macos")]`, Windows 전용 변경은 `#[cfg(target_os = "windows")]`와 `tauri.conf.json` bundle 설정까지 같이 확인한다.
- 검증하지 못한 항목은 최종 답변에 명확히 남긴다.
