import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PLUGIN, REQUIRED_TERMS, SKILL_BYTES, DESCRIPTION_BYTES } from "../scripts/validate-plugin.mjs";

const skill = fs.readFileSync(path.join(PLUGIN, "skills", "council", "SKILL.md"), "utf8");
const [, front, body] = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(skill);
const description = /^description: (.*)$/m.exec(front)[1];

test("one skill is the whole model-facing surface and it fits the budget", () => {
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN, "skills")), ["council"]);
  assert.match(front, /^name: council$/m);
  assert.ok(Buffer.byteLength(description) <= DESCRIPTION_BYTES, `the description is ${Buffer.byteLength(description)} B`);
  assert.ok(Buffer.byteLength(skill) <= SKILL_BYTES, `the skill is ${Buffer.byteLength(skill)} B`);
  assert.ok(fs.existsSync(path.join(PLUGIN, "skills", "council", "agents", "openai.yaml")));
  assert.doesNotMatch(body, /\]\(|\.md\b/, "a normal call needs no linked file");
});

test("the skill carries every required term of S0.5 and both call forms", () => {
  for (const term of REQUIRED_TERMS) assert.ok(skill.includes(term), term);
  assert.match(body, /<<'COUNCIL_EOF'\r?\n<text>\r?\nCOUNCIL_EOF/);
  assert.match(body, /@'\r?\n<text>\r?\n'@ \| node "<plugin>\\scripts\\council\.mjs" .*--; exit \$LASTEXITCODE/);
  assert.doesNotMatch(skill, /run_in_background|\/council:|slash command/, "nothing from the Claude host");
});

test("S7.1: the skill says why a turn exits 10, what bare `wait` does and which tier a task uses", () => {
  assert.match(body, /10 attention \(findings or `attention:`: denial, incomplete, open questions\)/);
  assert.match(body, /`wait` lists this session's jobs/);
  assert.match(body, /`task` only when the user authorizes edits, at default tier exec/);
});
