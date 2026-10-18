import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const script=fileURLToPath(import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=file=>hash(fs.readFileSync(file));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const absent=async pid=>{const until=Date.now()+3000;while(alive(pid)&&Date.now()<until)await delay(20);assert.equal(alive(pid),false,`owned process ${pid} remains`);};
const active=new Set(),attempts=[];
const environment=root=>Object.fromEntries(Object.entries({SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,
  USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA,TEMP:root,TMP:root}).filter(([,v])=>v));
function launch(executable,args,root) {
  const began=Date.now();
  const child=spawn(executable,args,{cwd:root,windowsHide:true,shell:false,env:environment(root),stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',resolveFirst;
  const first=new Promise(resolve=>{resolveFirst=resolve;});
  child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>131072)child.kill();
    if(stdout.includes('\n')){try{resolveFirst(JSON.parse(stdout.split('\n')[0]));}catch{resolveFirst(null);}}});
  child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.length>8192)child.kill();});
  child.stdin.on('error',()=>{});
  const done=new Promise(resolve=>{
    child.on('error',error=>{stderr+=error.code??'spawn_failed';});
    child.on('close',(code,signal)=>{resolveFirst(null);resolve({code,signal,stdout,stderr,elapsedMs:Date.now()-began});});
  });
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000),item={child,done};active.add(item);
  void done.then(out=>{clearTimeout(timer);active.delete(item);attempts.push(out);});
  return {child,first,done,began};
}
function start(config,mode='prepare') {
  return launch(config.helper,[mode,config.root,config.runtimeHash,config.entryHash,String(process.pid)],config.root);
}
if(process.argv[2]==='--owner') {
  const config=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  const bridge=start(config); const ready=await bridge.first;
  if(!ready){process.exitCode=1;}else{
    process.stdout.write(JSON.stringify({...ready,helperPid:bridge.child.pid})+'\n');
    await bridge.done;
  }
} else {
  assert.equal(process.platform,'win32');
  const partialOnly=process.argv[2]==='--partial-only';
  assert(process.argv.length===2 || (process.argv.length===3 && partialOnly));
  const review=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-private.json','utf8'));
  const nativeReview=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json','utf8'));
  assert(Date.now()<Date.parse(review.expiresAt));assert(Date.now()<Date.parse(nativeReview.expiresAt));
  const archive=fs.readFileSync('.tmp/g16a-clock-package-20260926/clock.tgz');assert.equal(hash(archive),review.archiveSha256);
  const tar=gunzipSync(archive);let entry;
  for(let offset=0;offset+512<=tar.length;){
    const header=tar.subarray(offset,offset+512);if(header.every(b=>b===0))break;
    const name=header.subarray(0,100).toString('ascii').replace(/\0.*$/s,'');
    const size=parseInt(header.subarray(124,136).toString('ascii').replace(/\0.*$/s,'').trim(),8);
    assert(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length);
    if(name===review.entryPoint){assert.equal(entry,undefined);entry=tar.subarray(offset+512,offset+512+size);}
    offset+=512+Math.ceil(size/512)*512;
  }
  assert(entry);assert.equal(hash(entry),review.files[review.entryPoint]);
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'g16a-prepared-'));
  const output=fs.mkdtempSync(path.join(fs.realpathSync('.tmp'),'g16a-prepared-build-'));
  const runtime=path.resolve('.tmp/g16a-private-clock-runtime-20260926/node.exe');
  assert.equal(sha(runtime),nativeReview.files['node.exe'].sha256);
  fs.copyFileSync(runtime,path.join(root,'node.exe'));fs.writeFileSync(path.join(root,'clock.cjs'),entry,{flag:'wx'});
  const sources=['EnvironmentClockJob.cs','EnvironmentClockIsolationLease.cs','EnvironmentClockPreparedBridge.cs'].map(name=>path.resolve('apps/desktop/native',name));
  const sourceHashes=Object.fromEntries(sources.map(file=>[path.relative(process.cwd(),file),sha(file)]));
  const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const helper=path.join(output,'prepared-bridge.exe');
  if(partialOnly){
    const frozen=JSON.parse(fs.readFileSync('docs/evidence/eh-g8-codex-first-paid-product-delivery-v1/launch-program/2026-09-26-g16a-prepared-native-transport.json','utf8'));
    assert.deepEqual(sourceHashes,frozen.sourceHashes);assert.equal(sha(frozen.helper),frozen.helperSha256);
    fs.copyFileSync(frozen.helper,helper);assert.equal(sha(helper),frozen.helperSha256);
  }else{
    const built=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${helper}`,...sources],{shell:false,windowsHide:true,encoding:'utf8',timeout:30000});
    assert.equal(built.status,0,built.stdout+built.stderr);
  }
  for(const file of sources)assert.equal(sha(file),sourceHashes[path.relative(process.cwd(),file)]);
  const config={root,helper,runtimeHash:sha(path.join(root,'node.exe')),entryHash:hash(entry)};
  const configPath=path.join(output,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  const frames=out=>out.stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const clean=()=>assert.equal(fs.readFileSync(path.join(root,'clock-isolation.journal'),'utf8').split('\n')[3],'cleaned');
  const recover=async()=>{const p=start(config,'recover');p.child.stdin.end();const out=await p.done;assert.equal(out.code,0,out.stderr);assert.deepEqual(frames(out),[{type:'recovered',version:2}]);clean();};
  const ready=async p=>{const frame=await p.first;assert.equal(frame?.type,'ready',JSON.stringify(await Promise.race([p.done,Promise.resolve('not closed')])));assert.equal(frame.version,2);assert(Number.isSafeInteger(frame.pid)&&frame.pid>0);return frame;};
  const request=()=>{const now=Date.now();return {schema:'helix.environment_connector.probe_request.v1',probe_request_id:`probe:${randomUUID()}`,
    capability_id:'com.casimirbot.system.clock.read',capability_version:1,catalog_snapshot_id:'catalog:prepared-fixture',arguments:{clock:'monotonic'},
    constraints:{read_only:true,side_effects_allowed:false,max_duration_ms:5000},created_at:new Date(now).toISOString(),deadline_at:new Date(now+5000).toISOString(),assistant_answer:false,raw_content_included:false};};
  const packet=value=>{const bytes=Buffer.from(JSON.stringify(value)),prefix=Buffer.alloc(4);prefix.writeInt32LE(bytes.length);return Buffer.concat([prefix,bytes]);};
  const results=[];
  const cases=[
    ['ready before request; one correlated observation',async()=>{
      const p=start(config),r=await ready(p);const preparationMs=Date.now()-p.began;
      await delay(150);assert(alive(r.pid));assert.equal(await Promise.race([p.done.then(()=>true),Promise.resolve(false)]),false);
      const value=request(),sent=Date.now();p.child.stdin.write(Buffer.concat([packet(value),Buffer.from([0x47])]));
      const out=await p.done;assert.equal(out.code,0,out.stderr);const records=frames(out);assert.equal(records.length,2);
      assert.equal(records[1].type,'result');assert.equal(records[1].version,2);
      const result=JSON.parse(Buffer.from(records[1].outputBase64,'base64').toString('utf8'));
      assert.equal(result.probe_request_id,value.probe_request_id);assert.equal(result.outcome,'succeeded');
      assert(Number.isSafeInteger(result.result.uptime_ms));assert(Date.now()<Date.parse(value.deadline_at));await absent(r.pid);clean();
      return {preparationMs,observationMs:Date.now()-sent};
    }],
    ['EOF without request cancels suspended child',async()=>{const p=start(config),r=await ready(p);p.child.stdin.end();const out=await p.done;
      assert.equal(out.code,1);assert.match(out.stderr,/clock_bridge_input_closed/);assert.equal(frames(out).length,1);await absent(r.pid);clean();}],
    ['oversized request denied before execution',async()=>{const p=start(config),r=await ready(p);const size=Buffer.alloc(4);size.writeInt32LE(65537);p.child.stdin.write(size);
      const out=await p.done;assert.equal(out.code,1);assert.match(out.stderr,/clock_bridge_input_invalid/);assert.equal(frames(out).length,1);await absent(r.pid);clean();}],
    ['wrong GO denied before execution',async()=>{const p=start(config),r=await ready(p);p.child.stdin.write(Buffer.concat([packet(request()),Buffer.from([0x58])]));
      const out=await p.done;assert.equal(out.code,1);assert.match(out.stderr,/clock_bridge_go_required/);assert.equal(frames(out).length,1);await absent(r.pid);clean();}],
    ['idle expiry kills child and requires recovery',async()=>{const p=start(config),r=await ready(p),at=Date.now();const out=await p.done;
      assert.equal(out.code,124);assert.match(out.stderr,/clock_prepared_idle_timeout/);assert.equal(frames(out).length,1);
      assert(Date.now()-at<7000);await absent(r.pid);await recover();return {idleElapsedMs:Date.now()-at};}],
    ['owner death kills prepared helper and child',async()=>{const p=launch(process.execPath,[script,'--owner',configPath],root),r=await ready(p);
      assert(Number.isSafeInteger(r.helperPid));p.child.kill('SIGKILL');await p.done;await absent(r.helperPid);await absent(r.pid);await recover();}],
    ...['partial header','payload without GO'].map(mode=>[`incomplete input: ${mode}`,async()=>{
      const p=start(config),r=await ready(p),at=Date.now();
      p.child.stdin.write(mode==='partial header'?Buffer.from([0x20,0x00]):packet(request()));
      const out=await p.done;assert.equal(out.code,124);assert.match(out.stderr,/clock_prepared_idle_timeout/);
      assert.equal(frames(out).length,1);assert(Date.now()-at<7000);await absent(r.pid);await recover();
      return {idleElapsedMs:Date.now()-at,noResult:true,childAbsent:true,leaseCleaned:true};
    }]),
  ];
  for(const [name,run] of cases.filter(([name])=>!partialOnly||name.startsWith('incomplete input:'))){
    try{const details=await run();results.push({name,status:'passed',details});console.log(`${name}: PASS`);}
    catch(error){results.push({name,status:'failed',error:String(error)});console.log(`${name}: FAIL`);process.exitCode=1;
      for(const item of active)item.child.kill('SIGKILL');await Promise.all([...active].map(item=>item.done));
      try{await recover();}catch(recoveryError){results.push({name:'failure cleanup',status:'failed',error:String(recoveryError)});break;}}
  }
  const report={schema:'casimirbot.private_clock_preparation_evidence.v1',candidateOnly:true,root,helper,helperSha256:sha(helper),
    sourceHashes,buildMode:partialOnly?'reused-slice34-helper':'compiled',compilerSha256:partialOnly?undefined:sha(compiler),
    scriptSha256:sha(script),runtimeHash:config.runtimeHash,entryHash:config.entryHash,results,attempts};
  const reportPath=path.join(output,'result.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync('.tmp/g16a-prepared-bridge-result-path.txt',reportPath+'\n');console.log(JSON.stringify({reportPath,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length}));
}
