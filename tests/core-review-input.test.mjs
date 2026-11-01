// S2.5: the shared review-input protocol, ported unchanged from grok_plugin_for_codex 1.1.0 tests/review-input.test.mjs
// (identical to claude_plugin_for_codex 0.5.0 tests/review-input.test.mjs); only the import path differs.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { digest, makeSnapshot, trackedInput, validateSnapshot, utf8, startReview, selectBatch, reviewCoverage,
  continueReview }
  from '../plugins/council/scripts/lib/core/review-input.mjs';

const raw = (patches, statuses = patches.map(() => 'M')) => Buffer.concat([
  Buffer.from(patches.map((_, i) => `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${statuses[i]}\0`
    + `file${i}\0${statuses[i].startsWith('R') ? `new${i}\0` : ''}`).join('') + '\0'),
  ...patches.map(patch => Buffer.from(patch)),
]);
const header = 'diff --git a/file0 b/file0\n--- a/file0\n+++ b/file0\n@@ -1 +1 @@\n-old\n+';

test('only literal LF separates file patches, including embedded CR and Unicode line separators', () => {
  for (const separator of ['\r', '\u2028', '\u2029']) {
    const patch = header + 'x' + separator + 'diff --git a/fake b/fake\n';
    const tracked = trackedInput(raw([patch]));
    assert.equal(tracked.entries.length, 1);
    assert.equal(tracked.diff.toString(), patch);
    const two = trackedInput(raw([patch, 'diff --git a/file1 b/file1\nold mode 100644\nnew mode 100755\n']));
    assert.equal(two.entries.length, 2);
    assert.ok(Buffer.concat(two.entries.map(entry => entry.body)).equals(two.diff));
  }
});

test('raw capture retains undecodable bytes and rename identities', () => {
  const output = raw([header.replaceAll('b/file0', 'b/new0') + 'value\n'], ['R100']);
  output[output.length - 2] = 0xff;
  const tracked = trackedInput(output);
  assert.equal(tracked.entries[0].kind, 'non_utf8');
  assert.equal(tracked.entries[0].oldPath, 'file0');
  assert.equal(tracked.entries[0].path, 'new0');
  assert.ok(tracked.diff.includes(0xff));
});

test('bounded UTF-8 fragments reconstruct the entire saved input without changing a byte', () => {
  const body = Buffer.from(header + '漢字🧪\n'.repeat(5000));
  const snapshot = makeSnapshot([{ path: 'file0', oldPath: 'file0', status: 'M', kind: 'text', body }], 16384);
  assert.ok(snapshot.index.units.length > 2);
  const pieces = snapshot.index.units.map(unit => snapshot.data.subarray(unit.offset, unit.offset + unit.length));
  assert.ok(pieces.every(piece => piece.length <= 16384 && utf8(piece)));
  assert.ok(Buffer.concat(pieces).equals(body));
  assert.equal(snapshot.index.dataHash, digest(body));
  assert.doesNotThrow(() => validateSnapshot(snapshot.index, snapshot.data));
});

test('snapshot content, metadata and expected identity are checked independently', () => {
  const snapshot = makeSnapshot([{ path: 'file0', kind: 'text', body: Buffer.from('saved\n') }], 16384);
  const changed = Buffer.from(snapshot.data); changed[0] ^= 1;
  assert.throws(() => validateSnapshot(snapshot.index, changed), /hash mismatch/);
  assert.throws(() => validateSnapshot({ ...snapshot.index, cap: 99999 }, snapshot.data), /hash mismatch/);
  assert.throws(() => validateSnapshot(snapshot.index, snapshot.data, 'wrong snapshot'), /hash mismatch/);
});

test('an over-budget single line is retained but cannot silently complete content coverage', () => {
  const body = Buffer.from('x'.repeat(20000));
  const snapshot = makeSnapshot([{ path: 'large', kind: 'text', body }], 16384);
  assert.equal(snapshot.index.units[0].kind, 'oversize_line');
  assert.ok(snapshot.data.equals(body));
});

test('long escaped paths still leave room for every bounded fragment', () => {
  const body = Buffer.from('line\n'.repeat(50000));
  const snapshot = makeSnapshot([{ path: '\u0001'.repeat(3000), oldPath: '\u0001'.repeat(3000),
    source: 'untracked', status: 'A', kind: 'text', body }], 180000);
  assert.ok(snapshot.index.units.every(unit => unit.kind === 'text' && unit.length < 180000));
  const first = startReview(snapshot, 'test', '/unused');
  assert.ok(first.state.active.length > 0);
  assert.ok(Buffer.byteLength(first.text) <= 180000);
});

test('type changes own both deletion and creation sections, with exact path validation', () => {
  const patch = 'diff --git a/file0 b/file0\ndeleted file mode 100644\n'
    + 'diff --git a/file0 b/file0\nnew file mode 120000\n';
  const bytes = Buffer.from(raw([patch], ['T']).toString().replace(':100644 100644', ':100644 120000'));
  const tracked = trackedInput(bytes);
  assert.equal(tracked.entries.length, 1);
  assert.equal(tracked.entries[0].status, 'T');
  assert.ok(tracked.entries[0].body.equals(tracked.diff));
  assert.throws(() => trackedInput(raw(['diff --git a/wrong b/wrong\n'])), /header disagrees/);
});

test('batch packing cannot skip an unsent middle unit to pack a later small tail', () => {
  const entries = [90000, 100000, 1000].map((bytes, i) => ({ path: `file${i}`, oldPath: `file${i}`,
    status: 'M', kind: 'text', body: Buffer.from('x\n'.repeat(bytes / 2)) }));
  const snapshot = makeSnapshot(entries, 180000);
  const first = selectBatch(snapshot, { completed: [] });
  assert.deepEqual(first.active, ['u1']);
  assert.equal(snapshot.index.units.length, 3);
});

test('the locale-independent Git binary-patch marker is never classified as text', () => {
  const patch = 'diff --git a/file0 b/file0\nGIT binary patch\nliteral 1\na\n';
  assert.equal(trackedInput(raw([patch])).entries[0].kind, 'binary');
});

test('valid publication survives unsupported hard links and a busy temporary-file cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-publish-'));
  const snapshot = makeSnapshot([{ path: 'file', kind: 'text', body: Buffer.from('source\n') }], 16384);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(snapshot.index));
  fs.writeFileSync(path.join(dir, 'review.data'), snapshot.data);
  const state = startReview(snapshot, 'fixture', dir).state;
  const link = fs.linkSync, unlink = fs.unlinkSync;
  let attempts = 0;
  try {
    fs.linkSync = () => { attempts++; throw Object.assign(new Error('no hard links'), { code: 'EPERM' }); };
    fs.unlinkSync = () => { throw Object.assign(new Error('scanner busy'), { code: 'EBUSY' }); };
    const result = reviewCoverage(state, true, false, path.join(dir, 'fixture', 'result.json'), { findings: [] });
    assert.equal(result.status, 'complete');
    assert.equal(result.completed.length, 1);
    assert.ok(fs.existsSync(result.results[0].path));
    assert.equal(attempts, 12, 'Each publication retries EPERM before using atomic rename.');
  } finally {
    fs.linkSync = link; fs.unlinkSync = unlink;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupted fallback publication cannot poison the content-addressed synthesis index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-atomic-'));
  const snapshot = makeSnapshot([{ path: 'file', kind: 'text', body: Buffer.from('source\n'.repeat(5000)) }],
    16384);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(snapshot.index));
  fs.writeFileSync(path.join(dir, 'review.data'), snapshot.data);
  let state = startReview(snapshot, 'fixture', dir).state;
  state = { ...state, completed: snapshot.index.units.map(unit => unit.id), results: [] };
  const link = fs.linkSync, rename = fs.renameSync;
  try {
    fs.linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    for (const published of [false, true]) {
      fs.rmSync(path.join(dir, 'responses'), { recursive: true, force: true });
      fs.renameSync = (from, to) => {
        if (published) rename(from, to);
        throw Object.assign(new Error('interrupted publication'), { code: 'EIO' });
      };
      assert.throws(() => continueReview(state, true), /interrupted publication/);
      fs.renameSync = rename;
      const result = continueReview(state, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(result.state.synthesisIndex)), []);
      assert.deepEqual(result.state.active, ['synthesis']);
    }
  } finally { fs.linkSync = link; fs.renameSync = rename; fs.rmSync(dir, { recursive: true, force: true }); }
});
