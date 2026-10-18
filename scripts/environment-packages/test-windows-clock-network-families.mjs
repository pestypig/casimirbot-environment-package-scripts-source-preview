import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';

assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');
const sha=file=>{const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(65536),h=createHash('sha256');
  try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}};
const review=JSON.parse(fs.readFileSync('apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json','utf8'));
assert(Date.now()<Date.parse(review.expiresAt));
const source='apps/desktop/native/EnvironmentClockJob.cs',driver='tests/fixtures/desktop-environment-isolation-probe.cs';
assert.equal(sha(source),review.sourceSha256['EnvironmentClockJob.cs']);
const output=fs.mkdtempSync(path.join(fs.realpathSync('.tmp'),'g16a-clock-isolation-network-'));
const runtime=path.join(output,'node.exe'),entry=path.join(output,'clock.cjs'),helper=path.join(output,'network-probe.exe');
const original=path.resolve('.tmp/g16a-private-clock-runtime-20260926/node.exe');assert.equal(sha(original),review.files['node.exe'].sha256);
fs.copyFileSync(original,runtime);assert.equal(sha(runtime),review.files['node.exe'].sha256);
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const compile=spawnSync(compiler,['/nologo','/platform:x64','/optimize+','/target:exe',`/out:${helper}`,path.resolve(source),path.resolve(driver)],
  {windowsHide:true,shell:false,encoding:'utf8',timeout:30000});
assert.equal(compile.status,0,compile.stdout+compile.stderr);
const env={SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,
  LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA,TEMP:output,TMP:output};
const results=[];
const resultPath=path.join(output,'result.json');
const persist=()=>fs.writeFileSync(resultPath,JSON.stringify({schema:'casimirbot.windows_clock_network_families.v1',at:new Date().toISOString(),
  sourceSha256:sha(source),driverSha256:sha(driver),scriptSha256:sha('scripts/environment-packages/test-windows-clock-network-families.mjs'),
  helperSha256:sha(helper),runtimeSha256:sha(runtime),compilerSha256:sha(compiler),results,
  limits:['loopback only; no non-loopback/DNS coverage','test driver with exact Job source; not full installed host','no general Windows sandbox certification']},null,2)+'\n');
fs.writeFileSync('.tmp/g16a-clock-network-families-path.txt',resultPath+'\n');
const run=async isolated=>{
  const child=spawn(isolated?helper:runtime,isolated?[output]:[entry],{cwd:process.cwd(),env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',size=0;
  const add=kind=>chunk=>{size+=chunk.length;if(size>98304){child.kill('SIGKILL');return;}if(kind==='stdout')stdout+=chunk;else stderr+=chunk;};
  child.stdout.on('data',add('stdout'));child.stderr.on('data',add('stderr'));child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill('SIGKILL'),12000);
  try{return await new Promise(resolve=>{child.once('error',()=>resolve({code:null,stdout,stderr:'spawn_failed'}));
    child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end();});}finally{clearTimeout(timer);}
};
const absent=pid=>{try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}};

for(const protocol of ['tcp','udp'])for(const family of [4,6]){
  const name=`${protocol}-ipv${family}`,host=family===4?'127.0.0.1':'::1',token=`network-test-${randomUUID()}`;
  let traffic=0;
  const service=protocol==='tcp'?net.createServer(socket=>{traffic++;socket.on('error',()=>{});socket.on('data',bytes=>socket.end(bytes));}):dgram.createSocket(`udp${family}`);
  if(protocol==='udp')service.on('message',(bytes,peer)=>{traffic++;service.send(bytes,peer.port,peer.address);});
  const row={name,host,status:'started'};results.push(row);persist();
  let listening=false;
  try{
    await new Promise((resolve,reject)=>{service.once('error',reject);
      const done=()=>{listening=true;resolve();};if(protocol==='tcp')service.listen({port:0,host,ipv6Only:family===6},done);else service.bind(0,host,done);});
    const config={protocol,host,port:service.address().port,token,family};
    fs.writeFileSync(entry,`const c=${JSON.stringify(config)};let done=false,transport;const finish=value=>{if(done)return;done=true;clearTimeout(timer);process.stdout.write(JSON.stringify(value));if(transport){if(c.protocol==='tcp')transport.destroy();else{try{transport.close();}catch{}}}};
const timer=setTimeout(()=>finish({network:'timeout-not-proof'}),2000);
if(c.protocol==='tcp'){transport=require('node:net').connect({host:c.host,port:c.port});transport.once('connect',()=>transport.write(c.token));transport.once('data',b=>finish({network:'reachable',ack:b.toString()===c.token}));}
else{transport=require('node:dgram').createSocket('udp'+c.family);transport.once('message',b=>finish({network:'reachable',ack:b.toString()===c.token}));transport.send(c.token,c.port,c.host,e=>{if(e)finish({network:e.code});});}
transport.on('error',e=>finish({network:e.code}));`);
    row.fixtureSha256=sha(entry);
    row.control=await run(false);persist();assert.equal(row.control.code,0);assert.equal(row.control.stderr,'');
    assert.deepEqual(JSON.parse(row.control.stdout),{network:'reachable',ack:true});assert.equal(traffic,1);
    row.isolated=await run(true);row.serverTraffic=traffic;persist();
    assert.equal(row.isolated.code,0,row.isolated.stderr);assert.equal(row.isolated.stderr,'');
    const frames=row.isolated.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    assert.equal(frames.length,3);assert.equal(frames[0].appContainer,true);assert.equal(frames[0].capabilityCount,1);assert.equal(frames[0].onlyRegistryRead,true);
    row.denial=JSON.parse(Buffer.from(frames[1].outputBase64,'base64'));
    assert(['EACCES','EPERM'].includes(row.denial.network),JSON.stringify(row.denial));
    assert.equal(traffic,1);assert.equal(frames[2].temporaryProfileRemoved,true);assert(absent(frames[0].pid));
    assert.equal(sha(entry),row.fixtureSha256);assert.equal(sha(runtime),review.files['node.exe'].sha256);
    row.status='passed';row.childAbsent=true;row.profileRemoved=true;persist();console.log(name+': PASS');
  }catch(error){row.status='failed';row.failure=error.code??error.message;persist();throw error;}
  finally{
    if(listening)await new Promise(resolve=>service.close(resolve));
    else if(protocol==='udp'){try{service.close();}catch{}}
  }
}
console.log(JSON.stringify({passed:results.filter(x=>x.status==='passed').length,resultPath}));
