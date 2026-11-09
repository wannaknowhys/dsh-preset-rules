/** Shared fixtures for tests: a throwaway dsh installation on disk. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset';

export function makeTempDir(t, prefix = 'dsh-preset-rules-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a minimal `@deepseek-ai/dsh-web-app` package with the given patch files. */
export function makeInstall(t, files) {
  const dir = makeTempDir(t, 'dsh-preset-rules-install-');
  const patch = Object.keys(files);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '9.9.9-fixture', dsh: { bundle: { patch } } }, null, 2),
  );
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

export const presetPatch = (id, order, plugins) =>
  [
    '- insert:',
    `    - id: preset-${id}`,
    `      name: '${PRESET_PLUGIN}'`,
    '      config:',
    `        id: ${id}`,
    `        order: ${order}`,
    plugins.length === 0 ? '        plugins: []' : '        plugins:',
    ...plugins.flatMap((plugin) => [
      `          - id: ${plugin.id}`,
      `            name: '${plugin.name}'`,
      ...(plugin.disabled ? [`            disabled: ${plugin.disabled}`] : []),
    ]),
    '',
  ].join('\n');

export const unrelatedPatch = ['- insert:', '    - id: some-tool', "      name: '@deepseek-ai/dsh-tool-web'", ''].join('\n');
