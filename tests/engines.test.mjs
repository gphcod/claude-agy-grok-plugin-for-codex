import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, satisfiesEngines } from "../scripts/validate-plugin.mjs";

const range = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).engines.node;

test("the engines range is the one Part A fixes", () => {
  assert.equal(range, ">=22.19.0");
});

test("admitted versions: 22.19.0 and anything later", () => {
  for (const v of ["22.19.0", "22.20.1", "24.0.0"]) assert.equal(satisfiesEngines(v, range), true, v);
});

test("rejected versions: everything before 22.19.0", () => {
  for (const v of ["18.20.8", "20.3.0", "21.7.3", "22.0.0", "22.18.9"]) assert.equal(satisfiesEngines(v, range), false, v);
});

test("the parser accepts the caret and comparator forms and refuses anything else", () => {
  assert.equal(satisfiesEngines("22.20.0", "^22.19.0 || >=24.0.0"), true);
  assert.equal(satisfiesEngines("23.0.0", "^22.19.0 || >=24.0.0"), false);
  assert.equal(satisfiesEngines("22.19.0", ">22.18.9 <=22.19.0"), true);
  assert.throws(() => satisfiesEngines("22.19.0", "~22.19.0"), /Unsupported engines form/);
  assert.throws(() => satisfiesEngines("22", range), /not a version/);
});
