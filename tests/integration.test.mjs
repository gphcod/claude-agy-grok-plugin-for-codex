// S6.0: cross-provider integration. All three adapters run against their fakes (tests/fixtures/fake-claude.mjs,
// fake-agy.mjs, fake-grok.mjs) in one state root, one Codex session and one workspace. Every provider binary is a small
// recording wrapper in front of its fake, so each invocation (probe, preflight exec descriptor or turn) is counted and
// its guard variables checked. No test reaches a real CLI: the three COUNCIL_*_BIN variables name the wrappers, and the
// HTTPS proxy variable makes the network descriptors skip their live request.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { makeWorld, jobIdOf, footerOf, until, alive, ROOT, BINARY } from "./helpers.mjs";
import { DEPTH_VARIABLES, PROVIDERS } from "../plugins/council/scripts/lib/core/host.mjs";
import { requestJobId } from "../plugins/council/scripts/lib/core/jobs.mjs";

const FAKES = { claude: "fake-claude.mjs", gemini: "fake-agy.mjs", grok: "fake-grok.mjs" };
const SESSION = "codex-integration-thread";
/** Cold preflight probes per provider (A1, decisions S1): Claude four, agy and grok two each. */
const COLD_PROBES = { claude: 4, gemini: 2, grok: 2 };
/** The scenario each fake plays for a resumed read-only turn and for an edit turn. */
const RESUME = { claude: "resume", gemini: "resume", grok: "resume" };
const TASK = { claude: "task", gemini: "task", grok: "resume" };
const WIN = process.platform === "win32";
const TURN_PROVIDERS = PROVIDERS;
const RESUME_DENY_MARKERS = ["search_replace", "write", "run_terminal_cmd", "search_tool", "use_tool"];

/** One state root, one session, one workspace; the three providers behind recording wrappers. */
function world() {
  const w = makeWorld();
  delete w.env.COUNCIL_TEST_NULL_ADAPTER;
  const bin = path.join(w.dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(w.dir, "invocations.log");
  for (const provider of PROVIDERS) {
    const wrapper = path.join(bin, `${BINARY[provider][0]}.mjs`);
    fs.writeFileSync(wrapper, [
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ provider: ${JSON.stringify(provider)}, pid: process.pid, argv: process.argv.slice(2),`,
      `  guard: Object.fromEntries(${JSON.stringify(DEPTH_VARIABLES)}.map((n) => [n, process.env[n] ?? null])) }) + "\\n");`,
      `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "tests", "fixtures", FAKES[provider])).href)});`, ""].join("\n"));
    w.env[BINARY[provider][1]] = wrapper;
  }
  fs.mkdirSync(path.join(w.dir, ".grok"));
  fs.writeFileSync(path.join(w.dir, ".grok", "auth.json"), "{}", { mode: 0o600 });
  Object.assign(w.env, { HTTPS_PROXY: "http://127.0.0.1:9", CODEX_THREAD_ID: SESSION });
  w.run = (args, scenario = "ok", extra = {}) => w.call(args, { ...extra, env: { COUNCIL_FAKE_SCENARIO: scenario, ...(extra.env ?? {}) } });
  /** Every provider-binary invocation so far, optionally for one provider. */
  w.invoked = (provider) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((e) => !provider || e.provider === provider);
  /** Turns only (a turn reads its prompt from stdin or --prompt-file; everything else is a probe). */
  w.turns = (provider) => w.invoked(provider).filter((e) => e.argv.includes("--input-format") || e.argv.includes("--prompt-file"));
  w.jobs = () => (fs.existsSync(path.join(w.home, "jobs")) ? fs.readdirSync(path.join(w.home, "jobs")).filter((n) => /^[a-z0-9]{16}$/.test(n)) : []);
  return w;
}
const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
/** Native access is consistent across advice, task and resumed advice. */
function fullAccessLaunch(provider, argv) {
  if (provider === "claude") return flag(argv, "--permission-mode") === "bypassPermissions" && flag(argv, "--tools") === "default";
  if (provider === "gemini") return argv.includes("--dangerously-skip-permissions") && !argv.includes("--sandbox");
  return argv.includes("--always-approve") && !argv.includes("--deny") && !argv.includes("--disallowed-tools");
}
/** The native thread a resumed turn names. */
const resumed = (provider, argv) => flag(argv, { claude: "--resume", gemini: "--conversation", grok: "-r" }[provider]);
const large = (w) => { for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "snapshot\n".repeat(18000)); };

test("three providers in one session and workspace, in sequence: bare wait lists all three, each reply stays with its provider, a conflicting --to starts nothing", () => {
  const w = world();
  const jobs = {};
  for (const provider of TURN_PROVIDERS) {
    const r = w.run(["ask", "--to", provider, "--effort", "low", "--", `hello ${provider}`]);
    assert.equal(r.status, 0, `${provider}: ${r.stdout}${r.stderr}`);
    assert.match(footerOf(r.stdout), new RegExp(`^council ${provider} ok · job [a-z0-9]{16} · \\S+/low · \\d+s · round 1/9$`));
    jobs[provider] = jobIdOf(r.stderr);
  }
  const listed = w.call(["wait"]).stdout.trim().split("\n");
  assert.equal(listed.length, TURN_PROVIDERS.length, listed.join("\n"));
  for (const provider of TURN_PROVIDERS) assert.ok(listed.some((l) => l.startsWith(`${jobs[provider]} · ${provider} · done · `)), `${provider} listed`);
  assert.match(w.call(["wait"], { env: { CODEX_THREAD_ID: "another-thread" } }).stdout, /^no council jobs in this workspace and Codex thread/);

  const before = w.invoked().length;
  const conflict = w.run(["reply", jobs.claude, "--to", "grok", "--", "more"]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /belongs to claude; --to grok conflicts with it/);
  assert.equal(w.invoked().length, before, "a provider conflict starts no process");

  for (const provider of TURN_PROVIDERS) {
    const r = w.run(["reply", jobs[provider], "--", "F1 AGREE"], RESUME[provider]);
    assert.equal(r.status, 0, `${provider}: ${r.stdout}${r.stderr}`);
    assert.match(footerOf(r.stdout), new RegExp(`^council ${provider} ok · .* · round 2/9$`));
    const turn = w.turns(provider).at(-1);
    assert.equal(resumed(provider, turn.argv), w.job(jobs[provider]).threadId, `${provider} resumed its own thread`);
  }
  assert.deepEqual(PROVIDERS.map((p) => w.turns(p).length), PROVIDERS.map((p) => (TURN_PROVIDERS.includes(p) ? 2 : 0)), "each provider ran exactly its own two turns");
});

test("read-only after a task, on every provider: ask, task --thread, reply relaunch read-only, edit, read-only", () => {
  const w = world();
  for (const provider of TURN_PROVIDERS) {
    const ask = w.run(["ask", "--to", provider, "--", "plan it"]);
    assert.equal(ask.status, 0, `${provider}: ${ask.stdout}${ask.stderr}`);
    const id = jobIdOf(ask.stderr);
    const task = w.run(["task", "--to", provider, "--thread", id, "--request-id", `t-${provider}`, "--", "do it"], TASK[provider]);
    assert.equal(task.status, 0, `${provider}: ${task.stdout}${task.stderr}`);
    assert.match(footerOf(task.stdout), / · round 2\/9 · edited \d+$/);
    const reply = w.run(["reply", id, "--", "and now?"], RESUME[provider]);
    assert.equal(reply.status, 0, `${provider}: ${reply.stdout}${reply.stderr}`);
    const turns = w.turns(provider);
    assert.equal(turns.length, 3);
    assert.deepEqual(turns.map((t) => fullAccessLaunch(provider, t.argv)), [true, true, true], `${provider}: the reply after the task is read-only again`);
    assert.deepEqual([ask, task, reply].map((r) => w.job(jobIdOf(r.stderr)).readOnly), [true, false, true]);
    const thread = w.job(id).threadId;
    assert.deepEqual(turns.slice(1).map((t) => resumed(provider, t.argv)), [thread, thread], `${provider}: one native thread`);
  }
});

test("provider- and verb-scoped flags are refused with exit 2 before any job, probe or launch, and the request id stays free", () => {
  const w = world();
  const grokAsk = w.run(["ask", "--to", "grok", "--", "q"]);
  assert.equal(grokAsk.status, 0, grokAsk.stderr);
  const grokJob = jobIdOf(grokAsk.stderr);
  const invoked = w.invoked().length, jobs = w.jobs().length;
  const cases = [
    [["ask", "--to", "grok", "--max-turns", "3", "--request-id", "scoped", "--", "q"], /--max-turns applies only to claude/],
    [["ask", "--to", "gemini", "--max-budget-usd", "1", "--", "q"], /--max-budget-usd applies only to claude/],
    [["task", "--to", "claude", "--allow-command", "npm test", "--", "q"], /--allow-command applies only to gemini/],
    [["task", "--to", "grok", "--allow-command", "npm test", "--", "q"], /--allow-command applies only to gemini/],
    [["ask", "--to", "gemini", "--allow-command", "npm test", "--", "q"], /--allow-command is not accepted by ask/],
    [["ask", "--to", "gemini", "--web", "--", "q"], /--web is not offered for gemini/],
    [["reply", grokJob, "--max-turns", "2", "--", "q"], /--max-turns applies only to claude/],
    [["ask", "--to", "claude", "--live", "--", "q"], /--live is not accepted by ask/],
    [["ask", "--to", "claude", "--confirm-ended", "--", "q"], /--confirm-ended is not accepted by ask/],
  ];
  for (const [args, pattern] of cases) {
    const r = w.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, pattern, args.join(" "));
  }
  assert.equal(w.invoked().length, invoked, "no probe and no launch for a refused flag");
  assert.equal(w.jobs().length, jobs, "no job record for a refused flag");
  const free = w.run(["ask", "--to", "grok", "--request-id", "scoped", "--", "q"]);
  assert.equal(free.status, 0, `the refused call left its request id free: ${free.stdout}${free.stderr}`);
});

// Grok's `denied` fixture is the FORBIDDEN-tool advertisement, a fail-closed exit 1 (tests/grok.test.mjs); its denial is
// the headless permission refusal, the `cancelled` stop (decisions S4.8).
test("a denial is needs attention (exit 10) on every provider, including a denied turn the CLI itself fails (core cabec41)", () => {
  const w = world();
  const cases = [["claude", ["ask"], "denied"], ["claude", ["ask"], "denied-error"], ["gemini", ["ask"], "denied"],
    ["gemini", ["task", "--allow-command", "node check.mjs", "--request-id", "dp"], "denied-prompt"], ["grok", ["ask"], "permission-cancelled"]].filter(([provider]) => TURN_PROVIDERS.includes(provider));
  for (const [provider, [verb, ...extra], scenario] of cases) {
    const r = w.run([verb, "--to", provider, ...extra, "--", "write the secret file"], scenario);
    assert.equal(r.status, 10, `${provider} ${scenario}: ${r.stdout}${r.stderr}`);
    assert.match(footerOf(r.stdout), new RegExp(`^council ${provider} needs attention · `), `${provider} ${scenario}`);
  }
});

test("an unconfirmed Grok session is not resumable by job, thread, --last or task --thread, and --last never falls back to the older Claude thread", () => {
  const w = world();
  const claude = w.run(["ask", "--to", "claude", "--", "first"]);
  assert.equal(claude.status, 0, claude.stderr);
  const grok = w.run(["ask", "--to", "grok", "--", "second"], "no-session");
  assert.equal(grok.status, 0, `the answer and exit code stand: ${grok.stdout}${grok.stderr}`);
  assert.match(footerOf(grok.stdout), /^council grok ok · .* · session not confirmed: start a new ask$/);
  const job = jobIdOf(grok.stderr);
  const before = w.invoked().length;
  for (const args of [["reply", job, "--", "more"], ["reply", "--last", "--", "more"], ["task", "--to", "grok", "--thread", job, "--", "edit"]]) {
    const r = w.run(args, "resume");
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /session not confirmed: start a new ask/);
  }
  assert.equal(w.invoked().length, before, "a refused resume starts nothing");
  const older = w.run(["reply", jobIdOf(claude.stderr), "--", "more"], "resume");
  assert.equal(older.status, 0, "the Claude thread, named explicitly, still continues");
});

test("an incomplete review keeps the output it received, on every provider (exit 10, no coverage)", () => {
  const w = world();
  for (const provider of TURN_PROVIDERS) {
    fs.writeFileSync(path.join(w.workspace, `change-${provider}.txt`), "x\n");
    const r = w.run(["review", "--to", provider, "--json"], "review-malformed");
    assert.equal(r.status, 10, `${provider}: ${r.stdout}${r.stderr}`);
    const result = JSON.parse(r.stdout);
    assert.equal(result.verdict, "incomplete", provider);
    assert.match(result.answer, /^Verdict: incomplete\.\nIncomplete: /, provider);
    assert.match(result.answer, /Received output \(not accepted\):\n\S/, `${provider} keeps what it received`);
    assert.equal(result.coverage.reviewed, 0, `${provider}: a malformed answer earns no coverage`);
  }
});

test("models --refresh and setup cover the three providers; every probe, preflight exec descriptor and turn carries the five guard variables", () => {
  const w = world();
  const models = w.call(["models", "--refresh"]);
  assert.equal(models.status, 0, models.stderr);
  assert.match(models.stdout, /^claude \(static catalog\)$/m, "Claude has no listing");
  assert.match(models.stdout, /^gemini \(refreshed [^)]+\)$/m);
  assert.match(models.stdout, /^grok \(refreshed [^)]+\)$/m);
  assert.deepEqual(PROVIDERS.map((p) => w.invoked(p).length), [0, 2, 2], "refresh probes agy and grok (version, models) and never Claude");
  const setup = w.call(["setup"]);
  assert.equal(setup.status, 0, setup.stderr);
  for (const provider of PROVIDERS) {
    assert.match(setup.stdout, new RegExp(`^${provider}: \\S+${BINARY[provider][0]}\\.mjs \\(node-script\\) · .* · logged in · tiers consult=\\S+ exec=\\S+ deep=\\S+ · preflight ok$`, "m"), provider);
  }
  assert.match(setup.stdout, /warning: Gemini read-only turns can search the web; --web is not offered for Gemini/);
  for (const provider of TURN_PROVIDERS) assert.equal(w.run(["ask", "--to", provider, "--", "q"]).status, 0, provider);
  const all = w.invoked();
  assert.ok(all.length >= TURN_PROVIDERS.length + 2 + 2 + 4 + 2 + 2, `probes, descriptors and turns were all recorded (${all.length})`);
  for (const entry of all) assert.ok(DEPTH_VARIABLES.every((n) => entry.guard[n] === "1"), `${entry.provider} ${entry.argv.slice(0, 3).join(" ")}: ${JSON.stringify(entry.guard)}`);
});

for (const provider of TURN_PROVIDERS) {
  test(`subprocess counters, ${provider}: a cold call probes then submits once, a warm call submits once, a replay starts nothing, owner-death cancellation starts nothing`, async () => {
    const w = world();
    const count = () => ({ all: w.invoked(provider).length, turns: w.turns(provider).length });
    assert.equal(w.run(["ask", "--to", provider, "--", "cold"]).status, 0);
    assert.deepEqual(count(), { all: COLD_PROBES[provider] + 1, turns: 1 }, "cold: the cached probes, then one submission");
    assert.equal(w.run(["ask", "--to", provider, "--", "warm"]).status, 0);
    assert.deepEqual(count(), { all: COLD_PROBES[provider] + 2, turns: 2 }, "warm: one submission, no probe");
    const first = w.run(["ask", "--to", provider, "--request-id", "counted", "--", "replayed"]);
    const again = w.run(["ask", "--to", provider, "--request-id", "counted", "--", "replayed"]);
    assert.deepEqual([first.status, again.status], [0, 0]);
    assert.equal(jobIdOf(again.stdout), jobIdOf(first.stdout), "the replay prints the first job");
    assert.deepEqual(count(), { all: COLD_PROBES[provider] + 3, turns: 3 }, "replay: zero provider processes");
    assert.equal(w.invoked().length, count().all, "no other provider was touched");

    const running = w.start(["ask", "--to", provider, "--request-id", "orphan", "--", "slow"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" } });
    const id = requestJobId(provider, SESSION, w.workspace, "orphan");
    await until(() => w.turns(provider).length === 4 && fs.existsSync(path.join(w.home, "jobs", id, "meta.json")) && w.job(id).pid && (WIN || w.job(id).leader));
    const child = w.job(id).pid;
    running.child.kill("SIGKILL");
    await running.exited;
    // Windows ends a non-detached child with its hard-killed parent (libuv's job object); only POSIX leaves an orphan.
    if (!WIN) assert.ok(alive(child), "the child outlives its companion");
    const before = count();
    const cancel = w.call(["cancel", id, "--timeout", "15"]);
    assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
    await until(() => !alive(child), 5000);
    assert.deepEqual(count(), before, "owner-death cancellation starts zero provider processes");
    assert.ok(fs.existsSync(path.join(w.home, "jobs", id, "stopped")));
  });
}

for (const provider of TURN_PROVIDERS) {
  test(`review batch continuation across a companion restart, ${provider}: a --next-input turn whose companion dies is redelivered after cancel, then the review completes`, async () => {
    const w = world();
    large(w);
    const first = w.run(["review", "--to", provider, "--request-id", "big"], "large-review");
    assert.equal(first.status, 10, first.stdout + first.stderr);
    const review = jobIdOf(first.stderr);
    const [, , total] = /batch (\d+)\/(\d+)/.exec(footerOf(first.stdout));
    assert.match(footerOf(first.stdout), new RegExp(`batch 1/${total} · next: reply ${review} --next-input$`));
    // The workspace moves on; continuation reads the saved, hash-checked snapshot, never the working tree.
    fs.writeFileSync(path.join(w.workspace, "part0.txt"), "changed after the snapshot\n");
    const turns = () => w.fakeCalls().filter((c) => typeof c.prompt === "string" && !c.probe && !c.mismatch);
    const units = (call) => /Batch units: (.*)/.exec(call.prompt)?.[1];

    const dying = w.start(["reply", review, "--next-input", "--request-id", "second"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" } });
    const id = requestJobId(provider, SESSION, w.workspace, "second");
    await until(() => turns().length === 2 && fs.existsSync(path.join(w.home, "jobs", id, "meta.json")) && w.job(id).pid && (WIN || w.job(id).leader));
    const killedUnits = units(turns()[1]);
    assert.ok(killedUnits && killedUnits !== units(turns()[0]), "the dying turn carried the second batch");
    const child = w.job(id).pid;
    dying.child.kill("SIGKILL");
    await dying.exited;
    const blocked = w.run(["reply", review, "--next-input"], "large-review");
    assert.equal(blocked.status, 1, "the lost turn blocks its thread until cancel confirms");
    assert.match(footerOf(blocked.stdout), new RegExp(`busy as job ${id}`));
    assert.equal(w.call(["cancel", id, "--timeout", "15"]).status, 0);
    await until(() => !alive(child), 5000);

    const redelivered = w.run(["reply", review, "--next-input"], "large-review");
    assert.notEqual(redelivered.status, 2, redelivered.stdout + redelivered.stderr);
    assert.equal(units(turns().at(-1)), killedUnits, "the batch the dead companion never finished is delivered again");
    assert.equal(turns().at(-1).prompt, turns()[1].prompt, "byte-identical batch text from the snapshot");
    assert.match(footerOf(redelivered.stdout), new RegExp(`batch 2/${total}`));
    let last = redelivered, ref = jobIdOf(redelivered.stderr);
    for (let i = 0; i < 10 && / --next-input$/.test(footerOf(last.stdout)); i++) {
      last = w.run(["reply", ref, "--next-input"], "large-review");
      ref = jobIdOf(last.stderr);
    }
    assert.doesNotMatch(footerOf(last.stdout), /--next-input/, "every saved batch and the synthesis were delivered");
    assert.equal(last.status, 10, "the first batch's blocker stays open through a clean synthesis");
    const done = JSON.parse(w.call(["wait", ref, "--json"]).stdout);
    assert.equal(done.coverage.status, "complete");
    assert.equal(done.coverage.pending, 0);
  });
}

test("replay and cancel isolation: a request id is bound to its first provider; cancelling one provider's job leaves another's running job and a third's record alone", async () => {
  const w = world();
  // The third provider's finished job.
  const gemini = w.run(["ask", "--to", "gemini", "--", "finished first"]);
  if (gemini) assert.equal(gemini.status, 0, gemini.stderr);
  const geminiJob = gemini ? jobIdOf(gemini.stderr) : null;
  const geminiMeta = gemini ? fs.readFileSync(path.join(w.home, "jobs", geminiJob, "meta.json"), "utf8") : null;

  const claude = w.run(["ask", "--to", "claude", "--request-id", "shared", "--", "q"]);
  assert.equal(claude.status, 0, claude.stderr);
  const before = w.invoked().length;
  const other = w.run(["ask", "--to", "grok", "--request-id", "shared", "--", "q"]);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /request id shared was already used with different input/);
  const replay = w.run(["ask", "--to", "claude", "--request-id", "shared", "--", "q"]);
  assert.equal(replay.status, 0);
  assert.equal(jobIdOf(replay.stdout), jobIdOf(claude.stderr));
  assert.equal(w.invoked().length, before, "neither the conflict nor the replay started a process");
  const elsewhere = w.run(["ask", "--to", "grok", "--request-id", "shared", "--", "q"], "ok", { env: { CODEX_THREAD_ID: "another-thread" } });
  assert.equal(elsewhere.status, 0, "the same id in another Codex thread is another request");

  const slowClaude = w.start(["ask", "--to", "claude", "--request-id", "c-slow", "--", "slow"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" } });
  const slowGrok = w.start(["ask", "--to", "grok", "--request-id", "g-slow", "--", "slow"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "4000" } });
  const claudeJob = requestJobId("claude", SESSION, w.workspace, "c-slow"), grokJob = requestJobId("grok", SESSION, w.workspace, "g-slow");
  await until(() => [claudeJob, grokJob].every((id) => fs.existsSync(path.join(w.home, "jobs", id, "meta.json")) && w.job(id).pid));
  const cancel = w.call(["cancel", claudeJob]);
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  const [claudeEnd, grokEnd] = await Promise.all([slowClaude.exited, slowGrok.exited]);
  assert.equal(claudeEnd.code, 1);
  assert.match(footerOf(claudeEnd.stdout), /^council claude cancelled · /);
  assert.equal(grokEnd.code, 0, `the other provider's job ran to completion: ${grokEnd.stdout}${grokEnd.stderr}`);
  assert.match(footerOf(grokEnd.stdout), /^council grok ok · /);
  assert.match(w.call(["cancel"]).stdout, /^no running council job to cancel/);
  if (gemini) {
    assert.equal(fs.readFileSync(path.join(w.home, "jobs", geminiJob, "meta.json"), "utf8"), geminiMeta, "a finished job of a third provider is untouched");
    const resumedAfter = w.run(["reply", geminiJob, "--", "still there?"], "resume");
    assert.equal(resumedAfter.status, 0, "the third provider's thread stays resumable");
  }
});

// S1.4 (2026-11-01): Codex runs the shell calls of one turn in parallel, so a fan-out may issue its asks at once (A6).
test("concurrent fan-out: one ask per provider started together, each with its own request id, overlap in time and all finish ok; follow-ups by job", async () => {
  const w = world();
  const env = { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "2000" };
  const running = TURN_PROVIDERS.map((provider) => w.start(["ask", "--to", provider, "--request-id", `fan-${provider}`, "--", "the same brief"], { env }));
  const ends = await Promise.all(running.map((r) => r.exited));
  const jobs = TURN_PROVIDERS.map((provider, i) => {
    assert.equal(ends[i].code, 0, `${provider}: ${ends[i].stdout}${ends[i].stderr}`);
    assert.match(footerOf(ends[i].stdout), new RegExp(`^council ${provider} ok · job ${requestJobId(provider, SESSION, w.workspace, `fan-${provider}`)} · `));
    return w.job(requestJobId(provider, SESSION, w.workspace, `fan-${provider}`));
  });
  const latestStart = Math.max(...jobs.map((j) => Date.parse(j.spawnedAt))), earliestEnd = Math.min(...jobs.map((j) => Date.parse(j.endedAt)));
  assert.ok(latestStart < earliestEnd, "every provider's turn was running at the same time");
  assert.deepEqual(TURN_PROVIDERS.map((p) => w.turns(p).length), TURN_PROVIDERS.map(() => 1), "one submission per provider");
  assert.equal(w.call(["wait"]).stdout.trim().split("\n").length, TURN_PROVIDERS.length);
  for (const [i, provider] of TURN_PROVIDERS.entries()) {
    const reply = w.run(["reply", jobs[i].id, "--", "F1 AGREE"], RESUME[provider]);
    assert.equal(reply.status, 0, `${provider}: ${reply.stdout}${reply.stderr}`);
    assert.equal(resumed(provider, w.turns(provider).at(-1).argv), jobs[i].threadId);
  }
});
