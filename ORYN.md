# Oryn Core

本仓库是 [Oryn](https://github.com/Lynricsy/Oryn) 的 agent 内核（Oryn Core），运行在 orb 内。它 fork 自 omp（oh-my-pi，MIT），是一个普通仓库（不是 GitHub fork），默认分支 `oryn`。

## 远端

| 远端 | 地址 | 含义 |
|---|---|---|
| `origin` | `https://github.com/Lynricsy/oryn-core.git` | 本仓库，Oryn 构建与发布的来源 |
| `nornzach` | `https://github.com/nornzach/oh-my-pi.git` | nornzach 的 fork，在上游基础上扩展了大量 RPC 命令（GUI 宿主能力），Oryn 依赖这些命令 |
| `upstream` | `https://github.com/can1357/oh-my-pi.git` | omp 官方上游 |

`oryn` 分支起点为 `nornzach/main` 的 `4b67dcb3174b412f2c236b7c993e3ad244520654`（omp 18.19.0）。

## 同步规程

同时合并两条线，都用 **merge**，不用 rebase：

```bash
scripts/oryn/sync.sh
```

脚本依次执行：`git fetch --all` → `git merge nornzach/main` → `git merge upstream/main` → `bun install` → `bun run gen:rpc` → 构建 linux-x64 → `--smoke-test` → `scripts/oryn/smoke-rpc.mjs`。任何一步失败即停止，解决后重新运行。

全部通过后推送 `oryn`，再打 tag `oryn-v<omp 版本>-<序号>`（例如 `oryn-v18.19.0-1`）触发 `.github/workflows/oryn-release.yml`，然后在 Oryn 仓库更新 `core/source.json` 并替换 `web/src/omp/rpc-types.d.ts`。

## 规则

- **只新增文件，不改动、不删除 nornzach 与上游的现有文件**（唯一例外：`README.md` 顶部的 Oryn Core 说明块，合并冲突时保留本块、其余取上游）。 这样每次合并都不会出现 modify/delete 冲突。Oryn 自己的东西全部放在 `ORYN.md`、`scripts/oryn/`、`.github/workflows/oryn-*.yml`。
- **Oryn 新命令只写在 `packages/coding-agent/src/modes/rpc/oryn-*.ts`。** `rpc-mode.ts` 里只加 import 与 `case`；同时把命令补进 `packages/coding-agent/src/modes/rpc/wire/commands.ts` 的 DSL，然后 `bun run gen:rpc`。这是上面「只新增文件」规则唯一允许的例外，改动保持在最少几行。
- **只用本仓库自带的 oxfmt / oxlint**（`bun run fmt:tools`、`bun run lint:tools`），不引入其它格式化器。
- **生成物冲突不手工解。** `rpc-wire.schema.json`、`rpc-wire.generated.ts`、`sdk/go/omp-rpc/wire.go` 以及 Python / Rust SDK 绑定出现冲突时，先解完源文件（`wire/*.ts` 等），再 `bun run gen:rpc` 重新生成并提交生成结果。
- `bun.lock` 中带有 nornzach 嵌套 GUI 布局（`packages/gui`）的条目，本仓库没有该目录，`bun install` 会改写锁文件；`sync.sh` 在安装后把锁文件还原为合并结果，**不要提交**由 `bun install` 产生的锁文件改动。

## 对现有文件的改动（例外清单）

以下改动无法只靠新增文件完成，合并冲突时以保留这些行为为准：

- **模型速度档位**（`oryn-v18.19.0-2`）：`get_state` 增加 `fastModeSupported`、`ultrafastSupported`、`ultrafastEnabled`，新增 `set_ultrafast_mode` 命令。涉及 `session/model-controls.ts`（`isFastModeSupported()` / `isUltrafastModeSupported()`）、`session/agent-session.ts`（转发）、`modes/rpc/rpc-mode.ts`、`rpc-types.ts`、`rpc-client.ts`、`wire/commands.ts`、`wire/state.ts`、`docs/rpc.md` 与对应测试；生成物由 `bun run gen:rpc` 重新生成。
- **Linux 文件锁后端可选**（`oryn-v18.19.0-3`）：设置 `PI_FILE_LOCK_BACKEND=sidecar` 后，Linux 上 pi-natives 的 `FileLock`（会话所有权租约、发布锁、`@oh-my-pi/utils` 的 `file-lock`、broker 租约、OAuth 回调租约）不再 bind abstract unix datagram socket，改为在锁路径上建持久旁路文件（缺失的父目录以 0700 创建）并持有其 OFD 写锁（`F_OFD_SETLK`），`isHeld` 用 `F_OFD_GETLK` 观测。用 OFD 锁而不是 macOS/BSD 的 `flock(2)`：两者都归属打开文件描述、持有进程退出即释放，但 Linux 上 `F_GETLK` 看不到 `flock` 的持有者，`isHeld` 无从实现。未设置（或取其它值）时行为与上游完全相同。原因：Oryn 的协调宿主沙箱用 seccomp 一律禁止 AF_UNIX（低版本 Landlock 挡不住宿主上 `/dev/log` 一类带路径的 datagram socket），默认的 abstract socket 锁在里面不可用。同一 agent 目录下的所有 omp 必须取同一后端，否则互不排斥。实现在新文件 `crates/pi-natives/src/file_lock/oryn_linux.rs`（含单测）；对上游文件只改了 `crates/pi-natives/src/file_lock/mod.rs` 的两处 cfg：声明 `mod oryn_linux`，Linux 的 `platform` 由 `linux` 改为 `oryn_linux`（它在默认后端下直接转调 `linux.rs`）。合并冲突时保留这两处。
- **natives 从源码构建**（`oryn-v18.19.0-3` 起）：因为上一条改了 Rust，`scripts/oryn/build-agent.ts` 不再下载 npm 上的 `@oh-my-pi/pi-natives-<平台>` 包，而是用上游的本地 cargo 路径（直接调 `packages/natives/scripts/build-bindings.ts`，profile `ci`，x64 固定 `PI_NATIVE_VARIANT=baseline`；不走 `bun run build`，因为上游 `bazel-natives.ts` 的 host 目标不认这个变量）在目标架构上构建；本机构建与 `sync.sh` 因此需要 `rust-toolchain.toml` 指定的工具链和 clang、cmake、ninja（同上游 Dockerfile 的 natives-builder）。
- **模型选择来源记录**（`oryn-v18.19.0-4`）：新命令 `oryn_select_model`（按 role 或 provider + modelId 切换模型）与 `oryn_mark_session_start`（记下全新会话的模型来源），在选择发生时追加 `custom` 条目 `oryn-model-source`（`data: {v:1, source:"role"|"manual"|"startup", model, role?, alias?}`）并 `ensureOnDisk()`；`model_change` 与 `setModel` 保持 omp 原样。实现与类型全部在新文件 `modes/rpc/oryn-model-source.ts`（单测 `test/oryn-model-source.test.ts`）；对现有文件只改了 `modes/rpc/rpc-mode.ts`（1 行 import + 2 个 `case`）、`rpc-types.ts`（1 行 import，`RpcCommand` / `RpcResponse` 联合各加一项）、`wire/commands.ts`（两条 DSL）、`docs/rpc.md`（「Oryn: model selection source」小节）；生成物由 `bun run gen:rpc` 重新生成；`scripts/oryn/smoke-rpc.mjs` 加一步接线检查。

## 脚本

| 文件 | 用途 |
|---|---|
| `scripts/oryn/build-agent.ts` | 构建单文件 omp：`bun scripts/oryn/build-agent.ts --target bun-linux-x64-baseline\|bun-linux-arm64 --out <path>` |
| `scripts/oryn/smoke-rpc.mjs` | RPC 冒烟：`node scripts/oryn/smoke-rpc.mjs <omp>`，末行 `VERDICT PASS\|FAIL` |
| `scripts/oryn/emit-rpc-dts.ts` | 产出自包含的 `dist/omp-rpc-types.d.ts`（`RpcCommand`、`RpcResponse`、全部帧），供 Oryn 前端使用 |
| `scripts/oryn/sync.sh` | 合并 nornzach 与上游并完整验证 |

## 发布

tag `oryn-v*` 触发 `oryn-release.yml`：`ubuntu-24.04` 构建 x64、`ubuntu-24.04-arm` 构建 arm64，各自跑 `omp --smoke-test` 与 `smoke-rpc.mjs`；产物 `omp-linux-x64`、`omp-linux-arm64`、`omp-rpc-types.d.ts`、`SHA256SUMS` 发布到同名 Release。
