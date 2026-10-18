import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {helixEnvironmentConnectorProbeRequestSchema,helixEnvironmentConnectorProbeResultSchema,
  HELIX_ENVIRONMENT_PROBE_REQUEST_V1_SCHEMA,HELIX_SYSTEM_CLOCK_READ_CAPABILITY} from '../../shared/helix-environment-connector.ts';

if(process.platform!=='win32')throw Error('Windows execution required');
const root=process.cwd(),temp=fs.realpathSync(path.join(root,'.tmp'));
const output=fs.mkdtempSync(path.join(temp,'g16a-clock-isolation-'));
assert.equal(path.dirname(fs.realpathSync(output)),temp);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source='apps/desktop/native/EnvironmentClockJob.cs',driver='tests/fixtures/desktop-environment-isolation-probe.cs';
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const executable=path.join(output,'isolation-probe.exe'),runtime=path.join(output,'node.exe'),entry=path.join(output,'clock.cjs');
const review=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-private.json','utf8'));
const clockEntry=process.env.G16A_CLOCK_ENTRY;
assert(clockEntry&&fs.existsSync(clockEntry),'Retained reviewed clock entry required');
assert.equal(sha(clockEntry),review.files['clock.cjs']);
fs.copyFileSync(process.execPath,runtime);assert.equal(sha(runtime),sha(process.execPath));
const compiled=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${executable}`,path.resolve(source),path.resolve(driver)],
  {cwd:root,windowsHide:true,encoding:'utf8',timeout:30000});
assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
const results=[];
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const run=async(name,input)=>{
  const child=spawn(executable,[output],{cwd:root,windowsHide:true,shell:false,
    env:{SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,
      USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,
      APPDATA:process.env.APPDATA,TEMP:output,TMP:output,
      G16A_ISOLATION_CANARY:'harmless-env-canary',NODE_OPTIONS:'--no-warnings'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  child.stdin.on('error',()=>{});child.stdin.end(input);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);}).finally(()=>clearTimeout(timer));
  // Preserve failures, including profile cleanup, before raising any assertion.
  fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify({code,stdout,stderr},null,2)+'\n');
  assert.equal(code,0,stderr||stdout);
  const lines=stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.equal(lines[0].appContainer,true);assert.equal(lines[0].capabilityCount,1);
  assert.equal(lines[0].onlyRegistryRead,true);
  assert.equal(lines.at(-1).temporaryProfileRemoved,true);assert.equal(alive(lines[0].pid),false);
  return {token:lines[0],result:JSON.parse(Buffer.from(lines[1].outputBase64,'base64').toString('utf8')),temporaryProfileRemoved:true,confirmedExited:true};
};
fs.copyFileSync(clockEntry,entry);
const now=new Date();
const request=helixEnvironmentConnectorProbeRequestSchema.parse({schema:HELIX_ENVIRONMENT_PROBE_REQUEST_V1_SCHEMA,
  probe_request_id:'probe:windows-lpac',capability_id:HELIX_SYSTEM_CLOCK_READ_CAPABILITY,capability_version:1,
  catalog_snapshot_id:'catalog:private-clock',arguments:{clock:'monotonic'},
  constraints:{read_only:true,side_effects_allowed:false,max_duration_ms:5000},created_at:now.toISOString(),
  deadline_at:new Date(now.getTime()+5000).toISOString(),assistant_answer:false,raw_content_included:false});
const clock=await run('reviewed-clock',JSON.stringify(request));
helixEnvironmentConnectorProbeResultSchema.parse(clock.result);
assert.equal(clock.result.probe_request_id,request.probe_request_id);assert.equal(clock.result.outcome,'succeeded');
assert.equal(clock.result.capability_id,request.capability_id);
assert(Number.isSafeInteger(clock.result.result.uptime_ms)&&clock.result.result.uptime_ms>=0);
assert.equal(clock.result.model_invoked,false);assert.equal(clock.result.side_effects_performed,false);
results.push({name:'reviewed-clock-in-lpac',status:'passed',details:clock});console.log('reviewed-clock-in-lpac: PASS');

const privateCanary=path.join(output,'private-canary.txt'),packageCanary=path.join(output,'app-packages-canary.txt');
fs.writeFileSync(privateCanary,'harmless-private-canary');fs.writeFileSync(packageCanary,'harmless-package-canary');
assert.equal(fs.readFileSync(privateCanary,'utf8'),'harmless-private-canary');
fs.writeFileSync(entry,`const fs=require('node:fs'),path=require('node:path');
const check=fn=>{try{fn();return 'unexpected-access';}catch(e){return e.code;}};
const result={privateRead:check(()=>fs.readFileSync(path.join(__dirname,'private-canary.txt'))),
allPackagesRead:check(()=>fs.readFileSync(path.join(__dirname,'app-packages-canary.txt'))),
writeNew:check(()=>fs.writeFileSync(path.join(__dirname,'unexpected.txt'),'unexpected')),
modifyEntry:check(()=>fs.appendFileSync(__filename,'// unexpected')),
modifyRuntime:check(()=>fs.openSync(process.execPath,'r+')),
environmentCanaryAbsent:!process.env.G16A_ISOLATION_CANARY&&!process.env.NODE_OPTIONS};process.stdout.write(JSON.stringify(result));`);
const entryHash=sha(entry),fileResult=await run('filesystem','');
assert.equal(fileResult.result.environmentCanaryAbsent,true);
for(const name of ['privateRead','allPackagesRead','writeNew','modifyEntry','modifyRuntime'])
  assert(['EACCES','EPERM'].includes(fileResult.result[name]),JSON.stringify(fileResult.result));
assert.equal(sha(entry),entryHash);assert.equal(sha(runtime),sha(process.execPath));
assert.equal(fs.existsSync(path.join(output,'unexpected.txt')),false);
assert.equal(fs.readFileSync(privateCanary,'utf8'),'harmless-private-canary');
results.push({name:'filesystem-denials-and-lpac-opt-out',status:'passed',details:fileResult});console.log('filesystem-denials-and-lpac-opt-out: PASS');

let accepted=0;
const server=net.createServer(socket=>{accepted++;socket.end();});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
try {
  const port=server.address().port;
  await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.end();resolve();});socket.once('error',reject);});
  assert.equal(accepted,1);
  fs.writeFileSync(entry,`const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:${port}});
socket.setTimeout(2000);socket.on('connect',()=>{process.stdout.write(JSON.stringify({network:'unexpected-access'}));socket.destroy();});
socket.on('error',e=>process.stdout.write(JSON.stringify({network:e.code})));
socket.on('timeout',()=>{process.stdout.write(JSON.stringify({network:'timeout-not-proof'}));socket.destroy();});`);
  const network=await run('network','');
  assert(['EACCES','EPERM'].includes(network.result.network),JSON.stringify(network));assert.equal(accepted,1);
  results.push({name:'loopback-network-denied-with-reachable-control',status:'passed',details:network});console.log('loopback-network-denied-with-reachable-control: PASS');
} finally {await new Promise(resolve=>server.close(resolve));}
const receipt={schema:'casimirbot.windows_clock_isolation_checks.v1',at:new Date().toISOString(),platform:process.platform,
  architecture:process.arch,sourceSha256:sha(source),driverSha256:sha(driver),scriptSha256:sha('scripts/environment-packages/test-windows-clock-isolation.mjs'),
  compiler:{path:compiler,sha256:sha(compiler)},runtime:{version:process.version,sha256:sha(runtime)},helperSha256:sha(executable),
  reviewedEntrySha256:review.files['clock.cjs'],results,
  notProven:['complete filesystem/network threat model','desktop host integration','authenticated runtime admission','Electron runtime compatibility','signed packaging','durable execution recovery']};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(receipt,null,2)+'\n');
fs.writeFileSync(path.join(temp,'g16a-clock-isolation-result-path.txt'),path.join(output,'result.json')+'\n');
console.log(JSON.stringify({passed:results.length,receipt:path.join(output,'result.json')}));
