import fs from "node:fs";
import path from "node:path";

// Launch receipts are append-only. A restart must name the newest receipt,
// so an older, exited PID cannot stand in for the current host's identity.
export function latestPrivateLaunch(root) {
  const records = fs.readdirSync(root).flatMap(name => {
    if (name === "launch.json") return [{ name, sequence: 1 }];
    const match = /^launch-(\d{4,})\.json$/.exec(name);
    if (!match) return [];
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 2 ||
        String(sequence).padStart(4, "0") !== match[1]) throw Error("launch_record_sequence_invalid");
    return [{ name, sequence }];
  }).sort((a, b) => b.sequence - a.sequence);
  const latest = records[0];
  return latest ? { path: path.join(root, latest.name), sequence: latest.sequence } : null;
}

export function privateLaunchPaths(root, resumePath) {
  const latest = latestPrivateLaunch(root);
  if (!latest) return { launchPath: path.join(root, "launch.json"), logPath: path.join(root, "private-app.log") };
  if (!resumePath) throw Error("candidate_already_launched_use_recorded_profile");
  if (resumePath !== latest.path) throw Error("resume_latest_launch_required");
  const sequence = latest.sequence + 1;
  if (!Number.isSafeInteger(sequence)) throw Error("launch_record_sequence_invalid");
  const suffix = String(sequence).padStart(4, "0");
  return { launchPath: path.join(root, `launch-${suffix}.json`), logPath: path.join(root, `private-app-${suffix}.log`) };
}

export function requirePrivateProcessAbsent(pid, probe = value => process.kill(value, 0)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("resume_process_identity_invalid");
  try { probe(pid); }
  catch (error) { if (error.code === "ESRCH") return; throw error; }
  throw Error("resume_process_still_present");
}
