# code-crew

Claude Code / Codex 세션을 옆으로 나열하는 SVG 펫 데스크탑 위젯.

세션 1개 = 펫 카드 1장. 단일 에이전트는 큰 펫 + 말풍선, 서브에이전트가 도는 동안엔 그 카드가 펫들의 채팅창. 같은 프로젝트(git remote 우선) 새 세션은 이전 대화를 자동 복원.

## 설치

### macOS
```
brew install --cask code-crew
```
(또는 Releases에서 `.dmg` 다운로드)

### Windows
Releases에서 `.msi` 다운로드 후 실행.

## 첫 실행

1. 앱을 실행하면 위젯이 화면 좌하단에 뜸
2. 위젯 우클릭 → "Install Claude Code hooks" → `~/.claude/settings.json` 자동 등록
3. 새 Claude Code 세션을 열면 카드가 자동으로 등장

## 개발

```bash
cd code-crew
npm install
npm run tauri dev
```

테스트:
```bash
# Rust
cd src-tauri && cargo test

# TS
npm test
```

수동 테스트 (서버에 이벤트 직접 주입):
```bash
curl -X POST http://127.0.0.1:19876/event \
  -H "content-type: application/json" \
  -d '{"hook_event_name":"SessionStart","session_id":"demo","cwd":"/tmp/x"}'
```

## 데이터 저장

`~/.code-crew/projects/{hash}.json` — 프로젝트별 메시지 200개 × 30일 보관.

## 라이센스

MIT
