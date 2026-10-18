import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform,'win32');
assert.equal(process.argv.length,2);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const review=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json','utf8'));
assert.equal(review.revision,'g16a-private-clock-native-artifacts-2026-09-26.1');
assert(Date.now()<Date.parse(review.expiresAt));
const evidencePath='docs/evidence/eh-g8-codex-first-paid-product-delivery-v1/launch-program/2026-09-26-g16a-native-read-buffer-candidate.json';
const evidence=JSON.parse(fs.readFileSync(evidencePath,'utf8').replace(/^\uFEFF/,''));
const leasePath='apps/desktop/native/EnvironmentClockIsolationLease.cs';
const expected={...review.sourceSha256,'EnvironmentClockIsolationLease.cs':evidence.artifacts.find(a=>a.path===leasePath)?.sha256};
assert.match(expected['EnvironmentClockIsolationLease.cs'],/^[a-f0-9]{64}$/);
const sources=Object.keys(expected).map(name=>path.resolve('apps/desktop/native',name));
for(const source of sources)assert.equal(sha(source),expected[path.basename(source)]);
const output=fs.mkdtempSync(path.join(fs.realpathSync('.tmp'),'g16a-clock-candidate-'));
const helperPath=path.join(output,'clock-bridge.exe');
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const result=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${helperPath}`,...sources],
  {windowsHide:true,shell:false,encoding:'utf8',timeout:30000});
assert.equal(result.status,0,result.stdout+result.stderr);
for(const source of sources)assert.equal(sha(source),expected[path.basename(source)]);
const buildPath=path.join(output,'candidate-build.json');
fs.writeFileSync(buildPath,JSON.stringify({schema:'casimirbot.private_clock_candidate_build.v1',candidateOnly:true,
  instrumented:false,helperPath,helperSha256:sha(helperPath),helperBytes:fs.statSync(helperPath).size,
  sourceSha256:expected,compilerSha256:sha(compiler),sourceEvidence:evidencePath,sourceEvidenceSha256:sha(evidencePath),
  scriptSha256:sha('scripts/environment-packages/build-clock-native-candidate.mjs'),builtAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
fs.writeFileSync('.tmp/g16a-clock-candidate-build-path.txt',buildPath+'\n');
console.log(JSON.stringify({buildPath,helperSha256:sha(helperPath)}));
