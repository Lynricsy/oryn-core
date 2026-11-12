#!/usr/bin/env bash
# 同步 nornzach 与上游，并完整验证（规程见 ORYN.md）。
#
# 用法：scripts/oryn/sync.sh
# 任何一步失败即退出；合并冲突时脚本停在冲突处，解决并提交后重新运行。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

step() { printf '\n==> %s\n' "$*"; }

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
	echo "工作区有未提交的改动，先提交或暂存后再同步" >&2
	exit 1
fi

step "git fetch --all"
git fetch --all --prune

step "git merge nornzach/main"
git merge --no-edit nornzach/main

step "git merge upstream/main"
git merge --no-edit upstream/main

step "bun install"
bun install
# nornzach 的锁文件含嵌套 GUI（packages/gui）条目，本仓库没有该目录；安装会改写锁文件，这里还原为合并结果。
git checkout -- bun.lock

step "bun run gen:rpc"
bun run gen:rpc
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
	echo "gen:rpc 改动了生成物，检查后提交（生成物冲突不手工解，见 ORYN.md）：" >&2
	git status --short --untracked-files=no >&2
fi

step "构建 linux-x64"
bun scripts/oryn/build-agent.ts --target bun-linux-x64-baseline --out dist/omp-linux-x64
./dist/omp-linux-x64 --version

step "omp --smoke-test"
./dist/omp-linux-x64 --smoke-test

step "smoke-rpc.mjs"
node scripts/oryn/smoke-rpc.mjs ./dist/omp-linux-x64

step "完成：推送 oryn 后打 tag oryn-v<版本>-<序号> 发布"
