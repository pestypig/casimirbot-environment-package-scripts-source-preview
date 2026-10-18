import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createTarGzip } from './tar-archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sdkRoot = process.argv[2];
const output = process.argv[3];
if (!sdkRoot || !output || !path.isAbsolute(sdkRoot) || !path.isAbsolute(output)) throw new Error('absolute_sdk_and_output_paths_required');
if (fs.existsSync(output)) throw new Error('output_must_be_new');
const proof = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/eh-g8-codex-first-paid-product-delivery-v1/c10-local/2026-09-26/package-proof.json')));
const builds = proof.packages;
if (!Array.isArray(builds)) throw new Error('reviewed_c10_proof_shape_changed');
const reviewed = builds.find(item => item.archiveHash === '443523d917a25580acc2d6406132abd92a5ab42f9b4e4b2cae92de6e3317dfdb');
if (!reviewed) throw new Error('reviewed_c10_archive_missing');
for (const [name, hash] of Object.entries(reviewed.inventory)) {
  const file = path.resolve(sdkRoot, name);
  if (!file.startsWith(path.resolve(sdkRoot) + path.sep) || fs.lstatSync(file).isSymbolicLink() || sha(fs.readFileSync(file)) !== hash) throw new Error('c10_installed_bytes_changed');
}
const sdkManifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
const zodManifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/zod/package.json')));
if (sdkManifest.dependencies.zod !== zodManifest.version) throw new Error('zod_version_drift');
const entry = path.join(root, 'apps/desktop/environment-packages/system-clock/entry.ts');
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'node',
  target: 'node24', format: 'cjs', minify: false, sourcemap: false, legalComments: 'inline',
  alias: {
    '@casimirbot/environment-connector-kit/examples/system-clock': path.join(sdkRoot, 'dist/connectors/environment/examples/system-clock/connector.js'),
    '@casimirbot/environment-connector-kit': path.join(sdkRoot, 'dist/connectors/environment/contract/v1/index.js'),
    zod: path.join(root, 'node_modules/zod/index.js'),
  }, metafile: true,
});
const entries = [
  { name: 'clock.cjs', bytes: Buffer.from(bundle.outputFiles[0].contents) },
  { name: 'LICENSE', bytes: Buffer.from('Private local evaluation only. No public distribution license is granted.\n') },
  { name: 'THIRD_PARTY_NOTICES.txt', bytes: Buffer.from(`Bundled dependency: zod ${zodManifest.version}, ${zodManifest.license}.\n\n${fs.readFileSync(path.join(root, 'node_modules/zod/LICENSE'), 'utf8')}\n`) },
  { name: 'provenance.json', bytes: Buffer.from(JSON.stringify({ schema: 'casimirbot.private_clock_provenance.v1',
    c10ArchiveSha256: reviewed.archiveHash, entrySha256: sha(fs.readFileSync(entry)),
    builderSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    archiveWriterSha256: sha(fs.readFileSync(path.join(root, 'scripts/environment-packages/tar-archive.mjs'))),
    inputs: Object.fromEntries(Object.keys(bundle.metafile.inputs).map(file => [file, sha(fs.readFileSync(path.resolve(root, file)))])),
    node: process.version, purpose: 'private-evaluation-only', providerRequired: false,
  }, null, 2) + '\n') },
].sort((a, b) => a.name.localeCompare(b.name));
const archive = createTarGzip(entries);
const manifest = { schema: 'casimirbot.environment_package_review.v1', packageId: 'com.casimirbot.system.clock',
  version: '1.0.0-private.1', publisher: 'publisher:casimirbot', archiveSha256: sha(archive),
  files: Object.fromEntries(entries.map(entry => [entry.name, sha(entry.bytes)])), entryPoint: 'clock.cjs',
  policyRevision: 'g16a-private-clock-install-2026-09-26.1', expiresAt: '2026-10-01T00:00:00.000Z',
  platforms: ['win32'], minNodeMajor: 24, privateOnly: true };
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'clock.tgz'), archive, { flag: 'wx' });
fs.writeFileSync(path.join(output, 'review-candidate.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, archiveSha256: manifest.archiveSha256, bytes: archive.length, files: entries.length, reviewRequired: true }));
