/**
 * Locate the dsh installation and read the shipped agent-preset declarations.
 *
 * Presets are discovered semantically, not by file path: every patch file the
 * bundle declares is parsed, and rows whose plugin is `@deepseek-ai/dsh-agent-preset`
 * with a `config.id` and a `config.plugins` array are collected. A future
 * reorganisation of `presets/` therefore keeps working.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { loadEntryList } from './yaml.js';

const WEB_APP_NAME = '@deepseek-ai/dsh-web-app';
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset';

/** Package-relative candidate directories inside the desktop installation. */
function desktopCandidates(execPath) {
  const execDir = path.dirname(execPath);
  const nested = ['dsh', 'node_modules', ...WEB_APP_NAME.split('/')];
  return [
    { dir: path.join(execDir, 'resources', 'app.asar', ...nested), origin: 'asar' },
    { dir: path.join(execDir, 'resources', 'app', ...nested), origin: 'unpacked' },
  ];
}

/**
 * Find the installed `@deepseek-ai/dsh-web-app` package.
 * @param {{webAppDir?: string, execPath?: string, requireFrom?: string}} options
 * @returns {{packageDir: string, packageFile: string, origin: string}}
 */
export function locateWebApp(options = {}) {
  const candidates = [];
  if (options.webAppDir) {
    candidates.push({ dir: options.webAppDir, origin: 'config' });
  }

  try {
    const requireFrom = createRequire(options.requireFrom ?? import.meta.url);
    const resolved = requireFrom.resolve(`${WEB_APP_NAME}/package.json`);
    candidates.push({ dir: path.dirname(resolved), origin: 'resolve' });
  } catch {
    // Not resolvable from this package, which is normal for a profile install.
  }

  candidates.push(...desktopCandidates(options.execPath ?? process.execPath));

  const tried = [];
  for (const candidate of candidates) {
    const packageFile = path.join(candidate.dir, 'package.json');
    let exists = false;
    try {
      exists = fs.existsSync(packageFile);
    } catch {
      exists = false;
    }
    if (exists) return { packageDir: candidate.dir, packageFile, origin: candidate.origin };
    tried.push(candidate.dir);
  }

  throw new Error(
    `cannot locate ${WEB_APP_NAME}; tried:\n- ${tried.join('\n- ')}\n` +
      'Set the "webAppDir" plugin option to the package directory that contains its package.json.',
  );
}

function declaredPatchFiles(manifest) {
  const declared = manifest?.dsh?.bundle?.patch;
  const list = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
  return list.filter((file) => typeof file === 'string' && file.length > 0);
}

/** Preset rows inserted by one parsed patch document. */
function presetRows(document, file, warnings) {
  const rows = [];
  for (const patch of Array.isArray(document) ? document : []) {
    if (!patch || typeof patch !== 'object') continue;
    if (!Array.isArray(patch.insert)) {
      if (typeof patch.id === 'string' && patch.id.startsWith('preset-')) {
        warnings.push(`${file}: patch target "${patch.id}" is an override, which 0.1 does not compose; using the original declaration`);
      }
      continue;
    }
    for (const row of patch.insert) {
      if (!row || row.name !== PRESET_PLUGIN) continue;
      if (typeof row?.config?.id !== 'string' || !Array.isArray(row?.config?.plugins)) {
        throw new Error(`${file}: agent-preset row is missing config.id or config.plugins`);
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Read every shipped preset declaration.
 * @param {{webAppDir?: string, execPath?: string, requireFrom?: string}} options
 * @returns {{packageDir: string, version: string|undefined, origin: string, files: string[],
 *            presets: Array<{presetId: string, row: object, file: string}>, sourceHash: string,
 *            warnings: string[]}}
 */
export function loadSourcePresets(options = {}) {
  const location = locateWebApp(options);
  const manifest = JSON.parse(fs.readFileSync(location.packageFile, 'utf8'));
  const files = declaredPatchFiles(manifest);
  if (files.length === 0) {
    throw new Error(`${location.packageFile} declares no dsh.bundle.patch files`);
  }

  const warnings = [];
  const presets = [];
  const hashed = [];

  for (const relative of files) {
    const file = path.resolve(location.packageDir, relative);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      warnings.push(`cannot read ${relative}: ${error.message}`);
      continue;
    }
    let document;
    try {
      document = loadEntryList(text, relative);
    } catch (error) {
      warnings.push(error.message);
      continue;
    }
    const rows = presetRows(document, relative, warnings);
    if (rows.length > 0) hashed.push({ relative, text });
    for (const row of rows) presets.push({ presetId: row.config.id, row, file: relative });
  }

  if (presets.length === 0) {
    throw new Error(`no agent-preset declarations found in ${files.length} patch file(s) of ${location.packageDir}`);
  }

  const duplicates = presets.map((preset) => preset.presetId).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`preset id declared more than once: ${[...new Set(duplicates)].join(', ')}`);
  }

  return {
    packageDir: location.packageDir,
    version: manifest.version,
    origin: location.origin,
    files,
    presets,
    sourceHash: hashSources(hashed),
    warnings,
  };
}

/**
 * Stable hash of the preset-bearing patch files (path + contents, sorted).
 * @param {Array<{relative: string, text: string}>} files
 */
export function hashSources(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.relative.localeCompare(right.relative))) {
    hash.update(file.relative);
    hash.update('\u0000');
    hash.update(file.text);
    hash.update('\u0000');
  }
  return `sha256:${hash.digest('hex')}`;
}
