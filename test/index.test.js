import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply, emit, homeDir, resolveOptions } from '../index.js';
import { makeInstall, makeTempDir, presetPatch } from './helpers.js';

function recorder() {
  const calls = [];
  return {
    calls,
    info: (message) => calls.push(['info', message]),
    warn: (message) => calls.push(['warn', message]),
    error: (message) => calls.push(['error', message]),
  };
}

const RULE = 'presets = all; entry = id: time-context; action = hide()';

function setup(t, rulesText = RULE) {
  const dir = makeTempDir(t);
  const install = makeInstall(t, {
    'presets/alpha.patch.yml': presetPatch('alpha', 1, [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    ]),
  });
  const rulesPath = path.join(dir, 'preset-rules.rules');
  if (rulesText !== null) fs.writeFileSync(rulesPath, rulesText);
  const targetPath = path.join(dir, 'cordis.patch.yml');
  return { dir, install, rulesPath, targetPath };
}

test('homeDir prefers DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(homeDir({ DSH_HOME: 'D:/ports/dsh' }, 'D:/users/x'), 'D:/ports/dsh');
  assert.equal(homeDir({}, 'D:/users/x'), path.join('D:/users/x', '.dsh'));
  assert.equal(homeDir({ DSH_HOME: '   ' }, 'D:/users/x'), path.join('D:/users/x', '.dsh'));
});

test('resolveOptions fills the documented defaults', () => {
  const options = resolveOptions({}, { DSH_HOME: 'D:/ports/dsh' }, 'D:/users/x');
  assert.equal(options.rulesPath, path.join('D:/ports/dsh', 'preset-rules.rules'));
  assert.equal(options.targetPath, path.join('D:/ports/dsh', 'cordis.patch.yml'));
  assert.equal(options.mode, 'apply');
  assert.equal(options.webAppDir, undefined);
});

test('resolveOptions keeps explicit values', () => {
  const options = resolveOptions(
    { rulesPath: 'r.rules', targetPath: 't.yml', mode: 'check', webAppDir: 'D:/app' },
    {},
    'D:/users/x',
  );
  assert.deepEqual(options, { rulesPath: 'r.rules', targetPath: 't.yml', mode: 'check', webAppDir: 'D:/app' });
});

test('emit stays silent when nothing changed and nothing warned', () => {
  const logger = recorder();
  emit({ action: 'unchanged', results: [{ changed: false }], diagnostics: [], bytes: 10 }, logger);
  assert.deepEqual(logger.calls, []);
});

test('emit reports a write as one line', () => {
  const logger = recorder();
  emit(
    {
      action: 'written',
      targetPath: 'D:/out.yml',
      bytes: 2048,
      results: [{ changed: true }, { changed: false }],
      diagnostics: [],
    },
    logger,
  );
  assert.deepEqual(logger.calls, [['info', 'preset-rules: wrote 1 entry (2.0 KB) -> D:/out.yml']]);
});

test('emit prints the whole report in check mode', () => {
  const logger = recorder();
  emit(
    {
      action: 'would-write',
      targetPath: 'D:/out.yml',
      bytes: 10,
      results: [{ presetId: 'alpha', changed: true, originalRows: [1, 2], rows: [1], hidden: ['time-context'] }],
      diagnostics: [],
    },
    logger,
  );
  assert.equal(logger.calls.length, 1);
  assert.equal(logger.calls[0][0], 'info');
  assert.match(logger.calls[0][1], /preset-rules: check \(no write\)/);
});

test('emit surfaces warnings even when nothing changed', () => {
  const logger = recorder();
  emit(
    {
      action: 'unchanged',
      bytes: 10,
      results: [{ changed: false }],
      diagnostics: [{ level: 'warning', message: 'unknown preset "ghost"', line: 2 }],
    },
    logger,
  );
  assert.deepEqual(logger.calls, [['warn', 'preset-rules: unknown preset "ghost" (line 2)']]);
});

test('apply writes the file and logs one line', (t) => {
  const { install, rulesPath, targetPath } = setup(t);
  const logger = recorder();

  apply({ logger }, { rulesPath, targetPath, webAppDir: install });

  assert.equal(fs.existsSync(targetPath), true);
  assert.equal(logger.calls.length, 1);
  assert.equal(logger.calls[0][0], 'info');
  assert.match(logger.calls[0][1], /wrote 1 entry/);
});

test('apply is silent on the second run', (t) => {
  const { install, rulesPath, targetPath } = setup(t);
  apply({ logger: recorder() }, { rulesPath, targetPath, webAppDir: install });

  const logger = recorder();
  apply({ logger }, { rulesPath, targetPath, webAppDir: install });
  assert.deepEqual(logger.calls, []);
});

test('apply never throws and reports a broken rule file', (t) => {
  const { install, rulesPath, targetPath } = setup(t, 'presets = all; entry = *; action = nope()');
  const logger = recorder();

  assert.doesNotThrow(() => apply({ logger }, { rulesPath, targetPath, webAppDir: install }));

  assert.equal(logger.calls.length, 1);
  assert.equal(logger.calls[0][0], 'error');
  assert.match(logger.calls[0][1], /unknown action "nope"/);
  assert.match(logger.calls[0][1], /preset-rules\.rules:1:/);
});

test('apply never throws when the installation cannot be found', (t) => {
  const logger = recorder();
  const dir = makeTempDir(t);
  assert.doesNotThrow(() =>
    apply({ logger }, { rulesPath: path.join(dir, 'missing.rules'), targetPath: path.join(dir, 'out.yml'), webAppDir: dir }),
  );
  assert.equal(logger.calls[0][0], 'error');
});

test('a fresh installation logs one line about the missing rules file', (t) => {
  const { install, rulesPath, targetPath } = setup(t, null);
  const logger = recorder();

  apply({ logger }, { rulesPath, targetPath, webAppDir: install });

  assert.equal(logger.calls.length, 1);
  assert.equal(logger.calls[0][0], 'info');
  assert.match(logger.calls[0][1], /no rules file at .*preset-rules\.rules/);
  assert.match(logger.calls[0][1], /--init/);
  assert.equal(fs.existsSync(targetPath), false);
});

test('the missing-rules notice stops once the file exists', (t) => {
  const { install, rulesPath, targetPath } = setup(t);
  const logger = recorder();

  apply({ logger }, { rulesPath, targetPath, webAppDir: install });

  assert.equal(logger.calls.length, 1);
  assert.doesNotMatch(logger.calls[0][1], /no rules file/);
});
