#!/usr/bin/env bun
/**
 * 产出自包含的 omp RPC 类型声明 `dist/omp-rpc-types.d.ts`，供 Oryn 前端直接使用。
 *
 * 入口为 `packages/coding-agent/src/modes/rpc/rpc-types.ts`（`RpcCommand`、`RpcResponse`、全部帧与其传递依赖），
 * 用 `dts-bundle-generator` 把所有工作区包（`@oh-my-pi/*`）内联进单个文件。
 *
 * 说明：
 * - 仓库自身使用 TypeScript 7（原生编译器，无 JS API），而 dts-bundle-generator 依赖 TS 5 的 JS API，
 *   因此工具链安装在 `$TMPDIR/oryn-dts-tools-<版本>` 的独立目录里，不改动仓库依赖。
 * - TS 5 对本仓库源码会报出少量仅在 TS 7 下成立的类型错误；这些不影响声明产出，
 *   因此只把「程序诊断」降级为警告，「声明产出诊断」仍视为失败。
 * - 产物末尾会校验不再引用任何 `@oh-my-pi/*` 包或相对路径模块。
 *
 * 用法（仓库根目录）：bun scripts/oryn/emit-rpc-dts.ts [--out dist/omp-rpc-types.d.ts]
 */
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

const DTS_BUNDLE_GENERATOR_VERSION = "9.5.1";
const TYPESCRIPT_VERSION = "5.9.3";

const repoRoot = path.join(import.meta.dir, "..", "..");
const entry = path.join(repoRoot, "packages", "coding-agent", "src", "modes", "rpc", "rpc-types.ts");

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const out = path.resolve(outFlag >= 0 ? args[outFlag + 1]! : path.join(repoRoot, "dist", "omp-rpc-types.d.ts"));

// 工具链装在临时目录、不在仓库依赖里，这里只声明用到的最小接口。
interface TsDiagnostic {
	readonly category: number;
}
interface TsProgram {
	getCompilerOptions(): { declaration?: boolean };
}
interface TypeScriptApi {
	readonly version: string;
	readonly DiagnosticCategory: { readonly Error: number };
	getPreEmitDiagnostics(program: TsProgram): readonly TsDiagnostic[];
}
interface DtsBundleGenerator {
	generateDtsBundle(
		entries: readonly {
			filePath: string;
			libraries?: { inlinedLibraries?: string[] };
			output?: { noBanner?: boolean; exportReferencedTypes?: boolean };
		}[],
		options?: { preferredConfigPath?: string },
	): string[];
}

async function ensureTools(): Promise<string> {
	const toolsDir = path.join(
		process.env.TMPDIR ?? "/tmp",
		`oryn-dts-tools-${DTS_BUNDLE_GENERATOR_VERSION}-${TYPESCRIPT_VERSION}`,
	);
	if (await Bun.file(path.join(toolsDir, "node_modules", "dts-bundle-generator", "package.json")).exists()) {
		return toolsDir;
	}
	await fs.mkdir(toolsDir, { recursive: true });
	await Bun.write(path.join(toolsDir, "package.json"), JSON.stringify({ name: "oryn-dts-tools", private: true }));
	const proc = Bun.spawn(
		[
			process.execPath,
			"add",
			"--registry=https://registry.npmjs.org",
			`dts-bundle-generator@${DTS_BUNDLE_GENERATOR_VERSION}`,
			`typescript@${TYPESCRIPT_VERSION}`,
		],
		{ cwd: toolsDir, stdout: "inherit", stderr: "inherit" },
	);
	if ((await proc.exited) !== 0) throw new Error("安装 dts-bundle-generator 失败");
	return toolsDir;
}

interface WorkspacePackage {
	readonly name?: string;
	readonly exports?: Record<string, string | { types?: string; import?: string }>;
}

/**
 * 由各工作区包的 `exports` 生成 tsconfig `paths`，让 `@oh-my-pi/*` 直接解析到源码而不经 node_modules 软链。
 * 经软链解析时 TS 会把它们当作外部库，dts-bundle-generator 就不会把它们转成声明文件，导致内联失败。
 */
async function workspacePaths(): Promise<{ names: string[]; paths: Record<string, string[]> }> {
	const names: string[] = [];
	const paths: Record<string, string[]> = {};
	for await (const pkgJson of new Bun.Glob("packages/*/package.json").scan({ cwd: repoRoot })) {
		const pkgDir = path.join(repoRoot, path.dirname(pkgJson));
		const pkg = (await Bun.file(path.join(repoRoot, pkgJson)).json()) as WorkspacePackage;
		if (!pkg.name) continue;
		names.push(pkg.name);
		for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
			const file = typeof target === "string" ? target : (target.types ?? target.import);
			if (!file || !/\.(?:d\.)?ts$/.test(file) || subpath.endsWith(".js")) continue;
			paths[`${pkg.name}${subpath.slice(1)}`] = [path.join(pkgDir, file)];
		}
	}
	return { names: names.sort(), paths };
}

const toolsDir = await ensureTools();
/**
 * 宿主运行时类型的模块内替身：源码里少量类型引用了 Bun / Node 全局，产物要在浏览器工程（无 `@types/bun`、
 * `@types/node`）里独立通过类型检查。声明位于模块作用域，不会污染使用方的全局。
 */
const RUNTIME_SHIMS = [
	"declare namespace Bun {",
	"\ttype FormDataEntryValue = File | string;",
	"}",
	"type Buffer = Uint8Array;",
];

/** 在只有 ES + DOM 标准库、没有任何 `@types/*` 的环境里对产物做类型检查，确保自包含。 */
async function checkSelfContained(dtsPath: string): Promise<void> {
	const checkDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oryn-dts-check-"));
	try {
		await fs.copyFile(dtsPath, path.join(checkDir, "omp-rpc-types.d.ts"));
		await Bun.write(
			path.join(checkDir, "use.ts"),
			[
				'import type { RpcCommand, RpcResponse } from "./omp-rpc-types";',
				'export const command: RpcCommand = { type: "get_state" };',
				"export const commandOf = (response: RpcResponse): string => response.command;",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(checkDir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "Bundler",
					lib: ["ES2023", "DOM", "DOM.Iterable"],
					types: [],
					skipLibCheck: false,
				},
				files: ["use.ts"],
			}),
		);
		const proc = Bun.spawn([path.join(toolsDir, "node_modules", ".bin", "tsc"), "-p", checkDir], {
			stdout: "inherit",
			stderr: "inherit",
		});
		if ((await proc.exited) !== 0) throw new Error("产物不能在无 @types 的环境中独立通过类型检查（见上方 tsc 输出）");
	} finally {
		await fs.rm(checkDir, { recursive: true, force: true });
	}
}

const toolsRequire = createRequire(path.join(toolsDir, "package.json"));
const ts = toolsRequire("typescript") as TypeScriptApi;
const diagnosticsHelper = toolsRequire("dts-bundle-generator/dist/helpers/check-diagnostics-errors.js") as {
	checkProgramDiagnosticsErrors(program: TsProgram): void;
};
const { generateDtsBundle } = toolsRequire("dts-bundle-generator") as DtsBundleGenerator;

// 程序诊断降级为警告（见文件头说明）；声明产出诊断仍由 dts-bundle-generator 自己判错。
diagnosticsHelper.checkProgramDiagnosticsErrors = program => {
	if (!program.getCompilerOptions().declaration) throw new Error("程序未开启 declaration 选项");
	const errors = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
	if (errors.length > 0) {
		console.warn(`[emit-rpc-dts] 忽略 ${errors.length} 条 TS ${ts.version} 程序诊断（源码以 TypeScript 7 为准）`);
	}
};

const workDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oryn-dts-"));
try {
	const workspace = await workspacePaths();
	const tsconfigPath = path.join(workDir, "tsconfig.json");
	await Bun.write(
		tsconfigPath,
		JSON.stringify({
			extends: path.join(repoRoot, "tsconfig.base.json"),
			compilerOptions: {
				noEmit: false,
				declaration: true,
				emitDeclarationOnly: true,
				skipLibCheck: true,
				paths: workspace.paths,
				typeRoots: [path.join(repoRoot, "types"), path.join(repoRoot, "node_modules", "@types")],
			},
			files: [entry],
		}),
	);
	const inlined = workspace.names;
	const [bundle] = generateDtsBundle(
		[
			{
				filePath: entry,
				libraries: { inlinedLibraries: inlined },
				output: { noBanner: true, exportReferencedTypes: false },
			},
		],
		{ preferredConfigPath: tsconfigPath },
	);
	if (!bundle) throw new Error("dts-bundle-generator 没有产出");

	const leaked = [...bundle.matchAll(/(?:from\s+|import\(\s*)["']((?:@oh-my-pi\/|\.{1,2}\/)[^"']*)["']/g)].map(
		m => m[1],
	);
	if (leaked.length > 0) {
		throw new Error(`产物仍引用工作区模块：${[...new Set(leaked)].join(", ")}`);
	}

	const header = [
		"// 由 oryn-core `scripts/oryn/emit-rpc-dts.ts` 自动生成，请勿手改。",
		"// 来源：packages/coding-agent/src/modes/rpc/rpc-types.ts",
		"",
		...RUNTIME_SHIMS,
		"",
	].join("\n");
	await fs.mkdir(path.dirname(out), { recursive: true });
	await Bun.write(out, `${header}${bundle}`);
	await checkSelfContained(out);
	console.log(`[emit-rpc-dts] 已写出 ${out}（${bundle.length} 字节，内联 ${inlined.length} 个工作区包）`);
} finally {
	await fs.rm(workDir, { recursive: true, force: true });
}
