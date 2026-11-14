#!/usr/bin/env bun
/**
 * 构建 Oryn orb 内使用的独立 omp 可执行文件。
 *
 * 以 nornzach/oh-my-pi-gui 的 `scripts/build-bundled-omp.ts`（MIT）为蓝本，去掉了 GUI 协议检查、
 * GUI 目录布局与 macOS 签名，只保留：
 *   1. 从本仓库源码构建 natives 原生插件（Oryn Core 改了 crates/pi-natives，见 ORYN.md，不能用 npm 上的官方 leaf 包）：
 *      走上游的本地 cargo 路径（`packages/natives/scripts/build-bindings.ts`，cargo profile 默认 `ci`），
 *      x64 固定构建 baseline 变体（x86-64-v2，加载器在支持 AVX2 的机器上也回落到它）；
 *      只能在目标架构的机器上构建（CI 用 x64 与 arm64 两种 runner）；
 *   2. 生成 stats 前端归档与导出查看器（与上游 release 构建一致）；
 *   3. 调用 `packages/coding-agent/scripts/compile-binary.ts` 的 `compileCodingAgent` 编译单文件二进制；
 *   4. 无论成功与否都还原临时生成物与临时移开的插件，使仓库保持干净。
 *
 * 用法（仓库根目录）：
 *   bun scripts/oryn/build-agent.ts --target bun-linux-x64-baseline --out dist/omp-linux-x64
 *   bun scripts/oryn/build-agent.ts --target bun-linux-arm64 --out dist/omp-linux-arm64
 * 省略 `--target` 时构建宿主平台；省略 `--out` 时输出到 `dist/omp-<os>-<arch>`。
 */
import * as fs from "node:fs/promises";
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
}

function resolveTarget(): AgentTarget {
	const targetFlag = argValue("--target");
	if (!targetFlag || targetFlag === `bun-${process.platform}-${process.arch}`) {
		return { platformTag: `${process.platform}-${process.arch}` };
	}
	const match = /^bun-(linux|darwin)-(arm64|x64)(?:-.*)?$/.exec(targetFlag);
	if (!match) {
		throw new Error(`不支持的 --target '${targetFlag}'，应为 bun-linux-x64-baseline 或 bun-linux-arm64 等`);
	}
	return { target: targetFlag as Bun.Build.CompileTarget, platformTag: `${match[1]}-${match[2]}` };
}

// ---------------------------------------------------------------------------
// natives 原生插件：从源码构建（嵌入步骤读取 packages/natives/native/ 下的 .node 文件）
// ---------------------------------------------------------------------------

/** 构建期间临时移开的其它变体插件（原始字节）；构建后还原。 */
const movedAside: Record<string, Uint8Array> = {};

async function buildNativeAddon(target: AgentTarget): Promise<void> {
	const hostTag = `${process.platform}-${process.arch}`;
	if (target.platformTag !== hostTag) {
		throw new Error(`natives 只能在目标架构的机器上构建：目标 ${target.platformTag}，本机 ${hostTag}`);
	}
	const x64 = process.arch === "x64";
	// 直接调 build-bindings.ts（`bun run build` 的 host 路径就是它）：上游 bazel-natives.ts 的 host 目标按本机 AVX2
	// 推断文件名并 dlopen 校验，不认 PI_NATIVE_VARIANT，在 AVX2 机器上构建 baseline 会找错文件。加载由之后的
	// `--smoke-test` 与 smoke-rpc 验证。
	await runCommand([process.execPath, path.join(nativesDir, "scripts", "build-bindings.ts")], {
		...(x64 ? { PI_NATIVE_VARIANT: "baseline" } : {}),
		OMP_NATIVE_CARGO_PROFILE: process.env.OMP_NATIVE_CARGO_PROFILE ?? "ci",
	});
	// 嵌入器会把 native/ 里同平台的每个变体都打进去：移开不是本次构建产出的变体（比如旧的 modern 插件）。
	const built = x64 ? `pi_natives.${hostTag}-baseline.node` : `pi_natives.${hostTag}.node`;
	const others = x64 ? [`pi_natives.${hostTag}-modern.node`] : [];
	if (!(await Bun.file(path.join(nativesNativeDir, built)).exists())) {
		throw new Error(`natives 构建没有产出 ${built}`);
	}
	for (const filename of others) {
		const local = path.join(nativesNativeDir, filename);
		if (!(await Bun.file(local).exists())) continue;
		movedAside[filename] = await Bun.file(local).bytes();
		await fs.rm(local, { force: true });
		console.log(`[build-agent] 移开 ${filename}：只嵌入本次从源码构建的 ${built}`);
	}
}

async function restoreMovedAddons(): Promise<void> {
	for (const [filename, original] of Object.entries(movedAside)) {
		await Bun.write(path.join(nativesNativeDir, filename), original);
	}
}

async function runCommand(command: string[], env: Record<string, string> = {}): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`命令失败（退出码 ${exitCode}）：${command.join(" ")}`);
}

// ---------------------------------------------------------------------------

const target = resolveTarget();
const [platform, arch] = target.platformTag.split("-") as [string, string];
const out = path.resolve(argValue("--out") ?? path.join(repoRoot, "dist", `omp-${target.platformTag}`));
await fs.mkdir(path.dirname(out), { recursive: true });

try {
	await buildNativeAddon(target);
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
	await restoreMovedAddons();
}

console.log(`[build-agent] 已构建 omp → ${out}${target.target ? `（目标 ${target.target}）` : ""}`);
