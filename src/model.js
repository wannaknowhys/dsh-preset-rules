/**
 * Evaluate parsed rules against the presets read from the installation.
 *
 * The model is a cross product: for every selected preset, every row matching
 * the selector receives the action. Rules apply in file order; hiding a row
 * removes it from later matching within the same run.
 */

import { RuleError } from './rules.js';

/** Actions implemented in 0.1. */
const SUPPORTED = new Set(['hide']);

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
  const working = new Map();
  const hidden = new Map();
  const unknown = new Map();

  for (const preset of presets) {
    const rows = preset?.row?.config?.plugins;
    if (!Array.isArray(rows)) {
      throw new Error(`preset "${preset?.presetId ?? '?'}" has no config.plugins array`);
    }
    originals.set(preset.presetId, structuredClone(rows));
    working.set(preset.presetId, structuredClone(preset.row));
    hidden.set(preset.presetId, []);
  }

  for (const rule of rules) {
    if (!SUPPORTED.has(rule.action.kind)) {
      throw new RuleError(
        `action "${rule.action.kind}" is not supported in 0.1 (planned for 0.2)`,
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
      const matched = row.config.plugins.filter((candidate) => selects(rule.entry, candidate));
      if (matched.length === 0) continue;
      matchedAnywhere = true;
      const drop = new Set(matched);
      row.config.plugins = row.config.plugins.filter((candidate) => !drop.has(candidate));
      for (const removed of matched) hidden.get(presetId).push(removed.id);
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
      hidden: hidden.get(preset.presetId),
      changed: !deepEqual(originalRows, row.config.plugins),
    };
  });

  return { results, diagnostics };
}
