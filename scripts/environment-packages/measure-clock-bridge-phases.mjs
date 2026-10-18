import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';

assert.equal(process.platform,'win32');
const sha=file=>{const fd=fs.openSync(file,'r'),b=Buffer.alloc(65536),h=createHash('sha256');
  try{let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}};
const review=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json','utf8'));
assert(Date.now()<Date.parse(review.expiresAt));
const native='apps/desktop/native/';
for(const [name,hash] of Object.entries(review.sourceSha256))assert.equal(sha(native+name),hash);
const entryHash='d7e56c123d29587091c6ee8adbc9492bef07f92a9fe9bd86d6c2d1231949a692';
const prior=JSON.parse(fs.readFileSync(fs.readFileSync('.tmp/g16a-startup-comparison-path.txt','utf8').trim(),'utf8'));
const entry=path.join(prior.results.at(-1).leaseRoot,'clock.cjs');assert.equal(sha(entry),entryHash);
const approved=path.resolve('.tmp/g16a-private-clock-runtime-20260926');
for(const name of ['node.exe','clock-bridge.exe'])assert.equal(sha(path.join(approved,name)),review.files[name].sha256);
const output=fs.mkdtempSync(path.join(fs.realpathSync('.tmp'),'g16a-bridge-phases-'));
const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'casimirbot-clock-phases-'));
const nested=process.argv.includes('--nested');
const approvedBaseline=process.argv.includes('--approved');
const hostDiagnostic=process.argv.includes('--build-host');
const bufferedHash=process.argv.includes('--buffered-hash');
assert(process.argv.slice(2).every(a=>['--nested','--approved','--build-host','--buffered-hash'].includes(a)));
assert(!bufferedHash || hostDiagnostic);
assert(!(hostDiagnostic&&approvedBaseline));
const root=nested?path.join(base,'clock-runtime','v1',createHash('sha256').update(base).digest('hex')):base;
if(nested)fs.mkdirSync(root,{recursive:true});
const replace=(s,a,b)=>{assert.equal(s.indexOf(a),s.lastIndexOf(a));assert(s.includes(a));return s.replace(a,b);};
let bridge=fs.readFileSync(native+'EnvironmentClockBridge.cs','utf8');
const tracePath=path.join(base,'phases.jsonl');
if(hostDiagnostic)fs.writeFileSync(tracePath,'',{flag:'wx'});
const sink=hostDiagnostic?`System.IO.File.AppendAllText(@"${tracePath.replaceAll('"','""')}", line+"\\n");`:
  'System.Console.Error.WriteLine(line); System.Console.Error.Flush();';
const marker=String.raw`public static class ClockPhaseDiagnostic {
  private static readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
  public static void Mark(string phase) {
    using(var p=System.Diagnostics.Process.GetCurrentProcess()) {
      string line="{\"phase\":\""+phase+"\",\"elapsedMs\":"+clock.ElapsedMilliseconds+
        ",\"utcMs\":"+(long)(System.DateTime.UtcNow-new System.DateTime(1970,1,1,0,0,0,System.DateTimeKind.Utc)).TotalMilliseconds+
        ",\"pid\":"+p.Id+",\"workingSetBytes\":"+p.WorkingSet64+",\"cpuMs\":"+(long)p.TotalProcessorTime.TotalMilliseconds+"}";
      TRACE_SINK
    }
  }
}
`;
// Substitutions preserve all control flow; instrumentation stays in temporary copies.
bridge += '\n'+marker.replace('TRACE_SINK',sink);
for(const [a,b] of [
 ['uint owner;','ClockPhaseDiagnostic.Mark("main"); uint owner;'],
 ['WatchOwner(owner);','WatchOwner(owner); ClockPhaseDiagnostic.Mark("owner-watch");'],
 ['byte[] request=ReadExact(input,length),output;','byte[] request=ReadExact(input,length),output; ClockPhaseDiagnostic.Mark("input");'],
 ['var job=lease.StartSuspended();','ClockPhaseDiagnostic.Mark("lease"); var job=lease.StartSuspended(); ClockPhaseDiagnostic.Mark("suspended");'],
 ['output=job.Exchange(request,5000);','ClockPhaseDiagnostic.Mark("go"); output=job.Exchange(request,5000); ClockPhaseDiagnostic.Mark("exchange");'],
 ['// Result publication follows confirmed job/profile cleanup.','ClockPhaseDiagnostic.Mark("cleaned"); // Result publication follows confirmed job/profile cleanup.'],
])bridge=replace(bridge,a,b);
let lease=fs.readFileSync(native+'EnvironmentClockIsolationLease.cs','utf8').replaceAll('\r\n','\n');
if(bufferedHash) lease=replace(lease,
  'lease.runtimeRead=new FileStream(lease.Runtime,FileMode.Open,FileAccess.Read,FileShare.Read);',
  'lease.runtimeRead=new FileStream(lease.Runtime,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.SequentialScan);');
for(const [a,b] of [
 ['lease.ReadRecord(); lease.RecoverRecord();\n                foreach','lease.ReadRecord(); lease.RecoverRecord(); ClockPhaseDiagnostic.Mark("lease-recovered");\n                foreach'],
 ['lease.nonce=Guid.NewGuid().ToString("N");','ClockPhaseDiagnostic.Mark("hashes"); lease.nonce=Guid.NewGuid().ToString("N");'],
 ['lease.WriteRecord("created");','ClockPhaseDiagnostic.Mark("profile"); lease.WriteRecord("created");'],
 ['lease.WriteRecord("granted");','lease.WriteRecord("granted"); ClockPhaseDiagnostic.Mark("grants");'],
])lease=replace(lease,a,b);
const bridgeSource=path.join(output,'Bridge.cs'),leaseSource=path.join(output,'Lease.cs');
fs.writeFileSync(bridgeSource,bridge);fs.writeFileSync(leaseSource,lease);
const helper=approvedBaseline?path.join(approved,'clock-bridge.exe'):path.join(output,'bridge-diagnostic.exe');
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
if(!approvedBaseline){const compile=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${helper}`,
  path.resolve(native+'EnvironmentClockJob.cs'),bridgeSource,leaseSource],{windowsHide:true,encoding:'utf8',timeout:30000});
assert.equal(compile.status,0,compile.stdout+compile.stderr);}
if(hostDiagnostic){
  const buildPath=path.join(output,'host-build.json');
  fs.writeFileSync(buildPath,JSON.stringify({schema:'casimirbot.diagnostic_clock_host_build.v1',diagnosticOnly:true,
    helperPath:helper,helperSha256:sha(helper),tracePath,sourceSha256:review.sourceSha256,
    experimentalChange:bufferedHash?'runtime-file-buffer-64k-sequential':'none',
    generatedBridgeSha256:sha(bridgeSource),generatedLeaseSha256:sha(leaseSource),scriptSha256:sha('scripts/environment-packages/measure-clock-bridge-phases.mjs')},null,2)+'\n');
  fs.writeFileSync('.tmp/g16a-bridge-host-build-path.txt',buildPath+'\n');console.log(JSON.stringify({buildPath}));process.exit(0);
}
fs.copyFileSync(path.join(approved,'node.exe'),path.join(root,'node.exe'));fs.copyFileSync(entry,path.join(root,'clock.cjs'));
assert.equal(sha(path.join(root,'node.exe')),review.files['node.exe'].sha256);assert.equal(sha(path.join(root,'clock.cjs')),entryHash);
const env={SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,
  LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA,TEMP:root,TMP:root};
const attempts=[];
const resultPath=path.join(output,'result.json');
const persist=()=>fs.writeFileSync(resultPath,JSON.stringify({schema:'casimirbot.clock_bridge_phases.v1',at:new Date().toISOString(),root,nested,approvedBaseline,
  review,scriptSha256:sha('scripts/environment-packages/measure-clock-bridge-phases.mjs'),helperSha256:sha(helper),
  generatedBridgeSha256:sha(bridgeSource),generatedLeaseSha256:sha(leaseSource),attempts,
  diagnosticOnly:true,approvedHelperChanged:false},null,2)+'\n');
for(const mode of ['first-use','reused']){
  const start=Date.now(),events=[];
  const request={schema:'helix.environment_connector.probe_request.v1',probe_request_id:`probe:phases-${randomUUID()}`,
    capability_id:'com.casimirbot.system.clock.read',capability_version:1,catalog_snapshot_id:'catalog:private-clock',arguments:{clock:'monotonic'},
    constraints:{read_only:true,side_effects_allowed:false,max_duration_ms:5000},created_at:new Date(start).toISOString(),
    deadline_at:new Date(start+5000).toISOString(),assistant_answer:false,raw_content_included:false};
  const input=Buffer.from(JSON.stringify(request)),prefix=Buffer.alloc(4);prefix.writeInt32LE(input.length);
  const child=spawn(helper,['execute',root,review.files['node.exe'].sha256,entryHash,String(process.pid)],
    {cwd:root,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let expired=false,invalid=false,total=0,accepted=false,prepared=false;
  const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},Math.max(1,start+5000-Date.now()));
  const consume=(stream,kind)=>{let pending='';stream.on('data',chunk=>{total+=chunk.length;if(total>98304){invalid=true;child.kill('SIGKILL');return;}
    pending+=chunk;while(pending.includes('\n')){const end=pending.indexOf('\n'),line=pending.slice(0,end);pending=pending.slice(end+1);
      try{const frame=JSON.parse(line);events.push({kind,receivedMs:Date.now()-start,...frame});
        if(kind==='stdout'&&frame.type==='prepared'){assert(!prepared);prepared=true;if(!expired&&Date.now()<start+5000)child.stdin.write(Buffer.from([0x47]));else{expired=true;child.kill('SIGKILL');}}
        if(kind==='stdout'&&frame.type==='result')accepted=Date.now()<start+5000;
      }catch{invalid=true;child.kill('SIGKILL');}}});};
  consume(child.stdout,'stdout');consume(child.stderr,'stderr');child.stdin.on('error',()=>{});
  const exit=await new Promise(resolve=>{child.once('error',()=>resolve(null));child.once('close',resolve);child.stdin.write(Buffer.concat([prefix,input]));});
  clearTimeout(timer);const elapsedMs=Date.now()-start;
  const recovery=spawnSync(path.join(approved,'clock-bridge.exe'),['recover',root,review.files['node.exe'].sha256,entryHash,String(process.pid)],
    {cwd:root,env,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:98304});
  const phase=fs.readFileSync(path.join(root,'clock-isolation.journal'),'utf8').split('\n')[3];
  attempts.push({mode,requestId:request.probe_request_id,exit,expired,invalid,accepted,elapsedMs,events,recoveryCode:recovery.status,phase});persist();
  assert.equal(recovery.status,0);assert.equal(phase,'cleaned');
}
fs.writeFileSync('.tmp/g16a-bridge-phases-path.txt',resultPath+'\n');
for(const attempt of attempts){
  if(!attempt.accepted)continue;
  const frame=attempt.events.find(e=>e.kind==='stdout'&&e.type==='result');assert(frame);
  const result=JSON.parse(Buffer.from(frame.outputBase64,'base64'));
  assert.equal(result.probe_request_id,attempt.requestId);assert.equal(result.capability_id,'com.casimirbot.system.clock.read');
  assert.equal(result.outcome,'succeeded');assert.equal(result.side_effects_performed,false);
  assert.equal(result.environment_mutation_performed,false);assert.equal(result.model_invoked,false);
  assert.equal(result.assistant_answer,false);assert.deepEqual(result.commands_executed,[]);
  assert(Number.isSafeInteger(result.result.uptime_ms)&&result.result.uptime_ms>=0);
}
console.log(JSON.stringify({resultPath,attempts:attempts.map(a=>({...a,events:a.events.map(({outputBase64,...e})=>e)}))}));
assert(attempts.every(a=>a.exit===0&&!a.expired&&!a.invalid&&a.accepted),'diagnostic deadline qualification failed');
