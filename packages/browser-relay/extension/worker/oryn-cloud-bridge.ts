/**
 * Oryn 云端模式与 Popup 胶水层（M27）：
 * 复用模块化 worker（`relay.ts` / `relay-rpc.ts` / `tabs.ts`），把 OrynCloudClient 与 popup.* 消息
 * 接入 MV3 service worker，避免把云端逻辑散落到上游文件中。
 */
import type { ExtToRelayMessage } from "../../../coding-agent/src/tools/browser/relay/protocol";
import { loadCloudConfig, OrynCloudClient } from "../oryn-cloud";
import type { ApprovalDecision } from "../policy";
import { buildHello, connectRelay, disconnectRelay, relayStatus, setRelayEventInterceptor } from "./relay";
import { relayInitiatedDetachTabs } from "./relay-events";
import { runRelayRpc } from "./relay-rpc";
import { snapshot } from "./tabs";

async function setBadgeRaw(text: string, color: string): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text });
		await chrome.action.setBadgeBackgroundColor({ color });
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

const cloud = new OrynCloudClient({
	buildFullHello: () => buildHello() as Promise<Extract<ExtToRelayMessage, { t: "hello" }>>,
	executeRpc: rpc => runRelayRpc(rpc, { open: true }),
	detachAndUngroup: async tabId => {
		relayInitiatedDetachTabs.add(tabId);
		await chrome.debugger.detach({ tabId }).catch(() => {
			relayInitiatedDetachTabs.delete(tabId);
		});
		await chrome.tabs.ungroup([tabId]).catch(() => {});
	},
	snapshotTab: async tabId => {
		try {
			const tab = await chrome.tabs.get(tabId);
			return snapshot(tab);
		} catch {
			return null;
		}
	},
	setBadge: setBadgeRaw,
});

/** 根据本地存储的模式启动 Oryn 云端模式或本地 native-host relay。 */
export async function syncRelayMode(): Promise<void> {
	const cfg = await loadCloudConfig();
	if (cfg.mode === "oryn") {
		disconnectRelay();
		await cloud.start();
		return;
	}
	await cloud.stop();
	connectRelay();
}

/** 拦截发往本地 relay 的事件帧：Oryn 云端模式激活时分流给云端客户端。 */
function interceptRelayEvent(message: ExtToRelayMessage): boolean {
	if (!cloud.active) return false;
	switch (message.t) {
		case "cdpEvent":
		case "detached":
		case "framesHidden":
			cloud.onDebuggerEvent(message);
			return true;
		case "tabCreated":
		case "tabUpdated":
		case "tabRemoved":
			cloud.onTabEvent(message);
			return true;
		default:
			return false;
	}
}

/** 注册 Oryn 云端事件分流、Popup 消息处理与模式切换监听。 */
export function installOrynCloudBridge(): void {
	setRelayEventInterceptor(interceptRelayEvent);
	// 工具栏图标点击打开 popup.html（可切本地/Oryn 云端模式及审批），Cmd/Ctrl+E 仍可开关侧边栏。
	chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

	chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
		if (!raw || typeof raw !== "object" || !("t" in raw) || typeof raw.t !== "string") return;
		if (!raw.t.startsWith("popup.")) return;
		const msg = raw as Record<string, unknown>;
		const handle = async (): Promise<unknown> => {
			switch (msg.t) {
				case "popup.getState": {
					await cloud.syncConfig();
					const isShareableUrl = (u: string): boolean => /^https?:\/\//i.test(u);
					const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
					let candidate: (typeof activeTab) | undefined = activeTab;
					if (
						!candidate ||
						candidate.id === undefined ||
						!isShareableUrl(candidate.url ?? candidate.pendingUrl ?? "")
					) {
						const allTabs = await chrome.tabs.query({});
						candidate =
							allTabs.find(t => t.active && t.id !== undefined && isShareableUrl(t.url ?? t.pendingUrl ?? "")) ??
							allTabs.find(t => t.id !== undefined && isShareableUrl(t.url ?? t.pendingUrl ?? ""));
					}
					const currentTab =
						candidate && candidate.id !== undefined
							? { tabId: candidate.id, title: candidate.title ?? "", url: candidate.url ?? candidate.pendingUrl ?? "" }
							: null;
					return {
						cloud: cloud.getPopupSnapshot(),
						localConnected: relayStatus().connected,
						currentTab,
					};
				}
				case "popup.setMode": {
					const nextMode = msg.mode === "oryn" ? "oryn" : "local";
					await chrome.storage.local.set({ mode: nextMode });
					await syncRelayMode();
					return { ok: true };
				}
				case "popup.startPairing":
					try {
						const pairing = await cloud.startPairing(String(msg.serverUrl ?? ""), String(msg.deviceName ?? ""));
						return { ok: true, pairing };
					} catch (err) {
						return { ok: false, error: err instanceof Error ? err.message : String(err) };
					}
				case "popup.pollPairing":
					return await cloud.pollPairingOnce();
				case "popup.unpair":
					await cloud.unpair();
					return { ok: true };
				case "popup.bindThread":
					await cloud.bindThread(String(msg.threadId ?? ""));
					return { ok: true };
				case "popup.unbindThread":
					await cloud.unbindThread(String(msg.threadId ?? ""));
					return { ok: true };
				case "popup.shareTab":
					await cloud.shareTab(String(msg.threadId ?? ""), Number(msg.tabId));
					return { ok: true };
				case "popup.unshareTab":
					await cloud.unshareTab(String(msg.threadId ?? ""), Number(msg.tabId));
					return { ok: true };
				case "popup.resolveApproval":
					await cloud.resolveApproval(
						String(msg.threadId ?? ""),
						String(msg.approvalId ?? ""),
						msg.decision as ApprovalDecision,
					);
					return { ok: true };
				case "popup.emergencyDisconnect":
					await cloud.emergencyDisconnectAll();
					return { ok: true };
				case "popup.refreshThreads":
					cloud.requestThreadsRefresh();
					return { ok: true };
				default:
					return { ok: false, error: "unknown message" };
			}
		};
		void handle().then(sendResponse);
		return true;
	});

	chrome.storage.onChanged.addListener((_changes, areaName) => {
		if (areaName !== "local") return;
		void syncRelayMode();
	});
	chrome.runtime.onInstalled.addListener(() => void syncRelayMode());
	chrome.runtime.onStartup.addListener(() => void syncRelayMode());
}
