import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "esbuild";

if (process.platform !== "win32") throw Error("windows_fixture_required");
const root = fs.mkdtempSync(path.join(fs.realpathSync(".tmp"), "g16a-lifecycle-electron-"));
const executable = path.resolve("apps/desktop/node_modules/electron/dist/electron.exe");
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const [entry, output] of [["tests/fixtures/desktop-environment-lifecycle-electron.ts", "main.cjs"],
  ["apps/desktop/src/preload.ts", "preload.cjs"]]) {
  await build({ entryPoints: [entry], outfile: path.join(root, output), bundle: true, platform: "node",
    target: "node24", format: "cjs", external: ["electron"], logLevel: "warning" });
}
fs.writeFileSync(path.join(root, "fixture.html"), '<!doctype html><title>Private lifecycle fixture</title><p>Automated lifecycle fixture.</p>');
const child = spawn(executable, [path.join(root, "main.cjs")], { shell: false, windowsHide: true,
  stdio: ["ignore", "ignore", "ignore"], env: { SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, TEMP: root, TMP: root } });
const timer = setTimeout(() => child.kill(), 40000);
const completion = await new Promise((resolve, reject) => {
  child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
}).finally(() => clearTimeout(timer));
const result = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
const files = ["apps/desktop/src/preload.ts", "apps/desktop/src/environment-private-revocation.ts",
  "apps/desktop/src/environment-private-lifecycle.ts", "tests/fixtures/desktop-environment-lifecycle-electron.ts",
  "scripts/environment-packages/test-desktop-lifecycle.mjs"];
fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify({ root, executable, executableSha256: sha(executable), completion, result,
  sourceSha256: Object.fromEntries(files.map(file => [file, sha(file)])),
  bundleSha256: { main: sha(path.join(root, "main.cjs")), preload: sha(path.join(root, "preload.cjs")) } }, null, 2));
fs.writeFileSync(".tmp/g16a-lifecycle-electron-evidence-path.txt", path.join(root, "evidence.json"));
if (completion.code !== 0 || !result.passed) throw Error("electron_lifecycle_fixture_failed");
console.log(JSON.stringify({ passed: true, evidence: path.join(root, "evidence.json") }));
