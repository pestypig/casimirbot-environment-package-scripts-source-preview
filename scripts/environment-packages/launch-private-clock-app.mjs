// Start one already-prepared private source candidate. A guarded resume may
// reopen an existing test profile after its recorded host/service have exited.
// Credentials and account stores are never inspected or copied.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { latestPrivateLaunch, privateLaunchPaths, requirePrivateProcessAbsent } from "./private-clock-launch-records.mjs";

const repo = fs.realpathSync(process.cwd());
const candidatePath = path.resolve(process.argv[2] ?? "");
const presentationCheck = process.argv[3] === "--presentation-check";
const resumePath = process.argv[3] === "--resume-from" && process.argv[4] ? path.resolve(process.argv[4]) : null;
if (process.argv.length > (resumePath ? 5 : 4) || (process.argv[3] && !presentationCheck && !resumePath)) throw Error("unknown_private_launch_mode");
const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
const root = fs.realpathSync(candidate.root);
if (path.dirname(root) !== path.join(repo, ".tmp") || !/^g16a-full-app-[A-Za-z0-9]{6}$/.test(path.basename(root)) ||
    candidatePath !== path.join(root, "candidate.json") || candidate.status !== "prepared") throw Error("identified_prepared_candidate_required");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const artifact of candidate.artifacts) {
  const file = path.resolve(root, artifact.path);
  if (!file.startsWith(root + path.sep) || hash(file) !== artifact.sha256) throw Error("candidate_artifact_changed");
}
const runtime = JSON.parse(fs.readFileSync(path.join(repo, "docs/evidence/eh-g8-codex-first-paid-product-delivery-v1/launch-program/2026-09-26-g16a-prepared-artifact-custody.json"), "utf8").replace(/^\uFEFF/, "")).bundle.root;
const reviewed = JSON.parse(fs.readFileSync(path.join(repo, "apps/desktop/environment-packages/system-clock/reviewed-prepared-runtime.json"), "utf8"));
if (!(Date.now() >= Date.parse(reviewed.validFrom) && Date.now() < Date.parse(reviewed.expiresAt))) throw Error("private_review_not_current");
for (const [name, item] of Object.entries(reviewed.files))
  if (hash(path.join(runtime, name)) !== item.sha256) throw Error("prepared_runtime_changed");
// The production loader still owns complete review/admission validation.
const allowed = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "HELIX_AGENT_OAUTH_ISSUER", "HELIX_AGENT_OAUTH_AUDIENCE", "HELIX_AGENT_OAUTH_JWKS_URL", "HELIX_AGENT_OAUTH_PROVIDER", "HELIX_AGENT_OAUTH_ALGORITHMS", "HELIX_AGENT_OAUTH_TENANT_CLAIM", "HELIX_AGENT_OAUTH_NATIVE_CLIENT_ID", "HELIX_AGENT_OAUTH_LINK_SCOPE", "HELIX_DEVELOPER_PROFILE_IDS"];
const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of ["HELIX_AGENT_OAUTH_ISSUER", "HELIX_AGENT_OAUTH_AUDIENCE", "HELIX_AGENT_OAUTH_NATIVE_CLIENT_ID", "HELIX_DEVELOPER_PROFILE_IDS"])
  if (!env[key]) throw Error(`missing_public_policy:${key}`);
Object.assign(env, { HELIX_PRIVATE_ENVIRONMENT_HOME: "1", HELIX_PRIVATE_CLOCK_RUNTIME: "1", HELIX_PRIVATE_CLOCK_RUNTIME_ROOT: runtime });
const profiles = path.join(env.LOCALAPPDATA, "CasimirBot-private-validation");
const launchRoot = presentationCheck ? fs.mkdtempSync(path.join(root, "presentation-")) : root;
const { launchPath, logPath } = privateLaunchPaths(launchRoot, resumePath);
fs.mkdirSync(profiles, { recursive: true });
const executable = path.join(repo, "apps/desktop/node_modules/electron/dist/electron.exe");
let userData, resumedFrom;
if (resumePath) {
  const priorRoot = fs.realpathSync(path.dirname(resumePath));
  if (path.dirname(priorRoot) !== path.join(repo, ".tmp") || !/^g16a-full-app-[A-Za-z0-9]{6}$/.test(path.basename(priorRoot)) ||
      resumePath !== latestPrivateLaunch(priorRoot)?.path) throw Error("resume_provenance_invalid");
  const prior = JSON.parse(fs.readFileSync(resumePath, "utf8"));
  if (prior.schema !== "casimirbot.private_full_app_launch.v1" || prior.candidatePath !== path.join(priorRoot, "candidate.json") ||
      hash(prior.candidatePath) !== prior.candidateSha256 || prior.executable !== executable || hash(executable) !== prior.executableSha256)
    throw Error("resume_provenance_invalid");
  userData = fs.realpathSync(prior.userData);
  if (path.dirname(userData) !== fs.realpathSync(profiles) || !/^g16a-full-app-[A-Za-z0-9]{6}$/.test(path.basename(userData)) ||
      fs.lstatSync(prior.userData).isSymbolicLink() || prior.readyReceiptPath !== path.join(userData, "state/desktop-service-ready.json"))
    throw Error("resume_profile_invalid");
  const ready = JSON.parse(fs.readFileSync(prior.readyReceiptPath, "utf8"));
  for (const pid of [prior.pid, ready.serviceProcessId]) {
    requirePrivateProcessAbsent(pid);
  }
  resumedFrom = { launchPath: resumePath, launchSha256: hash(resumePath), candidatePath: prior.candidatePath,
    previousHostPid: prior.pid, previousServicePid: ready.serviceProcessId, bothAbsentBeforeLaunch: true,
    credentialOrSessionStoreCopied: false };
} else userData = fs.mkdtempSync(path.join(profiles, presentationCheck ? "g16a-presentation-" : "g16a-full-app-"));
// Exclusive log reservation also prevents concurrent launches choosing the same
// next sequence. A failed launch keeps its log for diagnosis, never overwrites it.
const output = fs.openSync(logPath, "wx");
const child = spawn(executable, [candidate.desktop, `--user-data-dir=${userData}`], {
  cwd: root, env, windowsHide: false, detached: true, stdio: ["ignore", output, output] });
fs.closeSync(output);
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
child.unref();
const receipt = { schema: "casimirbot.private_full_app_launch.v1", at: new Date().toISOString(), pid: child.pid,
  purpose: presentationCheck ? "first-presentation-check-only" : "human-authenticated-qualification", windowsHide: false,
  candidatePath, candidateSha256: hash(candidatePath), executable, executableSha256: hash(executable), userData,
  ...(resumedFrom ? { resumedFrom } : {}),
  readyReceiptPath: path.join(userData, "state/desktop-service-ready.json"),
  privateClockRuntimeDirectory: runtime, reviewSha256: hash(path.join(repo, "apps/desktop/environment-packages/system-clock/reviewed-prepared-runtime.json")),
  publicPolicyKeysInherited: allowed.filter(key => key.startsWith("HELIX_") && env[key]),
  privateRuntimeOptIn: true, providerCredentialsInherited: false, authentication: "not observed", packagedAcceptance: false };
fs.writeFileSync(launchPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ launchPath, pid: receipt.pid, userData, readyReceiptPath: receipt.readyReceiptPath }));
