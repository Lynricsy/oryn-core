/**
 * `omp browser-relay` — drive the user's own Chrome tabs.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { BROWSER_RELAY_ACTIONS, DEFAULT_RELAY_PORT, runBrowserRelayCommand } from "../cli/browser-relay-cli";
import { browserRelayHelp } from "../cli/command-help";

/** Install or sync the omp Chrome extension; Chrome launches its native host. */
export default class BrowserRelay extends Command {
	static description = browserRelayHelp.description;

	static args = {
		action: Args.string({
			description: `Action: ${BROWSER_RELAY_ACTIONS.join(" | ")} (native-host is launched by Chrome; omit with --port for serve)`,
			options: [...BROWSER_RELAY_ACTIONS],
			required: false,
		}),
	};

	static flags = {
		dir: Flags.string({
			description: "Extension install directory (install; default ~/.omp/browser-relay/extension)",
		}),
		"no-chrome": Flags.boolean({
			description: "Skip the unattended install into Chrome and print the manual steps",
			default: false,
		}),
		profile: Flags.string({
			description: "Chrome profile directory for the unattended install (install; default: last used)",
		}),
		port: Flags.integer({
			description: `Listen port for standalone relay server (serve; default ${DEFAULT_RELAY_PORT})`,
		}),
		token: Flags.string({
			description: "Shared secret token required by /ext?token= (serve)",
		}),
		"no-group": Flags.boolean({
			description: "Do not group agent-driven tabs in Chrome (serve)",
			default: false,
		}),
		verbose: Flags.boolean({
			description: "Print relay diagnostics to stderr (serve)",
			default: false,
		}),
	};

	static examples = [
		"omp browser-relay install    # install the omp extension, register it in Chrome and add its native host",
		"omp browser-relay sync       # sync every registered extension directory",
		"omp browser-relay serve --port 18800 --token <tok>  # run a standalone loopback CDP relay",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserRelay);
		// Oryn M27 compatibility: `omp browser-relay --port <p> --token <tok>` omits the `serve` action.
		const rawAction = args.action ?? (flags.port !== undefined || flags.token !== undefined ? "serve" : undefined);
		if (rawAction === undefined) {
			throw new Error(`Missing required action: ${BROWSER_RELAY_ACTIONS.join(" | ")}`);
		}
		const action = BROWSER_RELAY_ACTIONS.find(candidate => candidate === rawAction);
		if (action === undefined) throw new Error(`Unknown action: ${rawAction}`);
		await runBrowserRelayCommand({
			action,
			port: flags.port,
			token: flags.token,
			group: !flags["no-group"],
			verbose: flags.verbose,
			dir: flags.dir,
			chrome: !flags["no-chrome"],
			profile: flags.profile,
		});
	}
}
