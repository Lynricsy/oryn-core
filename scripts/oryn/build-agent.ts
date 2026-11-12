#!/usr/bin/env bun
/**
 * 构建 Oryn orb 内使用的独立 omp 可执行文件。
 *
 * 以 nornzach/oh-my-pi-gui 的 `scripts/build-bundled-omp.ts`（MIT）为蓝本，去掉了 GUI 协议检查、
 * GUI 目录布局与 macOS 签名，只保留：
 *   1. 按目标平台准备 natives 原生插件：`packages/natives/native/` 中没有与包版本匹配的 `.node` 时，
 *      从官方 npm registry 下载 `@oh-my-pi/pi-natives-<tag>@<version>` leaf 包并暂存；
 *   2. 生成 stats 前端归档与导出查看器（与上游 release 构建一致）；
 *   3. 调用 `packages/coding-agent/scripts/compile-binary.ts` 的 `compileCodingAgent` 编译单文件二进制；
 *   4. 无论成功与否都还原临时生成物与暂存的插件，使仓库保持干净。
 *
 * 用法（仓库根目录）：
 *   bun scripts/oryn/build-agent.ts --target bun-linux-x64-baseline --out dist/omp-linux-x64
 *   bun scripts/oryn/build-agent.ts --target bun-linux-arm64 --out dist/omp-linux-arm64
 * 省略 `--target` 时构建宿主平台；省略 `--out` 时输出到 `dist/omp-<os>-<arch>`。
 */
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "../../packages/coding-agent/scripts/compile-binary";

const repoRoot = path.join(import.meta.dir, "..", "..");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const nativesDir = path.join(repoRoot, "packages", "natives");
const nativesNativeDir = path.join(nativesDir, "native");

const rootPackage = (await Bun.file(path.join(repoRoot, "package.json")).json()) as { packageManager: string };
const bunRequirement = rootPackage.packageManager.replace(/^bun@/, "");
if (!Bun.semver.satisfies(Bun.version, bunRequirement)) {
	throw new Error(`构建 omp 需要 Bun ${bunRequirement}，当前为 ${Bun.version}`);
}

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};

interface AgentTarget {
	/** Bun --compile 目标；undefined 表示宿主平台。 */
	readonly target?: Bun.Build.CompileTarget;
	/** natives 平台标签，如 linux-x64。 */
	readonly platformTag: string;
	/** 嵌入步骤按优先级查找的插件文件名。 */
	readonly addonFilenames: readonly string[];
}

function addonFilenamesFor(platformTag: string): readonly string[] {
	return platformTag.endsWith("-x64")
		? [`pi_natives.${platformTag}-modern.node`, `pi_natives.${platformTag}-baseline.node`]
		: [`pi_natives.${platformTag}.node`];
}

function resolveTarget(): AgentTarget {
	const targetFlag = argValue("--target");
	if (!targetFlag || targetFlag === `bun-${process.platform}-${process.arch}`) {
		const platformTag = `${process.platform}-${process.arch}`;
		return { platformTag, addonFilenames: addonFilenamesFor(platformTag) };
	}
	const match = /^bun-(linux|darwin)-(arm64|x64)(?:-.*)?$/.exec(targetFlag);
	if (!match) {
		throw new Error(`不支持的 --target '${targetFlag}'，应为 bun-linux-x64-baseline 或 bun-linux-arm64 等`);
	}
	const platformTag = `${match[1]}-${match[2]}`;
	return {
		target: targetFlag as Bun.Build.CompileTarget,
		platformTag,
		addonFilenames: addonFilenamesFor(platformTag),
	};
}

// ---------------------------------------------------------------------------
// natives 原生插件准备（嵌入步骤要求 .node 文件在本地暂存）
// ---------------------------------------------------------------------------

const nativesPkg = (await Bun.file(path.join(nativesDir, "package.json")).json()) as { version: string };

/** 构建前不存在、由本脚本新增的文件；构建后删除。 */
const addedByUs: string[] = [];
/** 被本脚本覆盖的既有文件原始字节；构建后还原。 */
const replacedByUs: Record<string, Uint8Array> = {};

/** 加载器自身使用的版本校验（链接后写入的版本戳，以及旧版导出哨兵）。 */
const versionSentinel = createRequire(import.meta.url)(path.join(nativesNativeDir, "version-sentinel.js")) as {
	containsVersionStamp(bytes: Uint8Array, version: string): boolean;
	containsLegacyVersionSentinel(bytes: Uint8Array, version: string): boolean;
};

async function addonMatchesVersion(filePath: string): Promise<boolean> {
	const bytes = await Bun.file(filePath).bytes();
	return (
		versionSentinel.containsVersionStamp(bytes, nativesPkg.version) ||
		versionSentinel.containsLegacyVersionSentinel(bytes, nativesPkg.version)
	);
}

async function stageNativeAddon(target: AgentTarget): Promise<void> {
	for (const filename of target.addonFilenames) {
		const local = path.join(nativesNativeDir, filename);
		if ((await Bun.file(local).exists()) && (await addonMatchesVersion(local))) return;
	}
	for (const filename of target.addonFilenames) {
		const local = path.join(nativesNativeDir, filename);
		if (await Bun.file(local).exists()) {
			replacedByUs[filename] = Buffer.from(await Bun.file(local).arrayBuffer());
			console.log(`[build-agent] 替换过期插件 ${filename}（版本戳 ≠ ${nativesPkg.version}）`);
		}
	}
	const leafPackage = `@oh-my-pi/pi-natives-${target.platformTag}`;
	console.log(`[build-agent] 暂存 ${leafPackage}@${nativesPkg.version}`);
	const cacheDir = path.join(process.env.TMPDIR ?? "/tmp", `omp-natives-${target.platformTag}-${nativesPkg.version}`);
	const installDir = path.join(cacheDir, "node_modules", "@oh-my-pi", `pi-natives-${target.platformTag}`);
	if (!(await Bun.file(path.join(installDir, "package.json")).exists())) {
		await fs.mkdir(cacheDir, { recursive: true });
		await Bun.write(
			path.join(cacheDir, "package.json"),
			JSON.stringify({ name: "omp-natives-cache", private: true }),
		);
		// 固定官方 registry：镜像源不一定提供平台 leaf 包；跨架构暂存必须模拟目标平台，否则 bun 会跳过该 tarball。
		const [targetOs, targetCpu] = target.platformTag.split("-");
		const proc = Bun.spawn(
			[
				process.execPath,
				"add",
				"--no-cache",
				"--registry=https://registry.npmjs.org",
				`--os=${targetOs}`,
				`--cpu=${targetCpu}`,
				`${leafPackage}@${nativesPkg.version}`,
			],
			{ cwd: cacheDir, stdout: "inherit", stderr: "inherit" },
		);
		const exit = await proc.exited;
		if (exit !== 0) {
			throw new Error(`下载 ${leafPackage}@${nativesPkg.version} 失败（退出码 ${exit}）`);
		}
	}
	let stagedCount = 0;
	for (const filename of target.addonFilenames) {
		const src = path.join(installDir, filename);
		if (await Bun.file(src).exists()) {
			if (!(filename in replacedByUs)) addedByUs.push(filename);
			await Bun.write(path.join(nativesNativeDir, filename), Bun.file(src));
			stagedCount++;
		}
	}
	if (stagedCount === 0) {
		throw new Error(`${leafPackage}@${nativesPkg.version} 中不含以下任一文件：${target.addonFilenames.join(", ")}`);
	}
	// leaf 包可能只带部分变体；未被替换的过期同名插件会被嵌入器拒绝，先移开（原始字节已在 replacedByUs 中，构建后还原）。
	for (const filename of target.addonFilenames) {
		const local = path.join(nativesNativeDir, filename);
		if (!(filename in replacedByUs) || !(await Bun.file(local).exists())) continue;
		if (await addonMatchesVersion(local)) continue;
		console.log(`[build-agent] 移开 ${filename}：${leafPackage}@${nativesPkg.version} 不提供该变体`);
		await fs.rm(local, { force: true });
	}
}

async function restoreStagedAddons(): Promise<void> {
	for (const filename of addedByUs) {
		await fs.rm(path.join(nativesNativeDir, filename), { force: true });
	}
	for (const [filename, original] of Object.entries(replacedByUs)) {
		await Bun.write(path.join(nativesNativeDir, filename), original);
	}
}

async function runCommand(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`命令失败（退出码 ${exitCode}）：${command.join(" ")}`);
}

// ---------------------------------------------------------------------------

const target = resolveTarget();
const [platform, arch] = target.platformTag.split("-") as [string, string];
const out = path.resolve(argValue("--out") ?? path.join(repoRoot, "dist", `omp-${target.platformTag}`));
await fs.mkdir(path.dirname(out), { recursive: true });

await stageNativeAddon(target);
try {
	try {
		await runCommand([process.execPath, "run", "gen:stats"]);
		await runCommand([process.execPath, "--cwd=packages/collab-web", "run", "gen:export-viewer"]);
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(codingAgentDir, "src", "cli.ts"),
			outfile: out,
			native: { platform, arch },
			...(target.target ? { target: target.target } : {}),
			minifyIdentifiers: true,
		});
	} finally {
		await runCommand([process.execPath, "run", "gen:stats:reset"]);
	}
} finally {
	await restoreStagedAddons();
}

console.log(`[build-agent] 已构建 omp → ${out}${target.target ? `（目标 ${target.target}）` : ""}`);
