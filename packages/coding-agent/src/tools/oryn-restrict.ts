/**
 * Oryn: switches that confine a session to public web reads.
 *
 * Oryn's background web researcher runs with `read.remoteOnly: true` and
 * `prompt.fileMentions: false`: its `read` may only fetch public http(s) pages
 * (plus its own `local://` scratch), and `@path` mentions in its prompts are not
 * expanded. This module is loaded by the settings layer, so it imports nothing
 * but the registry.
 */
import { register } from "../config/registry";

export const cfgReadRemoteOnly = register({
	id: "read.remoteOnly",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Read: Remote URLs Only",
		description:
			"Restrict the read tool to public http(s) URLs and the session's local:// scratch; local files and other internal URLs are refused",
	},
});

export const cfgPromptFileMentions = register({
	id: "prompt.fileMentions",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Auto-read @file Mentions",
		description: "Read files and directories mentioned as @path in user prompts",
	},
});

const REMOTE_ONLY_REFUSAL = "This session can only read public web pages (http/https URLs).";

/** IPv4 ranges (network, prefix length) that never name a public host. */
const BLOCKED_V4: readonly [number, number][] = [
	[0x00000000, 8], // 0.0.0.0/8
	[0x0a000000, 8], // 10.0.0.0/8
	[0x64400000, 10], // 100.64.0.0/10
	[0x7f000000, 8], // 127.0.0.0/8
	[0xa9fe0000, 16], // 169.254.0.0/16
	[0xac100000, 12], // 172.16.0.0/12
	[0xc0a80000, 16], // 192.168.0.0/16
];

function parseIPv4(host: string): number | undefined {
	const parts = host.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		value = value * 256 + octet;
	}
	return value;
}

function blockedIPv4(value: number): boolean {
	return BLOCKED_V4.some(([net, bits]) => {
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return (value & mask) >>> 0 === net;
	});
}

/**
 * Parse an IPv6 literal (without brackets) into eight 16-bit groups. Only the
 * hex form is accepted: the WHATWG URL parser serializes embedded IPv4
 * (`::ffff:127.0.0.1`) as hex groups (`::ffff:7f00:1`).
 */
function parseIPv6(host: string): number[] | undefined {
	const halves = host.split("::");
	if (halves.length > 2) return undefined;
	const [head, rest] = halves.map(half => (half === "" ? [] : half.split(":")));
	const parsed: number[] = [];
	for (const group of [...head, ...(rest ?? [])]) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
		parsed.push(Number.parseInt(group, 16));
	}
	if (rest === undefined) return parsed.length === 8 ? parsed : undefined;
	if (parsed.length > 7) return undefined;
	return [
		...parsed.slice(0, head.length),
		...Array.from({ length: 8 - parsed.length }, () => 0),
		...parsed.slice(head.length),
	];
}

function blockedIPv6(g: number[]): boolean {
	const zeroPrefix = (n: number) => g.slice(0, n).every(x => x === 0);
	if (zeroPrefix(8)) return true; // ::
	if (zeroPrefix(7) && g[7] === 1) return true; // ::1
	if (zeroPrefix(5) && g[5] === 0xffff) return true; // ::ffff:0:0/96
	if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
	if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
	return false;
}

function blockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.startsWith("[") && host.endsWith("]")) {
		const groups = parseIPv6(host.slice(1, -1));
		return groups === undefined || blockedIPv6(groups);
	}
	const v4 = parseIPv4(host);
	return v4 !== undefined && blockedIPv4(v4);
}

/**
 * Decide whether a remote-only session may read a target.
 *
 * `scheme` is the internal URL scheme of the read path (undefined for none); `urlPath`
 * is the external URL the read would fetch (null when it is not a web URL).
 * Returns `undefined` to allow the read, otherwise the refusal message.
 */
export function orynRemoteOnlyRefusal(scheme: string | undefined, urlPath: string | null): string | undefined {
	if (scheme === "local") return undefined;
	if (urlPath) {
		try {
			const url = new URL(/^https?:\/\//i.test(urlPath) ? urlPath : `https://${urlPath}`);
			if (!blockedHost(url.hostname)) return undefined;
		} catch {
			// Unparseable URLs are refused below.
		}
	}
	return REMOTE_ONLY_REFUSAL;
}
