/// <reference lib="dom" />
/**
 * Oryn / OMP Browser Relay 扩展弹窗界面（M27）。
 *
 * 与 background service worker 通过 chrome.runtime.sendMessage 通信：
 * - 本地模式：展示状态并提供跳转设置（切到 Oryn 云端模式或改端口）；
 * - Oryn 云端模式：支持输入服务器地址配对、选择绑定线程、一键共享/取消共享当前标签页、
 *   置顶处理待审批请求（允许这次 / 本会话允许 / 拒绝）、一键熔断断开全部共享。
 */
import type { CloudPopupSnapshot } from "./oryn-cloud";
import type { ApprovalDecision } from "./policy";

interface PopupStateResponse {
	cloud: CloudPopupSnapshot;
	localConnected: boolean;
	currentTab: { tabId: number; title: string; url: string } | null;
}

const root = document.getElementById("app") as HTMLElement;
let selectedThreadId = "";
let pollTimer: NodeJS.Timeout | null = null;

async function callBg<T = unknown>(msg: Record<string, unknown>): Promise<T> {
	return await chrome.runtime.sendMessage<T>(msg);
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	if (text !== undefined) node.textContent = text;
	return node;
}

async function render(): Promise<void> {
	const state = await callBg<PopupStateResponse>({ t: "popup.getState" });
	root.innerHTML = "";
	const { cloud, localConnected, currentTab } = state;

	// 顶部栏
	const header = el("div", { class: "header row" });
	const left = el("div");
	const dotClass =
		cloud.mode === "oryn"
			? cloud.pendingApprovals.length > 0
				? "dot warn"
				: cloud.connected
					? "dot ok"
					: "dot"
			: localConnected
				? "dot ok"
				: "dot";
	left.append(el("span", { class: dotClass }));
	left.append(el("span", { class: "title" }, cloud.mode === "oryn" ? "Oryn 浏览器中继" : "OMP 本地浏览器中继"));
	const right = el("div", { class: "row" });
	const optBtn = el("button", {}, "设置");
	optBtn.onclick = () => void chrome.runtime.openOptionsPage();
	right.append(optBtn);
	if (cloud.mode === "oryn" && cloud.paired) {
		const killBtn = el("button", { class: "danger" }, "立即断开");
		killBtn.onclick = async () => {
			await callBg({ t: "popup.emergencyDisconnect" });
			await render();
		};
		right.append(killBtn);
	}
	header.append(left, right);
	root.append(header);

	if (cloud.mode === "local") {
		const card = el("div", { class: "card" });
		card.append(
			el("div", {}, localConnected ? "已连接本地 omp browser-relay" : "等待本地 omp browser-relay 连接"),
			el("p", { class: "muted" }, "如需让远端 Oryn orb 操作本机 Chrome，请点击下方按钮切换到「Oryn 云端模式」。"),
		);
		const switchBtn = el("button", { class: "primary full" }, "切换到 Oryn 云端模式");
		switchBtn.onclick = async () => {
			await chrome.storage.local.set({ mode: "oryn" });
			await render();
		};
		card.append(switchBtn);
		root.append(card);
		return;
	}

	// Oryn 云端模式：未配对视图
	if (!cloud.paired) {
		const card = el("div", { class: "card" });
		card.append(el("div", { class: "title" }, "配对 Oryn 服务器"));
		if (cloud.lastError) {
			card.append(el("p", { class: "muted" }, cloud.lastError));
		}
		if (cloud.pairing) {
			card.append(
				el("div", { class: "muted" }, `服务器：${cloud.pairing.serverUrl}`),
				el("div", { class: "code" }, cloud.pairing.code),
				el("p", { class: "muted" }, "请在打开的 Oryn 批准页输入上方配对码并批准，批准后扩展会自动连接。"),
			);
			const actions = el("div", { class: "actions" });
			const openBtn = el("button", { class: "primary" }, "打开批准页");
			openBtn.onclick = () => void chrome.tabs.create({ url: cloud.pairing!.verifyUrl, active: true });
			const checkBtn = el("button", {}, "检查状态");
			checkBtn.onclick = async () => {
				await callBg({ t: "popup.pollPairing" });
				await render();
			};
			actions.append(openBtn, checkBtn);
			card.append(actions);
			if (!pollTimer) {
				pollTimer = setInterval(async () => {
					const res = await callBg<{ approved?: boolean; expired?: boolean }>({ t: "popup.pollPairing" });
					if (res.approved || res.expired) {
						clearInterval(pollTimer ?? undefined);
						pollTimer = null;
						await render();
					}
				}, 2000);
			}
		} else {
			const input = el("input", {
				type: "url",
				placeholder: "https://oryn.example.com",
				value: cloud.serverUrl,
			}) as HTMLInputElement;
			const nameInput = el("input", {
				type: "text",
				placeholder: "设备名称（如 Chrome Mac）",
				value: cloud.deviceName || "Chrome",
			}) as HTMLInputElement;
			const startBtn = el("button", { class: "primary full" }, "开始配对");
			const errEl = el("div", { class: "muted" });
			startBtn.onclick = async () => {
				startBtn.disabled = true;
				errEl.textContent = "";
				try {
					const res = await callBg<{ ok: boolean; error?: string }>({
						t: "popup.startPairing",
						serverUrl: input.value,
						deviceName: nameInput.value,
					});
					if (!res.ok) throw new Error(res.error || "配对启动失败");
					await render();
				} catch (err) {
					errEl.textContent = err instanceof Error ? err.message : String(err);
					startBtn.disabled = false;
				}
			};
			card.append(
				el("label", {}, "服务器地址"),
				input,
				el("label", {}, "浏览器名称"),
				nameInput,
				startBtn,
				errEl,
			);
		}
		root.append(card);
		return;
	}

	clearInterval(pollTimer ?? undefined);
	pollTimer = null;

	// 已配对状态摘要
	const info = el("div", { class: "muted" }, `${cloud.deviceName} · ${cloud.serverUrl}`);
	info.style.marginBottom = "8px";
	root.append(info);
	if (cloud.lastError) {
		const errCard = el("div", { class: "card warn" }, cloud.lastError);
		root.append(errCard);
	}

	// 1. 置顶待审批授权卡片（Rev 1：非阻塞，点击只写入放行票据并通知线程重试）
	for (const apr of cloud.pendingApprovals) {
		const card = el("div", { class: "card warn" });
		card.append(
			el("div", { class: "title" }, "待你确认授权"),
			el("div", {}, apr.summary),
			el("div", { class: "muted" }, `线程：${apr.threadId}`),
		);
		const actions = el("div", { class: "actions" });
		const addDecision = (label: string, decision: ApprovalDecision, cls = "") => {
			const b = el("button", cls ? { class: cls } : {}, label);
			b.onclick = async () => {
				await callBg({ t: "popup.resolveApproval", threadId: apr.threadId, approvalId: apr.id, decision });
				await render();
			};
			actions.append(b);
		};
		addDecision("允许这次", "approved_once", "primary");
		addDecision("本会话总是允许", "approved_session");
		addDecision("拒绝", "denied", "danger");
		card.append(actions);
		root.append(card);
	}

	// 2. 目标线程绑定选择器
	if (!selectedThreadId) {
		selectedThreadId = cloud.activeThreadIds[0] ?? cloud.threads[0]?.threadId ?? "";
	}
	const threadCard = el("div", { class: "card" });
	threadCard.append(el("div", { class: "title" }, "绑定工作线程"));
	const sel = el("select") as HTMLSelectElement;
	if (cloud.threads.length === 0) {
		sel.append(el("option", { value: "" }, "暂无活跃工作线程"));
	} else {
		for (const th of cloud.threads) {
			const boundMark = cloud.activeThreadIds.includes(th.threadId) ? " [已绑定]" : "";
			const opt = el(
				"option",
				{ value: th.threadId },
				`${th.projectName ? `[${th.projectName}] ` : ""}${th.title}${boundMark}`,
			);
			if (th.threadId === selectedThreadId) opt.selected = true;
			sel.append(opt);
		}
	}
	sel.onchange = () => {
		selectedThreadId = sel.value;
		void render();
	};
	threadCard.append(sel);

	const isBound = Boolean(selectedThreadId && cloud.activeThreadIds.includes(selectedThreadId));
	const bindRow = el("div", { class: "actions" });
	if (selectedThreadId) {
		if (isBound) {
			const unbindBtn = el("button", { class: "danger" }, "解除该线程绑定");
			unbindBtn.onclick = async () => {
				await callBg({ t: "popup.unbindThread", threadId: selectedThreadId });
				await render();
			};
			bindRow.append(unbindBtn);
		} else {
			const bindBtn = el("button", { class: "primary" }, "绑定到此线程");
			bindBtn.onclick = async () => {
				await callBg({ t: "popup.bindThread", threadId: selectedThreadId });
				await render();
			};
			bindRow.append(bindBtn);
		}
	}
	const refreshBtn = el("button", {}, "刷新线程");
	refreshBtn.onclick = async () => {
		await callBg({ t: "popup.refreshThreads" });
		setTimeout(() => void render(), 300);
	};
	bindRow.append(refreshBtn);
	threadCard.append(bindRow);
	root.append(threadCard);

	// 3. 当前标签页一键共享与已共享列表
	if (isBound && selectedThreadId) {
		const sum = cloud.sessions[selectedThreadId];
		const sharedTabs = sum?.sharedTabs ?? [];
		const curShared = currentTab ? sharedTabs.some(t => t.tabId === currentTab.tabId) : false;

		const shareCard = el("div", { class: "card" });
		shareCard.append(el("div", { class: "title" }, "共享标签页（未共享的现有标签对云端不可见）"));
		if (currentTab) {
			const btn = el(
				"button",
				{ class: curShared ? "danger full" : "primary full" },
				curShared ? `取消共享当前标签页：${currentTab.title}` : `共享当前标签页：${currentTab.title}`,
			);
			btn.style.marginTop = "6px";
			btn.onclick = async () => {
				await callBg({
					t: curShared ? "popup.unshareTab" : "popup.shareTab",
					threadId: selectedThreadId,
					tabId: currentTab.tabId,
				});
				await render();
			};
			shareCard.append(btn);
		}
		if (sharedTabs.length === 0) {
			shareCard.append(el("p", { class: "muted" }, "尚未共享任何现有标签页；agent 请求新建标签页时会先弹窗征求你的确认。"));
		} else {
			for (const t of sharedTabs) {
				const row = el("div", { class: "tab-item" });
				row.append(
					el("span", { class: "tab-title", title: t.url }, `${t.source === "created" ? "[新建] " : ""}${t.title || t.url}`),
				);
				const stopBtn = el("button", {}, "停止");
				stopBtn.onclick = async () => {
					await callBg({ t: "popup.unshareTab", threadId: selectedThreadId, tabId: t.tabId });
					await render();
				};
				row.append(stopBtn);
				shareCard.append(row);
			}
		}
		root.append(shareCard);
	}
}

void render();
