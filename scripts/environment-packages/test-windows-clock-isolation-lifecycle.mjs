import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

if(process.platform!=='win32')throw Error('Actual Windows execution required');
const root=process.cwd(),temp=fs.realpathSync(path.join(root,'.tmp'));
const output=fs.mkdtempSync(path.join(temp,'g16a-clock-lease-'));
assert.equal(path.dirname(fs.realpathSync(output)),temp);
const source='apps/desktop/native/EnvironmentClockIsolationLease.cs',jobSource='apps/desktop/native/EnvironmentClockJob.cs';
const driver='tests/fixtures/desktop-environment-isolation-lifecycle-probe.cs';
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const executable=path.join(output,'lifecycle-probe.exe'),runtime=path.join(output,'node.exe'),entry=path.join(output,'clock.cjs');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.copyFileSync(process.execPath,runtime);
const runtimeHash=sha(runtime);assert.equal(runtimeHash,sha(process.execPath));
const compiled=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${executable}`,path.resolve(source),path.resolve(jobSource),path.resolve(driver)],
  {cwd:root,windowsHide:true,encoding:'utf8',timeout:30000});
assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
const active=new Set(),results=[],attempts=[];
const journal=path.join(output,'clock-isolation.journal');
const normal=`const fs=require('node:fs'),path=require('node:path');let journalDenied=false;try{fs.readFileSync(path.join(__dirname,'clock-isolation.journal'));}catch(e){journalDenied=e.code==='EPERM'||e.code==='EACCES';}process.stdout.write(JSON.stringify({ok:true,journalDenied}));`;
const hang=`setInterval(()=>{},1000);`;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const noChild=async pid=>{const end=Date.now()+3000;while(alive(pid)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.equal(alive(pid),false);};
const start=(mode,options={})=>{
  const work=options.root??output;
  const child=spawn(executable,[mode,work,options.runtimeHash??runtimeHash,options.entryHash??(fs.existsSync(path.join(work,'clock.cjs'))?sha(path.join(work,'clock.cjs')):'unused')],
    {cwd:root,windowsHide:true,shell:false,env:{SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,
      USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA,TEMP:output,TMP:output},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',firstResolve;const first=new Promise(resolve=>firstResolve=resolve);
  child.stdout.on('data',b=>{stdout+=b;if(stdout.includes('\n'))firstResolve(JSON.parse(stdout.split('\n')[0]));});
  child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{firstResolve(null);resolve({code,stdout,stderr});});});
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000),lease={child,done};active.add(lease);
  void done.finally(()=>{clearTimeout(timer);active.delete(lease);});
  void done.then(out=>{attempts.push({mode,...out});fs.writeFileSync(path.join(output,'attempts.json'),JSON.stringify(attempts,null,2)+'\n');});
  return {child,first,done};
};
const parse=out=>out.stdout.trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
const recover=async(options={})=>{const p=start('recover',options);p.child.stdin.end();const out=await p.done;assert.equal(out.code,0,out.stderr);const last=parse(out).at(-1);assert.equal(last.profileRemoved,true);assert.equal(last.grantsRemoved,true);return last;};
const run=async(name,fn)=>{
  const details=await fn();results.push({name,status:'passed',details});console.log(name+': PASS');
};
try {
  fs.writeFileSync(entry,normal);
  await run('normal-close-removes-profile-and-grants',async()=>{
    const p=start('normal');p.child.stdin.end();const out=await p.done;assert.equal(out.code,0,out.stderr);const lines=parse(out);
    assert.deepEqual(JSON.parse(Buffer.from(lines[0].outputBase64,'base64').toString()),{ok:true,journalDenied:true});
    assert.deepEqual(lines.at(-1),{profileRemoved:true,grantsRemoved:true});await noChild(lines[0].pid);
    assert.equal(fs.readFileSync(journal,'utf8').split('\n')[3],'cleaned');return {pid:lines[0].pid,...lines.at(-1),journalDenied:true};
  });
  await run('live-lease-excludes-recovery-and-file-replacement',async()=>{
    const p=start('granted'),ready=await p.first;assert.equal(ready?.profileExists,true);
    const before=sha(journal),blocked=start('recover');blocked.child.stdin.end();const out=await blocked.done;
    assert.equal(out.code,1);assert.match(out.stderr,/clock_lease_already_owned/);assert.equal(sha(journal),before);
    assert.throws(()=>fs.appendFileSync(entry,'// forbidden'),e=>['EPERM','EACCES','EBUSY'].includes(e.code));
    assert.throws(()=>fs.renameSync(entry,path.join(output,'replaced-clock.cjs')),e=>['EPERM','EACCES','EBUSY'].includes(e.code));
    p.child.stdin.end('\n');const closed=await p.done;assert.equal(closed.code,0,closed.stderr);
    assert.deepEqual(parse(closed).at(-1),{profileRemoved:true,grantsRemoved:true});return {contenderDenied:true,journalUnchanged:true,writeAndRenameDenied:true};
  });
  fs.writeFileSync(entry,hang);
  for(const mode of ['granted','suspended','running'])await run('recover-after-owner-death-'+mode,async()=>{
    const p=start(mode),ready=await p.first;assert(ready,ready?'':JSON.stringify(await p.done));assert.equal(ready.profileExists,true);
    if(ready.pid)assert.equal(alive(ready.pid),true);
    p.child.kill('SIGKILL');await p.done;if(ready.pid)await noChild(ready.pid);
    const cleanup=await recover();const before=sha(journal);await recover();assert.equal(sha(journal),before);
    return {mode,pid:ready.pid??null,ownerKilledByOwnedHandle:true,childExited:ready.pid?true:null,...cleanup,idempotentRecovery:true};
  });
  await run('corrupt-and-cross-root-journals-deny-without-cleanup',async()=>{
    const p=start('granted');assert(await p.first);p.child.kill('SIGKILL');await p.done;
    const original=fs.readFileSync(journal),wrongRoot=fs.mkdtempSync(path.join(temp,'g16a-clock-lease-'));
    fs.writeFileSync(path.join(wrongRoot,'clock-isolation.journal'),original);
    const wrong=start('recover',{root:wrongRoot});wrong.child.stdin.end();const wrongOut=await wrong.done;
    assert.equal(wrongOut.code,1);assert.match(wrongOut.stderr,/clock_lease_journal_invalid/);
    assert.deepEqual(fs.readFileSync(journal),original);
    for(const bad of [Buffer.from('malformed'),Buffer.alloc(513,97)]) {
      fs.writeFileSync(journal,bad);const q=start('recover');q.child.stdin.end();const out=await q.done;
      assert.equal(out.code,1);assert.match(out.stderr,/clock_lease_journal_invalid/);assert.deepEqual(fs.readFileSync(journal),bad);
    }
    // Restore only this test's own exact pre-corruption record, then clean its lease.
    fs.writeFileSync(journal,original);const cleanup=await recover();return {malformedDenied:true,oversizedDenied:true,crossRootDenied:true,...cleanup};
  });
  await run('artifact-hash-drift-denied-before-profile-create',async()=>{
    const before=sha(journal),p=start('normal',{entryHash:'0'.repeat(64)});p.child.stdin.end();const out=await p.done;
    assert.equal(out.code,1);assert.match(out.stderr,/clock_lease_artifact_hash_mismatch/);assert.equal(sha(journal),before);
    return {denied:true,journalUnchanged:true};
  });
  await run('fresh-lease-after-recovery-uses-new-identity',async()=>{
    const previous=fs.readFileSync(journal,'utf8').split('\n')[2];fs.writeFileSync(entry,normal);
    const p=start('normal');p.child.stdin.end();const out=await p.done;assert.equal(out.code,0,out.stderr);const lines=parse(out);
    assert.deepEqual(JSON.parse(Buffer.from(lines[0].outputBase64,'base64').toString()),{ok:true,journalDenied:true});
    assert.notEqual(fs.readFileSync(journal,'utf8').split('\n')[2],previous);
    assert.deepEqual(lines.at(-1),{profileRemoved:true,grantsRemoved:true});await noChild(lines[0].pid);
    return {newLeaseIdentity:true,freshChildExited:true,...lines.at(-1)};
  });
  await run('hardlinked-runtime-denied-before-profile-create',async()=>{
    const work=fs.mkdtempSync(path.join(temp,'g16a-clock-lease-'));fs.linkSync(runtime,path.join(work,'node.exe'));fs.copyFileSync(entry,path.join(work,'clock.cjs'));
    const p=start('normal',{root:work});p.child.stdin.end();const out=await p.done;
    assert.equal(out.code,1);assert.match(out.stderr,/clock_lease_linked_file_denied/);assert.equal(fs.existsSync(path.join(work,'clock-isolation.journal')),false);
    return {denied:true,profileIntentAbsent:true};
  });
} finally {
  const leases=[...active];for(const lease of leases)lease.child.kill('SIGKILL');await Promise.allSettled(leases.map(x=>x.done));
}
const receipt={schema:'casimirbot.clock_isolation_lifecycle_checks.v1',at:new Date().toISOString(),platform:process.platform,
  sourceSha256:sha(source),jobSourceSha256:sha(jobSource),driverSha256:sha(driver),scriptSha256:sha('scripts/environment-packages/test-windows-clock-isolation-lifecycle.mjs'),
  runtimeSha256:runtimeHash,helperSha256:sha(executable),compilerSha256:sha(compiler),results,
  notProven:['power-loss durability','hostile same-user tampering','installed host/authenticated admission','durable action/result recovery','full sandbox threat model','profile-create/job-name collision recovery']};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(receipt,null,2)+'\n');
fs.writeFileSync(path.join(temp,'g16a-clock-isolation-lifecycle-result-path.txt'),path.join(output,'result.json')+'\n');
console.log(JSON.stringify({passed:results.length,receipt:path.join(output,'result.json')}));
