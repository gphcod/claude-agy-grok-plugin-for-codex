#!/usr/bin/env node
// The null adapter's child (S2.1): a provider-shaped process with no model behind it. It reads the launch the null
// adapter builds (see null-adapter.mjs for the profiles), logs it to COUNCIL_FAKE_LOG, and plays COUNCIL_FAKE_SCENARIO:
// ok, slow, hold-pipes, exit-nonzero, huge-line, fragmented-frames, no-completion, fail-then-success.
// Protocol (NDJSON on stdout): {type:"start",thread} · {type:"text",data} · {type:"tool",name,path,ok} · {type:"end",thread,cost}.
// The answer-file profile writes the answer to --answer-file and streams start/end only.
import fs from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const scenario = process.env.COUNCIL_FAKE_SCENARIO || "ok";
const log = (entry) => { if (process.env.COUNCIL_FAKE_LOG) fs.appendFileSync(process.env.COUNCIL_FAKE_LOG, `${JSON.stringify(entry)}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const fragmented = (event) => { for (const byte of Buffer.from(`${JSON.stringify(event)}\n`)) process.stdout.write(Buffer.from([byte])); };

if (argv[0] === "--version") { log({ probe: "version" }); console.log("null 0.0.1"); process.exit(0); }
if (argv[0] === "models") { log({ probe: "models" }); console.log("- null-model\n- null-fast"); process.exit(0); }

let prompt = "";
const promptFile = flag("--prompt-file");
if (promptFile !== undefined) prompt = fs.readFileSync(promptFile, "utf8");
else { for await (const chunk of process.stdin) prompt += chunk; }
const thread = flag("--thread") ?? `discovered-${process.pid}`;
const answerFile = flag("--answer-file");
const depth = Object.fromEntries(Object.entries(process.env).filter(([k]) => /DEPTH$/.test(k)));
log({ argv, cwd: process.cwd(), prompt, thread, depth, scenario, pid: process.pid });

// fail-then-success: the first call under a log file fails (exit 3, no end), the next succeeds.
const attempts = process.env.COUNCIL_FAKE_LOG ? fs.readFileSync(process.env.COUNCIL_FAKE_LOG, "utf8").split("\n").filter((l) => l.includes('"argv"')).length : 1;
const answer = process.env.COUNCIL_FAKE_ANSWER ?? `fake answer to: ${prompt.trim().slice(0, 60)}`;
const review = argv.includes("--schema");
const structured = review ? JSON.parse(process.env.COUNCIL_FAKE_STRUCTURED ?? JSON.stringify({ verdict: "approve", summary: "Clean.", findings: [], next_steps: [] })) : undefined;
const edits = (process.env.COUNCIL_FAKE_EDITS ?? "").split(",").filter(Boolean);
const out = scenario === "fragmented-frames" ? fragmented : emit;

const leave = (code) => { process.exitCode = code; process.stdin.destroy(); };
if (scenario === "exit-nonzero") { out({ type: "start", thread }); process.stderr.write("fake child: fatal\n"); leave(3); }
else if (scenario === "fail-then-success" && attempts % 2 === 1) { out({ type: "start", thread }); process.stderr.write("fake child: transient failure\n"); leave(3); }
else await turn();
async function turn() {
out({ type: "start", thread });
if (scenario === "slow") await sleep(Number(process.env.COUNCIL_FAKE_SLOW_MS ?? 1500));
if (scenario === "huge-line") { process.stdout.write(`{"type":"text","data":"${"x".repeat(Number(process.env.COUNCIL_FAKE_HUGE_BYTES ?? 2 * 1024 * 1024))}"}\n`); }
for (const file of edits) out({ type: "tool", name: "edit", path: file, ok: true });
if (process.env.COUNCIL_FAKE_FAILED_COMMAND) out({ type: "tool", name: "shell", command: process.env.COUNCIL_FAKE_FAILED_COMMAND, ok: false, exit: 1 });
if (process.env.COUNCIL_FAKE_DENY) out({ type: "tool", name: "edit", path: process.env.COUNCIL_FAKE_DENY, ok: false, denied: true });
if (answerFile) fs.writeFileSync(answerFile, answer);
else if (!review) { const half = Math.ceil(answer.length / 2); out({ type: "text", data: answer.slice(0, half) }); out({ type: "text", data: answer.slice(half) }); }
if (scenario === "no-completion") { leave(0); return; }
if (process.env.COUNCIL_FAKE_HANG) await new Promise(() => setInterval(() => {}, 1000));
out({ type: "end", thread, cost: 0.001, ...(structured ? { structured } : {}) });
if (scenario === "hold-pipes") {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${Number(process.env.COUNCIL_FAKE_HOLD_MS ?? 2000)})`], { stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true });
  child.unref();
  if (process.env.COUNCIL_FAKE_HOLD_PID) fs.writeFileSync(process.env.COUNCIL_FAKE_HOLD_PID, String(child.pid));
}
leave(0);
}
