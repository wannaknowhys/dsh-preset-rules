import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRules, RuleError, didYouMean, tokenize } from '../src/rules.js';

const one = (text) => parseRules(text)[0];

test('parses a complete rule into IR', () => {
  const rule = one('presets = all; entry = id: time-context; action = hide()');
  assert.equal(rule.line, 1);
  assert.deepEqual(rule.presets, { kind: 'all' });
  assert.deepEqual(rule.entry, { kind: 'field', field: 'id', values: ['time-context'] });
  assert.deepEqual(rule.action, { kind: 'hide' });
});

test('clauses are order independent', () => {
  const rule = one('action = hide(); presets = all; entry = id: time-context');
  assert.deepEqual(rule.action, { kind: 'hide' });
  assert.deepEqual(rule.entry.values, ['time-context']);
});

test('comments and blank lines are ignored', () => {
  const rules = parseRules('# header\n\n   \npresets = all; entry = *; action = hide() # trailing\n');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].line, 4);
});

test('set algebra builds nested IR', () => {
  const rule = one('presets = {cordis, ptc} - {ptc}; entry = *; action = hide()');
  assert.deepEqual(rule.presets, {
    kind: 'bin',
    op: '-',
    left: { kind: 'names', names: ['cordis', 'ptc'] },
    right: { kind: 'names', names: ['ptc'] },
  });
});

test('not() wraps a nested set', () => {
  const rule = one('presets = not(minimal); entry = *; action = hide()');
  assert.deepEqual(rule.presets, { kind: 'not', inner: { kind: 'names', names: ['minimal'] } });
});

test('selector supports negation, union and difference', () => {
  assert.deepEqual(one('presets = all; entry = not(id: tool-bash); action = hide()').entry, {
    kind: 'not',
    inner: { kind: 'field', field: 'id', values: ['tool-bash'] },
  });
  assert.deepEqual(one('presets = all; entry = id: a + id: b; action = hide()').entry.op, '+');
  assert.deepEqual(one('presets = all; entry = name: @deepseek-ai/dsh-tool-web; action = hide()').entry, {
    kind: 'field',
    field: 'name',
    values: ['@deepseek-ai/dsh-tool-web'],
  });
});

test('reserved actions parse for forward compatibility', () => {
  const rule = one('presets = all; entry = id: agent-instructions; action = set(config.maxBytes, 512)');
  assert.deepEqual(rule.action, { kind: 'set', path: ['config', 'maxBytes'], value: 512 });
  assert.equal(one('presets = all; entry = *; action = disable()').action.kind, 'disable');
});

test('literals cover numbers, strings and booleans', () => {
  assert.equal(one('presets = all; entry = *; action = set(config.a, -1)').action.value, -1);
  assert.equal(one('presets = all; entry = *; action = set(config.a, 2.5)').action.value, 2.5);
  assert.equal(one('presets = all; entry = *; action = set(config.a, "x;y")').action.value, 'x;y');
  assert.equal(one('presets = all; entry = *; action = set(config.a, true)').action.value, true);
});

test('unknown action suggests hide', () => {
  assert.throws(
    () => one('presets = all; entry = *; action = delete()'),
    (error) => error instanceof RuleError && /unknown action "delete"/.test(error.message) && /did you mean "hide"/.test(error.message),
  );
});

test('binary operators need surrounding spaces', () => {
  assert.throws(
    () => one('presets = all-{minimal}; entry = *; action = hide()'),
    (error) => error instanceof RuleError && /binary '-' must have spaces/.test(error.message),
  );
});

test('missing, duplicate and unknown clauses are rejected', () => {
  assert.throws(
    () => one('presets = all; entry = *'),
    (error) => /missing clause "action"/.test(error.message),
  );
  assert.throws(
    () => one('presets = all; presets = all; entry = *; action = hide()'),
    (error) => /duplicate clause "presets"/.test(error.message),
  );
  assert.throws(
    () => one('when = all; entry = *; action = hide()'),
    (error) => /unknown clause "when"/.test(error.message),
  );
});

test('errors carry the source position', () => {
  try {
    parseRules('presets = all; entry = *; action = nope()');
    assert.fail('expected a RuleError');
  } catch (error) {
    assert.equal(error.line, 1);
    assert.equal(error.col, 36);
  }
  try {
    parseRules('\n\npresets = all; entry = *; action = hide()\npresets = all; entry = *\n');
    assert.fail('expected a RuleError');
  } catch (error) {
    assert.equal(error.line, 4);
  }
});

test('empty input yields no rules', () => {
  assert.deepEqual(parseRules(''), []);
  assert.deepEqual(parseRules('# only a comment\n'), []);
});

test('tokenizer reports unterminated strings', () => {
  assert.throws(() => tokenize('entry = "abc', 1), /unterminated string/);
});

test('didYouMean stays quiet when nothing is close', () => {
  assert.equal(didYouMean('zzzzzz', ['hide']), '');
  assert.equal(didYouMean('hdie', ['hide']), ' (did you mean "hide"?)');
});
