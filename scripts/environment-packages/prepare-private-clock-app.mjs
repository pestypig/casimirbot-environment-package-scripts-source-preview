// Private development candidate only. This does not package, sign or publish.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const repo = fs.realpathSync(process.cwd());
if (!fs.existsSync(path.join(repo, "apps/desktop/scripts/build-host.mjs"))) throw Error("canonical_repo_required");
// Measured private candidates can approach 1 GiB once staged and packaged.
// Keep headroom for the OS/profile and refuse before creating another folder.
const diskBudget = fs.statfsSync(repo);
if (diskBudget.bavail * diskBudget.bsize < 3 * 1024 ** 3) throw Error("private_full_build_requires_3GiB_free; reuse an unchanged candidate or review generated payload retention");
const preserveCurrentPointer = process.argv.includes("--preserve-current-pointer");
const localMvp = process.argv.includes("--local-mvp");
const root = fs.mkdtempSync(path.join(repo, ".tmp/g16a-full-app-"));
const desktop = path.join(root, "apps/desktop"), dist = path.join(desktop, "dist");
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const copy = relative => {
  const source = path.join(repo, relative), target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
};
const tracked = ["apps/desktop/scripts/build-host.mjs", "vite.config.ts", "apps/desktop/package.json", "apps/desktop/package-lock.json",
  "apps/desktop/src/main.ts", "apps/desktop/src/preload.ts", "apps/desktop/src/service-environment.ts",
  "apps/desktop/src/environment-private-app.ts", "apps/desktop/src/environment-private-clock-host.ts",
  "apps/desktop/src/environment-private-clock-broker.ts", "apps/desktop/src/environment-private-clock-permission.ts",
  "apps/desktop/src/mcp-tunnel-transition-broker.ts", "shared/desktop-private-clock-permission.ts",
  "client/src/components/workstation/PrivateClockMcpPermission.tsx", "shared/private-clock-mcp.ts",
  "server/services/local-supervisor/private-clock-broker-client.ts", "server/auth/helix-desktop-mcp-identity.ts",
  "server/mcp/helix-mcp-server.ts", "server/routes/helix-mcp.ts", "server/index.ts",
  "shared/helix-mcp-evidence-capability-registry.ts",
  "server/routes/account-session.ts", "client/src/components/workstation/EnvironmentHomePanel.tsx",
  "client/src/components/workstation/PrivateClockCheck.tsx", "shared/environment-private-install.ts",
  "apps/desktop/src/environment-private-removal.ts", "apps/desktop/src/environment-private-removal-ipc.ts",
  "apps/desktop/src/environment-private-desktop-owner.ts", "apps/desktop/src/environment-private-install.ts",
  "apps/desktop/src/environment-package-installation.ts", "apps/desktop/src/environment-package-archive.ts",
  "apps/desktop/src/channels.ts", "shared/desktop-environment-removal.ts",
  "client/src/components/workstation/PrivatePackageRemoval.tsx", "client/src/lib/runtime/RuntimeSurfaceProvider.tsx",
  "apps/desktop/src/environment-clock-observation-journal.ts", "apps/desktop/src/environment-clock-supervisor.ts",
  "apps/desktop/src/environment-private-clock-ipc.ts", "shared/environment-private-runtime.ts",
  "server/services/environment-connectors/directory/private-runtime-policy.ts",
  "apps/desktop/environment-packages/system-clock/reviewed-private.json",
  "apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json",
  "apps/desktop/environment-packages/system-clock/reviewed-prepared-runtime.json",
  "scripts/environment-packages/prepare-private-clock-app.mjs",
  "client/src/components/agent-access/PrivateConnectionInspector.tsx",
  "client/src/components/agent-access/AgentConnectionSetup.tsx",
  "client/src/components/agent-access/AgentAccountBindingReadiness.tsx",
  "client/src/components/workstation/environmentHomeController.ts",
  "client/src/lib/agent-access/connectionObservation.ts",
  "server/routes/agent-connections.ts", "server/routes/helix-agent-account-bindings.ts",
  "server/services/helix-account/agent-account-link-store.ts",
  "client/src/components/agent-access/agentConnectionSetupState.ts",
  "client/src/components/helix/ask-console/PrivateAskConnectionMenu.tsx",
  "client/src/components/helix/ask-console/HelixAskComposerActionToolbarState.ts",
  "client/src/components/helix/ask-console/HelixAskComposerActionToolbarSurface.tsx",
  "client/src/components/helix/HelixAskPill.tsx",
  "client/src/lib/workstation/workstationGuidance.ts",
  "client/src/lib/workstation/accountCapabilityPolicy.ts",
  "client/src/store/useWorkstationLayoutStore.ts",
  "client/src/lib/agent-access/reasoningTaskBinding.ts",
  "shared/helix-agent-client-profile.ts", "shared/helix-agent-client-readiness.ts",
  "shared/helix-account-session.ts", "shared/desktop-environment-home.ts",
  "tools/solar_magnetic_los_diagnostic.py"];
if (localMvp) tracked.push("server/services/reference-canvas/default-service.ts", "server/routes/hosted-reference-canvas.ts", "public/local-reference-canvas.html", "public/local-reference-canvas.js", "shared/helix-hosted-budget.ts", "server/services/helix-account/hosted-budget-store.ts", "server/routes/local-hosted-account.ts", "client/src/components/agent-access/LocalHostedSubscription.tsx", "client/src/components/agent-access/LocalPersonalConnectionSetup.tsx");
const inputs = Object.fromEntries(tracked.map(file => [file, sha(path.join(repo, file))]));
const safeKeys = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"];
const env = Object.fromEntries(safeKeys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.NODE_ENV = "production";
if (localMvp) env.CASIMIR_PRIVATE_LOCAL_MVP_BUILD = "1";
env.VITE_BUILD_ID = path.basename(root);
const run = (args, logName) => new Promise((resolve, reject) => {
  const fd = fs.openSync(path.join(root, logName), "wx");
  const child = spawn(process.execPath, args, { cwd: repo, env, windowsHide: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  const timer = setTimeout(() => child.kill(), 12 * 60 * 1000);
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`${logName}_failed_${code ?? signal}`)); });
});
const receipt = { schema: "casimirbot.private_full_app_candidate.v1", root, desktop, createdAt: new Date().toISOString(),
  status: "building", sourceSha256: inputs, portable: false, signed: false, published: false,
  identityAcceptance: false, providerCredentialsInherited: false, localEnvFilesLoaded: false,
  currentCandidatePointerPreserved: preserveCurrentPointer };
receipt.privateLocalMvp = localMvp;
const save = () => write(path.join(root, "candidate.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
if (!preserveCurrentPointer) write(path.join(repo, ".tmp/g16a-full-app-candidate-path.txt"), path.join(root, "candidate.json"));
try {
  // Use the exact checked-in host recipe, redirecting its output and preserving
  // its original source-root resolution. No shared dist or runtime is replaced.
  const recipePath = path.join(repo, "apps/desktop/scripts/build-host.mjs");
  let recipe = fs.readFileSync(recipePath, "utf8");
  for (const [before, after] of [
    ["fileURLToPath(import.meta.url)", JSON.stringify(recipePath)],
    ['const distRoot = path.join(desktopRoot, "dist");', `const distRoot = ${JSON.stringify(dist)};`],
  ]) {
    if (recipe.split(before).length !== 2) throw Error("host_recipe_shape_changed");
    recipe = recipe.replace(before, after);
  }
  const hostRecipe = path.join(root, "build-host.mjs"); write(hostRecipe, recipe);
  await run([hostRecipe], "host-build.log");
  console.log("Private host/service build complete; starting isolated client build.");
  const config = path.join(root, "vite.private.config.ts");
  write(config, `import config from ${JSON.stringify(path.join(repo, "vite.config.ts").replaceAll("\\", "/"))};\nexport default {...config, envDir:false, build:{...config.build,outDir:${JSON.stringify(path.join(root, "dist/public"))},emptyOutDir:false}};\n`);
  await run(["--max-old-space-size=3072", path.join(repo, "node_modules/vite/bin/vite.js"), "build", "--config", config], "client-build.log");
  if (localMvp) for (const file of ["local-reference-canvas.html", "local-reference-canvas.js"]) {
    fs.copyFileSync(path.join(repo, "public", file), path.join(root, "dist/public", file));
  }
  for (const file of ["apps/desktop/package.json", "apps/desktop/tunnel-client.v1.json", "configs/ideology-verifiers.json",
    "docs/ethos/ideology.json", ".agents/plugins/marketplace.json", "plugins/casimirbot-device-check",
    "scripts/helix-minecraft-launch-fabric-loopback.ps1", "scripts/helix-minecraft-start-fabric-server.ps1",
    "tools/solar_magnetic_los_diagnostic.py"]) copy(file);
  const tunnel = JSON.parse(fs.readFileSync(path.join(desktop, "tunnel-client.v1.json"), "utf8"));
  const tunnelRoot = `apps/desktop/vendor/tunnel-client/v${tunnel.version}/windows-amd64/expanded`;
  for (const [name, expected] of [["tunnel-client.exe", tunnel.executableSha256], ["LICENSE", tunnel.licenseSha256]]) {
    if (sha(path.join(repo, tunnelRoot, name)) !== expected) throw Error("tunnel_artifact_changed");
    copy(`${tunnelRoot}/${name}`);
  }
  fs.symlinkSync(path.join(repo, "apps/desktop/node_modules"), path.join(desktop, "node_modules"), "junction");
  receipt.dependencyLink = { path: path.join(desktop, "node_modules"), target: path.join(repo, "apps/desktop/node_modules"), developmentOnly: true };
  for (const [file, hash] of Object.entries(inputs)) if (sha(path.join(repo, file)) !== hash) throw Error(`source_changed:${file}`);
  const inventory = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && !file.endsWith("candidate.json")) inventory.push({ path: path.relative(root, file).replaceAll("\\", "/"), bytes: fs.statSync(file).size, sha256: sha(file) });
    }
  };
  walk(root);
  receipt.status = "prepared"; receipt.artifacts = inventory;
  receipt.inputScope = "Pinned listed integration/recipe inputs; transitive dirty worktree remains represented by exact bundle hashes, not a clean commit.";
  receipt.remaining = ["full main startup", "human authentication", "native picker and clock journey", "restart/sign-out/account replacement", "installed/signed/domain acceptance"];
  save(); console.log(JSON.stringify({ status: receipt.status, candidate: path.join(root, "candidate.json"), files: inventory.length,
    bytes: inventory.reduce((sum, x) => sum + x.bytes, 0) }));
} catch (error) {
  receipt.status = "failed"; receipt.failure = String(error.message); save(); throw error;
}
