/**
 * Builds the browser relay extension and its distribution artifacts:
 * - `dist/extension/` — unpacked extension (load via chrome://extensions)
 * - `dist/omp-browser-relay-extension.zip` — packaged extension for GH releases
 * - `../coding-agent/src/tools/browser/relay/extension-assets/*.txt` —
 *   generated text assets embedded into the omp CLI so `omp browser-relay
 *   install` works from the compiled binary. Re-run this script after touching
 *   anything under `extension/` and commit the regenerated assets.
 *
 * Dependency-free on purpose: CI runs this without `bun install`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import {
	stampRelayExtensionManifest,
	stampRelayExtensionScript,
} from "../../coding-agent/src/tools/browser/relay/protocol";

const root = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(root, "../..");
const dist = path.join(root, "dist");
const distExtension = path.join(dist, "extension");
const assetsDir = path.resolve(root, "../coding-agent/src/tools/browser/relay/extension-assets");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(distExtension, { recursive: true });

const bundle = await Bun.build({
	entrypoints: [path.join(root, "extension/background.ts"), path.join(root, "extension/popup.ts")],
	outdir: distExtension,
	target: "browser",
	sourcemap: "none",
});
if (!bundle.success) {
	for (const log of bundle.logs) console.error(log);
	process.exit(1);
}

for (const file of ["options.html", "options.js", "popup.html"]) {
	await Bun.write(path.join(distExtension, file), Bun.file(path.join(root, "extension", file)));
}
await Bun.write(path.join(distExtension, "LICENSE"), Bun.file(path.join(repoRoot, "LICENSE")));
// The release zip carries the omp version it ships with, as `omp browser-relay install` stamps its copy;
// the extension reports it to the relay. The embedded assets stay unstamped so releases do not rewrite them.
const sourceManifest = path.join(root, "extension/manifest.json");
const distScript = path.join(distExtension, "background.js");
const unstampedScript = await Bun.file(distScript).text();
const { version: ompVersion } = await Bun.file(path.join(root, "../coding-agent/package.json")).json();
await Bun.write(distScript, stampRelayExtensionScript(unstampedScript, ompVersion));
await Bun.write(
	path.join(distExtension, "manifest.json"),
	stampRelayExtensionManifest(await Bun.file(sourceManifest).text(), ompVersion),
);
const zipOut = path.join(dist, "omp-browser-relay-extension.zip");
const zip = await $`zip -qr ${zipOut} .`.cwd(distExtension).nothrow();
if (zip.exitCode !== 0) {
	const pyZip =
		await $`python3 -c "import os,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(r,f), os.path.relpath(os.path.join(r,f), sys.argv[2])) for r,_,fs in os.walk(sys.argv[2]) for f in sorted(fs)]; z.close()" ${zipOut} ${distExtension}`.nothrow();
	if (pyZip.exitCode !== 0) {
		console.error("zip failed:", zip.stderr.toString(), pyZip.stderr.toString());
		process.exit(1);
	}
}
await Bun.write(path.join(assetsDir, "background.js.txt"), unstampedScript);
const embeddedAssets = [
	[sourceManifest, "manifest.json.txt"],
	[path.join(distExtension, "options.html"), "options.html.txt"],
	[path.join(distExtension, "options.js"), "options.js.txt"],
	[path.join(distExtension, "popup.html"), "popup.html.txt"],
	[path.join(distExtension, "popup.js"), "popup.js.txt"],
	[path.join(distExtension, "LICENSE"), "LICENSE.txt"],
] as const;
for (const [source, destination] of embeddedAssets) {
	await Bun.write(path.join(assetsDir, destination), Bun.file(source));
}

console.log("built:");
console.log(`  ${distExtension}`);
console.log(`  ${path.join(dist, "omp-browser-relay-extension.zip")}`);
console.log(`  ${assetsDir} (embedded CLI assets — commit these)`);
