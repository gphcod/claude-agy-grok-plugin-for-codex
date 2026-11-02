import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { main } from "../plugins/council/scripts/council.mjs";
import { USAGE, VERBS } from "../plugins/council/scripts/lib/core/args.mjs";
import { makeWorld } from "./helpers.mjs";

test("help for every verb returns before reading stdin, resolving paths or applying recursion guards", async () => {
  for (const verb of VERBS) for (const flag of ["--help", "-h"]) {
    let stdout = "", stderr = "";
    const stdin = new PassThrough();
    const code = await main([verb, flag, "--cwd", "Z:/missing-council-help-workspace"], { COUNCIL_DEPTH: "1" }, {
      stdin, stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } },
    });
    assert.equal(code, 0, `${verb} ${flag}: ${stderr}`);
    assert.equal(stdout, `${USAGE}\n`);
    assert.equal(stderr, "");
    assert.equal(stdin.listenerCount("data"), 0);
    stdin.destroy();
  }
});

test("review --help in a dirty repository submits no review and creates no job", () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.workspace, "change.txt"), "reviewable change\n");
  const result = world.call(["review", "--to", "null", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${USAGE}\n`);
  assert.equal(world.fakeCalls().length, 0, "help must never submit a paid provider turn");
  assert.equal(fs.existsSync(world.home), false, "help leaves no state directory");
});

test("--help=false and help flags after -- remain ordinary provider input", () => {
  const world = makeWorld();
  const result = world.call(["ask", "--to", "null", "--help=false", "--", "--help", "-h"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(world.fakeCalls().at(-1).prompt, "--help -h");
});
