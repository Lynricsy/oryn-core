/**
 * Renders reactive pi-tui views and legacy extension components for an RPC host
 * in its own virtual terminal. A host that opted into interactive terminals
 * (`terminal_configure`) gets a virtual terminal per view: a {@link TermBackend}
 * paints into it via {@link FrameWriter}, and the host's keystrokes and size
 * flow back. This lets `ui.custom()` extension UIs and fullscreen TUI overlays
 * work in the GUI instead of resolving empty.
 */
import { createSurface, type Surface, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { FramePlan, InputEvent, TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { FrameWriter } from "@oh-my-pi/pi-tui/driver/output/writer";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { KeybindingsManager } from "../../config/keybindings/keybindings";
import type {
	ExtensionCustomFactory,
	ExtensionCustomOptions,
	ExtensionUiHost,
} from "../../extensibility/extensions/types";
import { extensionOutput, extensionTheme, singleNode } from "../../ui/extensions/render-output";
import { extensionOverlay } from "../controllers/extension-ui-blocks";
import type { RpcTerminalHost, VirtualTerminalHandle } from "./rpc-terminal";

const VIRTUAL_CAPABILITIES: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: false,
	hyperlinks: true,
	textSizing: false,
	images: null,
	kittyKeyboard: false,
	bracketedPaste: false,
	background: null,
	dark: true,
	cell: null,
	multiplexer: null,
	tsp: false,
};

/** {@link TerminalDriver} backed by a host virtual terminal handle. */
class HostedTerminalDriver implements TerminalDriver {
	#handle: VirtualTerminalHandle | undefined;
	#writer: FrameWriter | undefined;
	readonly #inputListeners = new Set<(event: InputEvent) => void>();
	readonly #resizeListeners = new Set<(columns: number, rows: number) => void>();

	readonly capabilities: TerminalCapabilities = VIRTUAL_CAPABILITIES;

	get columns(): number {
		return this.#handle?.cols ?? 100;
	}

	get rows(): number {
		return this.#handle?.rows ?? 30;
	}

	attach(handle: VirtualTerminalHandle): void {
		this.#handle = handle;
		this.#writer = new FrameWriter({
			sink: {
				write: data => this.#handle?.write(data),
				flush: async () => {},
			},
			columns: this.columns,
			rows: this.rows,
			synchronizedOutput: () => false,
			multiplexer: () => false,
		});
	}

	input(data: string): void {
		for (const event of decodeInput(data, { kitty: false })) {
			for (const listener of this.#inputListeners) listener(event);
		}
	}

	resized(): void {
		const cols = this.columns;
		const rows = this.rows;
		this.#writer?.resize(cols, rows);
		for (const listener of this.#resizeListeners) listener(cols, rows);
	}

	async start(): Promise<void> {
		this.#writer?.start({ row: 0, col: 0 });
	}

	async stop(): Promise<void> {
		this.#writer?.stop();
	}

	present(frame: FramePlan): number | undefined {
		return this.#writer?.present(frame);
	}

	writeRaw(data: string): void {
		this.#handle?.write(data);
	}

	onInput(listener: (event: InputEvent) => void): () => void {
		this.#inputListeners.add(listener);
		return () => this.#inputListeners.delete(listener);
	}

	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resizeListeners.add(listener);
		return () => this.#resizeListeners.delete(listener);
	}

	onCapabilities(): () => void {
		return () => {};
	}

	onReplay(): () => void {
		return () => {};
	}

	resetDisplay(): void {
		this.#handle?.write("\x1b[2J\x1b[H");
	}

	setTitle(): void {}
}

export type HostedComponentFactory<T> = ExtensionCustomFactory<T>;

/**
 * Show `factory`'s view in a new host terminal until it calls `done`.
 * Closing the terminal resolves `undefined`, the cancel every TUI picker reports.
 */
export function showHostedComponent<T>(
	host: RpcTerminalHost,
	title: string,
	factory: HostedComponentFactory<T>,
	options?: ExtensionCustomOptions,
): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	if (options?.signal?.aborted) {
		reject(options.signal.reason ?? new DOMException("Dialog aborted", "AbortError"));
		return promise;
	}
	const driver = new HostedTerminalDriver();
	const revision = signal(0);
	let backend: TermBackend | undefined;
	let surface: Surface | undefined;
	let closed = false;

	const finish = (settle: () => void) => {
		if (closed) return;
		closed = true;
		options?.signal?.removeEventListener("abort", onAbort);
		try {
			backend?.stop();
			surface?.dispose();
			void driver.stop();
		} finally {
			handle.finish();
			settle();
		}
	};

	const onAbort = () =>
		finish(() => reject(options?.signal?.reason ?? new DOMException("Dialog aborted", "AbortError")));

	const handle = host.openVirtual(title, {
		onInput: data => driver.input(data),
		onResize: () => driver.resized(),
		onClose: () => finish(() => resolve(undefined as T)),
	});
	driver.attach(handle);
	void driver.start();
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	const uiHost: ExtensionUiHost = {
		requestRender: () => revision.set(revision.peek() + 1),
		size: () => ({ columns: driver.columns, rows: driver.rows }),
		suspend: async run => run(),
	};

	Promise.try(() =>
		factory(uiHost, extensionTheme(currentTheme()), KeybindingsManager.inMemory(), result =>
			finish(() => resolve(result)),
		),
	)
		.then(output => {
			if (closed) {
				if (output && typeof output === "object" && "dispose" in output) output.dispose?.();
				return;
			}
			let contentNode: UiNode | undefined;
			surface = createSurface(() => {
				const node = singleNode(extensionOutput(output, { revision, input: true }) ?? []);
				contentNode = node;
				if (options?.overlay) {
					return { layer: extensionOverlay(node, options.fullscreen === true, false) };
				}
				return { dock: node };
			});
			const focusTarget = contentNode ?? surface.layer()[0] ?? surface.dock()[0] ?? null;
			surface.focus(focusTarget);
			backend = new TermBackend({
				surface,
				driver,
				theme: currentTheme,
				frameInterval: 1,
			});
			backend.start();
			options?.onHandle?.({
				get closed() {
					return closed;
				},
				close: () => finish(() => resolve(undefined as T)),
			});
		})
		.catch((error: unknown) => finish(() => reject(error)));

	return promise;
}
