// S2.4/S2.6: the Windows process query's encoding and the ownership decisions made from it, ported from
// grok_plugin_for_codex 1.1.0 tests/windows-scan.test.mjs, plus self-identity and cancellation through main() with a fake
// PowerShell runner (PowerShell cannot run here, so the tests feed processSnapshot the text the query prints).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { makeWorld } from "./helpers.mjs";
import adapter from "./fixtures/null-adapter.mjs";
import { processSnapshot, ownedExecution, companionState, recoveryEvidence, stopIdentity, parseWindowsCommandLine } from "../plugins/council/scripts/lib/core/execution.mjs";
import { createJob, loadJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { cancelManaged } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { main } from "../plugins/council/scripts/council.mjs";

const UNKNOWN = { state: "unknown", rows: [] };
const hex = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, "0")).join("");
// One text field as the query prints it. JavaScript's $ without the m flag is .NET's \z.
const encodeText = (s) => (s === null ? "-" : /^[\x20-\x7e]*$/.test(s) ? `=${s}` : `x${hex(s)}`);
/** The query's output: PowerShell ends each output with CRLF; the rows are one output joined by LF. */
function output(rows) {
  const lines = rows.map((r) => [r.pid, r.ppid, r.stamp, encodeText(r.raw), encodeText(r.name), r.threads ?? 1].join("\t"));
  return `ok\r\n${lines.length ? `${lines.join("\n")}\r\n` : ""}complete\r\n`;
}
const scan = (rows) => processSnapshot({ platform: "win32", powershell: () => ({ status: 0, stdout: output(rows) }) });
/** The previous release's output and parser: every field in hex, one line per row. */
const oldOutput = (rows) => ["ok", ...rows.map((r) => [r.pid, r.ppid, r.stamp, r.raw === null ? "-" : hex(r.raw), hex(r.name), r.threads ?? 1].join("\t")), "complete", ""].join("\r\n");
function oldParse(stdout) {
  const decodeHex = (s) => /^(?:[0-9a-f]{4})*$/.test(s) ? (s.match(/.{4}/g) ?? []).map((c) => String.fromCharCode(parseInt(c, 16))).join("") : null;
  const lines = stdout.trimEnd().split(/\r?\n/);
  if (lines.shift() !== "ok" || lines.pop() !== "complete") return UNKNOWN;
  const rows = [];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 6 || ![...fields.slice(0, 3), fields[5]].every((s) => /^\d+$/.test(s))) return UNKNOWN;
    if (fields[5] === "0") continue;
    const inaccessible = fields[3] === "-";
    const raw = inaccessible ? null : decodeHex(fields[3]);
    const name = decodeHex(fields[4]);
    if ((!inaccessible && raw === null) || name === null) return UNKNOWN;
    rows.push({ pid: Number(fields[0]), ppid: Number(fields[1]), stamp: fields[2], raw, name, inaccessible, argv: raw ? parseWindowsCommandLine(raw) : null });
  }
  return { state: "ok", rows };
}
const HOSTILE = ['"C:\\Program Files\\Grok\\grok.exe" --prompt-file "C:\\a b\\prompt.md"', 'a "b c" d\\"e f\\\\"g h', "trailing\\", "tab\there", "line\nbreak", "cr\rlf\r\n",
  "ends with newline\n", "nul\u0000inside", "É User\\naïve 漢字", "emoji 😀 pair", "lone \ud800 high", "lone \udc00 low", "del\u007f", "=starts with equals", "x0041", "-", "", " ", "x",
  "%PATH% $env:X `tick 'single' ^&|<>", "k\u212a kelvin", "ß"];

test("every command line and name round-trips, and parses as CommandLineToArgvW would split it", () => {
  const rows = HOSTILE.map((raw, i) => ({ pid: 100 + i, ppid: 4, stamp: String(638900000000000000n + BigInt(i)), raw, name: raw }));
  const result = scan(rows);
  assert.equal(result.state, "ok");
  assert.deepEqual(result.rows.map((r) => r.raw), HOSTILE);
  assert.deepEqual(result.rows.map((r) => r.name), HOSTILE);
  for (const r of result.rows) assert.deepEqual(r.argv, r.raw ? parseWindowsCommandLine(r.raw) : null, JSON.stringify(r.raw));
  const text = output(rows);
  assert.ok(text.includes("\t=\"C:\\Program Files\\Grok\\grok.exe\" --prompt-file"), text);
  assert.ok(/^[\x20-\x7e\t\r\n]*$/.test(text), "the output is ASCII");
  assert.equal(text.split("\n").length, rows.length + 3);
});

function* random(seed) { for (let x = seed; ;) { x = (x * 1103515245 + 12345) % 2147483648; yield x / 2147483648; } }
const ALPHABET = ["a", "Z", "0", " ", '"', "\\", "\t", "\r", "\n", "\u0000", "é", "漢", "\ud83d\ude00", "\ud800", "\u007f", "=", "x", "-", "~", "%"];

test("the encoding parses to exactly the rows the previous all-hex encoding did", () => {
  for (const seed of [1, 2, 3]) {
    const next = random(seed);
    const pick = (n) => Array.from({ length: Math.floor(next.next().value * n) }, () => ALPHABET[Math.floor(next.next().value * ALPHABET.length)]).join("");
    const rows = Array.from({ length: 300 }, (_, i) => {
      const r = next.next().value;
      const raw = r < 0.1 ? null : r < 0.7 ? `C:\\Windows\\System32\\svchost.exe -k netsvcs -p -s ${i}` : pick(40);
      return { pid: 1000 + i, ppid: 4 + (i % 7), stamp: String(638900000000000000n + BigInt(i * 7)), raw, name: r < 0.8 ? "svchost.exe" : pick(12), threads: r > 0.95 ? 0 : 3 };
    });
    assert.deepEqual(scan(rows), oldParse(oldOutput(rows)), `seed ${seed}`);
  }
  assert.deepEqual(scan([]), { state: "ok", rows: [] });
});

test("both scripts set Windows PowerShell's module path first and use only ASCII framing", () => {
  const scripts = [];
  processSnapshot({ platform: "win32", powershell: (s) => { scripts.push(s); return { status: 0, stdout: "ok\r\ncomplete\r\n" }; } });
  stopIdentity({ pid: 7, stamp: "1", raw: "grok" }, { platform: "win32", powershell: (s) => { scripts.push(s); return { status: 0, stdout: "gone" }; } });
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.ok(script.startsWith("$env:PSModulePath=\"$PSHOME\\Modules\";$ErrorActionPreference='Stop';"), script);
  assert.equal(scripts[0].match(/-cmatch '\^\[ -~\]\*\\z'/g).length, 2);
  assert.ok(scripts[0].endsWith("if ($rows.Count) { $rows -join \"\n\" }; 'complete'"));
  assert.match(scripts[1], /taskkill \/T \/F \/PID \$env:CC_KILL_PID/);
});

test("a malformed field or framing reads as unknown, never as fewer processes", () => {
  const good = output([{ pid: 7, ppid: 4, stamp: "638900000000000000", raw: "grok --version", name: "grok.exe" }]);
  assert.equal(processSnapshot({ platform: "win32", powershell: () => ({ status: 0, stdout: good }) }).state, "ok");
  for (const bad of [good.replace("=grok --version", "grok --version"), good.replace("=grok --version", "=grök"), good.replace("=grok.exe", "x67a"), good.replace("=grok.exe", "x006G"),
    good.replace("=grok.exe", "-"), good.replace("=grok.exe", "X0067"), good.replace("complete\r\n", ""), good.replace("ok\r\n", ""), good.replace("=grok --version", "=grok --version\r"),
    good.replace("=grok --version", "=grok --version\u2028"), good.replace("=grok.exe", "=grok.exe\u2029")]) {
    assert.deepEqual(processSnapshot({ platform: "win32", powershell: () => ({ status: 0, stdout: bad }) }), UNKNOWN, JSON.stringify(bad));
  }
});

// A Windows-shaped null job: a node launcher whose backend carries the same --prompt-file operand.
const PROMPT = "C:\\Users\\É User\\.codex\\council\\jobs\\aaaaaaaaaaaaaaaa\\prompt.md";
const ARGS = ["--model", "null-model", "--prompt-file", PROMPT];
const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
const cmd = (...args) => args.map(quote).join(" ");
const JOB = { dir: "C:\\Users\\É User\\.codex\\council\\jobs\\aaaaaaaaaaaaaaaa", promptFile: PROMPT, childArgs: ARGS, pid: 300, execution: [],
  argv: ["C:\\Program Files\\nodejs\\node.exe", "C:\\fake-child.mjs", ...ARGS] };
const T = 638900000000000000n;
const at = (s) => String(T + BigInt(s) * 10000000n);
const launcher = { pid: 300, ppid: 290, stamp: at(10), raw: cmd(...JOB.argv), name: "node.exe" };
const backend = { pid: 301, ppid: 300, stamp: at(11), raw: cmd("C:\\Tools\\null.exe", ...ARGS), name: "null.exe" };
const tool = { pid: 302, ppid: 301, stamp: at(12), raw: "cmd.exe /c npm test", name: "cmd.exe" };
const stranger = { pid: 400, ppid: 4, stamp: at(1), raw: "C:\\Windows\\explorer.exe", name: "explorer.exe" };
const owned = (job, rows) => { const r = ownedExecution(job, scan(rows), "win32", [], adapter); return [r.state, r.rows.map((x) => x.pid)]; };

test("an early-exiting launcher's backend and its children are still found and owned through the adapter's operand", () => {
  assert.deepEqual(owned(JOB, [stranger, launcher, backend, tool]), ["owned", [300, 301, 302]]);
  assert.deepEqual(owned(JOB, [stranger, backend, tool]), ["owned", [301, 302]], "the backend names its dead launcher as parent and is found by its operand");
  assert.deepEqual(owned(JOB, [stranger]), ["gone", []]);
  const mention = { pid: 303, ppid: 4, stamp: at(13), raw: `node -e "console.log('--prompt-file ${PROMPT}')"`, name: "node.exe" };
  assert.deepEqual(owned(JOB, [mention]), ["gone", []], "a quoted mention of the path is not the operand");
});

test("a recorded child that outlives its parent stays owned until it is gone; a reused PID is never taken for it", () => {
  const known = { ...JOB, execution: [launcher, backend, tool].map((r) => ({ pid: r.pid, ppid: r.ppid, stamp: r.stamp })) };
  assert.deepEqual(owned(known, [stranger, tool]), ["owned", [302]]);
  assert.deepEqual(owned(known, [tool, { pid: 303, ppid: 302, stamp: at(13), raw: "node test.js", name: "node.exe" }]), ["owned", [302, 303]]);
  const reused = { pid: 300, ppid: 4, stamp: at(50), raw: "C:\\Windows\\notepad.exe", name: "notepad.exe" };
  assert.deepEqual(owned(JOB, [reused]), ["gone", []]);
  assert.deepEqual(owned({ ...JOB, execution: [{ pid: 302, stamp: tool.stamp }] }, [{ ...tool, stamp: at(60) }]), ["gone", []]);
  assert.deepEqual(owned(JOB, [backend, { pid: 304, ppid: 301, stamp: at(5), raw: "old.exe", name: "old.exe" }]), ["owned", [301]], "Windows never reparents: an older process is not a child");
});

test("denied inspection stays unknown wherever it could be ours; an exited process held by a handle is not running", () => {
  const denied = (r) => ({ ...r, raw: null });
  assert.equal(owned(JOB, [denied(launcher)])[0], "unknown", "the launched pid");
  assert.equal(owned(JOB, [backend, denied(tool)])[0], "unknown", "an owned descendant");
  assert.equal(owned({ ...JOB, execution: [{ pid: 302, stamp: tool.stamp }] }, [denied(tool)])[0], "unknown", "a known identity");
  assert.deepEqual(owned(JOB, [backend, denied(stranger)]), ["owned", [301]], "a stranger's process is no evidence");
  assert.deepEqual(owned(JOB, [{ ...denied(launcher), threads: 0 }]), ["gone", []]);
});

test("cancelManaged stops an orphaned backend after its companion is lost, and never while the companion lives", async () => {
  const w = makeWorld();
  const start = (secs) => Number((T + BigInt(secs) * 10000000n - 621355968000000000n) / 10000n);
  const job = createJob(w.home, { ...JOB, provider: "null", verb: "ask", status: "running", threadId: null, requestedThreadId: "00000001-0000-4000-8000-000000000001",
    threadIds: ["00000001-0000-4000-8000-000000000001"], admitted: true, cleanupPending: false, companionPid: 299, companionIdentity: { pid: 299, startedMs: start(9) }, cwd: w.workspace,
    spawnedAt: new Date().toISOString() });
  claimThread(w.home, "null", job.requestedThreadId, job);
  const companion = { pid: 299, ppid: 4, stamp: at(9), raw: "node council.mjs ask", name: "node.exe" };
  const control = (tables, stops) => ({ snapshot: () => scan(tables.length > 1 ? tables.shift() : tables[0]),
    inspect: (j, snapshot) => ownedExecution(j, snapshot, "win32", recoveryEvidence(j), adapter), stop: (row) => { stops.push(row); return "sent"; } });
  const live = [];
  const waited = await cancelManaged({ home: w.home }, loadJob(w.home, job.id), { timeoutMs: 300, control: control([[companion, backend]], live) });
  assert.deepEqual([waited.code, waited.status, live], [1, "not-stopped", []]);
  assert.equal(inspectClaim(w.home, "null", job.requestedThreadId).job, job.id);
  const stops = [];
  const reused = { ...companion, stamp: at(40) };
  const result = await cancelManaged({ home: w.home }, loadJob(w.home, job.id), { timeoutMs: 5000, control: control([[reused, backend], [reused]], stops) });
  assert.deepEqual([result.code, result.status], [0, "cancelled"], JSON.stringify(result));
  assert.deepEqual(stops.map((r) => [r.pid, r.stamp, r.raw]), [[301, backend.stamp, backend.raw]]);
  assert.equal(inspectClaim(w.home, "null", job.requestedThreadId).state, "absent");
  assert.equal(companionState({ companionPid: 299, companionIdentity: { pid: 299, startedMs: start(9) } }, scan([companion])), "live");
});

/** main() in-process with a fake PowerShell: the list query answers from `tables` in turn; the kill script answers `kill`. */
async function cancelThroughMain(w, args, { tables, kill = () => "sent" }) {
  let out = "", err = "";
  const kills = [];
  const powershell = (script, env) => {
    if (script.includes("taskkill")) { kills.push({ ...env }); return { status: 0, stdout: `${kill(env)}\r\n` }; }
    const rows = tables.length > 1 ? tables.shift() : tables[0];
    return rows === null ? { status: 1, stdout: "", stderr: "CimCmdlets could not be loaded" } : { status: 0, stdout: output(rows) };
  };
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, stdin: process.stdin };
  const code = await main(["cancel", ...args], { ...w.env }, io, { platform: "win32", powershell, cwd: w.workspace });
  return { code, out, err, kills };
}

test("through main(): Windows self-identity ticks decide whether the owner companion lives, and only a gone owner's child is killed", async () => {
  const w = makeWorld();
  const startedMs = Date.now() - 60000;
  const ticks = (ms) => String(BigInt(ms) * 10000n + 621355968000000000n);
  const thread = "00000002-0000-4000-8000-000000000002";
  const job = createJob(w.home, { provider: "null", verb: "ask", status: "running", cwd: fs.realpathSync(w.workspace), session: null, threadId: null, requestedThreadId: thread, threadIds: [thread],
    admitted: true, cleanupPending: false, companionPid: 4100, companionIdentity: { pid: 4100, startedMs }, pid: 4200, promptFile: PROMPT, childArgs: ARGS, argv: JOB.argv,
    spawnedAt: new Date().toISOString(), execution: [] });
  claimThread(w.home, "null", thread, job);
  const owner = { pid: 4100, ppid: 4, stamp: ticks(startedMs + 40), raw: "node council.mjs ask", name: "node.exe" };
  const child = { pid: 4200, ppid: 4100, stamp: ticks(startedMs + 900), raw: cmd(...JOB.argv), name: "node.exe" };
  const live = await cancelThroughMain(w, [job.id, "--timeout", "0.3"], { tables: [[owner, child]] });
  assert.equal(live.code, 1, live.out + live.err);
  assert.match(live.out, /^not-stopped · null · job /);
  assert.deepEqual(live.kills, [], "a live owner (birth within 5 s of its recorded start) is never signalled");
  const refused = await cancelThroughMain(w, [job.id, "--confirm-ended"], { tables: [[owner, child]] });
  assert.equal(refused.code, 10);
  assert.match(refused.out, /refused · null · job .* --confirm-ended refused: the owner companion \(pid 4100\) is still live/);
  const failed = await cancelThroughMain(w, [job.id, "--confirm-ended"], { tables: [null] });
  assert.equal(failed.code, 10, "a failed process query refuses --confirm-ended");
  assert.match(failed.out, /process query failed: CimCmdlets could not be loaded/);
  const reusedOwner = { ...owner, stamp: ticks(startedMs + 30000) };
  const stopped = await cancelThroughMain(w, [job.id, "--timeout", "5", "--json"], { tables: [[reusedOwner, child], [reusedOwner]] });
  assert.equal(stopped.code, 0, stopped.out + stopped.err);
  assert.deepEqual(JSON.parse(stopped.out).status, "cancelled");
  assert.deepEqual(stopped.kills.map((k) => [k.CC_KILL_PID, k.CC_KILL_STAMP, k.CC_KILL_RAW]), [["4200", child.stamp, child.raw]], "the kill passes the observed birth and command line");
  assert.equal(inspectClaim(w.home, "null", thread).state, "absent");
  assert.ok(fs.existsSync(path.join(job.dir, "stopped")));
});

test("through main(): a kill refused on a mismatch keeps the claim and reports not stopped", async () => {
  const w = makeWorld();
  const thread = "00000003-0000-4000-8000-000000000003";
  const job = createJob(w.home, { provider: "null", verb: "ask", status: "running", cwd: fs.realpathSync(w.workspace), session: null, requestedThreadId: thread, threadIds: [thread],
    admitted: true, companionPid: 5100, companionIdentity: { pid: 5100, startedMs: 1 }, pid: 5200, promptFile: PROMPT, childArgs: ARGS, argv: JOB.argv, spawnedAt: new Date().toISOString(), execution: [] });
  claimThread(w.home, "null", thread, job);
  const child = { pid: 5200, ppid: 5100, stamp: at(70), raw: cmd(...JOB.argv), name: "node.exe" };
  const r = await cancelThroughMain(w, [job.id, "--timeout", "0.5"], { tables: [[child]], kill: () => "mismatch" });
  assert.equal(r.code, 1);
  assert.ok(r.kills.length >= 1);
  assert.equal(inspectClaim(w.home, "null", thread).job, job.id, "nothing is released while the child survives");
  assert.ok(!fs.existsSync(path.join(job.dir, "stopped")));
});
