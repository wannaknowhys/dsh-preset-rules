/**
 * Host plugin entry.
 *
 * The plugin must never throw: a broken rule file, a missing installation, or a
 * refused write has to leave the boot untouched and surface in the log instead.
 *
 * Logging is deliberately quiet: a run that neither wrote nor complained says
 * nothing at all. `check` mode is the explicit request for output, so it prints
 * the full report at info level.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { generate } from './src/generate.js';
import { formatReport, summarize } from './src/report.js';
import { RuleError, formatError } from './src/rules.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'preset-rules';

/** No required services; the plugin only reads files and writes one of them. */
export const inject = [];

const RULES_FILENAME = 'preset-rules.rules';
const TARGET_FILENAME = 'cordis.patch.yml';

/**
 * Resolve the Harness home directory.
 * @param {Record<string, string|undefined>} env
 * @param {string} home
 */
export function homeDir(env = process.env, home = os.homedir()) {
  const configured = env?.DSH_HOME;
  return configured && String(configured).trim() !== '' ? String(configured) : path.join(home, '.dsh');
}

/**
 * Turn plugin config into absolute generation options.
 * @param {object} config plugin config
 * @param {Record<string, string|undefined>} env
 * @param {string} home
 */
export function resolveOptions(config = {}, env = process.env, home = os.homedir()) {
  const base = homeDir(env, home);
  return {
    rulesPath: config.rulesPath ? String(config.rulesPath) : path.join(base, RULES_FILENAME),
    targetPath: config.targetPath ? String(config.targetPath) : path.join(base, TARGET_FILENAME),
    mode: config.mode ?? 'apply',
    webAppDir: config.webAppDir ? String(config.webAppDir) : undefined,
  };
}

/**
 * Report one result according to the quiet policy.
 * @param {object} result
 * @param {{info: Function, warn: Function, error: Function}} logger
 */
export function emit(result, logger) {
  if (!result || result.action === 'off') return;

  if (result.action === 'would-write') {
    logger.info(formatReport(result));
  } else if (result.action === 'written') {
    logger.info(`preset-rules: ${summarize(result)} -> ${result.targetPath}`);
  }

  for (const diagnostic of result.diagnostics ?? []) {
    const where = diagnostic.line ? ` (line ${diagnostic.line})` : '';
    const line = `preset-rules: ${diagnostic.message}${where}`;
    if (diagnostic.level === 'error') logger.error(line);
    else logger.warn(line);
  }
}

function failureText(error, rulesPath) {
  if (error instanceof RuleError) return formatError(error, rulesPath ?? 'preset-rules.rules');
  return `preset-rules: ${error?.message ?? String(error)}`;
}

/**
 * Cordis entry point.
 * @param {object} ctx plugin context
 * @param {object} config plugin config (`rulesPath`, `targetPath`, `mode`, `webAppDir`)
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console;
  let options;

  try {
    options = resolveOptions(config);
    // A fresh installation has neither a rule file nor a generated patch: say
    // so once instead of looking like a no-op. Logging stops as soon as either
    // file exists.
    const fresh = !fs.existsSync(options.rulesPath) && !fs.existsSync(options.targetPath);
    const result = generate(options);
    if (fresh && result.action === 'unchanged') {
      logger.info(
        `preset-rules: no rules file at ${options.rulesPath}; nothing to do ` +
          '(run "preset-rules --init" or copy examples/preset-rules.rules)',
      );
    }
    emit(result, logger);
  } catch (error) {
    // Never fail the boot over a configuration generator.
    logger.error(failureText(error, options?.rulesPath ?? config?.rulesPath));
  }
}
