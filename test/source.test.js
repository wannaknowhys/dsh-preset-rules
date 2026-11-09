import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashSources, loadSourcePresets, locateWebApp } from '../src/source.js';
import { PRESET_PLUGIN as PRESET, makeInstall, presetPatch, unrelatedPatch } from './helpers.js';

test('locates the package through the explicit option', (t) => {
  const dir = makeInstall(t, { 'presets/alpha.patch.yml': presetPatch('alpha', 1, []) });
  const location = locateWebApp({ webAppDir: dir });
  assert.equal(location.origin, 'config');
  assert.equal(location.packageDir, dir);
  assert.equal(location.packageFile, path.join(dir, 'package.json'));
});

test('explains every location it tried when nothing is found', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preset-rules-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));

  assert.throws(
    () => locateWebApp({ webAppDir: empty, execPath: path.join(empty, 'node.exe'), requireFrom: path.join(empty, 'x.js') }),
    (error) => /cannot locate @deepseek-ai\/dsh-web-app/.test(error.message) && /webAppDir/.test(error.message),
  );
});

test('reads presets across patch files and ignores unrelated rows', (t) => {
  const dir = makeInstall(t, {
    'cordis.patch.yml': unrelatedPatch,
    'presets/alpha.patch.yml': presetPatch('alpha', 1, [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }]),
    'presets/beta.patch.yml': presetPatch('beta', 2, [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }]),
  });

  const loaded = loadSourcePresets({ webAppDir: dir });
  assert.deepEqual(loaded.presets.map((preset) => preset.presetId), ['alpha', 'beta']);
  assert.deepEqual(loaded.presets.map((preset) => preset.row.config.order), [1, 2]);
  assert.equal(loaded.version, '9.9.9-fixture');
  assert.equal(loaded.origin, 'config');
  assert.deepEqual(loaded.warnings, []);
  assert.match(loaded.sourceHash, /^sha256:[0-9a-f]{64}$/);
});

test('parses the !!js tag into an expression node', (t) => {
  const dir = makeInstall(t, {
    'presets/alpha.patch.yml': presetPatch('alpha', 1, [
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: "!!js process.platform === 'win32'" },
    ]),
  });

  const loaded = loadSourcePresets({ webAppDir: dir });
  assert.deepEqual(loaded.presets[0].row.config.plugins[0].disabled, { __jsExpr: "process.platform === 'win32'" });
});

test('the source hash is stable and content sensitive', (t) => {
  const dir = makeInstall(t, { 'presets/alpha.patch.yml': presetPatch('alpha', 1, []) });
  const first = loadSourcePresets({ webAppDir: dir }).sourceHash;
  const second = loadSourcePresets({ webAppDir: dir }).sourceHash;
  assert.equal(first, second);

  fs.writeFileSync(path.join(dir, 'presets/alpha.patch.yml'), presetPatch('alpha', 1, [{ id: 'x', name: 'y' }]));
  assert.notEqual(loadSourcePresets({ webAppDir: dir }).sourceHash, first);
});

test('hashSources ignores file order', () => {
  const left = hashSources([
    { relative: 'b.yml', text: 'b' },
    { relative: 'a.yml', text: 'a' },
  ]);
  const right = hashSources([
    { relative: 'a.yml', text: 'a' },
    { relative: 'b.yml', text: 'b' },
  ]);
  assert.equal(left, right);
});

test('a malformed patch file warns and the rest still loads', (t) => {
  const dir = makeInstall(t, {
    'presets/broken.patch.yml': '- insert: [\n',
    'presets/alpha.patch.yml': presetPatch('alpha', 1, []),
  });

  const loaded = loadSourcePresets({ webAppDir: dir });
  assert.deepEqual(loaded.presets.map((preset) => preset.presetId), ['alpha']);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /broken\.patch\.yml/);
});

test('an override patch is reported and not composed', (t) => {
  const dir = makeInstall(t, {
    'presets/alpha.patch.yml': presetPatch('alpha', 1, []),
    'presets/override.patch.yml': [`- id: preset-alpha`, `  name: '${PRESET}'`, '  config: { id: alpha }', ''].join('\n'),
  });

  const loaded = loadSourcePresets({ webAppDir: dir });
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /override/);
});

test('rejects a preset row without plugins', (t) => {
  const dir = makeInstall(t, {
    'presets/alpha.patch.yml': ['- insert:', `    - id: preset-alpha`, `      name: '${PRESET}'`, '      config: { id: alpha }', ''].join('\n'),
  });

  assert.throws(() => loadSourcePresets({ webAppDir: dir }), /missing config\.id or config\.plugins/);
});

test('rejects duplicate preset ids', (t) => {
  const dir = makeInstall(t, {
    'presets/a.patch.yml': presetPatch('alpha', 1, []),
    'presets/b.patch.yml': presetPatch('alpha', 2, []),
  });

  assert.throws(() => loadSourcePresets({ webAppDir: dir }), /declared more than once/);
});

test('rejects an installation without preset declarations', (t) => {
  const dir = makeInstall(t, { 'cordis.patch.yml': unrelatedPatch });
  assert.throws(() => loadSourcePresets({ webAppDir: dir }), /no agent-preset declarations found/);
});
