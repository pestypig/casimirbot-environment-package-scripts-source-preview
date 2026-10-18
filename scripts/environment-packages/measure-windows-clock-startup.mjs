import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';

assert.equal(process.platform,'win32');
const sha=file=>{const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(65536),hash=createHash('sha256');
  try {let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));return hash.digest('hex');}
  finally{fs.closeSync(fd);}};
const review=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json','utf8'));
assert(Date.now()<Date.parse(review.expiresAt));
for(const name of ['EnvironmentClockJob.cs','EnvironmentClockIsolationLease.cs'])
  assert.equal(sha('apps/desktop/native/'+name),review.sourceSha256[name]);
const prior=JSON.parse(fs.readFileSync(fs.readFileSync('.tmp/g16a-startup-comparison-path.txt','utf8').trim(),'utf8'));
const root=prior.results.at(-1).leaseRoot;
assert(root.startsWith(path.join(fs.realpathSync(os.tmpdir()),'casimirbot-clock-startup-')));
for(let p=root;;p=path.dirname(p)){assert(!fs.lstatSync(p).isSymbolicLink());if(path.dirname(p)===p)break;}
assert.equal(fs.readFileSync(path.join(root,'clock-isolation.journal'),'utf8').split('\n')[3],'cleaned');
assert.equal(sha(path.join(root,'node.exe')),review.files['node.exe'].sha256);
const entryHash='d7e56c123d29587091c6ee8adbc9492bef07f92a9fe9bd86d6c2d1231949a692';
assert.equal(sha(path.join(root,'clock.cjs')),entryHash);
const helper=path.resolve('.tmp/g16a-private-clock-runtime-20260926/clock-bridge.exe');
assert.equal(sha(helper),review.files['clock-bridge.exe'].sha256);
const output=fs.mkdtempSync(path.join(fs.realpathSync('.tmp'),'g16a-startup-probe-'));
const probe=path.join(output,'startup-probe.exe');
const driver='tests/fixtures/desktop-environment-clock-startup-probe.cs';
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const compiled=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${probe}`,
  path.resolve('apps/desktop/native/EnvironmentClockJob.cs'),path.resolve('apps/desktop/native/EnvironmentClockIsolationLease.cs'),path.resolve(driver)],
  {windowsHide:true,encoding:'utf8',timeout:30000});
assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
const now=Date.now();
const request={schema:'helix.environment_connector.probe_request.v1',probe_request_id:`probe:diagnostic-${randomUUID()}`,
  capability_id:'com.casimirbot.system.clock.read',capability_version:1,catalog_snapshot_id:'catalog:private-clock',
  arguments:{clock:'monotonic'},constraints:{read_only:true,side_effects_allowed:false,max_duration_ms:5000},
  created_at:new Date(now).toISOString(),deadline_at:new Date(now+5000).toISOString(),assistant_answer:false,raw_content_included:false};
const env={SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,
  LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA,TEMP:os.tmpdir(),TMP:os.tmpdir()};
const started=Date.now(),events=[];
let stderr='',pending='',bytes=0;
const child=spawn(probe,[root,review.files['node.exe'].sha256,entryHash],{env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
child.stdin.on('error',()=>{});
child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>98304){child.kill('SIGKILL');return;}pending+=chunk;
  while(pending.includes('\n')){const end=pending.indexOf('\n'),line=pending.slice(0,end);pending=pending.slice(end+1);
    try{events.push({receivedMs:Date.now()-started,...JSON.parse(line)});}catch{child.kill('SIGKILL');}}});
child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>4096)child.kill('SIGKILL');});
const exit=await new Promise(resolve=>{child.once('error',()=>resolve({code:null,error:'spawn_failed'}));child.once('close',code=>resolve({code}));
  child.stdin.end(JSON.stringify(request));});
clearTimeout(timer);
// Explicit recovery uses the unchanged pinned helper and its fixed owned root.
const recovery=spawnSync(helper,['recover',root,review.files['node.exe'].sha256,entryHash,String(process.pid)],
  {env,windowsHide:true,shell:false,encoding:'utf8',timeout:10000,maxBuffer:98304});
const result={schema:'casimirbot.private_clock_native_startup_diagnostic.v1',at:new Date().toISOString(),root,
  driverSha256:sha(driver),probeSha256:sha(probe),compilerSha256:sha(compiler),scriptSha256:sha('scripts/environment-packages/measure-windows-clock-startup.mjs'),
  review,exit,stderr,elapsedMs:Date.now()-started,events,recovery:{code:recovery.status,stdout:recovery.stdout,stderr:recovery.stderr},
  diagnosticOnly:true,approvedHelperChanged:false,composedHostAcceptance:false};
const resultPath=path.join(output,'result.json');fs.writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n');
fs.writeFileSync('.tmp/g16a-startup-probe-path.txt',resultPath+'\n');
console.log(JSON.stringify({resultPath,exit,events,recoveryCode:recovery.status}));
assert.equal(recovery.status,0);assert.equal(exit.code,0);assert.equal(stderr,'');
assert.equal(fs.readFileSync(path.join(root,'clock-isolation.journal'),'utf8').split('\n')[3],'cleaned');
const frame=events.find(x=>x.outputBase64);assert(frame);
assert.equal(JSON.parse(Buffer.from(frame.outputBase64,'base64')).outcome,'succeeded');
