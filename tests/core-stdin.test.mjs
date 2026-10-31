// S2.2: stdin reading (ported from grok_plugin_for_codex companion.test.mjs and claude_plugin_for_codex stdin.test.mjs
// cases) and the one-source and no-stdin rules of A3.1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readStdin, readText, skipsStdin, STDIN_IDLE_S, REQUEST_BYTES } from "../plugins/council/scripts/lib/core/stdin.mjs";
import { UsageError, parseArgv } from "../plugins/council/scripts/lib/core/args.mjs";

const ended = (text) => { const s = new PassThrough(); s.end(text); return s; };
const usage = (re) => (e) => e instanceof UsageError && re.test(e.message);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-stdin-"));
const text = (argv, stream, env = {}) => readText(parseArgv(argv), { stream, env: { COUNCIL_STDIN_DEADLINE_MS: "200", ...env } });

test("stdin is read to its end, and an open pipe that sends nothing is read for a bounded time", async () => {
  assert.equal(await readStdin(ended(), 200), "");
  assert.equal(await readStdin(ended("text\n"), 200), "text\n");
  assert.equal(await readStdin(ended('Quotes " 漢字 🧪\n'), 200), 'Quotes " 漢字 🧪\n');
  const tty = Object.assign(new PassThrough(), { isTTY: true });
  assert.equal(await readStdin(tty, 200), "", "a terminal gives no input at once");
  assert.equal(tty.listenerCount("data"), 0, "a terminal is not read");
  const silent = new PassThrough(), started = Date.now();
  assert.equal(await readStdin(silent, 200), null);
  assert.ok(Date.now() - started >= 150 && silent.destroyed);
  const slow = new PassThrough();
  const kanji = Buffer.from("漢");
  for (const [ms, write] of [[120, () => slow.write("a")], [240, () => slow.write(kanji.subarray(0, 2))], [360, () => slow.write(kanji.subarray(2))], [480, () => slow.end("b")]]) setTimeout(write, ms);
  assert.equal(await readStdin(slow, 200), "a漢b", "each chunk restarts the wait; a split character survives");
  const partial = new PassThrough();
  setTimeout(() => partial.write("half"), 50);
  await assert.rejects(readStdin(partial, 200), usage(/stdin sent nothing for 0\.2 s before its end/));
  assert.ok(partial.destroyed);
});

test("stdin over the request byte limit and a failed stream are refused", async () => {
  assert.equal(REQUEST_BYTES, 8 * 1024 * 1024);
  const large = new PassThrough();
  large.write(Buffer.alloc(REQUEST_BYTES + 1, "a"));
  await assert.rejects(readStdin(large, 5000), usage(/exceeds the request byte limit/));
  assert.ok(large.destroyed);
  const broken = new PassThrough();
  setImmediate(() => broken.destroy(new Error("broken pipe")));
  await assert.rejects(readStdin(broken, 5000), /broken pipe/);
});

test("the no-stdin rule: bare review, --next-input without text and the control verbs never read stdin", async () => {
  for (const argv of [["review", "--to", "grok"], ["review", "--to", "grok", "--base", "main"], ["reply", "k3f9", "--next-input"], ["reply", "--last", "--next-input"],
    ["wait"], ["wait", "k3f9"], ["cancel", "k3f9", "--confirm-ended"], ["models", "--refresh"], ["setup", "--live"]]) {
    assert.equal(skipsStdin(parseArgv(argv)), true, argv.join(" "));
    const silent = new PassThrough(), started = Date.now();
    assert.equal(await text(argv, silent), "", argv.join(" "));
    assert.ok(Date.now() - started < 150, `${argv.join(" ")}: returned without waiting`);
    assert.equal(silent.listenerCount("data"), 0, "stdin was never read");
  }
  for (const argv of [["ask", "--to", "grok"], ["review", "--to", "grok", "--"], ["review", "--to", "grok", "focus"], ["review", "--to", "grok", "--prompt-file", "f"], ["reply", "k3f9"], ["task", "--to", "grok", "--"]]) {
    assert.equal(skipsStdin(parseArgv(argv)), false, argv.join(" "));
  }
});

test("a review with `--` or a focus reads its focus; --next-input with any text is a usage error", async () => {
  assert.equal(await text(["review", "--to", "grok", "--"], ended("focus on the loop\n")), "focus on the loop");
  assert.equal(await text(["review", "--to", "grok", "--", "focus", "here"], ended("")), "focus here");
  assert.equal(await text(["review", "--to", "grok", "--"], ended("")), "", "a review may have an empty focus");
  await assert.rejects(text(["reply", "k3f9", "--next-input", "--", "text"], ended("")), usage(/--next-input accepts no text/));
  await assert.rejects(text(["reply", "k3f9", "--next-input", "--"], ended("more\n")), usage(/--next-input accepts no text/));
  const file = path.join(dir, "focus.txt");
  fs.writeFileSync(file, "x");
  await assert.rejects(text(["reply", "k3f9", "--next-input", "--prompt-file", file], ended("")), usage(/--next-input accepts no text/));
});

test("text comes from exactly one source: stdin, --prompt-file (UTF-8, BOM dropped) or the positionals", async () => {
  assert.equal(await text(["ask", "--to", "grok"], ended("  Grüße, 世界 🌍\n\n    indented\ntrailing space \n")), "  Grüße, 世界 🌍\n\n    indented\ntrailing space ", "stdin keeps everything but the final newline");
  assert.equal(await text(["ask", "--to", "grok"], ended("crlf text\r\n")), "crlf text", "a PowerShell pipe's CRLF ending is dropped like a heredoc's LF");
  assert.equal(await text(["ask", "--to", "grok"], ended("--tier deep --effort high review this\n")), "--tier deep --effort high review this", "stdin is never parsed for options");
  assert.equal(await text(["ask", "--to", "grok", "--", "--text"], ended("")), "--text", "after -- an option-looking token is text");
  const file = path.join(dir, "prompt.txt");
  fs.writeFileSync(file, "\uFEFFnon-ASCII: Grüße, 世界\r\nline two");
  assert.equal(await text(["ask", "--to", "grok", "--prompt-file", file], ended("")), "non-ASCII: Grüße, 世界\r\nline two", "the BOM goes, CRLF inside the file stays");
  await assert.rejects(text(["ask", "--to", "grok", "--prompt-file", file, "--", "more"], ended("")), usage(/not more than one/));
  await assert.rejects(text(["ask", "--to", "grok", "--prompt-file", file], ended("stdin text\n")), usage(/not more than one/));
  await assert.rejects(text(["ask", "--to", "grok", "--", "argv"], ended("stdin text\n")), usage(/not more than one/));
  await assert.rejects(text(["ask", "--to", "grok", "--prompt-file", path.join(dir, "missing.txt")], ended("")), /ENOENT/, "a missing file fails before any provider starts");
  await assert.rejects(text(["ask", "--to", "grok"], ended("   \n")), usage(/ask needs text/));
  await assert.rejects(text(["task", "--to", "grok", "--"], ended("")), usage(/task needs text/));
  const big = path.join(dir, "big.txt");
  fs.writeFileSync(big, Buffer.alloc(REQUEST_BYTES + 1, "a"));
  await assert.rejects(text(["ask", "--to", "grok", "--prompt-file", big], ended("")), usage(/--prompt-file exceeds/));
});

test("a silent open pipe: arguments or a file carry the text; with no text anywhere the call is refused after the deadline", async () => {
  const open = () => new PassThrough();
  const started = Date.now();
  assert.equal(await text(["ask", "--to", "grok", "--", "from", "argv"], open()), "from argv");
  const file = path.join(dir, "p2.txt");
  fs.writeFileSync(file, "from file");
  assert.equal(await text(["ask", "--to", "grok", "--prompt-file", file], open()), "from file");
  await assert.rejects(text(["ask", "--to", "grok"], open()), usage(/stdin stayed open for 0\.2 s with no input; .*\(<\/dev\/null, or \$null \| in PowerShell\) when there is none/));
  assert.ok(Date.now() - started >= 500 && Date.now() - started < 5000, "each call waited its deadline, shortened through COUNCIL_STDIN_DEADLINE_MS");
  assert.equal(STDIN_IDLE_S, 10, "the production deadline");
});
