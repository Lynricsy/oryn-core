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
- **工具变更被拒时降级**（`oryn-v18.19.0-5`）：compat 打开 `supportsMidConversationToolChanges` 的 Anthropic 模型在活动工具集变化时发 `tool_addition` / `tool_removal`；部分网关改写了 `tools[]` 的工具名却不改写这些块，请求 400（`references unknown tool`）且重试只会重放同一请求体。现在：在任何输出之前到达、且报错提到 `tool_addition` / `tool_removal` / `tool_reference_unresolved` 的 400，同一回合以关掉工具变更的 compat（普通顶层 `tools`、无控制块、不带 `mid-conversation-tool-changes` beta）重放一次；重放正常结束才对该端点（provider + baseUrl + 模型 id）在本进程内闩锁，之后直接不用工具变更；无关的 400 或重放仍失败则原样上抛、不闩锁。不新增配置键、不改 RPC。实现全部在新文件 `packages/ai/src/providers/oryn-tool-change-fallback.ts`（单测 `packages/ai/test/oryn-tool-change-fallback.test.ts`）；对现有文件只改了 `packages/ai/src/providers/anthropic.ts`（1 行 import + `streamAnthropic` 里把 `withToolChangeFallback(streamAnthropicOnce)` 作为 `withReplaySafeStreamRetry` 的 attempt 参数）。合并冲突时保留这层包裹。手工开关：provider 级 `compat: { supportsMidConversationToolChanges: false }` 仍可整个关掉工具变更。
- **RPC 命令与 TUI 对齐**（`oryn-v18.19.0-6`）：① loop 开启后，空闲时的 `prompt`（内置命令处理之后；扩展命令与仅 TUI 内置命令除外）成为循环 prompt，skill 命令不论是否流式都记录，`steer` / `follow_up` 不改（同 TUI `setLoopPrompt`）；② `set_plan_mode{enabled:true}` 在 goal 活动 / 暂停或 vibe 开启时拒绝（`Exit goal mode first.` / `Exit vibe mode first.`）；③ 新命令 `oryn_cancel_job{jobId}` → `{cancelled}`（同 `/jobs kill <id>`，只取消本会话拥有的运行中任务），`get_jobs` 的树行在可取消时带 `cancellable: true`；④ `RpcAvailableSlashCommand` 声明已在发送的 `textModeExecutable`；⑤ `get_active_tools` 的 xd:// 挂载项带 `mounted: true`；⑥ `omfg` 把面板状态发成 `setStatus`（key `omfg`）、候选规则与校验状态发成 `setWidget`（key `omfg`），确认框 `message` 附规则全文，结束时清掉。逻辑在新文件 `modes/rpc/oryn-ui-parity.ts`（测试 `test/oryn-ui-parity.test.ts`，夹具 `test/fixtures/oryn-ui-parity-rpc-agent.ts`）；对现有文件改了 `modes/rpc/rpc-mode.ts`（1 行 import、`prompt` 派发里 2 处 `loopModeController.onHostPrompt`、`set_plan_mode` 2 行检查、`oryn_cancel_job` 的 `case`）、`rpc-types.ts`（1 行 import、命令 / 应答联合各一项、`textModeExecutable` / `mounted` / `cancellable` 三个可选字段）、`rpc-reports.ts`（`mounted` 与 `cancellable` 的赋值）、`rpc-omfg.ts`（面板镜像，整文件以本仓库为准）、`wire/commands.ts`（一条 DSL）、`test/rpc-reports.test.ts`（两处期望补新字段）、`docs/rpc.md`（「Oryn: UI-command parity」小节）；生成物由 `bun run gen:rpc` 重新生成；`scripts/oryn/smoke-rpc.mjs` 加一步接线检查。
- **loop 每轮重走 skill 派发**（`oryn-v18.19.0-6` 之后的修复）：同 TUI `submitInteractiveInput`，循环 prompt 是 skill 命令时每一轮（含 `set_loop_mode{args}` 的内联 prompt、`loop.mode=reset` 的新会话）都走 `tryRunRpcSkillCommand` 发 `skill-prompt`，不再把字面 `/skill:…` 当普通文本发给模型。改了 `modes/rpc/rpc-modes.ts`（`RpcLoopModeControllerDeps` 加可选 `submit`，`#dispatchTurn` 优先用它，缺省仍是 `session.prompt`）与 `modes/rpc/rpc-mode.ts`（构造 `RpcLoopModeController` 时注入 `submit`），`docs/rpc.md` 的 Loop mode 一条补一句；测试在 `test/oryn-ui-parity.test.ts`（夹具加 `ORYN_LOOP_MODE`、`ORYN_RPC_HOLD_FIRST_TURN` 与 `/oryntest-release`）。

## 脚本

| 文件 | 用途 |
|---|---|
| `scripts/oryn/build-agent.ts` | 构建单文件 omp：`bun scripts/oryn/build-agent.ts --target bun-linux-x64-baseline\|bun-linux-arm64 --out <path>` |
| `scripts/oryn/smoke-rpc.mjs` | RPC 冒烟：`node scripts/oryn/smoke-rpc.mjs <omp>`，末行 `VERDICT PASS\|FAIL` |
| `scripts/oryn/emit-rpc-dts.ts` | 产出自包含的 `dist/omp-rpc-types.d.ts`（`RpcCommand`、`RpcResponse`、全部帧），供 Oryn 前端使用 |
| `scripts/oryn/sync.sh` | 合并 nornzach 与上游并完整验证 |

## 发布

tag `oryn-v*` 触发 `oryn-release.yml`：`ubuntu-24.04` 构建 x64、`ubuntu-24.04-arm` 构建 arm64，各自跑 `omp --smoke-test` 与 `smoke-rpc.mjs`；产物 `omp-linux-x64`、`omp-linux-arm64`、`omp-rpc-types.d.ts`、`SHA256SUMS` 发布到同名 Release。
