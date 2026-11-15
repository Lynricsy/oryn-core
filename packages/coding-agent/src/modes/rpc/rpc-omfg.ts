import type { OmfgPanelComponent, OmfgPanelResult } from "@oh-my-pi/pi-tui/overlays/omfg-panel";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import { OmfgController } from "../controllers/omfg-controller";
import type { InteractiveModeContext } from "../types";

export interface RpcOmfgResult {
	state: "saved" | "rejected" | "aborted";
	savedPath?: string;
}

/** Status/widget key the /omfg progress line and candidate-rule preview ride on. */
export const RPC_OMFG_UI_KEY = "omfg";

const VALIDATION_LABEL = {
	pending: "validating against this conversation…",
	matched: "matches this conversation",
	unconfirmed: "could not confirm a match in this conversation",
} as const;

/**
 * Oryn: mirror the TUI /omfg panel over RPC. Every panel status becomes a `setStatus`
 * line, the candidate rule rides a `setWidget` preview headed by its validation state,
 * and confirm dialogs carry the rule text, so the host never picks a save location blind.
 */
function createRpcOmfgPanelMirror(ui: ExtensionUIContext) {
	let rule = "";
	let validation: keyof typeof VALIDATION_LABEL = "pending";
	const publishRule = () =>
		ui.setWidget(
			RPC_OMFG_UI_KEY,
			rule ? [`TTSR rule — ${VALIDATION_LABEL[validation]}`, "", ...rule.split("\n")] : undefined,
		);
	return {
		attach(component: OmfgPanelComponent): void {
			const setRule = component.setRule.bind(component);
			component.setRule = text => {
				setRule(text);
				rule = text;
				validation = "pending";
				publishRule();
			};
			const setStatus = component.setStatus.bind(component);
			component.setStatus = (state, status) => {
				setStatus(state, status);
				ui.setStatus(RPC_OMFG_UI_KEY, `/omfg · ${status}`);
				// A candidate leaves validation either for the save picker (matched) or for the
				// "save anyway?" confirmation (no match found, or no judge available).
				if (rule && validation === "pending" && (state === "saving" || state === "confirming")) {
					validation = state === "saving" ? "matched" : "unconfirmed";
					publishRule();
				}
			};
		},
		withRule(message: string): string {
			return rule ? `${message}\n\n${rule}` : message;
		},
		clear(): void {
			ui.setStatus(RPC_OMFG_UI_KEY, undefined);
			ui.setWidget(RPC_OMFG_UI_KEY, undefined);
		},
	};
}

/** Run the existing TTSR-rule workflow over RPC-hosted select/input/confirm dialogs. */
export async function runRpcOmfg(
	session: AgentSession,
	ui: ExtensionUIContext,
	complaint: string,
): Promise<RpcOmfgResult> {
	let diagnostic = "Unable to create TTSR rule.";
	const mirror = createRpcOmfgPanelMirror(ui);
	const context = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		ui: { requestRender: () => {} },
		omfgContainer: { clear: () => {}, addChild: (component: OmfgPanelComponent) => mirror.attach(component) },
		showStatus: (message: string) => {
			diagnostic = message;
		},
		showError: (message: string) => {
			diagnostic = message;
		},
		showHookConfirm: (title: string, message: string) => ui.confirm(title, mirror.withRule(message)),
		showHookSelector: (title: string, options: string[]) => ui.select(title, options),
		showHookInput: (title: string, placeholder?: string) => ui.input(title, placeholder),
	} as unknown as InteractiveModeContext;
	let result: OmfgPanelResult | undefined;
	try {
		result = await new OmfgController(context).startAndWait(complaint);
	} finally {
		mirror.clear();
	}
	if (!result) throw new Error(diagnostic);
	if (result.state === "error") throw new Error(result.errorMessage ?? diagnostic);
	if (result.state === "saved") return { state: "saved", savedPath: result.savedPath };
	if (result.state === "rejected") return { state: "rejected" };
	if (result.state === "aborted") return { state: "aborted" };
	throw new Error(`Unexpected /omfg terminal state: ${result.state}`);
}
