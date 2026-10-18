import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {helixEnvironmentConnectorProbeRequestSchema,helixEnvironmentConnectorProbeResultSchema,
  HELIX_ENVIRONMENT_PROBE_REQUEST_V1_SCHEMA,HELIX_SYSTEM_CLOCK_READ_CAPABILITY} from '../../shared/helix-environment-connector.ts';

if(process.platform!=='win32')throw Error('Windows execution required; no skipped acceptance');
const root=process.cwd(), temp=fs.realpathSync(path.join(root,'.tmp'));
const output=fs.mkdtempSync(path.join(temp,'g16a-windows-job-'));
assert.equal(path.dirname(fs.realpathSync(output)),temp);
const source='apps/desktop/native/EnvironmentClockJob.cs', driver='tests/fixtures/desktop-environment-job-probe.cs';
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const executable=path.join(output,'job-probe.exe');
const compiled=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${executable}`,path.resolve(source),path.resolve(driver)],
  {cwd:root,windowsHide:true,encoding:'utf8',timeout:30000});
if(compiled.status!==0)throw Error(`Compilation failed: ${compiled.stdout}\n${compiled.stderr}`);
const results=[], activeHelpers=new Set();
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const review=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-private.json','utf8'));
const clockEntry=process.env.G16A_CLOCK_ENTRY;
assert(clockEntry&&fs.existsSync(clockEntry),'G16A_CLOCK_ENTRY must name the retained reviewed clock.cjs; do not skip protocol proof');
assert.equal(sha(clockEntry),review.files['clock.cjs']);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const noChild=async pid=>{const end=Date.now()+3000;while(alive(pid)&&Date.now()<end)await sleep(20);assert.equal(alive(pid),false,'Contained process still alive');};
const fixture=(name,mode)=>{
  const folder=path.join(output,name);fs.mkdirSync(folder);
  const entry=path.join(folder,'clock.cjs');
  fs.writeFileSync(entry,`const fs=require('node:fs'),path=require('node:path');
const result=value=>fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(value));
fs.writeFileSync(path.join(__dirname,'entered'),'yes');
if(process.env.G16A_JOB_CANARY||process.env.NODE_OPTIONS){result({environmentLeaked:true});process.exit(91);}
const mode=${JSON.stringify(mode)};
if(process.argv[2]==='grandchild'){fs.writeFileSync(path.join(__dirname,'grandchild'),'unexpected');process.exit(0);}
if(mode==='success'){const buffer=Buffer.alloc(64*1024*1024,1);result({ok:buffer[0]===1});}
if(mode==='hang'){result({started:true});setInterval(()=>{},1000);}
if(mode==='memory'){const chunks=[];try{for(let i=0;i<32;i++)chunks.push(Buffer.alloc(16*1024*1024,1));result({overLimit:true});}
catch(error){result({allocationDenied:true});process.exit(17);}}
if(mode==='spawn'){const child=require('node:child_process').spawnSync(process.execPath,[__filename,'grandchild'],{windowsHide:true,timeout:1000});result({spawnBlocked:Boolean(child.error)||child.status!==0});}
if(mode==='echo'||mode==='duplex'){if(mode==='duplex')process.stdout.write('o'.repeat(60000));const parts=[];process.stdin.on('data',b=>parts.push(b));process.stdin.on('end',()=>process.stdout.write(mode==='echo'?Buffer.concat(parts):JSON.stringify({received:Buffer.concat(parts).length})));}
if(mode==='stdout'){process.stdout.write('x'.repeat(70000));}
if(mode==='stderr'){process.stderr.write('private-fixture-detail'.repeat(400));}
if(mode==='stderr-small'){process.stderr.write('private-fixture-detail');}
if(mode==='exit'){process.exit(3);}
`);
  return {folder,entry,receipt:path.join(folder,'result.json')};
};
const start=(f,mode)=>{
  const child=spawn(executable,[mode,process.execPath,f.entry],{windowsHide:true,shell:false,
    env:{SystemRoot:process.env.SystemRoot,G16A_JOB_CANARY:'harmless-canary',NODE_OPTIONS:'--no-warnings'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',firstDone=false,firstResolve,firstReject;
  const first=new Promise((resolve,reject)=>{firstResolve=resolve;firstReject=reject;});
  child.stdout.on('data',b=>{stdout+=b;if(!firstDone&&stdout.includes('\n')){firstDone=true;try{firstResolve(JSON.parse(stdout.split('\n')[0]));}catch(error){firstReject(error);}}});
  child.stderr.on('data',b=>stderr+=b);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{if(!firstDone)firstReject(Error('No readiness record: '+stderr));resolve({code,stdout,stderr});});});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  const lease={child,done}; activeHelpers.add(lease);
  const settled=()=>{clearTimeout(timer);activeHelpers.delete(lease);};
  void done.then(settled,settled);
  return {child,first,done};
};
const lines=out=>out.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
const run=async(name,fn)=>{
  try {const details=await fn();results.push({name,status:'passed',details});console.log(name+': PASS');}
  finally {
    // Only handles created by this verification driver; never enumerate/kill
    // unrelated processes. Closing the helper also closes its anonymous job.
    const remaining=[...activeHelpers];
    for(const lease of remaining)lease.child.kill('SIGKILL');
    await Promise.allSettled(remaining.map(lease=>lease.done));
  }
};
await run('bounded-clock-process-and-minimal-environment',async()=>{
  const f=fixture('success','success'),p=start(f,'run');const ready=await p.first,out=await p.done;
  assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)),{ok:true});
  const stats=lines(out).at(-1);assert.equal(stats.exit,0);assert(stats.peakJobMemory>64*1024*1024&&stats.peakJobMemory<=256*1024*1024);
  await noChild(ready.pid);
  return {pid:ready.pid,...stats,confirmedExited:true,environmentCanaryAbsent:true};
});
await run('child-process-creation-denied',async()=>{
  const f=fixture('spawn','spawn'),p=start(f,'run');const ready=await p.first,out=await p.done;
  assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)),{spawnBlocked:true});
  assert.equal(fs.existsSync(path.join(f.folder,'grandchild')),false);await noChild(ready.pid);
  return {pid:ready.pid,spawnBlocked:true,grandchildMarkerAbsent:true,confirmedExited:true};
});
await run('committed-memory-ceiling-enforced',async()=>{
  const f=fixture('memory','memory'),p=start(f,'run');const ready=await p.first,out=await p.done;
  assert.equal(out.code,0,out.stderr);const stats=lines(out).at(-1);assert.notEqual(stats.exit,0);
  assert(stats.peakJobMemory>128*1024*1024&&stats.peakJobMemory<=256*1024*1024);
  if(fs.existsSync(f.receipt))assert.equal(JSON.parse(fs.readFileSync(f.receipt)).overLimit,undefined);
  await noChild(ready.pid);
  return {pid:ready.pid,...stats,confirmedExited:true,overLimitCompletionAbsent:true};
});
await run('explicit-stop-confirms-owned-process-exit',async()=>{
  const f=fixture('stop','hang'),p=start(f,'hold');const ready=await p.first;
  p.child.stdin.end('\n');const out=await p.done;assert.equal(out.code,0,out.stderr);assert.equal(lines(out).at(-1).exit,125);await noChild(ready.pid);
  return {pid:ready.pid,exit:125,confirmedExited:true};
});
for(const mode of ['hold','suspended'])await run('owner-death-cleans-'+mode,async()=>{
  const f=fixture('death-'+mode,'hang'),p=start(f,mode);const ready=await p.first;
  assert.equal(alive(ready.pid),true);
  if(mode==='suspended')assert.equal(fs.existsSync(f.receipt),false);
  else {const end=Date.now()+3000;while(!fs.existsSync(f.receipt)&&Date.now()<end)await sleep(20);assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)),{started:true});}
  p.child.kill('SIGKILL');await p.done;await noChild(ready.pid);
  if(mode==='suspended')assert.equal(fs.existsSync(f.receipt),false);
  return {pid:ready.pid,ownerKilledByOwnedHandle:true,confirmedExited:true,suspended:mode==='suspended'};
});
await run('reviewed-clock-protocol-over-native-pipes',async()=>{
  const folder=path.join(output,'reviewed');fs.mkdirSync(folder);const entry=path.join(folder,'clock.cjs');fs.copyFileSync(clockEntry,entry);
  const now=new Date();
  const request=helixEnvironmentConnectorProbeRequestSchema.parse({schema:HELIX_ENVIRONMENT_PROBE_REQUEST_V1_SCHEMA,
    probe_request_id:'probe:windows-job',capability_id:HELIX_SYSTEM_CLOCK_READ_CAPABILITY,capability_version:1,
    catalog_snapshot_id:'catalog:private-clock',arguments:{clock:'monotonic'},
    constraints:{read_only:true,side_effects_allowed:false,max_duration_ms:5000},created_at:now.toISOString(),
    deadline_at:new Date(now.getTime()+5000).toISOString(),assistant_answer:false,raw_content_included:false});
  const p=start({entry},'exchange'),ready=await p.first;p.child.stdin.end(JSON.stringify(request));const out=await p.done;
  assert.equal(out.code,0,out.stderr);const result=helixEnvironmentConnectorProbeResultSchema.parse(JSON.parse(Buffer.from(lines(out).at(-1).outputBase64,'base64').toString('utf8')));
  assert.equal(result.probe_request_id,request.probe_request_id);assert.equal(result.capability_id,request.capability_id);
  assert.equal(result.outcome,'succeeded');assert(Number.isSafeInteger(result.result.uptime_ms)&&result.result.uptime_ms>=0);
  assert.equal(result.model_invoked,false);assert.equal(result.side_effects_performed,false);await noChild(ready.pid);
  return {pid:ready.pid,entrySha256:sha(entry),confirmedExited:true,result};
});
for(const mode of ['echo','duplex'])await run('bounded-'+mode+'-exchange',async()=>{
  const f=fixture(mode,mode),p=start(f,'exchange'),ready=await p.first;
  const input=Buffer.alloc(65536,97);p.child.stdin.end(input);const out=await p.done;assert.equal(out.code,0,out.stderr);
  const returned=Buffer.from(lines(out).at(-1).outputBase64,'base64');
  if(mode==='echo')assert.deepEqual(returned,input);
  else {assert.equal(returned.subarray(0,60000).toString(),'o'.repeat(60000));assert.deepEqual(JSON.parse(returned.subarray(60000)),{received:65536});}
  await noChild(ready.pid);return {pid:ready.pid,inputBytes:input.length,outputBytes:returned.length,confirmedExited:true};
});
for(const [mode,expected] of [['stdout','clock_job_stdout_limit'],['stderr','clock_job_stderr_limit'],
  ['stderr-small','clock_job_stderr_present'],['exit','clock_job_process_failed'],['hang','clock_job_deadline_expired']])
await run('reject-exchange-'+mode,async()=>{
  const f=fixture('exchange-'+mode,mode),p=start(f,mode==='hang'?'exchange-short':'exchange'),ready=await p.first;
  // A blocked writer must also exit when the deadline terminates the child.
  p.child.stdin.end(mode==='hang'?Buffer.alloc(65536,97):'');const out=await p.done;
  assert.equal(out.code,1);assert.equal(out.stderr.trim(),expected);assert.equal(lines(out).length,1);
  assert.equal(out.stderr.includes('private-fixture-detail'),false);await noChild(ready.pid);
  return {pid:ready.pid,error:expected,noPartialResult:true,confirmedExited:true};
});
await run('reject-oversized-input-before-resume',async()=>{
  const f=fixture('oversized-input','echo'),p=start(f,'exchange'),ready=await p.first;p.child.stdin.end(Buffer.alloc(65537,97));
  const out=await p.done;assert.equal(out.code,1);assert.equal(out.stderr.trim(),'clock_job_input_invalid');
  assert.equal(fs.existsSync(path.join(f.folder,'entered')),false);await noChild(ready.pid);
  return {pid:ready.pid,error:'clock_job_input_invalid',childNotResumed:true,confirmedExited:true};
});
const receipt={schema:'casimirbot.windows_clock_job_checks.v1',at:new Date().toISOString(),platform:process.platform,
  architecture:process.arch,sourceSha256:sha(source),driverSha256:sha(driver),scriptSha256:sha('scripts/environment-packages/test-windows-clock-job.mjs'),
  compiler:{path:compiler,sha256:sha(compiler)},runtime:{path:process.execPath,version:process.version,sha256:sha(process.execPath)},
  helper:{path:executable,sha256:sha(executable)},memoryLimitBytes:256*1024*1024,results,
  notProven:['filesystem/network sandbox','authenticated runtime admission','desktop host integration','Electron runtime compatibility','signed packaging','durable execution result recovery']};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(receipt,null,2)+'\n');
fs.writeFileSync(path.join(temp,'g16a-windows-job-result-path.txt'),path.join(output,'result.json')+'\n');
console.log(JSON.stringify({passed:results.length,receipt:path.join(output,'result.json')}));
