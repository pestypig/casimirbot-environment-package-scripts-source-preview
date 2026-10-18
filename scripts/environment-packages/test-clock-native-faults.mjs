import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
assert.equal(process.platform,'win32');assert.equal(process.argv.length,2);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidence=JSON.parse(fs.readFileSync('docs/evidence/eh-g8-codex-first-paid-product-delivery-v1/launch-program/2026-09-26-g16a-prepared-native-transport.json','utf8'));
for(const [file,hash] of Object.entries(evidence.sourceHashes))assert.equal(sha(file),hash);
assert.equal(sha(evidence.helper),evidence.helperSha256);
const output=fs.mkdtempSync(path.join(fs.realpathSync('.tmp'),'g16a-native-faults-'));
const timeoutRoot=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'g16a-native-timeout-'));
const exchangeRoot=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'g16a-native-exchange-'));
const driverSource=path.resolve('tests/fixtures/desktop-clock-native-fault-driver.cs'),driver=path.join(output,'fault-driver.exe');
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const build=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${driver}`,driverSource],{windowsHide:true,shell:false,encoding:'utf8',timeout:30000});
assert.equal(build.status,0,build.stdout+build.stderr);
const env=root=>({SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,
  LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA,TEMP:root,TMP:root});
const attempts=[],active=new Set(),results=[];
function launch(executable,args,root){
  const started=Date.now(),child=spawn(executable,args,{cwd:root,windowsHide:true,shell:false,env:env(root),stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',firstResolve;
  const first=new Promise(resolve=>firstResolve=resolve);
  child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>131072)child.kill();if(stdout.includes('\n')){try{firstResolve(JSON.parse(stdout.split('\n')[0]));}catch{firstResolve(null);}}});
  child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.length>4096)child.kill();});child.stdin.on('error',()=>{});
  const done=new Promise(resolve=>{child.on('error',e=>{stderr+=e.code??'spawn_failed';});child.once('close',(code,signal)=>{
    firstResolve(null);resolve({code,signal,stdout,stderr,elapsedMs:Date.now()-started});});});
  const timer=setTimeout(()=>child.kill('SIGKILL'),18000),item={child,done};active.add(item);
  void done.then(result=>{clearTimeout(timer);active.delete(item);attempts.push({executable:path.basename(executable),mode:args[0],...result});});
  return {child,first,done};
}
const bridge=(root,hash,mode='prepare')=>launch(evidence.helper,[mode,root,hash,sha(path.join(root,'clock.cjs')),String(process.pid)],root);
const recover=async(root,hash)=>{const p=bridge(root,hash,'recover');p.child.stdin.end();const out=await p.done;
  assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{type:'recovered',version:2});};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const absent=async pid=>{const end=Date.now()+3000;while(alive(pid)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.equal(alive(pid),false);};
const sparse=path.join(timeoutRoot,'node.exe');
let allocation;
try{
  const created=spawnSync(driver,['sparse',sparse],{windowsHide:true,shell:false,encoding:'utf8',timeout:5000,env:env(timeoutRoot)});
  assert.equal(created.status,0,created.stderr);allocation=JSON.parse(created.stdout);assert(allocation.allocatedBytes<=1024*1024);
  fs.writeFileSync(path.join(timeoutRoot,'clock.cjs'),'throw Error("must never execute");');
  const p=bridge(timeoutRoot,'0'.repeat(64));const out=await p.done;
  assert.equal(out.code,124,out.stderr);assert.match(out.stderr,/clock_preparation_timeout/);assert.equal(out.stdout,'');
  assert(out.elapsedMs>=10000&&out.elapsedMs<14000);assert(!fs.existsSync(path.join(timeoutRoot,'clock-isolation.journal')));
  await recover(timeoutRoot,'0'.repeat(64));
  results.push({name:'actual preparation timeout while hashing sparse invalid runtime',status:'passed',elapsedMs:out.elapsedMs,allocation,noReady:true,noLeaseIntent:true,ownershipRecovered:true});
}catch(error){results.push({name:'actual preparation timeout',status:'failed',error:String(error)});process.exitCode=1;}
finally{
  for(const item of active)item.child.kill('SIGKILL');await Promise.all([...active].map(item=>item.done));
  if(fs.existsSync(sparse)){
    assert.equal(path.dirname(fs.realpathSync(sparse)),timeoutRoot);assert.equal(path.dirname(timeoutRoot),fs.realpathSync(os.tmpdir()));
    assert(path.basename(timeoutRoot).startsWith('g16a-native-timeout-'));assert(!fs.lstatSync(sparse).isSymbolicLink());
    fs.unlinkSync(sparse);assert(!fs.existsSync(sparse));
  }
}
const nativeReview=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json','utf8'));
const runtime=path.resolve('.tmp/g16a-private-clock-runtime-20260926/node.exe');assert.equal(sha(runtime),nativeReview.files['node.exe'].sha256);
fs.copyFileSync(runtime,path.join(exchangeRoot,'node.exe'));
fs.writeFileSync(path.join(exchangeRoot,'clock.cjs'),'setInterval(()=>{},1000);\n');
const runtimeHash=sha(runtime);
for(const mode of ['EOF','helper termination']){
  try{
    const p=bridge(exchangeRoot,runtimeHash),ready=await p.first;assert.equal(ready?.type,'ready');assert.equal(ready.version,2);
    const observer=launch(driver,['cpu',String(ready.pid)],exchangeRoot),baseline=await observer.first;assert(Number.isSafeInteger(baseline.baselineTicks));
    const bytes=Buffer.from('{}'),prefix=Buffer.alloc(4);prefix.writeInt32LE(bytes.length);
    p.child.stdin.write(Buffer.concat([prefix,bytes,Buffer.from([0x47])]));observer.child.stdin.write('G');
    const measured=await observer.done;assert.equal(measured.code,0,measured.stderr);
    const running=JSON.parse(measured.stdout.trim().split(/\r?\n/).at(-1));assert(running.deltaTicks>0);assert(alive(ready.pid));
    if(mode==='EOF')p.child.stdin.end();else assert(p.child.kill('SIGKILL'));
    const out=await p.done;assert.notEqual(out.code,0);assert.equal(out.stdout.trim().split(/\r?\n/).length,1);
    await absent(ready.pid);await recover(exchangeRoot,runtimeHash);
    assert.equal(fs.readFileSync(path.join(exchangeRoot,'clock-isolation.journal'),'utf8').split('\n')[3],'cleaned');
    results.push({name:`active exchange cancellation: ${mode}`,status:'passed',baseline,running,childAbsent:true,leaseCleaned:true,noResult:true});
  }catch(error){results.push({name:`active exchange cancellation: ${mode}`,status:'failed',error:String(error)});process.exitCode=1;}
  finally{for(const item of active)item.child.kill('SIGKILL');await Promise.all([...active].map(item=>item.done));await recover(exchangeRoot,runtimeHash);}
}
const report={schema:'casimirbot.private_native_fault_evidence.v1',helper:evidence.helper,helperSha256:evidence.helperSha256,sourceHashes:evidence.sourceHashes,
  driverSha256:sha(driver),driverSourceSha256:sha(driverSource),scriptSha256:sha('scripts/environment-packages/test-clock-native-faults.mjs'),
  timeoutRoot,exchangeRoot,sparseFileRemoved:!fs.existsSync(sparse),runtimeHash,syntheticEntrySha256:sha(path.join(exchangeRoot,'clock.cjs')),results,attempts};
const reportPath=path.join(output,'result.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
fs.writeFileSync('.tmp/g16a-native-fault-result-path.txt',reportPath+'\n');console.log(JSON.stringify({reportPath,results},null,2));
