// Process inspection and ownership (S2.4), ported from grok_plugin_for_codex 1.1.0 lib/execution.mjs and lib/winargs.mjs
// (inline). `ownsExecution` delegates the job-specific argv evidence to `adapter.ownsProcess(row, job, platform,
// hasFlagOperand)`; darwin's ps adds `pgid=`; the empty-command-line list covers the three provider binaries and node; the
// depth guard reads the five A5.1 variables.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "./fs.mjs";
import { BINARIES, CHILD_BINARIES, DEPTH_VARIABLES } from "./host.mjs";

const UNKNOWN = { state: "unknown", rows: [] };
/** The first WMI query on a cold Windows machine can take several seconds; a query cut short reads as unknown. */
export const QUERY_MS = 20000;
const norm = (s, platform) => platform === "win32" ? String(s).replace(/\\/g, "/").toLowerCase() : String(s);
const decodeHex = (s) => /^(?:[0-9a-f]{4})*$/.test(s) ? (s.match(/.{4}/g) ?? []).map((c) => String.fromCharCode(parseInt(c, 16))).join("") : null;
const decodeText = (s) => s[0] === "=" ? (/^[\x20-\x7e]*$/.test(s.slice(1)) ? s.slice(1) : null) : s[0] === "x" ? decodeHex(s.slice(1)) : null;
const psRun = (script, env, timeout = QUERY_MS) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  env: { ...process.env, ...env }, encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024,
});

/** The depth guard (A5.1): refuse to run when any of the five variables is set in this process's environment. */
export function depthGuard(env = process.env) {
  const set = DEPTH_VARIABLES.filter((name) => env[name]);
  return set.length ? `refusing a nested call: ${set.join(", ")} set; this process runs inside a provider turn started by a plugin` : null;
}

/**
 * Splits a Windows command line into arguments the way CommandLineToArgvW does (grok_plugin_for_codex lib/winargs.mjs).
 */
export function parseWindowsCommandLine(line) {
  const isSpace = (char) => char === " " || char === "\t";
  let i = 0;
  while (isSpace(line[i])) i += 1;
  let programEnd = i, program;
  if (line[i] === '"') {
    programEnd = line.indexOf('"', i + 1);
    programEnd = programEnd < 0 ? line.length : programEnd;
    program = line.slice(i + 1, programEnd);
    i = Math.min(programEnd + 1, line.length);
  } else {
    while (programEnd < line.length && !isSpace(line[programEnd])) programEnd += 1;
    program = line.slice(i, programEnd);
    i = programEnd;
  }
  const args = [program];
  let current = "", inArgument = false, inQuotes = false;
  while (i < line.length) {
    const char = line[i];
    if (char === "\\") {
      let backslashes = 0;
      while (line[i] === "\\") { backslashes += 1; i += 1; }
      inArgument = true;
      if (line[i] !== '"') current += "\\".repeat(backslashes);
      else {
        current += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) { current += '"'; i += 1; }
      }
    } else if (char === '"') {
      inArgument = true;
      if (inQuotes && line[i + 1] === '"') { current += '"'; inQuotes = false; i += 2; }
      else { inQuotes = !inQuotes; i += 1; }
    } else if (isSpace(char) && !inQuotes) {
      if (inArgument) { args.push(current); current = ""; inArgument = false; }
      i += 1;
    } else { current += char; inArgument = true; i += 1; }
  }
  if (inArgument) args.push(current);
  return args;
}

const MODULES = `$env:PSModulePath="$PSHOME\\Modules";`;
const WINDOWS_LIST = `${MODULES}$ErrorActionPreference='Stop';
$props = 'ProcessId','ParentProcessId','CreationDate','CommandLine','Name','ThreadCount';
if ($env:CC_QUERY_PID) { $items = @(CimCmdlets\\Get-CimInstance Win32_Process -Property $props -Filter "ProcessId=$env:CC_QUERY_PID") } else { $items = @(CimCmdlets\\Get-CimInstance Win32_Process -Property $props) };
'ok'; $rows = @(foreach ($p in $items) {
  $cl = $p.CommandLine; $n = "$($p.Name)";
  $raw = if ($null -eq $cl) { '-' } elseif ($cl -cmatch '^[ -~]*\\z') { "=$cl" } else { 'x' + (-join $(foreach ($ch in [char[]]$cl) { '{0:x4}' -f [int]$ch })) };
  $name = if ($n -cmatch '^[ -~]*\\z') { "=$n" } else { 'x' + (-join $(foreach ($ch in [char[]]$n) { '{0:x4}' -f [int]$ch })) };
  $stamp = if ($p.CreationDate) { "$($p.CreationDate.ToUniversalTime().Ticks)" } else { "0" };
  "$($p.ProcessId)\t$($p.ParentProcessId)\t$stamp\t$raw\t$name\t$($p.ThreadCount)"
}); if ($rows.Count) { $rows -join "\n" }; 'complete'`;

function linuxRow(proc, pid, boot) {
  const file = `${proc}/${pid}`;
  const stat = fs.readFileSync(`${file}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return null;
  const argv = fs.readFileSync(`${file}/cmdline`, "utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  const check = fs.readFileSync(`${file}/stat`, "utf8"), again = check.slice(check.lastIndexOf(")") + 2).split(" ");
  if (again[19] !== fields[19]) throw new Error("process identity changed during query");
  const row = { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), stamp: fields[19], boot, argv, raw: argv.join(" "), name: path.basename(argv[0] ?? "") };
  return Number(again[6]) & 4 ? { ...row, exiting: true } : row;
}
function queryFailed(r, timeout) {
  if (r.error) return { ...UNKNOWN, error: r.error.code === "ETIMEDOUT" ? `process query timed out after ${timeout / 1000} s` : `process query failed: ${r.error.message}` };
  const text = String(r.stderr ?? "").split(/\r?\n\s*At line:/)[0].replace(/\s+/g, " ").trim().slice(0, 300);
  return { ...UNKNOWN, error: `process query failed: ${text || `exit code ${r.status}`}` };
}

/** Complete scoped process snapshot; an unavailable query is never an empty table. Rows carry pgid where the platform gives one. */
export function processSnapshot({ pid = null, platform = process.platform, run = spawnSync, powershell = psRun, timeout = QUERY_MS, proc = "/proc" } = {}) {
  try {
    if (platform === "linux") {
      const ids = pid === null ? fs.readdirSync(proc).filter((p) => /^\d+$/.test(p)).map(Number) : [pid];
      const boot = fs.readFileSync(`${proc}/sys/kernel/random/boot_id`, "utf8").trim(), rows = [];
      const deadline = Date.now() + timeout;
      for (const id of ids) {
        if (Date.now() > deadline) return UNKNOWN;
        try {
          if (pid === null && fs.statSync(`${proc}/${id}`).uid !== process.getuid()) continue;
          const row = linuxRow(proc, id, boot);
          if (row) rows.push(row);
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") return UNKNOWN; }
      }
      return { state: "ok", rows };
    }
    if (platform === "win32") {
      const r = powershell(WINDOWS_LIST, { CC_QUERY_PID: pid === null ? "" : String(pid) }, timeout);
      if (r.error || r.status !== 0) return queryFailed(r, timeout);
      const lines = r.stdout.trimEnd().split(/\r?\n/);
      if (lines.shift() !== "ok" || lines.pop() !== "complete") return UNKNOWN;
      const rows = [];
      for (const line of lines) {
        const fields = line.split("\t");
        if (fields.length !== 6 || ![...fields.slice(0, 3), fields[5]].every((s) => /^\d+$/.test(s))) return UNKNOWN;
        if (fields[5] === "0") continue;
        const inaccessible = fields[3] === "-";
        const raw = inaccessible ? null : decodeText(fields[3]);
        const name = decodeText(fields[4]);
        if ((!inaccessible && raw === null) || name === null) return UNKNOWN;
        rows.push({ pid: Number(fields[0]), ppid: Number(fields[1]), stamp: fields[2], raw, name, inaccessible, argv: raw ? parseWindowsCommandLine(raw) : null });
      }
      return { state: "ok", rows };
    }
    if (platform === "darwin") {
      const r = run("ps", ["-ww", ...(pid === null ? ["-ax"] : ["-p", String(pid)]), "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart=,args="], {
        encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8" }, shell: false, timeout, maxBuffer: 16 * 1024 * 1024,
      });
      if (r.error || (r.status !== 0 && !(pid !== null && r.status === 1 && !r.stdout.trim()))) return queryFailed(r, timeout);
      const rows = [];
      for (const line of r.stdout.split("\n").filter((s) => s.trim())) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line);
        if (!m) return UNKNOWN;
        if (m[5].startsWith("Z") || (pid === null && Number(m[4]) >>> 0 !== process.getuid())) continue;
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stamp: m[6].replace(/\s+/g, " "), raw: m[7], argv: null, name: m[7].split(" ")[0] });
      }
      return { state: "ok", rows };
    }
  } catch { return UNKNOWN; }
  return UNKNOWN;
}

export function sameIdentity(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.stamp && b.stamp === a.stamp && (a.boot ?? null) === (b.boot ?? null));
}
export function currentIdentity(pid = process.pid, options = {}) {
  const snapshot = processSnapshot({ ...options, pid });
  return snapshot.state === "ok" ? snapshot.rows[0] ?? null : null;
}

/**
 * Whether a process row carries `--flag <operand>` as a whole argument pair: exact on Linux/Windows (argv), and on macOS
 * (raw text only) as the whole-word pair `--flag <operand>` within the command line, never a substring of another word.
 */
export function hasFlagOperand(row, flag, operand, platform = process.platform) {
  if (operand === undefined || operand === null) return false;
  if (row.argv) return row.argv.some((s, i) => s === flag && norm(row.argv[i + 1], platform) === norm(operand, platform));
  if (typeof row.raw !== "string") return false;
  const needle = ` ${flag} ${operand}`;
  let at = -1;
  while ((at = row.raw.indexOf(needle, at + 1)) >= 0) {
    const after = row.raw[at + needle.length];
    if (after === undefined || after === " ") return true;
  }
  return false;
}
/**
 * macOS gives only the space-joined command line, which cannot tell one argument from several. A row matches by suffix:
 * it must end with the job's complete recorded child-argument string (which carries the job-specific operand), and the
 * program part before it must be the recorded launcher, or equal the provider's native binary (`binary`, named
 * explicitly) or end with `/<binary>`, as when `node /npm/grok` execs the native grok (grok_plugin_for_codex 1.1.0
 * `ownsExecution`, generalized from `grok` to the provider's binary name). A program part with spaces is a path with
 * spaces only when that file exists (`/Users/First Last/.grok/bin/grok`); otherwise it may be a wrapper's arguments, so
 * the row cannot be parsed unambiguously: `null`, which ownership reads as unknown, never gone.
 */
export function ownsRecordedInvocation(row, job, binary = null, exists = fs.existsSync) {
  const childArgs = job.childArgs ?? [];
  if (!job.argv?.length || !childArgs.length || typeof row.raw !== "string") return false;
  const suffix = childArgs.join(" ");
  if (!row.raw.endsWith(` ${suffix}`)) return false;
  const program = row.raw.slice(0, -suffix.length - 1);
  if (program === job.argv.slice(0, job.argv.length - childArgs.length).join(" ")) return true;
  if (!binary || (program !== binary && !program.endsWith(`/${binary}`))) return false;
  if (!program.includes(" ")) return true;
  return program.startsWith("/") && exists(program) ? true : null;
}
/** The provider's binary name (host.mjs), or the adapter's own `binary` for a test adapter. */
export const binaryOf = (adapter) => BINARIES[adapter?.id]?.name ?? adapter?.binary ?? null;
/**
 * Ownership of one row always goes through the adapter's job-specific evidence (`adapter.ownsProcess` over
 * `hasFlagOperand`); on macOS, whose rows are text only, the row must also carry the complete recorded invocation.
 * Without an adapter nothing is owned (and `ownedExecution` reports unknown).
 */
export function ownsExecution(row, job, platform = process.platform, adapter = null, binary = binaryOf(adapter)) {
  if (!adapter?.ownsProcess) return false;
  if (!row.argv && (platform !== "darwin" || ownsRecordedInvocation(row, job, binary) !== true)) return false;
  return Boolean(adapter.ownsProcess(row, job, platform, hasFlagOperand));
}

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
/**
 * A creation stamp in comparable form: Linux jiffies and Windows ticks as BigInt, macOS `ps -o lstart` text
 * ("Sat Oct 31 12:00:00 2026", local time) as epoch seconds; null when unreadable.
 */
export function startTime(stamp) {
  if (/^\d+$/.test(stamp ?? "")) return BigInt(stamp);
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2}) (\d{4})$/.exec(String(stamp ?? "").trim());
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (month < 0 || month % 3) return null;
  return BigInt(Math.floor(new Date(Number(m[6]), month / 3, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000));
}
/** The launched child's (the macOS group leader's) creation time from `job.leader`, recorded right after spawn; null means no leader identity. */
function leaderStart(job) {
  return job.leader && job.leader.pid === job.pid ? startTime(job.leader.stamp) : null;
}

const EPOCH_TICKS = 621355968000000000n;
/** On Windows a PowerShell query costs most of a second per turn, so Node supplies the start time instead. */
export function selfIdentity(platform = process.platform) {
  if (platform === "win32") return { pid: process.pid, startedMs: Math.round(Date.now() - process.uptime() * 1000) };
  return currentIdentity(process.pid, { platform });
}
/** The companion's identity, not its heartbeat, controls whether recovery can free a claim. */
export function companionState(job, snapshot) {
  if (snapshot.state !== "ok") return "unknown";
  const row = snapshot.rows.find((r) => r.pid === job.companionPid);
  if (!row) return "gone";
  const id = job.companionIdentity;
  if (!id) return "unknown";
  if (id.startedMs === undefined) return sameIdentity(row, id) ? "live" : "gone";
  if (!/^[1-9]\d*$/.test(row.stamp ?? "")) return "unknown";
  return Math.abs(Number((BigInt(row.stamp) - EPOCH_TICKS) / 10000n) - id.startedMs) <= 5000 ? "live" : "gone";
}

export function recoveryEvidence(job) {
  const dir = path.join(job.dir, "cleanup-evidence");
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    if (record.ownerToken !== (job.ownerToken ?? null) || !Array.isArray(record.rows)) throw new Error("unreadable cleanup evidence");
    rows.push(...record.rows);
  }
  return rows;
}
export function recordRecoveryEvidence(job, rows) {
  if (!rows.length) return;
  const dir = path.join(job.dir, "cleanup-evidence");
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, `${randomUUID()}.json`), JSON.stringify({ ownerToken: job.ownerToken ?? null, rows }));
}

/**
 * Discover owned execution behind dead launchers and retain separately grouped known descendants. A descendant counts
 * only when born at or after its parent; a persisted identity (`job.execution`, refreshed by the lifecycle on every
 * heartbeat and stop snapshot, plus cancel's evidence) counts by pid and creation time. On darwin, members of a group a
 * live owned row leads count when born at or after that leader. Any other live member of group job.pid is never
 * signalled and is reported in `unverified`, making the state unknown, unless a live process holding pid job.pid has a
 * creation time outside the recorded leader's (a reused group id) and the member was born at or after it. A darwin text
 * row that cannot be parsed unambiguously is unknown too. Without an adapter ownership is unknown.
 */
export function ownedExecution(job, snapshot, platform = process.platform, evidence = [], adapter = null) {
  if (snapshot.state !== "ok") return { state: "unknown", rows: [], ...(snapshot.error && { error: snapshot.error }) };
  if (!adapter?.ownsProcess) return { state: "unknown", rows: [], error: "ownership evidence unavailable: the provider module is not loaded" };
  const rows = snapshot.rows;
  // On darwin a persisted identity is evidence only when the leader's own identity was recorded (`job.leader`).
  const known = platform === "darwin" && leaderStart(job) === null ? [] : [...(job.execution ?? []), ...evidence];
  const owned = new Map();
  let unknown = false;
  const launched = path.basename(job.argv?.[0] ?? "").toLowerCase();
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    if (ownsExecution(row, job, platform, adapter) || known.some((p) => sameIdentity(p, row))) owned.set(row.pid, row);
    if (!row.raw && !row.inaccessible && [...CHILD_BINARIES, launched].includes(row.name?.toLowerCase())) unknown = true;
    // A text row that carries the job's arguments and operand but cannot be parsed unambiguously: never signalled, never gone.
    if (platform === "darwin" && !row.argv && !owned.has(row.pid) && ownsRecordedInvocation(row, job, binaryOf(adapter)) === null
      && adapter.ownsProcess(row, job, platform, hasFlagOperand)) unknown = true;
  }
  const atOrAfter = (child, from) => { const t = startTime(child.stamp); return from === null || from === undefined || (t !== null && t >= from); };
  const bornAfter = (child, parent) => startTime(child.stamp) === null || atOrAfter(child, startTime(parent.stamp));
  // Groups by leader pid → earliest start a member may have. Only a group a live owned row leads is followed: a child
  // that shares its parent's group, as a test's or a shell's does, never pulls that group in.
  const groups = new Map();
  const leads = (r) => Number.isInteger(r.pgid) && r.pgid === r.pid && r.pid !== process.pid;
  if (platform === "darwin") for (const r of owned.values()) if (leads(r)) groups.set(r.pgid, startTime(r.stamp));
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.pid) || row.pid === process.pid) continue;
      const child = owned.has(row.ppid) && bornAfter(row, owned.get(row.ppid));
      const member = platform === "darwin" && Number.isInteger(row.pgid) && groups.has(row.pgid) && atOrAfter(row, groups.get(row.pgid));
      if (child || member) { owned.set(row.pid, row); if (platform === "darwin" && leads(row) && !groups.has(row.pgid)) groups.set(row.pgid, startTime(row.stamp)); changed = true; }
    }
  }
  // Every live member of the launched child's group (pgid == job.pid) that no evidence adopted is unverified, whatever its
  // birth time (a surviving descendant can spawn after the companion finalized). The one exception: a live process holds
  // pid job.pid with a creation time outside the recorded leader's, so the group id was reused and members born at or
  // after that new leader are unrelated; a member that predates it (or has no readable time) stays unverified.
  const unverified = [];
  if (platform === "darwin" && Number.isInteger(job.pid) && job.pid > 0) {
    const members = rows.filter((r) => r.pgid === job.pid && !owned.has(r.pid) && r.pid !== process.pid);
    const holder = rows.find((r) => r.pid === job.pid && !owned.has(r.pid));
    const start = leaderStart(job), born = holder ? startTime(holder.stamp) : null;
    if (holder && start !== null && born !== null && born !== start) {
      unverified.push(...members.filter((r) => r.pid !== job.pid && (startTime(r.stamp) === null || startTime(r.stamp) < born)));
    } else unverified.push(...members);
  }
  if (unverified.length) unknown = true;
  if (rows.some((r) => r.inaccessible && (r.pid === job.pid || owned.has(r.pid) || known.some((p) => sameIdentity(p, r))))) unknown = true;
  if ([...owned.values()].some((r) => !r.stamp || r.stamp === "0" || (!r.raw && !r.exiting))) unknown = true;
  return { state: unknown ? "unknown" : owned.size ? "owned" : "gone", rows: [...owned.values()], ...(unverified.length ? { unverified } : {}) };
}

const WINDOWS_KILL = `${MODULES}$ErrorActionPreference='Stop';
try { $p=Get-Process -Id $env:CC_KILL_PID -ErrorAction Stop; $h=$p.Handle } catch { 'unknown'; exit };
if ($p.HasExited) { 'gone'; exit };
$q=Get-CimInstance Win32_Process -Filter "ProcessId=$env:CC_KILL_PID";
if (-not $q -or -not $q.CommandLine) { 'unknown'; exit };
if ("$($q.CreationDate.ToUniversalTime().Ticks)" -ne $env:CC_KILL_STAMP -or $q.CommandLine -cne $env:CC_KILL_RAW) { 'mismatch'; exit };
taskkill /T /F /PID $env:CC_KILL_PID | Out-Null;
if ($LASTEXITCODE -eq 0 -or $p.HasExited) { 'sent' } else { 'unknown' }`;

/**
 * Stop one identified process: `signal` SIGTERM first (the group stop of A7.5) or SIGKILL. Signal delivery is not
 * confirmation; callers rescan before declaring cleanup complete. On Windows `taskkill /T /F` after an identity check.
 */
export function stopIdentity(row, { platform = process.platform, snapshot = processSnapshot, kill = process.kill.bind(process), powershell = psRun, timeout = QUERY_MS, signal = "SIGKILL" } = {}) {
  if (row.pid === process.pid) return "unknown";
  if (platform === "win32") {
    const r = powershell(WINDOWS_KILL, { CC_KILL_PID: String(row.pid), CC_KILL_STAMP: row.stamp, CC_KILL_RAW: row.raw }, timeout);
    const result = r.stdout?.trim().split(/\s+/).at(-1);
    return r.status === 0 && ["sent", "gone", "mismatch"].includes(result) ? result : "unknown";
  }
  const now = snapshot({ pid: row.pid, platform, timeout });
  if (now.state !== "ok") return "unknown";
  const current = now.rows.find((r) => r.pid === row.pid);
  if (!current || !sameIdentity(row, current)) return "gone";
  if (platform === "darwin" && current.raw !== row.raw) return "unknown";
  try { kill(row.pid, signal); return "sent"; }
  catch (e) { return e.code === "ESRCH" ? "gone" : "unknown"; }
}

/** The controller the lifecycle uses; `adapter` supplies the ownership evidence (loaded for ownsProcess only on cancel). */
export function executionController(options = {}) {
  const platform = options.platform ?? process.platform;
  const snapshot = options.snapshot ?? processSnapshot;
  const adapter = options.adapter ?? null;
  return {
    platform,
    snapshot: (timeout = QUERY_MS) => snapshot({ platform, timeout, powershell: options.powershell, run: options.run }),
    self: () => selfIdentity(platform),
    /** One scoped query for a single pid's identity (the leader right after spawn), or null. */
    identify: (pid, timeout = QUERY_MS) => {
      const found = snapshot({ pid, platform, timeout, powershell: options.powershell, run: options.run });
      return found.state === "ok" ? found.rows.find((r) => r.pid === pid) ?? null : null;
    },
    inspect: (job, snap) => ownedExecution(job, snap, platform, recoveryEvidence(job), adapter),
    stop: (row, timeout = QUERY_MS, signal = "SIGKILL") => stopIdentity(row, { ...options, platform, snapshot, timeout, signal }),
  };
}
