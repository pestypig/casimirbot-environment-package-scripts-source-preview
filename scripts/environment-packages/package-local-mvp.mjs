// Unsigned private local executable; never publishes or replaces installed builds.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const repo = fs.realpathSync(process.cwd());
const root = fs.realpathSync(process.argv[2] ?? "");
if (!root.startsWith(path.join(repo, ".tmp") + path.sep)) throw Error("isolated_candidate_required");
const solarArgs = process.argv.slice(3);
if (solarArgs.length !== 0 &&
    (solarArgs.length !== 2 || !solarArgs[0].startsWith("--solar-runtime-candidate=") ||
      !solarArgs[1].startsWith("--solar-runtime-manifest-sha256="))) {
  throw Error("solar_runtime_candidate_and_pinned_manifest_required");
}
const solarCandidate = solarArgs.length
  ? path.resolve(solarArgs[0].slice("--solar-runtime-candidate=".length)) : null;
const solarManifestSha256 = solarArgs.length
  ? solarArgs[1].slice("--solar-runtime-manifest-sha256=".length) : null;
if (solarCandidate && (!path.isAbsolute(solarCandidate) || !/^[a-f0-9]{64}$/.test(solarManifestSha256))) {
  throw Error("solar_runtime_candidate_and_pinned_manifest_required");
}
const receipt = JSON.parse(fs.readFileSync(path.join(root, "candidate.json"), "utf8"));
if (receipt.status !== "prepared" || receipt.privateLocalMvp !== true) throw Error("prepared_private_local_mvp_required");
const output = path.join(root, "local-executable");
if (fs.existsSync(output)) throw Error("executable_output_already_exists");
const diskBudget = fs.statfsSync(repo);
if (diskBudget.bavail * diskBudget.bsize < 2 * 1024 ** 3) throw Error("private_full_packaging_requires_2GiB_free; use a verified service-only update when the host/client are unchanged");
const desktop = path.join(root, "apps/desktop");
const copy = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true }); };
for (const relative of ["apps/desktop/scripts", "apps/desktop/package-lock.json", "apps/desktop/release-slice.v1.json", "data/starsim/solar-product-registry.v1.json", "data/starsim/solar-reference-pack.v1.json"]) copy(path.join(repo, relative), path.join(root, relative));
const env = Object.fromEntries(["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
// Private opt-in only. stage-runtime verifies the complete candidate inventory,
// frozen manifest hash, and non-release claim boundary before copying any bytes.
if (solarCandidate) {
  env.CASIMIR_SOLAR_RUNTIME_DIR = solarCandidate;
  env.CASIMIR_SOLAR_RUNTIME_MANIFEST_SHA256 = solarManifestSha256;
}
const stage = spawnSync(process.execPath, [path.join(desktop, "scripts/stage-runtime.mjs")], { cwd: root, env, windowsHide: true, encoding: "utf8" });
fs.writeFileSync(path.join(root, "package-stage.log"), stage.stdout + stage.stderr);
if (stage.status !== 0) throw Error("private_runtime_stage_failed");
copy(path.join(repo, "apps/desktop/node_modules/electron/dist"), output);
fs.renameSync(path.join(output, "electron.exe"), path.join(output, "CasimirBot-Local-MVP.exe"));
const app = path.join(output, "resources/app");
copy(path.join(desktop, "dist"), path.join(app, "dist"));
copy(path.join(desktop, "package.json"), path.join(app, "package.json"));
copy(path.join(desktop, "runtime"), path.join(output, "resources/runtime"));
// Exact desktop native dependency closure, without the Electron/build tool tree.
for (const name of ["electron-updater", "sharp"]) {
  const visited = new Set();
  const visit = name => {
    if (visited.has(name)) return; visited.add(name);
    const source = path.join(repo, "apps/desktop/node_modules", name);
    if (!fs.existsSync(source)) throw Error(`native_dependency_missing:${name}`);
    copy(source, path.join(app, "node_modules", name));
    const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) visit(dependency);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) if (fs.existsSync(path.join(repo, "apps/desktop/node_modules", dependency))) visit(dependency);
  };
  visit(name);
}
const inventory = [];
const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  const file = path.join(directory, entry.name);
  if (entry.isDirectory()) walk(file);
  else if (entry.isFile()) inventory.push({ path: path.relative(output, file).replaceAll("\\", "/"), bytes: fs.statSync(file).size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
} };
walk(output);
fs.writeFileSync(path.join(root, "local-executable-manifest.json"), JSON.stringify({ schema: "casimirbot.private_local_executable.v1", executable: path.join(output, "CasimirBot-Local-MVP.exe"), signed: false, published: false, candidate: path.join(root, "candidate.json"), files: inventory }, null, 2));
console.log(path.join(output, "CasimirBot-Local-MVP.exe"));
