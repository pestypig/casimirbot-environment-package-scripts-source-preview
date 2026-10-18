// Read-only comparison of the current staged client and retained private EXE.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const repo = fs.realpathSync(process.cwd());
const staged = path.join(repo, 'dist/public');
const retainedRoot = path.join(repo, '.tmp/g16a-full-app-YWB9I4/local-executable/resources/runtime');
const installed = path.join(retainedRoot, 'dist/public');
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(retainedRoot, 'runtime-manifest.json'), 'utf8'));
if (runtimeManifest.schemaVersion !== 'casimir_desktop_runtime_manifest/2') throw Error('unexpected_retained_runtime_manifest');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(root) {
  const files = new Map();
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        files.set(relative, hash(fs.readFileSync(file)));
      }
    }
  }
  visit(root);
  const tree = hash([...files].map(([relative, digest]) => `${relative}\0${digest}`).join('\n'));
  return { files, tree };
}
const stage = inventory(staged), native = inventory(installed);
if (native.tree !== runtimeManifest.clientTreeSha256) throw Error('retained_client_tree_manifest_mismatch');
const stageOnly = [...stage.files.keys()].filter(file => !native.files.has(file));
const nativeOnly = [...native.files.keys()].filter(file => !stage.files.has(file));
const changedCommon = [...stage.files.keys()].filter(file => native.files.has(file) && stage.files.get(file) !== native.files.get(file));
function entry(root) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return { script: html.match(/\/assets\/index-[^"\s]+\.js/)?.[0] ?? null,
    stylesheet: html.match(/\/assets\/index-[^"\s]+\.css/)?.[0] ?? null };
}
console.log(JSON.stringify({ schema: 'casimirbot.local_mvp_client_drift.v1', mode: 'read_only',
  stagedFiles: stage.files.size, installedFiles: native.files.size,
  stagedTreeSha256: stage.tree, installedTreeSha256: native.tree,
  stagedOnly: stageOnly.length, installedOnly: nativeOnly.length,
  changedCommon, sameTree: stage.tree === native.tree,
  stagedEntry: entry(staged), installedEntry: entry(installed) }, null, 2));
