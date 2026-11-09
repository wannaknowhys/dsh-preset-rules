import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRules } from '../src/rules.js';
import { applyRules, deepEqual, selects } from '../src/model.js';

const preset = (presetId, order, plugins) => ({
  presetId,
  row: {
    id: `preset-${presetId}`,
    name: '@deepseek-ai/dsh-agent-preset',
    config: { id: presetId, order, plugins },
  },
});

const fixtures = () => [
  preset('standard', 1, [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
  ]),
  preset('minimal', 3, [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: { __jsExpr: 'process.platform === "win32"' } },
  ]),
];

const run = (text, presets = fixtures()) => applyRules(presets, parseRules(text));

test('hide removes a row from every selected preset', () => {
  const { results, diagnostics } = run('presets = all; entry = id: time-context; action = hide()');
  assert.deepEqual(diagnostics, []);
  const standard = results.find((result) => result.presetId === 'standard');
  assert.equal(standard.rows.length, 2);
  assert.deepEqual(standard.hidden, ['time-context']);
  assert.equal(standard.changed, true);
  const minimal = results.find((result) => result.presetId === 'minimal');
  assert.equal(minimal.changed, false);
  assert.deepEqual(minimal.hidden, []);
});

test('not(minimal) skips the excluded preset', () => {
  const { results } = run('presets = not(minimal); entry = id: persona; action = hide()');
  assert.equal(results.find((result) => result.presetId === 'standard').rows.length, 2);
  assert.equal(results.find((result) => result.presetId === 'minimal').rows.length, 2);
});

test('set difference selects exactly the named presets', () => {
  const { results } = run('presets = {standard, minimal} - {minimal}; entry = id: persona; action = hide()');
  assert.equal(results.find((result) => result.presetId === 'standard').hidden.length, 1);
  assert.equal(results.find((result) => result.presetId === 'minimal').hidden.length, 0);
});

test('name selectors and negation match rows', () => {
  const { results } = run('presets = all; entry = name: @deepseek-ai/dsh-persona; action = hide()');
  for (const result of results) assert.deepEqual(result.hidden, ['persona']);

  const negative = run('presets = {minimal}; entry = not(id: tool-fs); action = hide()');
  assert.deepEqual(negative.results[1].hidden, ['persona']);
});

test('unknown presets warn instead of failing', () => {
  const { diagnostics, results } = run('presets = {minimal, ghost}; entry = id: persona; action = hide()');
  assert.equal(results.find((result) => result.presetId === 'minimal').hidden.length, 1);
  const warning = diagnostics.find((entry) => /unknown preset "ghost"/.test(entry.message));
  assert.ok(warning, 'expected an unknown preset warning');
  assert.equal(warning.level, 'warning');
});

test('a selector that matches nothing warns once', () => {
  const { diagnostics } = run('presets = all; entry = id: nope; action = hide()');
  assert.equal(diagnostics.filter((entry) => /matched no rows/.test(entry.message)).length, 1);
});

test('a selector missing from some presets stays quiet', () => {
  const { diagnostics } = run('presets = all; entry = id: time-context; action = hide()');
  assert.deepEqual(diagnostics, []);
});

test('rules apply in order and hiding is absorbing', () => {
  const { results } = run(
    [
      'presets = all; entry = id: time-context; action = hide()',
      'presets = all; entry = id: time-context; action = hide()',
    ].join('\n'),
  );
  const standard = results.find((result) => result.presetId === 'standard');
  assert.deepEqual(standard.hidden, ['time-context']);
  assert.equal(standard.rows.length, 2);
});

test('reserved actions are rejected at evaluation time', () => {
  assert.throws(
    () => run('presets = all; entry = id: agent-instructions; action = set(config.maxBytes, 512)'),
    (error) => /not supported in 0.1/.test(error.message) && error.line === 1,
  );
});

test('rows keep their original objects and js expressions', () => {
  const presets = fixtures();
  const before = structuredClone(presets[1].row);
  const { results } = run('presets = all; entry = id: time-context; action = hide()', presets);
  assert.deepEqual(presets[1].row, before, 'input presets must not be mutated');
  assert.deepEqual(results[1].rows[1].disabled, { __jsExpr: 'process.platform === "win32"' });
});

test('preset row metadata survives untouched', () => {
  const { results } = run('presets = all; entry = id: time-context; action = hide()');
  const row = results[0].row;
  assert.equal(row.id, 'preset-standard');
  assert.equal(row.config.id, 'standard');
  assert.equal(row.config.order, 1);
});

test('selects handles the empty selector result', () => {
  assert.equal(selects({ kind: 'any' }, { id: 'x' }), true);
  assert.equal(selects({ kind: 'field', field: 'id', values: [] }, { id: 'x' }), false);
  assert.equal(
    selects(
      {
        kind: 'bin',
        op: '-',
        left: { kind: 'field', field: 'id', values: ['x'] },
        right: { kind: 'field', field: 'id', values: ['x'] },
      },
      { id: 'x' },
    ),
    false,
  );
});

test('deepEqual compares nested structures', () => {
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
});
