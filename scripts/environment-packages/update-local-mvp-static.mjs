// Apply one reviewed private canvas asset only while the retained EXE is stopped.
// Never signs, publishes, launches or edits profile data.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = fs.realpathSync(process.cwd());
const candidate = path.join(repo, '.tmp/g16a-full-app-YWB9I4');
const checkpoint = path.resolve(process.argv[2] || '.tmp/local-mvp-source-checkpoint-post-native-build-inputs');
const asset = process.argv[3] || 'local-reference-canvas.js';
if (!['local-reference-canvas.js', 'local-reference-canvas.html'].includes(asset)) throw Error('unsupported_private_asset');
if (!checkpoint.startsWith(path.join(repo, '.tmp') + path.sep)) throw Error('checkpoint_outside_repo_tmp');
const sourceRelative = `public/${asset}`;
const source = path.join(repo, sourceRelative);
const packedRoot = path.join(candidate, 'local-executable/resources/runtime');
const installedRelative = `dist/public/${asset}`;
const installed = path.join(packedRoot, installedRelative);
const runtimeManifestPath = path.join(packedRoot, 'runtime-manifest.json');
const executableManifestPath = path.join(candidate, 'local-executable-manifest.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file);
const checkpointManifest = JSON.parse(read(path.join(checkpoint, 'manifest.json')));
if (checkpointManifest.schema !== 'casimirbot.local_mvp_source_checkpoint.v1') throw Error('checkpoint_schema_mismatch');
const sourceEntry = checkpointManifest.files.find(item => item.file === sourceRelative);
if (!sourceEntry) throw Error('asset_not_in_reviewed_checkpoint');
const sourceBytes = read(source);
const sourceHash = hash(sourceBytes);
if (sourceHash !== sourceEntry.sha256) throw Error('source_changed_since_checkpoint');
const runtimeManifest = JSON.parse(read(runtimeManifestPath));
const executableManifest = JSON.parse(read(executableManifestPath));
if (runtimeManifest.schemaVersion !== 'casimir_desktop_runtime_manifest/2' ||
    executableManifest.schema !== 'casimirbot.private_local_executable.v1' ||
    executableManifest.signed !== false || executableManifest.published !== false) throw Error('private_candidate_required');
const inventoryEntry = executableManifest.files.find(item => item.path === `resources/runtime/${installedRelative}`);
const runtimeEntry = executableManifest.files.find(item => item.path === 'resources/runtime/runtime-manifest.json');
if (!inventoryEntry || !runtimeEntry || inventoryEntry.sha256 !== hash(read(installed)) ||
    runtimeEntry.sha256 !== hash(read(runtimeManifestPath))) throw Error('installed_inventory_baseline_mismatch');
const treeRoot = path.join(packedRoot, 'dist/public');
function hashTree(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const file = path.join(directory, name), stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) entries.push(`${path.relative(root, file).replaceAll('\\', '/')}\0${hash(read(file))}`);
    }
  }
  visit(root);
  return { count: entries.length, sha256: hash(entries.join('\n')) };
}
const oldTree = hashTree(treeRoot);
if (oldTree.sha256 !== runtimeManifest.clientTreeSha256) throw Error('installed_client_tree_baseline_mismatch');
const oldHash = inventoryEntry.sha256;
if (oldHash === sourceHash) { console.log(JSON.stringify({ status: 'already_applied', asset, sha256: sourceHash })); process.exit(0); }

const safeEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']
  .filter(name => process.env[name]).map(name => [name, process.env[name]]));
safeEnvironment.CASIMIR_LOCAL_MVP_EXE_TARGET = path.join(candidate, 'local-executable/CasimirBot-Local-MVP.exe');
const running = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$target=$env:CASIMIR_LOCAL_MVP_EXE_TARGET; @(Get-CimInstance Win32_Process -Filter \"name='CasimirBot-Local-MVP.exe'\" | Where-Object { $_.ExecutablePath -eq $target }).Count"], {
  encoding: 'utf8', windowsHide: true, env: safeEnvironment,
});
const countOutput = running.stdout.trim();
if (running.status !== 0 || !/^\d+$/.test(countOutput)) throw Error('cannot_check_target_exe_processes');
const activeCount = Number(countOutput);
if (!Number.isSafeInteger(activeCount)) throw Error('cannot_check_target_exe_processes');
if (activeCount > 0) throw Error('target_exe_is_running; close_its_instances_gracefully_before_static_update');
const free = fs.statfsSync(repo).bavail * fs.statfsSync(repo).bsize;
if (free < 512 * 1024 ** 2) throw Error('insufficient_disk_reserve');
const rollback = path.join(repo, `.tmp/local-mvp-static-update-${asset.replaceAll('.', '-')}-${sourceHash.slice(0, 12)}`);
if (fs.existsSync(rollback)) throw Error('rollback_destination_exists');
fs.mkdirSync(rollback);
const targets = [installed, runtimeManifestPath, executableManifestPath];
for (const target of targets) fs.copyFileSync(target, path.join(rollback, path.basename(target)));
const writeAtomic = (file, bytes) => {
  const temporary = `${file}.local-mvp-update-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  fs.renameSync(temporary, file);
};
try {
  writeAtomic(installed, sourceBytes);
  const newTree = hashTree(treeRoot);
  if (newTree.count !== oldTree.count) throw Error('client_tree_file_count_changed');
  runtimeManifest.clientTreeSha256 = newTree.sha256;
  writeAtomic(runtimeManifestPath, Buffer.from(JSON.stringify(runtimeManifest, null, 2) + '\n'));
  inventoryEntry.bytes = sourceBytes.length;
  inventoryEntry.sha256 = sourceHash;
  const runtimeBytes = read(runtimeManifestPath);
  runtimeEntry.bytes = runtimeBytes.length;
  runtimeEntry.sha256 = hash(runtimeBytes);
  writeAtomic(executableManifestPath, Buffer.from(JSON.stringify(executableManifest, null, 2) + '\n'));
  const receipt = { schema: 'casimirbot.private_static_update.v1', asset, checkpoint,
    oldSha256: oldHash, newSha256: sourceHash, oldTreeSha256: oldTree.sha256,
    newTreeSha256: newTree.sha256, treeFiles: newTree.count, rollback,
    executableManifestSha256: hash(read(executableManifestPath)), signed: false, published: false };
  fs.writeFileSync(path.join(rollback, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} catch (error) {
  for (const target of targets) fs.copyFileSync(path.join(rollback, path.basename(target)), target);
  throw error;
}
