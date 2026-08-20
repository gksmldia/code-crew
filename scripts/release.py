#!/usr/bin/env python3
"""code-crew 릴리즈 자동화 스크립트.

사용법: python scripts/release.py [커밋메시지] [--dry-run]
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path


USAGE = "사용법: python scripts/release.py [커밋메시지] [--dry-run]"


def print_usage() -> None:
    print(USAGE)


def parse_args(argv: list[str]) -> tuple[str | None, bool]:
    commit_message = None
    dry_run = False

    for arg in argv:
        if arg == "--dry-run":
            dry_run = True
        elif arg in ("-h", "--help"):
            print_usage()
            sys.exit(0)
        elif commit_message is None:
            commit_message = arg
        else:
            print("위치 인자는 하나만 사용할 수 있습니다.")
            print_usage()
            sys.exit(1)

    return commit_message, dry_run


def command_text(args: list[str]) -> str:
    return shlex.join(args)


def run_command(root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    print(f"$ {command_text(args)}")
    try:
        return subprocess.run(
            args,
            cwd=root,
            text=True,
            capture_output=True,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        print(f"명령 실행에 실패했습니다: {command_text(args)}")
        if exc.stdout:
            print("stdout:")
            print(exc.stdout.rstrip())
        if exc.stderr:
            print("stderr:")
            print(exc.stderr.rstrip())
        sys.exit(1)


def print_dry_command(args: list[str]) -> None:
    print(f"[dry-run] 실행 예정: {command_text(args)}")


def preflight(root: Path) -> None:
    result = run_command(root, ["git", "rev-parse", "--is-inside-work-tree"])
    if result.stdout.strip() != "true":
        print("git 저장소 내부가 아닙니다.")
        sys.exit(1)

    branch = run_command(root, ["git", "branch", "--show-current"]).stdout.strip()
    if branch != "main":
        print(f"현재 브랜치가 main이 아닙니다: {branch}")
        sys.exit(1)

    run_command(root, ["gh", "--version"])


def read_current_version(root: Path) -> str:
    package_path = root / "package.json"
    with package_path.open(encoding="utf-8") as file:
        data = json.load(file)

    version = data.get("version")
    if not isinstance(version, str):
        print("package.json의 version 값을 찾을 수 없습니다.")
        sys.exit(1)

    return version


def next_patch_version(current: str) -> str:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", current)
    if not match:
        print(f"지원하지 않는 버전 형식입니다: {current}")
        sys.exit(1)

    major, minor, patch = match.groups()
    return f"{major}.{minor}.{int(patch) + 1}"


def ensure_tag_absent(root: Path, new_tag: str) -> None:
    result = run_command(root, ["git", "tag", "--list"])
    tags = {line.strip() for line in result.stdout.splitlines()}
    if new_tag in tags:
        print(f"이미 존재하는 태그입니다: {new_tag}")
        sys.exit(1)


def replace_once(
    root: Path,
    relative_path: str,
    pattern: str,
    replacement: str,
    expected_exact: bool,
    dry_run: bool,
) -> None:
    path = root / relative_path
    original = path.read_bytes().decode("utf-8")
    updated, count = re.subn(pattern, replacement, original, count=1, flags=re.MULTILINE)

    valid = count == 1 if expected_exact else count >= 1
    if not valid:
        expected = "1" if expected_exact else "1 이상"
        print(f"{relative_path} 치환 개수가 기대와 다릅니다: 기대 {expected}, 실제 {count}")
        sys.exit(1)

    if dry_run:
        print(f"[dry-run] 수정 예정: {relative_path}")
        return

    path.write_bytes(updated.encode("utf-8"))
    print(f"수정 완료: {relative_path}")


def update_versions(root: Path, current: str, next_version: str, dry_run: bool) -> None:
    escaped_current = re.escape(current)
    print(f"현재 버전: {current}")
    print(f"다음 버전: {next_version}")
    print("수정 예정 파일:")
    print("- package.json")
    print("- src-tauri/tauri.conf.json")
    print("- src-tauri/Cargo.toml")
    print("- src-tauri/Cargo.lock")

    replace_once(
        root,
        "package.json",
        rf'("version":\s*"){escaped_current}(")',
        rf"\g<1>{next_version}\2",
        True,
        dry_run,
    )
    replace_once(
        root,
        "src-tauri/tauri.conf.json",
        rf'("version":\s*"){escaped_current}(")',
        rf"\g<1>{next_version}\2",
        True,
        dry_run,
    )
    replace_once(
        root,
        "src-tauri/Cargo.toml",
        rf'^version = "{escaped_current}"$',
        f'version = "{next_version}"',
        False,
        dry_run,
    )
    replace_once(
        root,
        "src-tauri/Cargo.lock",
        rf'(name = "code-crew"\nversion = "){escaped_current}(")',
        rf"\g<1>{next_version}\2",
        True,
        dry_run,
    )


def commit_and_tag(root: Path, commit_message: str, new_tag: str, dry_run: bool) -> None:
    commit_args = ["git", "commit", "-am", commit_message]
    tag_args = ["git", "tag", new_tag]

    if dry_run:
        print_dry_command(commit_args)
        print_dry_command(tag_args)
        return

    run_command(root, commit_args)
    run_command(root, tag_args)


def remote_target_user(root: Path) -> str:
    remote_url = run_command(root, ["git", "remote", "get-url", "origin"]).stdout.strip()
    match = re.search(r"https://([^@/]+)@", remote_url)
    if not match:
        print("origin URL에서 GitHub 사용자명을 찾을 수 없습니다.")
        sys.exit(1)
    return match.group(1)


def push_release(root: Path, new_tag: str, dry_run: bool) -> None:
    target_user = remote_target_user(root)
    push_args = [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "origin",
        "main",
        new_tag,
    ]

    if dry_run:
        print_dry_command(["gh", "api", "user", "--jq", ".login"])
        print(f"[dry-run] 푸시 대상 GitHub 계정: {target_user}")
        print_dry_command(["gh", "auth", "switch", "--user", target_user])
        print_dry_command(push_args)
        print_dry_command(["gh", "auth", "switch", "--user", "<orig_user>"])
        return

    orig_user = run_command(root, ["gh", "api", "user", "--jq", ".login"]).stdout.strip()
    run_command(root, ["gh", "auth", "switch", "--user", target_user])

    push_failed = False
    try:
        run_command(root, push_args)
    except SystemExit:
        push_failed = True
        print("커밋과 태그는 로컬에 생성되었습니다. push만 재시도할 수 있습니다.")
        raise
    finally:
        try:
            run_command(root, ["gh", "auth", "switch", "--user", orig_user])
        except SystemExit:
            if push_failed:
                print("push 실패 후 gh 계정 원복도 실패했습니다. 현재 gh 인증 계정을 확인하세요.")
            else:
                raise


def wait_for_release_run(root: Path, new_tag: str, dry_run: bool) -> None:
    list_args = [
        "gh",
        "run",
        "list",
        "--workflow",
        "release.yml",
        "--event",
        "push",
        "--limit",
        "20",
        "--json",
        "databaseId,headBranch,status,conclusion,createdAt",
    ]

    if dry_run:
        print_dry_command(list_args)
        print_dry_command(["gh", "run", "watch", "<run_id>", "--exit-status", "--interval", "15"])
        return

    run_id = None
    for attempt in range(1, 25):
        result = run_command(root, list_args)
        try:
            runs = json.loads(result.stdout)
        except json.JSONDecodeError:
            print("gh run list 응답을 JSON으로 해석할 수 없습니다.")
            print(result.stdout.rstrip())
            sys.exit(1)

        for run in runs:
            if run.get("headBranch") == new_tag:
                run_id = run.get("databaseId")
                break

        if run_id:
            break

        print(f"release.yml 실행 대기 중: {new_tag} ({attempt}/24)")
        time.sleep(5)

    if run_id is None:
        print(f"release.yml 실행을 찾지 못했습니다: {new_tag}")
        sys.exit(1)

    print(f"release.yml 실행 감지: {run_id}")
    run_command(root, ["gh", "run", "watch", str(run_id), "--exit-status", "--interval", "15"])


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    commit_message, dry_run = parse_args(sys.argv[1:])

    preflight(root)

    current = read_current_version(root)
    next_version = next_patch_version(current)
    new_tag = f"v{next_version}"
    if commit_message is None:
        commit_message = new_tag

    ensure_tag_absent(root, new_tag)
    update_versions(root, current, next_version, dry_run)
    commit_and_tag(root, commit_message, new_tag, dry_run)
    push_release(root, new_tag, dry_run)
    wait_for_release_run(root, new_tag, dry_run)

    if dry_run:
        print(f"[dry-run] {new_tag} 릴리즈 절차를 여기까지 시뮬레이션했습니다.")
    else:
        print(f"{new_tag} push 완료")
        print("release.yml CI 완료")
        print("배포된 업데이트는 앱 타이틀바 update 버튼으로 적용됩니다.")


if __name__ == "__main__":
    main()
