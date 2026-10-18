import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fork, spawn } from "node:child_process";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadTailwindConfig from "tailwindcss/loadConfig.js";
import { buildDesktopServiceEnvironment } from "../../apps/desktop/src/service-environment.ts";

if (process.platform !== "win32" || process.arch !== "x64") throw Error("windows_x64_fixture_required");
const removalMode = process.argv[2] === "--removal";
const pickerSwitchMode = process.argv[2] === "--picker-account-switch";
const historySwitchMode = process.argv[2] === "--history-account-switch";
const connectionRevokeHomeMode = process.argv[2] === "--connection-revoke-home";
const connectionRevokeMode = process.argv[2] === "--connection-revoke" || connectionRevokeHomeMode;
const connectionMode = process.argv[2] === "--connections" || connectionRevokeMode;
const keyboardMode = process.argv[2] === "--home-keyboard";
const retiredMode = process.argv[2] === "--expired-removal" ? "expired-remove"
  : process.argv[2] === "--withdrawn-removal" ? "withdrawn-remove" : null;
const coldServiceMode = process.argv[2] === "--cold-restart" || Boolean(retiredMode);
const restartMode = process.argv[2] === "--restart" || coldServiceMode;
if (process.argv.length > 3 || (process.argv[2] && !removalMode && !restartMode && !pickerSwitchMode && !historySwitchMode && !connectionMode && !keyboardMode)) throw Error("fixture_mode_invalid");
const root = fs.mkdtempSync(path.join(fs.realpathSync(".tmp"), "g16a-clock-ui-"));
const userData = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "g16a-clock-ui-"));
const executable = path.resolve("apps/desktop/node_modules/electron/dist/electron.exe");
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const custody = JSON.parse(fs.readFileSync("docs/evidence/eh-g8-codex-first-paid-product-delivery-v1/launch-program/2026-09-26-g16a-prepared-artifact-custody.json", "utf8").replace(/^\uFEFF/, ""));
const review = JSON.parse(fs.readFileSync("apps/desktop/environment-packages/system-clock/reviewed-prepared-runtime.json", "utf8"));
const baseline = JSON.parse(fs.readFileSync("apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json", "utf8"));
for (const [name, hash] of Object.entries(review.sourceSha256)) if (sha(path.join("apps/desktop/native", name)) !== hash) throw Error("native_source_changed");
const profileId = "profile:g16a-clock-ui", deviceId = `desktop_device_${"u".repeat(22)}`;
const safeEnv = { SystemRoot: process.env.SystemRoot, USERPROFILE: userData, LOCALAPPDATA: userData,
  APPDATA: userData, TEMP: userData, TMP: userData, HELIX_PRIVATE_ENVIRONMENT_HOME: "1", HELIX_PRIVATE_CLOCK_RUNTIME: "1",
  HELIX_DEVELOPER_PROFILE_IDS: pickerSwitchMode || historySwitchMode ? `${profileId},${profileId}-other` : profileId };
const environment = buildDesktopServiceEnvironment({ processEnv: safeEnv, userDataPath: userData,
  serviceOrigin: "http://127.0.0.1:43121", deviceId,
  providerCredentialBroker: { origin: "http://127.0.0.1:43122", token: Buffer.alloc(32, 4).toString("base64url") },
  mcpTransitionBroker: { origin: "http://127.0.0.1:43123", token: Buffer.alloc(32, 5).toString("base64url") },
  friendsPartiesCoordinationBroker: null });
// Fixture-only database/host designation; never inherit the developer's server.
// An explicit pg-mem DSN deliberately bypasses persistence in createPool.
// Cold recovery must use the desktop's no-DSN local snapshot path instead.
Object.assign(environment, { DATABASE_URL: coldServiceMode ? "" : `pg-mem://clock-ui-${randomUUID()}`, HELIX_LOCAL_PG_MEM_PERSIST: coldServiceMode ? "1" : "0",
  CASIMIR_DESKTOP_HOST: "1", NODE_ENV: "test" });
for (const [entry, output] of [["tests/fixtures/desktop-clock-ui-electron.ts", "main.cjs"], ["apps/desktop/src/preload.ts", "preload.cjs"]]) {
  await build({ entryPoints: [entry], outfile: path.join(root, output), bundle: true, platform: "node", target: "node24",
    format: "cjs", external: ["electron"], logLevel: "warning" });
}
await build({ entryPoints: ["tests/fixtures/desktop-clock-ui-renderer.tsx"], outfile: path.join(root, "renderer.js"),
  bundle: true, platform: "browser", target: "chrome140", format: "iife", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
const css = await postcss([tailwindcss({ ...loadTailwindConfig(path.resolve("tailwind.config.ts")), content: ["client/src/components/workstation/EnvironmentHomePanel.tsx", "client/src/components/workstation/PrivateClockCheck.tsx", "client/src/components/workstation/PrivatePackageRemoval.tsx",
  ...(connectionMode || keyboardMode ? ["client/src/components/agent-access/PrivateConnectionInspector.tsx", "client/src/components/agent-access/AgentConnectionSetup.tsx",
    "client/src/components/agent-access/AgentAccountBindingReadiness.tsx", "client/src/components/helix/ask-console/PrivateAskConnectionMenu.tsx",
    "client/src/components/ui/dialog.tsx"] : [])] })])
  .process(fs.readFileSync("client/src/index.css", "utf8"), { from: path.resolve("client/src/index.css") });
fs.writeFileSync(path.join(root, "fixture.css"), css.css);
fs.writeFileSync(path.join(root, "fixture.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Private clock app fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/renderer.js"></script></body></html>');
const serviceLegs = [];
const startService = (port = 0) => {
  const child = fork(path.resolve("tests/fixtures/desktop-clock-ui-service.ts"), [root, String(port), connectionRevokeMode ? "connection-revoke" : connectionMode ? "connections" : "clock"], {
    execArgv: ["--import", "tsx"], env: environment, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const completion = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null, spawnFailed: true }));
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("fixture_service_start_timeout")), 45000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(Error("fixture_service_exited")); });
    child.on("message", message => { if (message?.kind === "ready") { clearTimeout(timer); resolve(message.origin); } });
  });
  return { child, completion, ready };
};
const stopService = async instance => {
  if (instance.child.connected) instance.child.send({ kind: "close" });
  const timer = setTimeout(() => instance.child.kill(), 15000);
  const completion = await instance.completion.finally(() => clearTimeout(timer));
  const file = path.join(root, "service-result.json");
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { closed: false };
  // Consume this leg's report before a second process can overwrite it.
  serviceLegs.push({ pid: instance.child.pid, completion, result });
  if (fs.existsSync(file)) fs.renameSync(file, path.join(root, `service-result-${serviceLegs.length}.json`));
  return completion;
};
let service = startService();
let completion, result, serviceCompletion;
const legs=[];
let snapshotPresentBeforeRecovery = false;
try {
  const origin = await service.ready;
  for(const mode of restartMode ? ["restart-prime",retiredMode ?? "restart-recover"] : [connectionRevokeHomeMode ? "connection-revoke-home" : connectionRevokeMode ? "connection-revoke" : keyboardMode ? "home-keyboard" : connectionMode ? "connections" : pickerSwitchMode ? "picker-account-switch" : historySwitchMode ? "history-account-switch" : removalMode ? "removal" : "baseline"]){
  fs.writeFileSync(path.join(root, "input.json"), JSON.stringify({ userData, origin, profileId, deviceId, mode, runtimeDirectory: custody.bundle.root,
    archive: path.resolve(".tmp/g16a-clock-package-20260926/clock.tgz") }));
  const child = spawn(executable, [path.join(root, "main.cjs")], { shell: false, windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"], env: { SystemRoot: process.env.SystemRoot, USERPROFILE: userData,
      LOCALAPPDATA: userData, APPDATA: userData, TEMP: userData, TMP: userData } });
  const timer = setTimeout(() => child.kill(), removalMode ? 130000 : 90000);
  completion = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); })
    .finally(() => clearTimeout(timer));
  result = JSON.parse(fs.readFileSync(path.join(root, restartMode ? `result-${mode}.json` : "result.json"), "utf8"));
  legs.push({mode,hostPid:child.pid,completion,result});
  if(completion.code!==0 || !result.passed || result.cleanup.quit!=="clean" || result.children.some(child=>!child.absent))
    throw Error(`fixture_leg_failed:${mode}`);
  if(coldServiceMode && mode === "restart-prime") {
    const firstService = service;
    serviceCompletion = await stopService(firstService); service = null;
    if(serviceCompletion.code !== 0 || !serviceLegs[0].result.closed) throw Error("fixture_prime_service_shutdown_failed");
    const snapshotPath = environment.HELIX_LOCAL_DB_PATH;
    if(!snapshotPath || !fs.realpathSync(snapshotPath).startsWith(fs.realpathSync(userData) + path.sep))
      throw Error("fixture_snapshot_outside_profile");
    const snapshot = fs.lstatSync(snapshotPath);
    if(!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.size === 0) throw Error("fixture_snapshot_missing");
    snapshotPresentBeforeRecovery = true;
    if(retiredMode === "withdrawn-remove") {
      environment.HELIX_PRIVATE_ENVIRONMENT_HOME = "0";
      environment.HELIX_PRIVATE_CLOCK_RUNTIME = "0";
    }
    service = startService(Number(new URL(origin).port));
    if(await service.ready !== origin || service.child.pid === firstService.child.pid) throw Error("fixture_service_restart_identity_invalid");
  }
  }
  if(restartMode){
    if(legs.length!==2 || legs[0].hostPid===legs[1].hostPid || !result.identityRecoveredWithoutSignIn ||
       (retiredMode ? !result.retiredRemovalPassed : !result.historicalReceiptRecovered))
      throw Error("fixture_restart_incomplete");
    result={...result,children:legs.flatMap(leg=>leg.result.children),restartLegsPassed:2};
  }
} catch (error) { result = { passed: false, runnerError: String(error?.message ?? "fixture_unknown") }; }
finally {
  if(service) serviceCompletion = await stopService(service);
}
const serviceResult = { closed: serviceLegs.length > 0 && serviceLegs.every(leg => leg.completion.code === 0 && leg.result.closed), counts: {} };
for(const leg of serviceLegs) for(const [key,count] of Object.entries(leg.result.counts ?? {}))
  serviceResult.counts[key] = (serviceResult.counts[key] ?? 0) + count;
if(restartMode && serviceResult.counts?.["POST /api/account/session/sign-in 200"]!==1){
  result={...result,passed:false,runnerError:result.runnerError ?? "fixture_restart_sign_in_count_invalid"};
}
if(coldServiceMode && (serviceLegs.length !== 2 || !snapshotPresentBeforeRecovery ||
    (serviceLegs[1]?.result.counts?.["POST /api/account/session/sign-in 200"] ?? 0) !== 0))
  result={...result,passed:false,runnerError:result.runnerError ?? "fixture_cold_service_restart_incomplete"};
const removed = [];
if (completion?.code === 0 && result?.passed && result.cleanup.quit === "clean" && result.children.every(child => child.absent)) {
  const stageParent = path.join(userData, "clock-runtime", "v1"), expectedPrefix = fs.realpathSync(userData) + path.sep;
  if (fs.existsSync(stageParent)) {
    for (const entry of fs.readdirSync(stageParent, { withFileTypes: true })) {
      const directory = path.join(stageParent, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !fs.realpathSync(directory).startsWith(expectedPrefix)) throw Error("fixture_cleanup_path_invalid");
      const runtime = path.join(directory, "node.exe"), journal = path.join(directory, "clock-isolation.journal");
      if (!fs.existsSync(runtime)) continue;
      const stat = fs.lstatSync(runtime);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || sha(runtime) !== baseline.files["node.exe"].sha256 ||
          fs.readFileSync(journal, "utf8").split("\n")[3] !== "cleaned") throw Error("fixture_cleanup_unconfirmed");
      for (const child of result.children) { try { process.kill(child.pid, 0); throw Error("fixture_child_still_present"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      removed.push({ path: runtime, bytes: stat.size, sha256: sha(runtime) }); fs.unlinkSync(runtime);
    }
  }
}
const sources = ["tests/fixtures/desktop-clock-ui-service.ts", "tests/fixtures/desktop-clock-ui-electron.ts", "tests/fixtures/desktop-clock-ui-renderer.tsx",
  "scripts/environment-packages/test-desktop-clock-ui.mjs", "client/src/components/workstation/EnvironmentHomePanel.tsx", "client/src/components/workstation/PrivateClockCheck.tsx",
  "apps/desktop/src/environment-private-app.ts", "apps/desktop/src/preload.ts", "apps/desktop/src/environment-private-clock-host.ts", "apps/desktop/src/service-environment.ts",
  "shared/environment-private-install.ts", "server/routes/account-session.ts", "server/routes/environment-connector-platform.ts", "server/services/environment-connectors/directory/private-runtime-policy.ts",
  "apps/desktop/src/environment-private-removal.ts", "apps/desktop/src/environment-private-removal-ipc.ts", "apps/desktop/src/environment-private-desktop-owner.ts",
  "apps/desktop/src/environment-private-install.ts", "apps/desktop/src/environment-package-installation.ts", "shared/desktop-environment-removal.ts", "client/src/components/workstation/PrivatePackageRemoval.tsx",
  "server/db/client.ts", "server/services/helix-account/account-session-store.ts",
  "apps/desktop/src/environment-clock-observation-journal.ts", "apps/desktop/src/environment-clock-supervisor.ts",
  "apps/desktop/src/environment-private-clock-ipc.ts", "client/src/lib/runtime/RuntimeSurfaceProvider.tsx",
  "client/src/components/workstation/environmentHomeController.ts",
  "client/src/components/agent-access/AgentConnectionSetup.tsx", "server/routes/agent-connections.ts",
  "client/src/components/agent-access/PrivateConnectionInspector.tsx", "client/src/components/agent-access/AgentAccountBindingReadiness.tsx",
  "client/src/lib/agent-access/connectionObservation.ts",
  "server/routes/helix-agent-account-bindings.ts", "server/services/helix-account/agent-account-link-store.ts"];
const evidence = { root, userData, executable, executableSha256: sha(executable), completion, serviceCompletion, result, serviceResult, removed, restartMode, legs,
  coldServiceMode, retiredMode, pickerSwitchMode, historySwitchMode, connectionMode, connectionRevokeMode, connectionRevokeHomeMode, keyboardMode, serviceLegs, snapshotPresentBeforeRecovery,
  sourceSha256: Object.fromEntries(sources.map(file => [file, sha(file)])),
  bundleSha256: Object.fromEntries(["main.cjs", "preload.cjs", "renderer.js", "fixture.css"].map(file => [file, sha(path.join(root, file))])) };
fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
fs.writeFileSync(".tmp/g16a-clock-ui-evidence-path.txt", path.join(root, "evidence.json"));
if (completion?.code !== 0 || !result?.passed || result.cleanup.quit !== "clean" || !serviceResult.closed) throw Error(`fixture_failed:${root}`);
console.log(JSON.stringify({ passed: true, evidence: path.join(root, "evidence.json"), reclaimedBytes: removed.reduce((sum, item) => sum + item.bytes, 0) }));
