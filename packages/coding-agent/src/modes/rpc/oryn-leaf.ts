/**
 * Oryn：持久化 RPC 叶子切换（`switch_leaf` / `navigate_tree`）。
 *
 * omp 的不带摘要叶子移动只改内存 `#index.leafId`，不往会话 JSONL 写任何行；agent 进程重启或
 * `/resume` 重新加载文件时，加载器按文件最后一条条目重放叶子，导致会话跳回被放弃的分支，
 * 控制面与 Core 失步。这里在 RPC 移动叶子后写入一条离分支 `custom` 标记（`customType: "oryn-leaf"`，
 * `activeLeafId` 为当前叶子或 `null`）并立刻 `flush()`，让磁盘会话文件本身记录当前分支。
 */
import type { AgentSession } from "../../session/agent-session";

export const ORYN_LEAF_CUSTOM_TYPE = "oryn-leaf";

export function persistRpcLeaf(session: Pick<AgentSession, "sessionManager">): Promise<void> | undefined {
	if (!session.sessionManager.persistLeaf()) return undefined;
	return session.sessionManager.flush();
}
