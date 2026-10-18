// Reuse a private executable's unchanged host/client; preserve original receipts.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const repo = fs.realpathSync(process.cwd());
const roots = process.argv.slice(2).map(value => fs.realpathSync(value));
if (roots.length !== 2 || roots.some(root => !root.startsWith(path.join(repo, ".tmp") + path.sep))) throw Error("two_isolated_candidates_required");
const [oldRoot, newRoot] = roots;
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const contained = (root, file) => {
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(root + path.sep)) throw Error("candidate_path_escape");
  return resolved;
};
const old = read(path.join(oldRoot, "candidate.json")), next = read(path.join(newRoot, "candidate.json"));
if ([old, next].some(receipt => receipt.status !== "prepared" || receipt.privateLocalMvp !== true)) throw Error("prepared_private_candidates_required");
for (const [root, receipt] of [[oldRoot, old], [newRoot, next]]) {
  if (receipt.signed !== false || receipt.published !== false) throw Error("unsigned_unpublished_candidates_required");
  if (fs.realpathSync(receipt.desktop) !== contained(root, path.join(root, "apps/desktop"))) throw Error("candidate_desktop_mismatch");
}
if (JSON.stringify(Object.keys(old.sourceSha256).sort()) !== JSON.stringify(Object.keys(next.sourceSha256).sort())) throw Error("source_inventory_changed");
const changed = Object.keys(next.sourceSha256).filter(file => old.sourceSha256[file] !== next.sourceSha256[file]);
if (changed.length !== 1 || changed[0] !== "server/services/reference-canvas/default-service.ts") throw Error("unexpected_source_change");
for (const [file, hash] of Object.entries(next.sourceSha256)) if (sha(contained(repo, path.resolve(repo, file))) !== hash) throw Error(`source_changed:${file}`);
const executableRoot = contained(oldRoot, path.join(oldRoot, "local-executable"));
const appDist = contained(executableRoot, path.join(executableRoot, "resources/app/dist"));
const nextDist = contained(newRoot, path.join(next.desktop, "dist"));
if (sha(path.join(appDist, "main.cjs")) !== sha(path.join(nextDist, "main.cjs"))) throw Error("host_changed");
const manifestPath = path.join(oldRoot, "local-executable-manifest.json");
const beforePath = path.join(oldRoot, "local-executable-manifest-before-account-fix.json");
if (fs.existsSync(beforePath)) throw Error("update_already_attempted");
const inventory = read(manifestPath);
if (inventory.schema !== "casimirbot.private_local_executable.v1" || inventory.signed !== false || inventory.published !== false || path.resolve(inventory.candidate) !== path.join(oldRoot, "candidate.json") || path.resolve(inventory.executable) !== path.join(executableRoot, "CasimirBot-Local-MVP.exe")) throw Error("private_executable_inventory_required");
for (const requiredPath of ["resources/app/dist/service.mjs", "resources/app/dist/service-dependencies.json", "resources/runtime/runtime-manifest.json"]) {
  if (!inventory.files.some(file => file.path === requiredPath)) throw Error("incomplete_executable_inventory");
}
for (const file of inventory.files) if (sha(contained(executableRoot, path.resolve(executableRoot, file.path))) !== file.sha256) throw Error(`prior_inventory_changed:${file.path}`);
const stat = fs.statfsSync(repo);
const required = fs.statSync(path.join(nextDist, "service.mjs")).size + 512 * 1024 * 1024;
if (stat.bavail * stat.bsize < required) throw Error("insufficient_space_with_512MiB_reserve");
const dependencyReceipt = read(path.join(nextDist, "service-dependencies.json"));
const originalDependencies = read(path.join(appDist, "service-dependencies.json"));
if (JSON.stringify(dependencyReceipt.requiredRuntimePackages) !== JSON.stringify(originalDependencies.requiredRuntimePackages) || JSON.stringify(dependencyReceipt.requiredDataAssets) !== JSON.stringify(originalDependencies.requiredDataAssets)) throw Error("dependency_or_data_change");
if (sha(path.join(nextDist, "service.mjs")) !== dependencyReceipt.serviceSha256) throw Error("new_service_hash_mismatch");
fs.copyFileSync(manifestPath, beforePath, fs.constants.COPYFILE_EXCL);
const servicePath = path.join(appDist, "service.mjs");
fs.copyFileSync(path.join(nextDist, "service.mjs"), servicePath + ".next", fs.constants.COPYFILE_EXCL);
fs.renameSync(servicePath + ".next", servicePath);
fs.copyFileSync(path.join(nextDist, "service-dependencies.json"), path.join(appDist, "service-dependencies.json"));
const runtimePath = path.join(executableRoot, "resources/runtime/runtime-manifest.json");
const runtime = read(runtimePath); runtime.serverSha256 = dependencyReceipt.serviceSha256;
fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2) + "\n");
for (const file of inventory.files) { const absolute = path.join(executableRoot, file.path); file.sha256 = sha(absolute); file.bytes = fs.statSync(absolute).size; }
inventory.serviceUpdate = { candidate: path.join(newRoot, "candidate.json"), sourceChange: changed[0], originalServiceRetained: path.join(old.desktop, "dist/service.mjs"), unchangedHostAndClientReused: true, requiredFreeBytesWithReserve: required };
fs.writeFileSync(manifestPath, JSON.stringify(inventory, null, 2));
console.log(JSON.stringify({ updatedServiceSha256: dependencyReceipt.serviceSha256, preservedOriginalInventory: beforePath, freeBytes: fs.statfsSync(repo).bavail * stat.bsize }));
