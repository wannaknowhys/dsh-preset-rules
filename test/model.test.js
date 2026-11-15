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

test('set reaches a row nested inside a group', () => {
  const presets = [
    preset('standard', 1, [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        ],
      },
    ]),
  ];

  const { results, diagnostics } = run(
    'presets = all; entry = id: compaction-basic; action = set(config.auto, false)',
    presets,
  );
  assert.deepEqual(diagnostics, []);
  const group = results[0].rows.find((row) => row.id === 'compaction');
  assert.deepEqual(group.config[0].config, { auto: false });
  assert.equal(results[0].changed, true);
  assert.equal(results[0].originalCount, 4, 'group children count as rows');
  assert.equal(results[0].count, 4);
  assert.deepEqual(results[0].applied, [
    { id: 'compaction-basic', kind: 'set', path: 'config.auto', value: false },
  ]);
});

test('hide removes a nested group row from its owning list only', () => {
  const presets = [
    preset('standard', 1, [
      {
        id: 'shell',
        name: 'cordis:group',
        group: true,
        config: [
          { id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash' },
          { id: 'terminal-pwsh', name: '@deepseek-ai/dsh-terminal-bash' },
        ],
      },
    ]),
  ];
  const { results } = run('presets = all; entry = id: terminal-pwsh; action = hide()', presets);
  assert.deepEqual(results[0].rows[0].config.map((row) => row.id), ['terminal-bash']);
  assert.equal(results[0].originalCount, 3);
  assert.equal(results[0].count, 2);
  assert.deepEqual(results[0].hidden, ['terminal-pwsh']);
});

test('an unknown preset warns instead of failing', () => {
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

test('set writes a new config field on every selected row', () => {
  const presets = fixtures();
  const { results, diagnostics } = run(
    'presets = all; entry = name: @deepseek-ai/dsh-persona; action = set(config.prefix, "You are brief.")',
    presets,
  );
  assert.deepEqual(diagnostics, []);
  for (const result of results) {
    const row = result.rows.find((candidate) => candidate.id === 'persona');
    assert.deepEqual(row.config, { prefix: 'You are brief.' });
    assert.equal(result.changed, true);
    assert.deepEqual(result.applied, [
      { id: 'persona', kind: 'set', path: 'config.prefix', value: 'You are brief.' },
    ]);
  }
  assert.equal(presets[0].row.config.plugins[0].config, undefined, 'input presets must not be mutated');
});

test('set overwrites an existing field and supports dotted paths', () => {
  const presets = [
    preset('standard', 1, [
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    ]),
  ];
  const { results } = run(
    [
      'presets = all; entry = id: agent-instructions; action = set(config.maxBytes, 512)',
      'presets = all; entry = id: agent-instructions; action = set(config.retry.count, 2)',
    ].join('\n'),
    presets,
  );
  assert.deepEqual(results[0].rows[0].config, { maxBytes: 512, retry: { count: 2 } });
});

test('disable(), enable(), and set(disabled, …) rewrite the row flag', () => {
  const presets = [
    preset('standard', 1, [
      {
        id: 'tool-bash',
        name: '@deepseek-ai/dsh-tool-bash',
        disabled: { __jsExpr: 'process.platform === "win32"' },
      },
    ]),
  ];
  const disabled = run('presets = all; entry = id: tool-bash; action = disable()', presets);
  assert.equal(disabled.results[0].rows[0].disabled, true);
  assert.deepEqual(disabled.results[0].applied, [{ id: 'tool-bash', kind: 'disable' }]);

  const enabled = run('presets = all; entry = id: tool-bash; action = enable()', presets);
  assert.equal(enabled.results[0].rows[0].disabled, false);

  const literal = run('presets = all; entry = id: tool-bash; action = set(disabled, true)', presets);
  assert.equal(literal.results[0].rows[0].disabled, true);
});

test('setting a value the row already has counts as unchanged', () => {
  const presets = [
    preset('standard', 1, [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'x' } }]),
  ];
  const { results } = run('presets = all; entry = id: persona; action = set(config.prefix, "x")', presets);
  assert.equal(results[0].changed, false);
});

test('set(name, …) swaps the plugin package of a matched row', () => {
  const presets = [
    preset('standard', 1, [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false } },
    ]),
  ];
  const { results } = run(
    'presets = all; entry = id: compaction-basic; action = set(name, "dsh-compaction-full-context")',
    presets,
  );
  assert.equal(results[0].rows[0].name, 'dsh-compaction-full-context');
  assert.deepEqual(results[0].rows[0].config, { auto: false }, 'the rest of the row survives');
  assert.deepEqual(results[0].applied, [
    { id: 'compaction-basic', kind: 'set', path: 'name', value: 'dsh-compaction-full-context' },
  ]);
  assert.equal(presets[0].row.config.plugins[0].name, '@deepseek-ai/dsh-compaction-basic');
});

test('set(name, …) rejects a non-string or empty value', () => {
  assert.throws(
    () => run('presets = all; entry = id: persona; action = set(name, "")'),
    (error) => /non-empty package name/.test(error.message) && error.line === 1,
  );
  assert.throws(
    () => run('presets = all; entry = id: persona; action = set(name, 7)'),
    (error) => /non-empty package name/.test(error.message),
  );
});

test('an ungovernable set path fails with the rule position', () => {
  assert.throws(
    () => run('presets = all; entry = id: persona; action = set(config.id, "other")'),
    (error) => /belongs to the generator/.test(error.message) && error.line === 1,
  );
  assert.throws(
    () => run('presets = all; entry = id: persona; action = set(disabled, 1)'),
    (error) => /needs true or false/.test(error.message) && error.line === 1,
  );
});

test('a set that matches nothing warns once', () => {
  const { diagnostics } = run('presets = all; entry = id: nope; action = set(config.auto, false)');
  assert.equal(diagnostics.filter((entry) => /matched no rows/.test(entry.message)).length, 1);
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
