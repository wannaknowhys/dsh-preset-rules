/**
 * Orchestrate one generation run: read rules, read the installation, apply,
 * render, validate, and only then write.
 *
 * The write path is deliberately conservative:
 * - the rendered text is parsed back and checked against the model result;
 * - unchanged bytes skip the write entirely (no reload churn);
 * - a file this generator did not write is never overwritten;
 * - the write is a temp file plus rename.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseRules } from './rules.js';
import { applyRules } from './model.js';
import { loadSourcePresets } from './source.js';
import { GENERATED_MARKER, hashText, isGenerated, renderPatch } from './render.js';
import { loadEntryList } from './yaml.js';

/** Failure that is not a rule syntax error (I/O, upstream shape, write refusal). */
export class GenerateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'GenerateError';
  }
}

const MODES = new Set(['apply', 'check', 'off']);

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new GenerateError(`cannot read ${file}: ${error.message}`, { cause: error });
  }
}

function writeAtomic(targetPath, text) {
  const directory = path.dirname(targetPath);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new GenerateError(`cannot create ${directory}: ${error.message}`, { cause: error });
  }

  const temporary = `${targetPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, targetPath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort: the original error is the useful one.
    }
    throw new GenerateError(`cannot write ${targetPath}: ${error.message}`, { cause: error });
  }
}

/**
 * Check that the rendered text matches the model result before anything is written.
 * @param {string} text rendered YAML
 * @param {Array<object>} results model results
 * @param {string} file label for diagnostics
 * @returns {Array<object>} parsed entries
 * @throws {GenerateError} when the text and the model disagree
 */
export function validateRendered(text, results, file = 'generated') {
  let rows;
  try {
    rows = loadEntryList(text, file);
  } catch (error) {
    throw new GenerateError(error.message, { cause: error });
  }
  if (!Array.isArray(rows)) throw new GenerateError(`${file}: generated file is not a patch list`);

  const changed = results.filter((result) => result.changed);
  if (rows.length !== changed.length) {
    throw new GenerateError(`${file}: rendered ${rows.length} entries, expected ${changed.length}`);
  }

  for (const result of changed) {
    const entry = rows.find((row) => row?.config?.id === result.presetId);
    if (!entry) throw new GenerateError(`${file}: preset "${result.presetId}" is missing from the output`);
    if (entry.name !== '@deepseek-ai/dsh-agent-preset') {
      throw new GenerateError(`${file}: preset "${result.presetId}" has an unexpected plugin name`);
    }
    const plugins = entry?.config?.plugins;
    if (!Array.isArray(plugins)) throw new GenerateError(`${file}: preset "${result.presetId}" has no plugins`);
    if (plugins.length !== result.rows.length) {
      throw new GenerateError(
        `${file}: preset "${result.presetId}" rendered ${plugins.length} rows, expected ${result.rows.length}`,
      );
    }
    for (const hidden of result.hidden) {
      if (plugins.some((row) => row?.id === hidden)) {
        throw new GenerateError(`${file}: hidden row "${hidden}" survived in preset "${result.presetId}"`);
      }
    }
  }

  return rows;
}

/**
 * Run one generation.
 * @param {object} options
 * @param {string} options.rulesPath
 * @param {string} options.targetPath
 * @param {'apply'|'check'|'off'} [options.mode]
 * @param {string} [options.webAppDir]
 * @param {string} [options.execPath]
 * @param {{name: string, version: string}} [options.generator]
 * @returns {{action: 'off'|'unchanged'|'would-write'|'written', targetPath: string,
 *            rulesPath: string, source?: object, results: Array<object>,
 *            diagnostics: Array<object>, bytes?: number, text?: string}}
 */
export function generate(options = {}) {
  const {
    rulesPath,
    targetPath,
    webAppDir,
    execPath,
    generator = { name: 'dsh-preset-rules', version: '0.1.0' },
  } = options;
  const mode = options.mode ?? 'apply';

  if (!MODES.has(mode)) throw new GenerateError(`unknown mode "${mode}" (expected apply, check, or off)`);
  if (mode === 'off') return { action: 'off', targetPath, rulesPath, results: [], diagnostics: [] };
  if (!rulesPath) throw new GenerateError('rulesPath is required');
  if (!targetPath) throw new GenerateError('targetPath is required');

  const rulesText = readIfExists(rulesPath);
  const rules = rulesText === null ? [] : parseRules(rulesText);

  let source;
  try {
    source = loadSourcePresets({ webAppDir, execPath });
  } catch (error) {
    if (error instanceof GenerateError) throw error;
    throw new GenerateError(error.message, { cause: error });
  }
  const { results, diagnostics } = applyRules(source.presets, rules);
  const entries = results.filter((result) => result.changed).map((result) => result.row);

  const text = renderPatch({
    entries,
    generator,
    source: { name: '@deepseek-ai/dsh-web-app', version: source.version },
    sourceHash: source.sourceHash,
    rulesHash: rulesText === null ? 'none' : hashText(rulesText),
  });

  validateRendered(text, results, targetPath);

  const report = {
    targetPath,
    rulesPath,
    source: {
      packageDir: source.packageDir,
      version: source.version,
      sourceHash: source.sourceHash,
      origin: source.origin,
    },
    results,
    diagnostics: [
      ...source.warnings.map((message) => ({ level: 'warning', message })),
      ...diagnostics,
    ],
    bytes: Buffer.byteLength(text, 'utf8'),
    text,
  };

  const existing = readIfExists(targetPath);
  if (existing !== null && !isGenerated(existing)) {
    throw new GenerateError(
      `refusing to overwrite ${targetPath}: the file does not start with "${GENERATED_MARKER}"; ` +
        'move it away or point "targetPath" somewhere else',
    );
  }

  if (existing === text) return { ...report, action: 'unchanged' };
  if (existing === null && entries.length === 0) return { ...report, action: 'unchanged' };
  if (mode === 'check') return { ...report, action: 'would-write' };

  writeAtomic(targetPath, text);
  return { ...report, action: 'written' };
}
