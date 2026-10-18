import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
const mode = process.argv[2] ?? "all";
assert(["all", "--network-only", "--local-namespace"].includes(mode)); assert(process.argv.length <= 3);
const sha = file => { const fd = fs.openSync(file, "r"), buffer = Buffer.alloc(65536), hash = createHash("sha256");
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); return hash.digest("hex"); }
  finally { fs.closeSync(fd); } };
const review = JSON.parse(fs.readFileSync("apps/desktop/environment-packages/system-clock/reviewed-native-runtime.json", "utf8"));
assert(Date.now() >= Date.parse(review.validFrom) && Date.now() < Date.parse(review.expiresAt));
const source = "apps/desktop/native/EnvironmentClockJob.cs", driver = "tests/fixtures/desktop-environment-isolation-probe.cs";
assert.equal(sha(source), review.sourceSha256["EnvironmentClockJob.cs"]);
const output = fs.mkdtempSync(path.join(fs.realpathSync(".tmp"), "g16a-clock-isolation-endpoints-"));
const runtime = path.join(output, "node.exe"), entry = path.join(output, "clock.cjs"), helper = path.join(output, "endpoint-probe.exe");
const original = path.resolve(".tmp/g16a-private-clock-runtime-20260926/node.exe");
assert.equal(sha(original), review.files["node.exe"].sha256); fs.copyFileSync(original, runtime);
const runtimeHash = sha(runtime); assert.equal(runtimeHash, review.files["node.exe"].sha256);
const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const compiled = spawnSync(compiler, ["/nologo", "/platform:x64", "/optimize+", "/target:exe", `/out:${helper}`, path.resolve(source), path.resolve(driver)],
  { windowsHide: true, shell: false, encoding: "utf8", timeout: 30000 });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const env = { SystemRoot: process.env.SystemRoot, windir: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE,
  LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, TEMP: output, TMP: output };
const results = [], resultPath = path.join(output, "result.json");
let cleanup;
const persist = () => fs.writeFileSync(resultPath, JSON.stringify({ schema: "casimirbot.windows_clock_local_endpoints.v1",
  at: new Date().toISOString(), mode, sourceSha256: sha(source), driverSha256: sha(driver),
  scriptSha256: sha("scripts/environment-packages/test-windows-clock-local-endpoints.mjs"),
  helperSha256: sha(helper), runtimeSha256: runtimeHash, compilerSha256: sha(compiler), results, cleanup,
  limits: ["test-owned named pipes and this machine's available local interface addresses only", "no remote host, DNS or COM qualification",
    "exact Job source in a test driver; not an installed product or general sandbox certification"] }, null, 2));
fs.writeFileSync(".tmp/g16a-clock-local-endpoints-path.txt", resultPath);
const run = async isolated => {
  const child = spawn(isolated ? helper : runtime, isolated ? [output] : [entry], { cwd: process.cwd(), env,
    windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", size = 0;
  const add = kind => chunk => { size += chunk.length; if (size > 98304) { child.kill(); return; }
    if (kind === "stdout") stdout += chunk; else stderr += chunk; };
  child.stdout.on("data", add("stdout")); child.stderr.on("data", add("stderr")); child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill(), 12000);
  try { return await new Promise(resolve => { child.once("error", () => resolve({ code: null, stdout, stderr: "spawn_failed" }));
    child.once("close", code => resolve({ code, stdout, stderr })); child.stdin.end(); }); }
  finally { clearTimeout(timer); }
};
const absent = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } };
const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item && !item.internal);
const cases = mode === "--local-namespace" ? [
  { name: "named-pipe-LOCAL-namespace", protocol: "pipe", namespaceProbe: true, endpoint: `\\\\.\\pipe\\LOCAL\\CasimirBot.ClockIsolation.${randomUUID()}` },
] : mode === "--network-only" ? [] : [
  { name: "named-pipe", protocol: "pipe", endpoint: `\\\\.\\pipe\\CasimirBot.ClockIsolation.${randomUUID()}` },
  { name: "named-pipe-LOCAL-namespace", protocol: "pipe", namespaceProbe: true, endpoint: `\\\\.\\pipe\\LOCAL\\CasimirBot.ClockIsolation.${randomUUID()}` },
];
for (const family of mode === "--local-namespace" ? [] : [4, 6]) {
  // Scope IDs are retained for local link-local IPv6. These addresses come only
  // from the host interface inventory, never a supplied external endpoint.
  const available = addresses.filter(item => item.family === `IPv${family}`).sort((a, b) => a.address.localeCompare(b.address));
  const selected = available.find(item => !item.address.startsWith("fe80:")) ?? available[0];
  if (!selected) {
    for (const protocol of ["tcp", "udp"]) results.push({ name: `${protocol}-local-ipv${family}`, status: "unavailable", reason: "no_non_loopback_interface_address" });
  } else {
    const host = family === 6 && selected.address.startsWith("fe80:") && !selected.address.includes("%")
      ? `${selected.address}%${selected.scopeid}` : selected.address;
    for (const protocol of ["tcp", "udp"]) cases.push({ name: `${protocol}-local-ipv${family}`, protocol, host, family });
  }
}
persist();
for (const config of cases) {
  const token = `endpoint-${randomUUID()}`; let traffic = 0, unexpected = 0, listening = false;
  const service = config.protocol === "udp" ? dgram.createSocket(`udp${config.family}`) : net.createServer(socket => {
    socket.on("error", () => {}); socket.setTimeout(2000, () => socket.destroy());
    let bytes = Buffer.alloc(0); socket.on("data", chunk => { bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > token.length) { unexpected++; socket.destroy(); }
      else if (bytes.length === token.length) { if (bytes.toString() === token) { traffic++; socket.end(bytes); } else { unexpected++; socket.destroy(); } }
    });
  });
  if (config.protocol === "udp") service.on("message", (bytes, peer) => {
    if (bytes.toString() !== token || peer.address.split("%")[0] !== config.host.split("%")[0]) { unexpected++; return; }
    traffic++; service.send(bytes, peer.port, peer.address);
  });
  const row = { ...config, status: "started" }; results.push(row); persist();
  try {
    await new Promise((resolve, reject) => { service.once("error", reject); const ready = () => { listening = true; resolve(); };
      if (config.protocol === "pipe") service.listen(config.endpoint, ready);
      else if (config.protocol === "tcp") service.listen({ port: 0, host: config.host, ipv6Only: config.family === 6 }, ready);
      else service.bind(0, config.host, ready);
    });
    const c = { ...config, token, port: config.protocol === "pipe" ? undefined : service.address().port };
    fs.writeFileSync(entry, `const c=${JSON.stringify(c)};let done=false,transport;const finish=v=>{if(done)return;done=true;clearTimeout(timer);process.stdout.write(JSON.stringify(v));if(transport){if(c.protocol!=='udp')transport.destroy();else{try{transport.close();}catch{}}}};
const timer=setTimeout(()=>finish({access:'timeout-not-proof'}),2000);
if(c.protocol==='udp'){transport=require('node:dgram').createSocket('udp'+c.family);transport.once('message',b=>finish({access:'reachable',ack:b.toString()===c.token}));transport.send(c.token,c.port,c.host,e=>{if(e)finish({access:e.code});});}
else{transport=require('node:net').connect(c.protocol==='pipe'?{path:c.endpoint}:{host:c.host,port:c.port});transport.once('connect',()=>transport.write(c.token));transport.once('data',b=>finish({access:'reachable',ack:b.toString()===c.token}));}
transport.on('error',e=>finish({access:e.code}));`);
    const controlSource = fs.readFileSync(entry, "utf8");
    row.fixtureSha256 = sha(entry); row.control = await run(false); persist();
    assert.equal(row.control.code, 0); assert.equal(row.control.stderr, "");
    assert.deepEqual(JSON.parse(row.control.stdout), { access: "reachable", ack: true }); assert.equal(traffic, 1); assert.equal(unexpected, 0);
    if (config.namespaceProbe) {
      fs.writeFileSync(entry, `const c=${JSON.stringify(c)},net=require('node:net');let done=false,client;
const server=net.createServer(socket=>{socket.on('error',()=>{});socket.once('data',b=>socket.end('inside:'+b.toString()));});
const finish=value=>{if(done)return;done=true;clearTimeout(timer);process.stdout.write(JSON.stringify(value));client?.destroy();server.close();};
const timer=setTimeout(()=>finish({namespace:'timeout-not-proof'}),2000);
server.once('error',e=>finish({namespace:e.code}));
server.listen(c.endpoint,()=>{client=net.connect({path:c.endpoint});client.once('connect',()=>client.write(c.token));client.once('data',b=>finish({namespace:'local',ack:b.toString()==='inside:'+c.token}));client.on('error',e=>finish({namespace:e.code}));});`);
      row.namespaceFixtureSha256 = sha(entry);
    }
    row.isolated = await run(true); row.serverTraffic = traffic; row.unexpectedTraffic = unexpected; persist();
    assert.equal(row.isolated.code, 0, row.isolated.stderr); assert.equal(row.isolated.stderr, "");
    const frames = row.isolated.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(frames.length, 3); assert.equal(frames[0].appContainer, true); assert.equal(frames[0].capabilityCount, 1); assert.equal(frames[0].onlyRegistryRead, true);
    row.denial = JSON.parse(Buffer.from(frames[1].outputBase64, "base64"));
    if (config.namespaceProbe) assert.deepEqual(row.denial, { namespace: "local", ack: true });
    else assert(["EACCES", "EPERM"].includes(row.denial.access), JSON.stringify(row.denial));
    assert.equal(traffic, 1); assert.equal(unexpected, 0); assert.equal(frames[2].temporaryProfileRemoved, true); assert(absent(frames[0].pid));
    assert.equal(sha(entry), row.namespaceFixtureSha256 ?? row.fixtureSha256); assert.equal(sha(runtime), runtimeHash);
    if (config.namespaceProbe) {
      fs.writeFileSync(entry, controlSource); row.controlAfter = await run(false);
      assert.equal(row.controlAfter.code, 0); assert.equal(row.controlAfter.stderr, "");
      assert.deepEqual(JSON.parse(row.controlAfter.stdout), { access: "reachable", ack: true });
      assert.equal(traffic, 2); assert.equal(unexpected, 0); row.serverTrafficAfterControl = traffic;
    }
    row.status = "passed"; row.childAbsent = true; row.profileRemoved = true; persist(); console.log(`${config.name}: PASS`);
  } catch (error) { row.status = "failed"; row.failure = error.code ?? error.message; persist(); throw error; }
  finally { if (listening) await new Promise(resolve => service.close(resolve)); else if (config.protocol === "udp") { try { service.close(); } catch {} } }
}
// Only this script's new verified runtime copy is reclaimed; reports/helper and
// the reviewed original are retained. All executed cases confirmed cleanup.
assert.equal(fs.realpathSync(runtime), path.join(output, "node.exe")); assert.equal(sha(runtime), runtimeHash);
cleanup = { removedRuntimeCopy: runtime, bytes: fs.statSync(runtime).size, sha256: runtimeHash };
fs.unlinkSync(runtime); persist();
console.log(JSON.stringify({ passed: results.filter(row => row.status === "passed").length,
  unavailable: results.filter(row => row.status === "unavailable").length, resultPath }));
