const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const ts = require('typescript');

const root = fs.realpathSync(process.cwd());
const manifestPath = path.resolve(process.argv[2] || '.tmp/local-mvp-source-checkpoint-reviewed-navigation/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schema !== 'casimirbot.local_mvp_source_checkpoint.v1') throw Error('unexpected_checkpoint_schema');
const sealed = new Set(manifest.files.map(item => item.file));
const starts = [...new Set([
  'apps/desktop/src/main.ts', 'apps/desktop/src/preload.ts', 'server/index.ts', 'client/src/main.tsx', 'vite.config.ts',
  ...manifest.files.map(item => item.file).filter(file => /\.(tsx?|jsx?|mjs|cjs)$/.test(file)),
])];
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root).options;
const seen = new Set(), unresolved = [], edges = [];
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  if (seen.size > 10000) throw Error('review_inventory_limit');
  const full = path.resolve(file);
  for (const item of ts.preProcessFile(fs.readFileSync(full, 'utf8'), true, true).importedFiles) {
    const specifier = item.fileName;
    if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('@shared/')) continue;
    const module = ts.resolveModuleName(specifier, full, options, ts.sys).resolvedModule;
    if (!module) { unresolved.push({ from: file, specifier }); continue; }
    const resolved = fs.realpathSync(module.resolvedFileName);
    if (!resolved.startsWith(root + path.sep) || resolved.includes(path.sep + 'node_modules' + path.sep)) continue;
    const next = path.relative(root, resolved).replaceAll('\\', '/');
    edges.push({ from: file, to: next, specifier });
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(next)) walk(next);
  }
}
starts.forEach(walk);
const status = cp.spawnSync('git', ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], {
  encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
});
if (status.status !== 0) throw Error('git_status_failed');
const changed = new Set(status.stdout.split('\0').filter(Boolean).map(line => line.slice(3).replaceAll('\\', '/')));
const missing = [...seen].filter(file => changed.has(file) && !sealed.has(file));
const assetImports = [], unresolvedAssets = [], changedAssetsOutsideCheckpoint = [];
for (const item of unresolved) {
  const cleanSpecifier = item.specifier.split('?')[0];
  const candidate = cleanSpecifier.startsWith('@/')
    ? path.resolve(root, 'client/src', cleanSpecifier.slice(2))
    : path.resolve(path.dirname(path.resolve(item.from)), cleanSpecifier);
  const relative = path.relative(root, candidate).replaceAll('\\', '/');
  if (relative.startsWith('../') || path.isAbsolute(relative) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    unresolvedAssets.push(item);
    continue;
  }
  assetImports.push({ from: item.from, to: relative, specifier: item.specifier });
  if (changed.has(relative) && !sealed.has(relative)) changedAssetsOutsideCheckpoint.push(relative);
}
const dynamic = [], unresolvedDynamic = [];
for (const file of sealed) {
  if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(file)) continue;
  const full = path.resolve(file);
  const tree = ts.createSourceFile(file, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function inspect(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteralLike(argument)) {
        unresolvedDynamic.push({ from: file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
      } else {
        const specifier = argument.text;
        const module = ts.resolveModuleName(specifier, full, options, ts.sys).resolvedModule;
        if (!module) unresolvedDynamic.push({ from: file, specifier });
        else {
          const resolved = fs.realpathSync(module.resolvedFileName);
          if (resolved.startsWith(root + path.sep) && !resolved.includes(path.sep + 'node_modules' + path.sep)) {
            dynamic.push({ from: file, to: path.relative(root, resolved).replaceAll('\\', '/'), specifier });
          }
        }
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(tree);
}
const changedDynamicOutsideCheckpoint = dynamic.filter(edge => changed.has(edge.to) && !sealed.has(edge.to));
// These are source inputs read or copied by build-host.mjs, package-local-mvp.mjs,
// and stage-runtime.mjs outside the TypeScript import graph. Generated dist/public,
// installed dependencies, and optional Solar candidates still need their own checks.
const knownBuildInputs = [
  'apps/desktop/package.json', 'apps/desktop/package-lock.json',
  'apps/desktop/release-slice.v1.json', 'apps/desktop/tunnel-client.v1.json',
  'data/starsim/solar-product-registry.v1.json',
  'data/starsim/solar-reference-pack.v1.json',
  'configs/ideology-verifiers.json', 'docs/ethos/ideology.json',
  '.agents/plugins/marketplace.json',
  'scripts/helix-minecraft-launch-fabric-loopback.ps1',
  'scripts/helix-minecraft-start-fabric-server.ps1',
];
const copiedSourceTrees = ['apps/desktop/scripts/', 'plugins/casimirbot-device-check/'];
const missingBuildInputs = knownBuildInputs.filter(file => !fs.existsSync(path.resolve(file)));
const changedBuildInputsOutsideCheckpoint = [...changed].filter(file =>
  (knownBuildInputs.includes(file) || copiedSourceTrees.some(prefix => file.startsWith(prefix))) && !sealed.has(file));
const result = { visitedFiles: seen.size, edges: edges.length, changed: [...seen].filter(file => changed.has(file)).length,
  missingFromCheckpoint: missing, unresolved: unresolved.length, assetImports: assetImports.length,
  unresolvedAssets, changedAssetsOutsideCheckpoint, dynamicImports: dynamic.length,
  changedDynamicOutsideCheckpoint, unresolvedDynamic, knownBuildInputs: knownBuildInputs.length,
  copiedSourceTrees: copiedSourceTrees.length, missingBuildInputs, changedBuildInputsOutsideCheckpoint,
  scope: 'Static TypeScript-resolved imports, existing local Vite assets, literal dynamic imports, and known desktop build/stage source inputs; generated assets, transitive runtime files, and remaining test inputs need separate review.' };
console.log(JSON.stringify(result));
if (missing.length || unresolvedAssets.length || changedAssetsOutsideCheckpoint.length ||
    changedDynamicOutsideCheckpoint.length || unresolvedDynamic.length ||
    missingBuildInputs.length || changedBuildInputsOutsideCheckpoint.length) process.exitCode = 1;
