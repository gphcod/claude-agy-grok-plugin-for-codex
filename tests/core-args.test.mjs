// S2.2: argument parsing (ported from grok_plugin_for_codex tests/args.test.mjs) and the verb-specific positional rules.
import test from "node:test";
import assert from "node:assert/strict";
import { UsageError, SPEC, VERBS, parseArgv, parseOptions, positiveInt, seconds } from "../plugins/council/scripts/lib/core/args.mjs";

test("options are matched by arity: values take the next token or an inline =value, booleans take none", () => {
  assert.deepEqual(parseOptions(["--tier", "deep", "--json", "--model=grok-x", "--web=false", "k3f9", "--effort", "low", "rest"]), {
    options: { tier: "deep", json: true, model: "grok-x", web: false, effort: "low" }, positionals: ["k3f9", "rest"], hasDashDash: false,
  });
  assert.deepEqual(parseOptions(["--request-id=a=b", "--prompt-file", "C:\\p q.txt"]).options, { "request-id": "a=b", "prompt-file": "C:\\p q.txt" });
  assert.deepEqual(parseOptions(["--to", "claude", "--commit", "abc", "--uncommitted", "--adversarial", "--refresh", "--live", "--confirm-ended", "--next-input"]).options,
    { to: "claude", commit: "abc", uncommitted: true, adversarial: true, refresh: true, live: true, "confirm-ended": true, "next-input": true });
  assert.deepEqual(parseOptions(["--cwd", "/w", "--max-turns", "3", "--max-budget-usd", "0.5", "--set", "p.json"]).options, { cwd: "/w", "max-turns": "3", "max-budget-usd": "0.5", set: "p.json" });
});

test("--allow-command is repeatable and collects every value in order", () => {
  assert.deepEqual(parseOptions(["--allow-command", "node check.mjs", "--allow-command=npm test"]).options, { "allow-command": ["node check.mjs", "npm test"] });
  assert.deepEqual(parseOptions(["--allow-command", "one"]).options["allow-command"], ["one"]);
  assert.deepEqual(parseOptions([]).options, {});
  assert.ok(SPEC.repeat.includes("allow-command") && !SPEC.value.includes("allow-command"));
});

test("everything after -- is text, even tokens that look like options", () => {
  assert.deepEqual(parseOptions(["--tier", "exec", "--", "--tier", "deep", "--", "x"]), { options: { tier: "exec" }, positionals: ["--tier", "deep", "--", "x"], hasDashDash: true });
  assert.deepEqual(parseOptions(["--"]), { options: {}, positionals: [], hasDashDash: true });
  assert.deepEqual(parseOptions(["a", "b"]), { options: {}, positionals: ["a", "b"], hasDashDash: false });
});

test("an unknown option or a value option without its value is a usage error", () => {
  assert.throws(() => parseOptions(["--bogus"]), (e) => e instanceof UsageError && /Unknown option --bogus\. Put -- before the text/.test(e.message));
  assert.throws(() => parseOptions(["--tier"]), (e) => e instanceof UsageError && /Missing value for --tier/.test(e.message));
  assert.throws(() => parseOptions(["--allow-command"]), /Missing value for --allow-command/);
  assert.throws(() => parseOptions(["--session", "s1"]), /Unknown option --session/, "the Claude host's --session is not a Codex option");
  assert.throws(() => parseOptions(["--profile", "x"]), /Unknown option --profile/, "CLAUDEX profiles are not council flags");
  assert.throws(() => parseOptions(["--with-context"]), /Unknown option --with-context/);
});

test("parseArgv returns the verb and refuses unknown verbs with the usage line", () => {
  assert.deepEqual(VERBS, ["ask", "reply", "review", "task", "wait", "cancel", "models", "setup"]);
  assert.deepEqual(parseArgv(["ask", "--to", "grok", "--", "hello", "world"]), { verb: "ask", options: { to: "grok" }, positionals: ["hello", "world"], hasDashDash: true });
  assert.throws(() => parseArgv(["rescue"]), (e) => e instanceof UsageError && /unknown verb "rescue"\. usage: council\.mjs <ask\|reply\|review\|task\|wait\|cancel\|models\|setup>/.test(e.message));
  assert.throws(() => parseArgv([]), (e) => e instanceof UsageError && e.message.startsWith("usage: council.mjs"));
  assert.equal(parseArgv(["--help"]).verb, "help");
});

test("reply: a first positional names the thread unless --thread or --last does, and `reply k3f9 -- text` keeps the text", () => {
  assert.deepEqual(parseArgv(["reply", "k3f9"]).options, { thread: "k3f9" });
  const dashed = parseArgv(["reply", "k3f9", "--", "follow", "up"]);
  assert.deepEqual([dashed.options.thread, dashed.positionals, dashed.hasDashDash], ["k3f9", ["follow", "up"], true]);
  const explicit = parseArgv(["reply", "--thread", "k3f9", "--", "follow", "up"]);
  assert.deepEqual([explicit.options.thread, explicit.positionals], ["k3f9", ["follow", "up"]], "the positional and --thread are aliases");
  assert.deepEqual(parseArgv(["reply", "--last", "k3f9"]).options, { last: true }, "--last leaves the positional as text");
  assert.deepEqual(parseArgv(["reply", "--last", "k3f9"]).positionals, ["k3f9"]);
  assert.deepEqual(parseArgv(["reply", "--", "k3f9", "text"]).options, {}, "after -- nothing names a thread");
  assert.deepEqual(parseArgv(["reply", "k3f9", "--next-input"]).options, { thread: "k3f9", "next-input": true });
  assert.deepEqual(parseArgv(["reply", "k3f9", "some", "text"]), { verb: "reply", options: { thread: "k3f9" }, positionals: ["some", "text"], hasDashDash: false });
});

test("wait and cancel take one job or thread id as --job; two is a usage error", () => {
  assert.deepEqual(parseArgv(["wait", "k3f9", "--timeout", "5"]).options, { job: "k3f9", timeout: "5" });
  assert.deepEqual(parseArgv(["cancel", "k3f9", "--confirm-ended"]).options, { job: "k3f9", "confirm-ended": true });
  assert.deepEqual(parseArgv(["wait"]).options, {});
  assert.deepEqual(parseArgv(["cancel"]).positionals, []);
  assert.throws(() => parseArgv(["wait", "a", "b"]), /wait accepts one job or thread id/);
  assert.throws(() => parseArgv(["cancel", "a", "b"]), /cancel accepts one job/);
  assert.deepEqual(parseArgv(["models", "--to", "grok", "--refresh"]).options, { to: "grok", refresh: true });
  assert.deepEqual(parseArgv(["setup", "--live", "--set", "p.json"]).options, { live: true, set: "p.json" });
});

test("numeric helpers: positive integers and seconds within the timer range", () => {
  assert.equal(positiveInt("3", "--rounds"), 3);
  for (const bad of ["0", "-1", "1.5", "x", ""]) assert.throws(() => positiveInt(bad, "--rounds"), /--rounds needs a positive integer/);
  assert.equal(seconds(undefined, 90, "timeout"), 90);
  assert.equal(seconds("0.5", 90, "timeout"), 0.5);
  for (const bad of ["0", "-1", "NaN", "x", String(3 * 10 ** 6)]) assert.throws(() => seconds(bad, 90, "deadline"), /--deadline needs a finite positive number of seconds/);
});
