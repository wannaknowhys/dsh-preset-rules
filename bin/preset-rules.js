#!/usr/bin/env node
/**
 * Standalone entry to the same generator the plugin runs at boot.
 *
 * It exists so a rule file can be verified before installing the bundle, and so
 * users can reproduce what the plugin does without reading the log:
 *
 *   node bin/preset-rules.js --check --rules ./preset-rules.rules
 *
 * Reading a packaged desktop installation (files inside `app.asar`) only works
 * under Electron-as-node; otherwise point `--source` at an unpacked package
 * directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/generate.js';
import { formatReport } from '../src/report.js';
import { RuleError, formatError } from '../src/rules.js';
import { resolveOptions } from '../index.js';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'preset-rules.rules');

const USAGE = `preset-rules — generate a dsh agent-preset patch from a rule file

Usage:
  preset-rules [--check|--apply] [--rules <file>] [--target <file>]
               [--source <dir>] [--json]
  preset-rules --init [--rules <file>]

  --check          compute and print the result without writing
  --apply          write the generated patch (default)
  --init           create a starter rule file if none exists
  --rules <file>   rule file        (default: $DSH_HOME/preset-rules.rules)
  --target <file>  generated patch  (default: $DSH_HOME/cordis.patch.yml)
  --source <dir>   @deepseek-ai/dsh-web-app package directory (default: auto-detect)
  --json           machine-readable summary
  -h, --help       show this help
`;

function fail(message) {
  process.stderr.write(`preset-rules: ${message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = { mode: 'apply' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      if (arg === '-h') {
        options.help = true;
        continue;
      }
      throw new Error(`unexpected argument "${arg}"`);
    }

    const separator = arg.indexOf('=');
    const flag = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);
    const takeValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`missing value for --${flag}`);
      return value;
    };

    switch (flag) {
      case 'check':
        options.mode = 'check';
        break;
      case 'apply':
        options.mode = 'apply';
        break;
      case 'init':
        options.init = true;
        break;
      case 'rules':
        options.rulesPath = takeValue();
        break;
      case 'target':
        options.targetPath = takeValue();
        break;
      case 'source':
        options.webAppDir = takeValue();
        break;
      case 'json':
        options.json = true;
        break;
      case 'help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option "--${flag}"`);
    }
  }

  return options;
}

function toJson(result) {
  return JSON.stringify(
    {
      action: result.action,
      targetPath: result.targetPath,
      rulesPath: result.rulesPath,
      bytes: result.bytes,
      source: result.source,
      presets: (result.results ?? []).map((item) => ({
        presetId: item.presetId,
        before: item.originalRows.length,
        after: item.rows.length,
        hidden: item.hidden,
        changed: item.changed,
      })),
      diagnostics: result.diagnostics ?? [],
    },
    null,
    2,
  );
}

/** Write the starter rule file, never overwriting an existing one. */
function initialize(rulesPath) {
  if (fs.existsSync(rulesPath)) {
    process.stdout.write(`preset-rules: ${rulesPath} already exists\n`);
    return;
  }
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, template, 'utf8');
  process.stdout.write(`preset-rules: created ${rulesPath}\n`);
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(error.message);
    process.stderr.write(USAGE);
    return;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }

  const options = resolveOptions({
    rulesPath: parsed.rulesPath,
    targetPath: parsed.targetPath,
    mode: parsed.mode,
    webAppDir: parsed.webAppDir,
  });

  if (parsed.init) {
    try {
      initialize(options.rulesPath);
    } catch (error) {
      process.stderr.write(`preset-rules: ${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    const result = generate(options);
    process.stdout.write(`${parsed.json ? toJson(result) : formatReport(result)}\n`);
  } catch (error) {
    const message = error instanceof RuleError ? formatError(error, options.rulesPath) : `preset-rules: ${error.message}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
