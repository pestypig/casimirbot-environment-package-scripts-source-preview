import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "esbuild";

if (process.platform !== "win32" || process.arch !== "x64") throw Error("windows_x64_fixture_required");
const root = fs.mkdtempSync(path.join(fs.realpathSync(".tmp"), "g16a-clock-ipc-electron-"));
const userData = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "g16a-clock-ipc-electron-"));
const executable = path.resolve("apps/desktop/node_modules/electron/dist/electron.exe");
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const custody = JSON.parse(fs.readFileSync("docs/evidence/eh-g8-codex-first-paid-product-delivery-v1/launch-program/2026-09-26-g16a-prepared-artifact-custody.json", "utf8").replace(/^\uFEFF/, ""));
const review = JSON.parse(fs.readFileSync("apps/desktop/environment-packages/system-clock/reviewed-prepared-runtime.json", "utf8"));
for (const [name, hash] of Object.entries(review.sourceSha256)) if (sha(path.join("apps/desktop/native", name)) !== hash) throw Error("native_source_changed");
fs.writeFileSync(path.join(root, "input.json"), JSON.stringify({ userData, runtimeDirectory: custody.bundle.root,
  archive: path.resolve(".tmp/g16a-clock-package-20260926/clock.tgz") }));
for (const [entry, output] of [["tests/fixtures/desktop-clock-ipc-electron.ts", "main.cjs"], ["apps/desktop/src/preload.ts", "preload.cjs"]]) {
  await build({ entryPoints: [entry], outfile: path.join(root, output), bundle: true, platform: "node",
    target: "node24", format: "cjs", external: ["electron"], logLevel: "warning" });
}
fs.writeFileSync(path.join(root, "fixture.html"), '<!doctype html><title>Private clock IPC fixture</title><p>Automated native fixture.</p>');
const child = spawn(executable, [path.join(root, "main.cjs")], { shell: false, windowsHide: true,
  stdio: ["ignore", "ignore", "ignore"], env: { SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, TEMP: userData, TMP: userData } });
const timer = setTimeout(() => child.kill(), 55000);
const completion = await new Promise((resolve, reject) => {
  child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
}).finally(() => clearTimeout(timer));
const result = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
const files = ["apps/desktop/src/preload.ts", "apps/desktop/src/environment-private-clock-ipc.ts", "apps/desktop/src/environment-private-clock-host.ts",
  "apps/desktop/src/environment-private-desktop-owner.ts", "apps/desktop/src/environment-private-lifecycle.ts",
  "tests/fixtures/desktop-clock-ipc-electron.ts", "scripts/environment-packages/test-desktop-clock-ipc.mjs"];
const evidence = { root, userData, executable, executableSha256: sha(executable), completion, result,
  sourceSha256: Object.fromEntries(files.map(file => [file, sha(file)])),
  bundleSha256: { main: sha(path.join(root, "main.cjs")), preload: sha(path.join(root, "preload.cjs")) } };
fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
fs.writeFileSync(".tmp/g16a-clock-ipc-electron-evidence-path.txt", path.join(root, "evidence.json"));
if (completion.code !== 0 || !result.passed || result.cleanup.quit !== "clean") throw Error("electron_clock_ipc_fixture_failed");
console.log(JSON.stringify({ passed: true, evidence: path.join(root, "evidence.json") }));
