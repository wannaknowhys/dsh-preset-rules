/**
 * YAML helpers.
 *
 * Loading uses the same dialect the dsh loader uses for entry lists: the JSON
 * schema extended with the `!!js` tag, so shipped presets parse exactly as the
 * runtime parses them.
 *
 * Dumping uses the default schema on purpose: `{ __jsExpr: "..." }` is written
 * as a plain mapping. The loader only checks for the `__jsExpr` key, so the
 * meaning is unchanged while the file stays readable by any YAML tool.
 */

import yaml from 'js-yaml';

/** `!!js` expression node, matching `dsh-app-boot`'s entry-list dialect. */
const JsExpression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data.__jsExpr,
});

/** Schema for reading entry lists. */
export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpression);

/**
 * Parse an entry-list YAML document.
 * @param {string} text
 * @param {string} file used in the error message
 */
export function loadEntryList(text, file = '<yaml>') {
  try {
    return yaml.load(text, { schema: entryListSchema });
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`, { cause: error });
  }
}

/**
 * Serialize patch rows deterministically.
 * @param {Array<object>} rows
 */
export function dumpEntries(rows) {
  return yaml.dump(rows, {
    noRefs: true,
    lineWidth: -1,
    indent: 2,
  });
}
