/**
 * Human-readable output shared by the plugin and the CLI.
 * The `check` shape is documented in DESIGN.md §7.4.
 */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function countLabel(changed) {
  return `${changed} ${changed === 1 ? 'entry' : 'entries'}`;
}

function header(action) {
  if (action === 'off') return 'preset-rules: off';
  if (action === 'would-write') return 'preset-rules: check (no write)';
  if (action === 'written') return 'preset-rules: written';
  return 'preset-rules: unchanged';
}

function summaryLine(result) {
  const label = result.presetId.padEnd(9);
  if (!result.changed) return `  ${label}: ${result.originalRows.length} rows, unchanged`;
  const hidden = result.hidden.length > 0 ? `   (- ${result.hidden.join(', ')})` : '';
  return `  ${label}: ${result.originalRows.length} -> ${result.rows.length}${hidden}`;
}

/** One-line outcome, used by the plugin log and the report footer. */
export function summarize(result) {
  const changed = (result.results ?? []).filter((item) => item.changed).length;
  const entries = countLabel(changed);
  const size = formatBytes(result.bytes);
  if (result.action === 'written') {
    return changed === 0 ? `cleared the generated patch (${size})` : `wrote ${entries} (${size})`;
  }
  if (result.action === 'would-write') return `would write ${entries} (${size})`;
  if (result.action === 'unchanged') return `no change (${entries}, ${size})`;
  return result.action;
}

/** Render the result of {@link generate} as plain text. */
export function formatReport(result) {
  const lines = [header(result.action)];

  for (const item of result.results ?? []) lines.push(summaryLine(item));

  if (result.source) {
    lines.push(`source: ${result.source.version ?? 'unknown'}${result.source.origin ? ` (${result.source.origin})` : ''}`);
  }
  if (result.targetPath) lines.push(`target: ${result.targetPath}`);
  if (result.action !== 'off') lines.push(summarize(result));

  for (const diagnostic of result.diagnostics ?? []) {
    const where = diagnostic.line ? ` (line ${diagnostic.line})` : '';
    lines.push(`${diagnostic.level ?? 'warning'}: ${diagnostic.message}${where}`);
  }

  return lines.join('\n');
}
