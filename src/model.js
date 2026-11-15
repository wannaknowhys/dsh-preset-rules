/**
 * Evaluate parsed rules against the presets read from the installation.
 *
 * The model is a cross product: for every selected preset, every row matching
 * the selector receives the action. Rules apply in file order; hiding a row
 * removes it from later matching within the same run, while `set`, `disable`
 * and `enable` rewrite the row in place so later rules still see it.
 */

import { RuleError } from './rules.js';

/** Actions this version can apply. */
const SUPPORTED = new Set(['hide', 'set', 'disable', 'enable']);

/** Config keys the generator owns, so a rule may not rewrite them. */
const RESERVED_CONFIG_KEYS = new Set(['id', 'plugins']);

/**
 * Visit every plugin row of one preset, including rows nested in group configs.
 * A `cordis:group` row keeps its child entry list in `config`, so one walk covers
 * the shipped presets, which mount compaction, delegation and shell tooling there.
 * @param {object} presetRow agent-preset declaration row
 * @param {(row: object, siblings: Array<object>) => void} visit receives each row and its owning list
 */
export function walkRows(presetRow, visit) {
  const walk = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      visit(row, rows);
      if (Array.isArray(row.config)) walk(row.config);
    }
  };
  walk(presetRow?.config?.plugins);
}

/**
 * Count every plugin row of one preset, nested group entries included.
 * @param {object} presetRow agent-preset declaration row
 * @returns {number} row count
 */
export function countRows(presetRow) {
  let total = 0;
  walkRows(presetRow, () => { total += 1; });
  return total;
}

/**
 * Write one action onto a row, creating the config object when the row has none.
 * `disabled` and `name` are whole-row fields; `config` takes a dotted field path.
 * @param {object} row plugin entry, mutated in place
 * @param {Array<string>} segments path segments from `parsePath`
 * @param {unknown} value literal value for `set`
 * @throws {Error} when the path or the value cannot be written
 */
function writeSet(row, segments, value) {
  const [root, ...rest] = segments;
  if (root === 'disabled') {
    if (typeof value !== 'boolean') throw new Error('set(disabled, …) needs true or false');
    row.disabled = value;
    return;
  }
  if (root === 'name') {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('set(name, …) needs a non-empty package name, for example set(name, "my-engine")');
    }
    row.name = value;
    return;
  }
  if (rest.length === 0) {
    throw new Error('set(config, …) needs a field, for example set(config.auto, false)');
  }
  if (RESERVED_CONFIG_KEYS.has(rest[0])) {
    throw new Error(`config.${rest[0]} belongs to the generator and cannot be set by a rule`);
  }
  if (row.config === undefined || row.config === null) row.config = {};
  if (typeof row.config !== 'object' || Array.isArray(row.config)) {
    throw new Error('the row config is not a mapping');
  }
  let target = row.config;
  for (const key of rest.slice(0, -1)) {
    const next = target[key];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      target[key] = {};
    }
    target = target[key];
  }
  target[rest[rest.length - 1]] = value;
}

/** Structural equality for plain JSON-like values. */
export function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null || typeof left !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

/**
 * Whether one preset row matches a selector.
 * @param {object} selector IR node
 * @param {object} row preset row ({ id, name, config?, disabled? })
 */
export function selects(selector, row) {
  switch (selector.kind) {
    case 'any':
      return true;
    case 'field':
      return selector.values.includes(row[selector.field]);
    case 'not':
      return !selects(selector.inner, row);
    case 'bin': {
      const left = selects(selector.left, row);
      if (selector.op === '+') return left || selects(selector.right, row);
      return left && !selects(selector.right, row);
    }
    default:
      throw new Error(`unknown selector node: ${selector.kind}`);
  }
}

function evaluatePresetSet(expression, allIds, unknown, line) {
  switch (expression.kind) {
    case 'all':
      return new Set(allIds);
    case 'names': {
      const selected = new Set();
      for (const name of expression.names) {
        if (allIds.includes(name)) selected.add(name);
        else if (!unknown.has(name)) unknown.set(name, line);
      }
      return selected;
    }
    case 'not': {
      const inner = evaluatePresetSet(expression.inner, allIds, unknown, line);
      return new Set(allIds.filter((id) => !inner.has(id)));
    }
    case 'bin': {
      const left = evaluatePresetSet(expression.left, allIds, unknown, line);
      const right = evaluatePresetSet(expression.right, allIds, unknown, line);
      if (expression.op === '+') return new Set([...left, ...right]);
      return new Set([...left].filter((id) => !right.has(id)));
    }
    default:
      throw new Error(`unknown set node: ${expression.kind}`);
  }
}

/**
 * Apply rules to presets.
 * @param {Array<{presetId: string, row: object}>} presets upstream preset rows
 * @param {Array<object>} rules parsed rules from {@link parseRules}
 * @returns {{results: Array<object>, diagnostics: Array<object>}}
 * @throws {RuleError} when a rule uses an action this version cannot apply
 */
export function applyRules(presets, rules) {
  const diagnostics = [];
  const ids = presets.map((preset) => preset.presetId);
  const originals = new Map();
  const before = new Map();
  const working = new Map();
  const hidden = new Map();
  const applied = new Map();
  const unknown = new Map();

  for (const preset of presets) {
    const rows = preset?.row?.config?.plugins;
    if (!Array.isArray(rows)) {
      throw new Error(`preset "${preset?.presetId ?? '?'}" has no config.plugins array`);
    }
    originals.set(preset.presetId, structuredClone(rows));
    before.set(preset.presetId, structuredClone(preset.row));
    working.set(preset.presetId, structuredClone(preset.row));
    hidden.set(preset.presetId, []);
    applied.set(preset.presetId, []);
  }

  for (const rule of rules) {
    if (!SUPPORTED.has(rule.action.kind)) {
      throw new RuleError(
        `action "${rule.action.kind}" is not supported by this version`,
        rule.actionAt.line,
        rule.actionAt.col,
      );
    }

    const selected = [...evaluatePresetSet(rule.presets, ids, unknown, rule.line)].sort(
      (left, right) => ids.indexOf(left) - ids.indexOf(right),
    );

    if (selected.length === 0) {
      diagnostics.push({
        level: 'warning',
        line: rule.line,
        message: 'rule selects no presets',
      });
      continue;
    }

    let matchedAnywhere = false;
    for (const presetId of selected) {
      const row = working.get(presetId);
      const matched = [];
      walkRows(row, (candidate, siblings) => {
        if (selects(rule.entry, candidate)) matched.push([candidate, siblings]);
      });
      if (matched.length === 0) continue;
      matchedAnywhere = true;
      if (rule.action.kind === 'hide') {
        for (const [target, siblings] of matched) {
          const index = siblings.indexOf(target);
          if (index >= 0) siblings.splice(index, 1);
          hidden.get(presetId).push(target.id);
        }
        continue;
      }
      for (const [target] of matched) {
        try {
          if (rule.action.kind === 'set') writeSet(target, rule.action.path, rule.action.value);
          else writeSet(target, ['disabled'], rule.action.kind === 'disable');
        } catch (error) {
          throw new RuleError(error.message, rule.actionAt.line, rule.actionAt.col);
        }
        applied.get(presetId).push({
          id: typeof target.id === 'string' && target.id !== '' ? target.id : '?',
          kind: rule.action.kind,
          ...rule.action.kind === 'set' ? { path: rule.action.path.join('.'), value: rule.action.value } : {},
        });
      }
    }
    if (!matchedAnywhere) {
      diagnostics.push({
        level: 'warning',
        line: rule.line,
        message: 'row selector matched no rows in the selected presets',
      });
    }
  }

  for (const [name, line] of unknown) {
    diagnostics.push({
      level: 'warning',
      line,
      message: `unknown preset "${name}" (found: ${ids.join(', ') || 'none'})`,
    });
  }

  const results = presets.map((preset) => {
    const row = working.get(preset.presetId);
    const originalRows = originals.get(preset.presetId);
    return {
      presetId: preset.presetId,
      row,
      originalRows,
      rows: row.config.plugins,
      originalCount: countRows(before.get(preset.presetId)),
      count: countRows(row),
      hidden: hidden.get(preset.presetId),
      applied: applied.get(preset.presetId),
      changed: !deepEqual(before.get(preset.presetId), row),
    };
  });

  return { results, diagnostics };
}
