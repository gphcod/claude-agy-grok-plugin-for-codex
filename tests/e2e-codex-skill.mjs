// S6.2: the call forms SKILL.md tells Codex to use, run through a real shell against the three fakes. Adapted from
// claude_plugin_for_codex 0.5.0 tests/e2e-codex-skill.mjs: the documented blocks are extracted from the skill, their
// placeholders filled in (<plugin>, <verb>, <provider>, [flags], <text>), and each run through `sh`; on Windows through
// powershell.exe and pwsh when present (S7.2 runs them; elsewhere those cases are skipped). Each case parses
// `council <provider> ok · job <16 chars>` from the last line and checks the prompt bytes the fake received.
// On Windows every Gemini turn verb is refused with exit 2 and the A8 message (gemini.mjs checkRequest), so the Gemini
// cases there assert that refusal through the call form instead. Run with `npm run test:e2e`. No real CLI is reached: the COUNCIL_*_BIN variables name the fakes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeWorld, ROOT, PLUGIN_ROOT, BINARY } from "./helpers.mjs";
import { PROVIDERS } from "../plugins/council/scripts/lib/core/host.mjs";
import { WINDOWS_UNSUPPORTED } from "../plugins/council/scripts/lib/providers/gemini.mjs";

const skill = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", "council", "SKILL.md"), "utf8");
const blocks = [...skill.matchAll(/```(?:bash|sh|powershell|pwsh)?\r?\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => /scripts[\\/]council\.mjs/.test(b));
const posixForm = blocks.find((b) => b.includes("<<'COUNCIL_EOF'"));
const powershellForm = blocks.find((b) => /^@'\r?\n[\s\S]*\r?\n'@ \|/.test(b));
const FAKES = { claude: "fake-claude.mjs", gemini: "fake-agy.mjs", grok: "fake-grok.mjs" };
const FOOTER = (provider, label = "ok") => new RegExp(`^council ${provider} ${label} · job ([a-z0-9]{16}) · `);

/** The shells that run a form here: `sh` for POSIX; powershell.exe and pwsh on Windows when present. */
const onPath = (name) => spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8" }).status === 0;
const SHELLS = process.platform !== "win32" || onPath("sh") ? [{ name: "sh", form: "posix", argv: (script) => ["sh", ["-c", script]] }] : [];
if (process.platform === "win32") {
  for (const exe of ["powershell.exe", "pwsh"]) if (onPath(exe)) SHELLS.push({ name: exe, form: "powershell", argv: (script) => [exe, ["-NoProfile", "-NonInteractive", "-Command", script]] });
}
/** A8: on Windows every Gemini turn verb is refused with exit 2 before any job; the call form must still carry the code. */
const refusedHere = (provider) => provider === "gemini" && process.platform === "win32";
function assertRefused(run, label) {
  assert.equal(run.code, 2, `${label}: ${run.stdout}${run.stderr}`);
  assert.ok(run.stderr.includes(WINDOWS_UNSUPPORTED), `${label}: the A8 refusal: ${run.stderr}`);
}
const POWERSHELL_SKIP = process.platform === "win32" ? (SHELLS.some((s) => s.form === "powershell") ? false : "neither powershell.exe nor pwsh is on PATH")
  : "the PowerShell call form runs on Windows (PLAN.md S7.2)";

/** A world wired to the three fakes, one Codex session, the network check kept offline, Grok logged in. */
function world() {
  const w = makeWorld();
  delete w.env.COUNCIL_TEST_NULL_ADAPTER;
  delete w.env.COUNCIL_STDIN_DEADLINE_MS; // the skill's no-stdin rule is checked against the real idle limit
  for (const provider of PROVIDERS) w.env[BINARY[provider][1]] = path.join(ROOT, "tests", "fixtures", FAKES[provider]);
  fs.mkdirSync(path.join(w.dir, ".grok"));
  fs.writeFileSync(path.join(w.dir, ".grok", "auth.json"), "{}", { mode: 0o600 });
  Object.assign(w.env, { HTTPS_PROXY: "http://127.0.0.1:9", CODEX_THREAD_ID: "e2e-codex-thread" });
  w.received = () => (fs.existsSync(w.env.COUNCIL_FAKE_LOG) ? fs.readFileSync(w.env.COUNCIL_FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((e) => typeof e.prompt === "string" && !e.probe && !e.mismatch).map((e) => e.prompt);
  return w;
}

/** The documented form with its placeholders filled in. */
function callForm(form, { verb, provider, flags = "", text, delimiter = "COUNCIL_EOF" }) {
  const source = form === "posix" ? posixForm.replaceAll("COUNCIL_EOF", delimiter) : powershellForm;
  return source.replace("<plugin>", PLUGIN_ROOT).replace("<verb>", verb).replace("<provider>", provider).replace(" [flags]", flags ? ` ${flags}` : "").replace("<text>", text);
}
/** The first line of a form without its text part: a call that carries no text (bare review, --prompt-file). */
function bareForm(form, { verb, provider, flags = "", stdinNull = false }) {
  if (form === "posix") {
    const line = posixForm.split("\n")[0].replace(/ -- <<'COUNCIL_EOF'$/, "");
    return `${line.replace("<plugin>", PLUGIN_ROOT).replace("<verb>", verb).replace("<provider>", provider).replace(" [flags]", flags ? ` ${flags}` : "")}${stdinNull ? " </dev/null" : ""}`;
  }
  const line = /'@ \| (node .*) --; exit \$LASTEXITCODE/.exec(powershellForm)[1];
  return `${stdinNull ? "$null | " : ""}${line.replace("<plugin>", PLUGIN_ROOT).replace("<verb>", verb).replace("<provider>", provider).replace(" [flags]", flags ? ` ${flags}` : "")}; exit $LASTEXITCODE`;
}
/** Runs a script through a shell; stdin stays open unless `closeStdin`, as a host shell may leave it. */
function shell(w, sh, script, { scenario = "ok", closeStdin = true, timeout = 60000 } = {}) {
  const [command, args] = sh.argv(script);
  const started = Date.now();
  const child = spawn(command, args, { cwd: w.workspace, env: { ...w.env, COUNCIL_FAKE_SCENARIO: scenario }, windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  if (closeStdin) child.stdin.end();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!closeStdin) child.stdin.destroy();
      resolve({ code, stdout: stdout.replace(/\r\n/g, "\n"), stderr, ms: Date.now() - started });
    });
  });
}
const lastLine = (r) => r.stdout.trimEnd().split("\n").at(-1);
const received = (w) => w.received().at(-1);
/** The fake received the text exactly, after the turn's instructions. */
function assertPrompt(w, text, label) {
  const prompt = received(w);
  assert.ok(prompt !== undefined, `${label}: the fake received no prompt`);
  assert.ok(Buffer.from(prompt).subarray(-Buffer.byteLength(`\n\n${text}`)).equals(Buffer.from(`\n\n${text}`)), `${label}: received ${JSON.stringify(prompt.slice(-200))}`);
}

test("the skill documents both call forms with every placeholder the e2e substitutes", () => {
  assert.ok(posixForm, "POSIX heredoc form");
  assert.ok(powershellForm, "PowerShell here-string form");
  for (const form of [posixForm, powershellForm]) for (const p of ["<plugin>", "<verb>", "<provider>", "[flags]", "<text>"]) assert.ok(form.includes(p), `${p} in ${form}`);
  assert.match(powershellForm, /--; exit \$LASTEXITCODE\s*$/);
  assert.match(skill, /absolute paths/);
});

for (const sh of SHELLS.filter((s) => s.form === "posix")) {
  for (const provider of PROVIDERS) {
    test(`${sh.name}, ${provider}: leading flags, a literal -- and multiline text reach the fake byte for byte; exit codes survive`, async () => {
      const w = world();
      const simple = "Reply with pong";
      const one = await shell(w, sh, callForm("posix", { verb: "ask", provider, flags: "--effort low --request-id e2e-flags", text: simple }));
      if (refusedHere(provider)) { assertRefused(one, "ask"); assert.equal(w.received().length, 0); return; }
      assert.equal(one.code, 0, one.stdout + one.stderr);
      assert.match(lastLine(one), FOOTER(provider));
      assert.match(lastLine(one), /\/low · /, "the leading --effort flag applied");
      assertPrompt(w, simple, "simple");
      const dashes = "a -- b\n-- --to grok --json\n--";
      const two = await shell(w, sh, callForm("posix", { verb: "ask", provider, text: dashes }));
      assert.equal(two.code, 0, two.stdout + two.stderr);
      assert.match(lastLine(two), FOOTER(provider));
      assertPrompt(w, dashes, "literal --");
      const multiline = "first line\n\n  indented line\n$HOME `not expanded` $(echo nope)\nnaïve ✓ 漢字\nlast line";
      const three = await shell(w, sh, callForm("posix", { verb: "ask", provider, text: multiline }));
      assert.equal(three.code, 0, three.stdout + three.stderr);
      assertPrompt(w, multiline, "multiline");
      const job = FOOTER(provider).exec(lastLine(three))[1];
      const reply = await shell(w, sh, callForm("posix", { verb: `reply ${job}`, provider, text: "F1 AGREE" }), { scenario: "resume" });
      assert.equal(reply.code, 0, reply.stdout + reply.stderr);
      assert.match(lastLine(reply), / · round 2\/9$/);
      assertPrompt(w, "F1 AGREE", "reply");
      const bad = await shell(w, sh, bareForm("posix", { verb: "wait", provider: provider, flags: "zzzzzzzzzzzzzzzz" }).replace(` --to ${provider}`, ""));
      assert.equal(bad.code, 2, "exit 2 survives the shell");
      const replay = await shell(w, sh, callForm("posix", { verb: "ask", provider, flags: "--effort low --request-id e2e-flags", text: simple }));
      assert.equal(FOOTER(provider).exec(lastLine(replay))[1], FOOTER(provider).exec(lastLine(one))[1], "a request-id replay prints the first job");
      assert.equal(w.received().length, 4, "the replay started no second submission");
    });

    test(`${sh.name}, ${provider}: a delimiter collision cuts the text short; another delimiter carries it whole`, async () => {
      const w = world();
      const text = "first line\nCOUNCIL_EOF\nnot-a-command-e2e";
      const collided = await shell(w, sh, callForm("posix", { verb: "ask", provider, text }));
      assert.notEqual(collided.code, 0, "the rest of the text ran as a command");
      assert.notEqual(received(w)?.endsWith(text), true, "the default delimiter cuts the text short");
      const run = await shell(w, sh, callForm("posix", { verb: "ask", provider, text, delimiter: "COUNCIL_EOF_2" }));
      if (refusedHere(provider)) return assertRefused(run, "ask");
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.match(lastLine(run), FOOTER(provider));
      assertPrompt(w, text, "other delimiter");
    });

    test(`${sh.name}, ${provider}: text with '@ and non-ASCII goes through --prompt-file`, async () => {
      const w = world();
      const text = "first line\n'@ looks like a terminator\nnon-ASCII 漢字 ✓";
      const file = path.join(w.dir, "prompt.txt");
      fs.writeFileSync(file, text, "utf8");
      const run = await shell(w, sh, bareForm("posix", { verb: "ask", provider, flags: `--prompt-file "${file}"`, stdinNull: true }));
      if (refusedHere(provider)) return assertRefused(run, "--prompt-file");
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.match(lastLine(run), FOOTER(provider));
      assertPrompt(w, text, "--prompt-file");
    });

    test(`${sh.name}, ${provider}: a bare review --to ${provider} without -- reads no stdin and exits promptly with the review's code`, async () => {
      const w = world();
      fs.writeFileSync(path.join(w.workspace, "sum.mjs"), "export const sum = (a) => a.length;\n");
      const run = await shell(w, sh, bareForm("posix", { verb: "review", provider }), { scenario: "review-findings", closeStdin: false, timeout: 30000 });
      assert.ok(run.ms < 8000, `returned in ${run.ms} ms with stdin left open (the idle limit is 10 s)`);
      if (refusedHere(provider)) return assertRefused(run, "review");
      assert.equal(run.code, 10, run.stdout + run.stderr);
      assert.match(lastLine(run), FOOTER(provider, "needs attention"));
      assert.ok(run.ms < 8000, `returned in ${run.ms} ms with stdin left open (the idle limit is 10 s)`);
    });
  }
}

const powershells = SHELLS.filter((s) => s.form === "powershell");
for (const sh of powershells.length ? powershells : [{ name: "powershell" }]) {
  for (const provider of PROVIDERS) {
    test(`${sh.name}, ${provider}: here-string with leading flags, a literal -- and multiline text; exit $LASTEXITCODE keeps the code`, { skip: POWERSHELL_SKIP }, async () => {
      const w = world();
      const text = "first line\n-- --to grok --json\n\nlast line";
      const run = await shell(w, sh, callForm("powershell", { verb: "ask", provider, flags: "--effort low --request-id e2e-ps", text }));
      if (refusedHere(provider)) return assertRefused(run, "here-string ask");
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.match(lastLine(run), FOOTER(provider));
      assertPrompt(w, text, "here-string");
      const bad = await shell(w, sh, bareForm("powershell", { verb: "wait", provider, flags: "zzzzzzzzzzzzzzzz" }).replace(` --to ${provider}`, ""));
      assert.equal(bad.code, 2, "exit 2 survives `; exit $LASTEXITCODE`");
    });

    test(`${sh.name}, ${provider}: '@ and non-ASCII go through --prompt-file with $null piped`, { skip: POWERSHELL_SKIP }, async () => {
      const w = world();
      const text = "first line\n'@ looks like a terminator\nnon-ASCII 漢字";
      const file = path.join(w.dir, "prompt.txt");
      fs.writeFileSync(file, text, "utf8");
      const run = await shell(w, sh, bareForm("powershell", { verb: "ask", provider, flags: `--prompt-file "${file}"`, stdinNull: true }));
      if (refusedHere(provider)) return assertRefused(run, "--prompt-file");
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assertPrompt(w, text, "--prompt-file");
    });

    test(`${sh.name}, ${provider}: a bare review without -- exits promptly`, { skip: POWERSHELL_SKIP }, async () => {
      const w = world();
      fs.writeFileSync(path.join(w.workspace, "sum.mjs"), "export const sum = (a) => a.length;\n");
      const run = await shell(w, sh, bareForm("powershell", { verb: "review", provider }), { scenario: "review-findings", closeStdin: false, timeout: 30000 });
      assert.ok(run.ms < 8000, `returned in ${run.ms} ms`);
      if (refusedHere(provider)) return assertRefused(run, "review");
      assert.equal(run.code, 10, run.stdout + run.stderr);
    });
  }
}
