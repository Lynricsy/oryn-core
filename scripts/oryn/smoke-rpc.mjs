#!/usr/bin/env node
// omp RPC 冒烟探针：以 `--mode rpc-ui` 启动给定二进制，验证 Oryn 依赖的握手与串行队列未卡死。
//
// 以 nornzach/oh-my-pi-gui 的 `scripts/smoke-sidecar.mjs`（MIT）为蓝本：
//   ready → negotiate_protocol{2} → get_state → oryn_select_model{} / oryn_cancel_job{}（期望参数错误，证明已接线）
//   → get_available_models（≤6s）→ get_state → set_thinking_level → get_settings → set_setting 往返（结束后还原）。
// 末行输出 `VERDICT PASS|FAIL`，失败退出码非 0。
//
// 用法：node scripts/oryn/smoke-rpc.mjs ./dist/omp-linux-x64
// 环境变量：OMP_SMOKE_TIMEOUT_MS 硬超时（默认 40000）。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const WEDGE_MS = 6000;
const HARD_TIMEOUT_MS = Number(process.env.OMP_SMOKE_TIMEOUT_MS ?? 40_000);

const exe = process.argv[2];
if (!exe) {
	console.error("用法：node scripts/oryn/smoke-rpc.mjs <omp 可执行文件>");
	process.exit(2);
}
const spawnCmd = resolve(exe);
const spawnArgs = ["--mode", "rpc-ui"];
console.log(`probing: ${spawnCmd} ${spawnArgs.join(" ")}`);

const child = spawn(spawnCmd, spawnArgs, {
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, PI_RPC_EMIT_TITLE: "1", PI_NO_PTY: "1", PI_NOTIFICATIONS: "off" },
});

const pending = new Map();
const results = [];
let readyDone = false;
let finished = false;
let seq = 0;

const send = (type, extra = {}) => {
	const id = `probe-${++seq}`;
	const t0 = Date.now();
	const p = new Promise(res => pending.set(id, { res, t0 }));
	child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
	return p;
};

const rl = createInterface({ input: child.stdout });
rl.on("line", line => {
	let f;
	try {
		f = JSON.parse(line);
	} catch {
		return;
	}
	if (f.type === "response" && f.id && pending.has(f.id)) {
		const { res, t0 } = pending.get(f.id);
		pending.delete(f.id);
		results.push({ id: f.id, ok: f.success, ms: Date.now() - t0, error: f.error });
		res(f);
	}
});
child.stderr.on("data", d => {
	const t = d.toString().trim();
	if (t) process.stderr.write(`[omp] ${t.slice(0, 200)}\n`);
});

const hardKill = setTimeout(() => {
	console.log(`HARD_TIMEOUT — omp 在 ${HARD_TIMEOUT_MS}ms 内未完成探测`);
	console.log("\nVERDICT FAIL  hard-timeout");
	child.kill("SIGKILL");
	process.exit(4);
}, HARD_TIMEOUT_MS);
child.on("exit", code => {
	if (finished) return;
	console.log(`OMP_EXIT code=${code} readyDone=${readyDone} — 中止`);
	console.log("\nVERDICT FAIL  early-exit");
	clearTimeout(hardKill);
	process.exit(code || 3);
});

const line = (label, r) =>
	console.log(`${label.padEnd(24)}${r.ok ? "ok " : "ERR"} ${r.ms}ms${r.ok ? "" : ` ${r.error}`}`);

(async () => {
	const ready = await new Promise(res => {
		const onLine = l => {
			try {
				const f = JSON.parse(l);
				if (f.type === "ready") {
					readyDone = true;
					rl.off("line", onLine);
					res(f);
				}
			} catch {}
		};
		rl.on("line", onLine);
	});
	console.log(
		`READY protocolVersion=${ready.protocolVersion} supported=${JSON.stringify(ready.supportedProtocolVersions)}`,
	);

	const negotiated = await send("negotiate_protocol", { protocolVersion: 2 });
	line("negotiate_protocol", results.at(-1));
	const negotiatedOk = negotiated.success && negotiated.data?.protocolVersion === 2;

	await send("get_state");
	line("get_state[boot]", results.at(-1));

	// 不带参数：已接线的 Core 以参数错误拒绝；旧 Core 应答 `Unknown command`。
	const oryn = await send("oryn_select_model");
	const orynWired =
		oryn.success === false && typeof oryn.error === "string" && oryn.error.startsWith("oryn_select_model requires");
	console.log(
		`${"oryn_select_model[wired]".padEnd(24)}${orynWired ? "ok " : "ERR"} ${results.at(-1).ms}ms ${oryn.error}`,
	);
	const cancelJob = await send("oryn_cancel_job");
	const cancelJobWired =
		cancelJob.success === false &&
		typeof cancelJob.error === "string" &&
		cancelJob.error.startsWith("oryn_cancel_job requires");
	console.log(
		`${"oryn_cancel_job[wired]".padEnd(24)}${cancelJobWired ? "ok " : "ERR"} ${results.at(-1).ms}ms ${cancelJob.error}`,
	);

	const modelsFrame = await send("get_available_models");
	const models = results.at(-1);
	line("get_available_models", models);
	console.log(`  models=${Array.isArray(modelsFrame.data?.models) ? modelsFrame.data.models.length : "?"}`);

	await send("get_state");
	const follow = results.at(-1);
	line("get_state[after-models]", follow);

	await send("set_thinking_level", { level: "off" });
	const mutate = results.at(-1);
	line("set_thinking_level", mutate);

	const settingsBefore = await send("get_settings", { paths: ["colorBlindMode"] });
	const originalColorBlindMode = settingsBefore.data?.values?.colorBlindMode;
	const settingsReadable = settingsBefore.success && typeof originalColorBlindMode === "boolean";
	console.log(`${"get_settings".padEnd(24)}${settingsReadable ? "ok " : "ERR"} ${results.at(-1).ms}ms`);

	let settingsPersisted = false;
	if (settingsReadable) {
		const toggled = !originalColorBlindMode;
		const toggle = await send("set_setting", { path: "colorBlindMode", value: toggled });
		const settingsAfter = await send("get_settings", { paths: ["colorBlindMode"] });
		settingsPersisted = toggle.success && settingsAfter.data?.values?.colorBlindMode === toggled;
		console.log(
			`${"set_setting round-trip".padEnd(24)}${settingsPersisted ? "ok " : "ERR"} ${results.at(-2).ms + results.at(-1).ms}ms`,
		);
		await send("set_setting", { path: "colorBlindMode", value: originalColorBlindMode });
	}

	const postDiscovery = [follow, mutate];
	const wedged = postDiscovery.some(r => r.ms > WEDGE_MS);
	const modelsReturned = models.ms <= WEDGE_MS;
	const pass =
		negotiatedOk &&
		orynWired &&
		cancelJobWired &&
		!wedged &&
		modelsReturned &&
		settingsReadable &&
		settingsPersisted;
	if (!negotiatedOk) console.log("FAIL negotiate_protocol 未协商到 v2");
	if (!orynWired) console.log("FAIL oryn_select_model 未接线");
	if (!cancelJobWired) console.log("FAIL oryn_cancel_job 未接线");
	if (!modelsReturned) console.log("FAIL get_available_models 超出时限");
	if (wedged) console.log("FAIL 模型发现后的命令卡住——串行队列阻塞");
	console.log(
		`\nVERDICT ${pass ? "PASS" : "FAIL"}  postDiscoveryMax=${Math.max(...postDiscovery.map(r => r.ms))}ms  models=${models.ms}ms  commands=${results.length}`,
	);

	finished = true;
	clearTimeout(hardKill);
	child.kill("SIGTERM");
	setTimeout(() => {
		child.kill("SIGKILL");
		process.exit(pass ? 0 : 1);
	}, 1500).unref();
	child.on("exit", () => process.exit(pass ? 0 : 1));
})();
