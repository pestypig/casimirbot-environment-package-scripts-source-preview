import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { EnvironmentClockNativeStaging } from "../../apps/desktop/src/environment-clock-native-staging";
import { NativePrivateClockHost } from "../../apps/desktop/src/environment-private-clock-host";
import { loadPrivateClockRuntimeArtifacts } from "../../apps/desktop/src/environment-private-runtime-artifacts";
import { PRIVATE_CLOCK_INSTALL_REVIEW, PRIVATE_INSTALL_DIRECTORY_REVISION } from "../../shared/environment-private-install";
import { PRIVATE_CLOCK_RUNTIME_PROFILE, PRIVATE_CLOCK_RUNTIME_REVISION } from "../../shared/environment-private-runtime";
import { HELIX_ENVIRONMENT_PROBE_REQUEST_V1_SCHEMA, HELIX_SYSTEM_CLOCK_READ_CAPABILITY } from "../../shared/helix-environment-connector";

export async function runPrivateClockHostDiagnostic(instrumented = false) {
  assert(process.env.G16A_CLOCK_PACKAGE, "G16A_CLOCK_PACKAGE required");
  let runtime = loadPrivateClockRuntimeArtifacts(fs.realpathSync(".tmp/g16a-private-clock-runtime-20260926"));
  let diagnostic: { helperPath: string; helperSha256: string; tracePath: string; sourceSha256: Record<string, string>; diagnosticOnly: boolean; schema: string } | undefined;
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (instrumented) {
    const buildPath = fs.readFileSync(".tmp/g16a-bridge-host-build-path.txt", "utf8").trim();
    assert.equal(path.dirname(path.dirname(buildPath)), fs.realpathSync(".tmp"));
    assert(path.basename(path.dirname(buildPath)).startsWith("g16a-bridge-phases-"));
    diagnostic = JSON.parse(fs.readFileSync(buildPath, "utf8"));
    assert(diagnostic?.diagnosticOnly && diagnostic.schema === "casimirbot.diagnostic_clock_host_build.v1");
    assert.equal(path.dirname(diagnostic.helperPath), path.dirname(buildPath));
    assert.equal(sha(diagnostic.helperPath), diagnostic.helperSha256);
    for (const name of ["EnvironmentClockJob.cs", "EnvironmentClockIsolationLease.cs", "EnvironmentClockBridge.cs"])
      assert.equal(sha(path.join("apps/desktop/native", name)), diagnostic.sourceSha256[name]);
    assert.equal(path.dirname(path.dirname(diagnostic.tracePath)), fs.realpathSync(os.tmpdir()));
    assert(path.basename(path.dirname(diagnostic.tracePath)).startsWith("casimirbot-clock-phases-"));
    assert.equal(fs.statSync(diagnostic.tracePath).size, 0);
    for (const file of [buildPath, diagnostic.helperPath, diagnostic.tracePath])
      for (let p = file;; p = path.dirname(p)) { assert(!fs.lstatSync(p).isSymbolicLink()); if (path.dirname(p) === p) break; }
    runtime = { ...runtime, helperPath: diagnostic.helperPath, helperSha256: diagnostic.helperSha256 };
  }
  const userDataPath = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "casimirbot-clock-direct-"));
  const reportPath = path.join(fs.realpathSync(".tmp"), `g16a-direct-host-${randomUUID()}.json`);
  fs.writeFileSync(".tmp/g16a-direct-host-path.txt", reportPath + "\n");
  const account = { profileId: "profile:direct-startup", sessionId: "account_session:direct-startup-1234", accountType: "developer" as const };
  const identity = { profile_id: account.profileId, device_id: `desktop_device_${"q".repeat(22)}`,
    session_ref: createHash("sha256").update(account.sessionId).digest("hex"),
    artifact_sha256: PRIVATE_CLOCK_INSTALL_REVIEW.archiveSha256, review_revision: PRIVATE_CLOCK_INSTALL_REVIEW.policyRevision,
    credential_included: false, public_release: false };
  const results: Array<Record<string, unknown>> = [];
  let started = 0, events: Array<{ phase: string; elapsedMs: number }> = [];
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const originalPrepare = EnvironmentClockNativeStaging.prototype.prepare;
  EnvironmentClockNativeStaging.prototype.prepare = function(entryPath: string) {
    events.push({ phase: "staging:start", elapsedMs: Date.now() - started });
    try { return originalPrepare.call(this, entryPath); }
    finally { events.push({ phase: "staging:end", elapsedMs: Date.now() - started }); }
  };
  const host = new NativePrivateClockHost({ userDataPath, deviceId: identity.device_id, runtime,
    featureEnabled: () => true, runtimeEnabled: () => true, readAccount: async () => account,
    selectArchive: async () => path.join(process.env.G16A_CLOCK_PACKAGE!, "clock.tgz"),
    readPolicy: async () => ({ ...identity, schema: "casimirbot.private_environment_install_policy.v1",
      policy_revision: PRIVATE_INSTALL_DIRECTORY_REVISION, expires_at: PRIVATE_CLOCK_INSTALL_REVIEW.expiresAt,
      install_allowed: true, runtime_allowed: false }),
    readRuntimePolicy: async () => {
      events.push({ phase: "policy", elapsedMs: Date.now() - started }); const now = new Date();
      return { ...identity, schema: "casimirbot.private_clock_runtime_policy.v1", policy_revision: PRIVATE_CLOCK_RUNTIME_REVISION,
        runtime_profile: PRIVATE_CLOCK_RUNTIME_PROFILE, capability_id: HELIX_SYSTEM_CLOCK_READ_CAPABILITY,
        issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 30000).toISOString(),
        runtime_allowed: true, hosted_required: false, model_invoked: false };
    } });
  const persist = () => fs.writeFileSync(reportPath, JSON.stringify({ schema: "casimirbot.private_clock_direct_startup.v1",
    capturedAt: new Date().toISOString(), userDataPath, runtime, results, deadlineMs: 5000,
    diagnostic, accountReaders: "controlled fixtures", actualComposedHost: true, installedDesktopAcceptance: false }, null, 2) + "\n");
  try {
    assert.equal((await host.installer.install()).status, "installed_stopped");
    for (const mode of ["first-use", "reused"]) {
      events = []; started = Date.now(); loop.reset(); const cpuStart = process.cpuUsage();
      const request = { schema: HELIX_ENVIRONMENT_PROBE_REQUEST_V1_SCHEMA, probe_request_id: `probe:direct-${randomUUID()}`,
        capability_id: HELIX_SYSTEM_CLOCK_READ_CAPABILITY, capability_version: 1, catalog_snapshot_id: "catalog:private-clock",
        arguments: { clock: "monotonic" }, constraints: { read_only: true, side_effects_allowed: false, max_duration_ms: 5000 },
        created_at: new Date(started).toISOString(), deadline_at: new Date(started + 5000).toISOString(),
        assistant_answer: false, raw_content_included: false };
      let outcome = "succeeded", code: string | undefined;
      try { assert.equal((await host.observe(request)).result.outcome, "succeeded"); }
      catch (error: any) { outcome = "failed"; code = error.code ?? "test_error"; }
      const record: Record<string, unknown> = { mode, requestId: request.probe_request_id, outcome, code,
        startedUtcMs: started, elapsedMs: Date.now() - started, events: [...events], status: host.status(),
        hostCpuMicroseconds: process.cpuUsage(cpuStart), hostMemory: process.memoryUsage(),
        eventLoopDelayMs: { max: loop.max / 1e6, mean: Number.isFinite(loop.mean) ? loop.mean / 1e6 : null } };
      if (diagnostic) {
        assert(fs.statSync(diagnostic.tracePath).size <= 65536);
        record.nativePhases = fs.readFileSync(diagnostic.tracePath, "utf8").trim().split(/\r?\n/).filter(Boolean)
          .map(line => JSON.parse(line)).filter(p => p.utcMs >= started).map(p => ({ ...p, sinceRequestMs: p.utcMs - started }));
      }
      results.push(record); persist();
      assert.deepEqual(host.status(), { admissionPending: false, running: false, fenced: false, pid: undefined });
      const history = await host.recoverObservation(request); record.history = history; persist();
      assert.equal(history.fresh, false); assert.equal(history.state, outcome === "succeeded" ? "accepted" : "uncertain");
    }
    assert.deepEqual(results.map(r => r.outcome), ["succeeded", "succeeded"]);
  } finally {
    EnvironmentClockNativeStaging.prototype.prepare = originalPrepare; loop.disable();
    try { await host.close(); } finally { persist(); console.log(JSON.stringify({ reportPath, results })); }
  }
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/measure-private-clock-host.ts")) {
  assert(process.argv.slice(2).every(a => a === "--instrumented"));
  runPrivateClockHostDiagnostic(process.argv.includes("--instrumented"))
    .catch(error => { console.error(error.code ?? "private_clock_diagnostic_failed"); process.exitCode = 1; });
}
