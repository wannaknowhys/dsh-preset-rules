/**
 * Lexer and parser for the preset-rules DSL (v0.1 grammar).
 *
 * The parser is pure: it takes text and returns rules or throws a RuleError.
 * It never touches the filesystem and never evaluates a rule.
 */

export class RuleError extends Error {
  /** @param {string} message @param {number} line @param {number} col */
  constructor(message, line, col) {
    super(message);
    this.name = 'RuleError';
    this.line = line;
    this.col = col;
  }
}

const PUNCT = new Set([...';,():{}*=']);
const IDENT_CHAR = /[A-Za-z0-9_@.\/-]/;
const CLAUSES = ['presets', 'entry', 'action'];
const ACTIONS = ['hide', 'disable', 'enable', 'set'];

/** Human-readable rendering of a token for diagnostics. */
function describe(token) {
  if (!token) return 'end of line';
  if (token.type === 'string') return `string ${JSON.stringify(token.value)}`;
  if (token.type === 'number') return `number ${token.value}`;
  return `${token.type} ${JSON.stringify(token.value)}`;
}

/**
 * Split one source line into tokens.
 * @param {string} text line contents (comments allowed)
 * @param {number} line 1-based line number for diagnostics
 */
export function tokenize(text, line) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '#') break;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const col = index + 1;
    const previous = tokens[tokens.length - 1];

    if (PUNCT.has(char)) {
      tokens.push({ type: 'punct', value: char, col });
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        const current = text[cursor];
        if (current === '\\') {
          const escaped = text[cursor + 1];
          if (escaped === undefined) break;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          cursor += 2;
          continue;
        }
        if (current === quote) {
          closed = true;
          cursor += 1;
          break;
        }
        value += current;
        cursor += 1;
      }
      if (!closed) throw new RuleError('unterminated string', line, col);
      tokens.push({ type: 'string', value, col });
      index = cursor;
      continue;
    }

    const afterSeparator =
      previous !== undefined &&
      previous.type === 'punct' &&
      (previous.value === ',' || previous.value === '(');

    if (char === '-' && /[0-9]/.test(text[index + 1] ?? '') && afterSeparator) {
      let cursor = index + 1;
      while (cursor < text.length && /[0-9]/.test(text[cursor])) cursor += 1;
      if (text[cursor] === '.') {
        cursor += 1;
        while (cursor < text.length && /[0-9]/.test(text[cursor])) cursor += 1;
      }
      tokens.push({ type: 'number', value: Number(text.slice(index, cursor)), col });
      index = cursor;
      continue;
    }

    if (char === '+' || char === '-') {
      const spacedLeft = index === 0 || /\s/.test(text[index - 1]);
      const spacedRight = index + 1 >= text.length || /\s/.test(text[index + 1]);
      if (spacedLeft && spacedRight) {
        tokens.push({ type: 'punct', value: char, col });
        index += 1;
        continue;
      }
      throw new RuleError(`binary '${char}' must have spaces on both sides`, line, col);
    }

    if (/[0-9]/.test(char)) {
      let cursor = index;
      while (cursor < text.length && /[0-9]/.test(text[cursor])) cursor += 1;
      if (text[cursor] === '.') {
        cursor += 1;
        while (cursor < text.length && /[0-9]/.test(text[cursor])) cursor += 1;
      }
      tokens.push({ type: 'number', value: Number(text.slice(index, cursor)), col });
      index = cursor;
      continue;
    }

    if (IDENT_CHAR.test(char)) {
      let cursor = index;
      while (cursor < text.length && IDENT_CHAR.test(text[cursor])) cursor += 1;
      tokens.push({ type: 'ident', value: text.slice(index, cursor), col });
      index = cursor;
      continue;
    }

    throw new RuleError(`unexpected character ${JSON.stringify(char)}`, line, col);
  }

  return tokens;
}

/** Cursor over one clause's tokens. */
class Cursor {
  constructor(tokens, line) {
    this.tokens = tokens;
    this.line = line;
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  next() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  atEnd() {
    return this.index >= this.tokens.length;
  }

  expectPunct(value) {
    const token = this.peek();
    if (!token || token.type !== 'punct' || token.value !== value) {
      throw new RuleError(`expected "${value}", got ${describe(token)}`, this.line, token?.col ?? this.eol());
    }
    return this.next();
  }

  expectIdent() {
    const token = this.peek();
    if (!token || token.type !== 'ident') {
      throw new RuleError(`expected a name, got ${describe(token)}`, this.line, token?.col ?? this.eol());
    }
    return this.next();
  }

  eol() {
    const last = this.tokens[this.tokens.length - 1];
    return last ? last.col + String(last.value).length : 1;
  }

  expectEnd() {
    const token = this.peek();
    if (token) throw new RuleError(`unexpected ${describe(token)}`, this.line, token.col);
  }
}

function levenshtein(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, (_, i) => [i, ...new Array(cols - 1).fill(0)]);
  for (let j = 1; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[rows - 1][cols - 1];
}

/** Suggest the closest known name, or an empty string when nothing is close. */
export function didYouMean(value, candidates) {
  let best;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(String(value), candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= 2 ? ` (did you mean "${best}"?)` : '';
}

function parseSetTerm(cursor) {
  const token = cursor.next();
  if (!token) throw new RuleError('expected a preset set', cursor.line, cursor.eol());

  if (token.type === 'punct' && token.value === '{') {
    const names = [];
    if (cursor.peek()?.type === 'punct' && cursor.peek().value === '}') {
      throw new RuleError('empty set "{}"', cursor.line, token.col);
    }
    names.push(cursor.expectIdent().value);
    while (cursor.peek()?.type === 'punct' && cursor.peek().value === ',') {
      cursor.next();
      names.push(cursor.expectIdent().value);
    }
    cursor.expectPunct('}');
    return { kind: 'names', names };
  }

  if (token.type === 'ident') {
    if (token.value.endsWith('-') || token.value.endsWith('+')) {
      const operator = token.value.slice(-1);
      throw new RuleError(
        `binary '${operator}' must have spaces on both sides`,
        cursor.line,
        token.col + token.value.length - 1,
      );
    }
    if (token.value === 'all') return { kind: 'all' };
    if (token.value === 'not') {
      cursor.expectPunct('(');
      const inner = parseSetExpr(cursor);
      cursor.expectPunct(')');
      return { kind: 'not', inner };
    }
    return { kind: 'names', names: [token.value] };
  }

  throw new RuleError(`expected a preset set, got ${describe(token)}`, cursor.line, token.col);
}

function parseSetExpr(cursor) {
  let left = parseSetTerm(cursor);
  for (;;) {
    const token = cursor.peek();
    if (!token || token.type !== 'punct' || (token.value !== '+' && token.value !== '-')) break;
    cursor.next();
    left = { kind: 'bin', op: token.value, left, right: parseSetTerm(cursor) };
  }
  return left;
}

function parseSelectorValue(cursor) {
  const token = cursor.peek();
  if (!token) throw new RuleError('expected a selector value', cursor.line, cursor.eol());
  if (token.type === 'punct' && token.value === '{') {
    cursor.next();
    if (cursor.peek()?.type === 'punct' && cursor.peek().value === '}') {
      throw new RuleError('empty set "{}"', cursor.line, token.col);
    }
    const values = [cursor.expectIdent().value];
    while (cursor.peek()?.type === 'punct' && cursor.peek().value === ',') {
      cursor.next();
      values.push(cursor.expectIdent().value);
    }
    cursor.expectPunct('}');
    return values;
  }
  if (token.type === 'string') {
    cursor.next();
    return [token.value];
  }
  return [cursor.expectIdent().value];
}

function parseSelectorAtom(cursor) {
  const token = cursor.next();
  if (!token) throw new RuleError('expected a row selector', cursor.line, cursor.eol());

  if (token.type === 'punct' && token.value === '*') return { kind: 'any' };

  if (token.type === 'ident') {
    if (token.value === 'not') {
      cursor.expectPunct('(');
      const inner = parseSelectorExpr(cursor);
      cursor.expectPunct(')');
      return { kind: 'not', inner };
    }
    if (token.value === 'id' || token.value === 'name') {
      cursor.expectPunct(':');
      return { kind: 'field', field: token.value, values: parseSelectorValue(cursor) };
    }
    throw new RuleError(
      `unknown selector field "${token.value}" (expected id, name, or *)`,
      cursor.line,
      token.col,
    );
  }

  throw new RuleError(`expected a row selector, got ${describe(token)}`, cursor.line, token.col);
}

function parseSelectorExpr(cursor) {
  let left = parseSelectorAtom(cursor);
  for (;;) {
    const token = cursor.peek();
    if (!token || token.type !== 'punct' || (token.value !== '+' && token.value !== '-')) break;
    cursor.next();
    left = { kind: 'bin', op: token.value, left, right: parseSelectorAtom(cursor) };
  }
  return left;
}

function parsePath(token, line) {
  const segments = token.value.split('.');
  const root = segments[0];
  if (root !== 'config' && root !== 'disabled') {
    throw new RuleError(`unsupported path root "${root}" (expected config or disabled)`, line, token.col);
  }
  if (root === 'disabled' && segments.length > 1) {
    throw new RuleError('"disabled" takes no sub-path', line, token.col);
  }
  return segments;
}

function parseLiteral(cursor) {
  const token = cursor.next();
  if (!token) throw new RuleError('expected a literal value', cursor.line, cursor.eol());
  if (token.type === 'number' || token.type === 'string') return token.value;
  if (token.type === 'ident') {
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    throw new RuleError(
      `expected a literal value, got ${JSON.stringify(token.value)} (quote strings)`,
      cursor.line,
      token.col,
    );
  }
  throw new RuleError(`expected a literal value, got ${describe(token)}`, cursor.line, token.col);
}

function parseAction(tokens, line) {
  const cursor = new Cursor(tokens, line);
  const nameToken = cursor.expectIdent();
  const name = nameToken.value;

  if (!ACTIONS.includes(name)) {
    const suggestion = name === 'delete' ? ' (did you mean "hide"?)' : didYouMean(name, ACTIONS);
    throw new RuleError(`unknown action "${name}"${suggestion}`, line, nameToken.col);
  }

  cursor.expectPunct('(');

  if (name === 'set') {
    const pathToken = cursor.expectIdent();
    cursor.expectPunct(',');
    const value = parseLiteral(cursor);
    cursor.expectPunct(')');
    cursor.expectEnd();
    return { action: { kind: 'set', path: parsePath(pathToken, line), value }, col: nameToken.col };
  }

  cursor.expectPunct(')');
  cursor.expectEnd();
  return { action: { kind: name }, col: nameToken.col };
}

function parseClauses(tokens, line) {
  const segments = [];
  let current = [];
  let depth = 0;

  for (const token of tokens) {
    if (token.type === 'punct' && (token.value === '(' || token.value === '{')) depth += 1;
    if (token.type === 'punct' && (token.value === ')' || token.value === '}')) depth -= 1;
    if (depth < 0) throw new RuleError('unbalanced closing bracket', line, token.col);
    if (depth === 0 && token.type === 'punct' && token.value === ';') {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (depth !== 0) throw new RuleError('unclosed bracket', line, tokens[tokens.length - 1].col);
  if (current.length > 0) segments.push(current);

  const clauses = {};
  for (const segment of segments) {
    if (segment.length === 0) throw new RuleError('empty clause', line, 1);
    const [key, equals, ...rest] = segment;
    if (!key || key.type !== 'ident' || !CLAUSES.includes(key.value)) {
      throw new RuleError(
        `unknown clause ${JSON.stringify(key?.value ?? '')} (expected presets, entry, action)`,
        line,
        key?.col ?? 1,
      );
    }
    if (!equals || equals.type !== 'punct' || equals.value !== '=') {
      throw new RuleError(`clause "${key.value}" needs "="`, line, equals?.col ?? key.col);
    }
    if (clauses[key.value]) throw new RuleError(`duplicate clause "${key.value}"`, line, key.col);
    if (rest.length === 0) throw new RuleError(`clause "${key.value}" has no expression`, line, key.col);
    clauses[key.value] = { tokens: rest, col: key.col };
  }

  for (const required of CLAUSES) {
    if (!clauses[required]) {
      throw new RuleError(`missing clause "${required}" (all three are required)`, line, 1);
    }
  }

  return clauses;
}

/**
 * Parse a whole rules file.
 * @param {string} text
 * @returns {Array<{line:number, presets:object, entry:object, action:object, actionAt:{line:number,col:number}}>}
 * @throws {RuleError} on the first syntax error
 */
export function parseRules(text) {
  const rules = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const tokens = tokenize(lines[index], line);
    if (tokens.length === 0) continue;
    const clauses = parseClauses(tokens, line);
    const presetCursor = new Cursor(clauses.presets.tokens, line);
    const presets = parseSetExpr(presetCursor);
    presetCursor.expectEnd();
    const entryCursor = new Cursor(clauses.entry.tokens, line);
    const entry = parseSelectorExpr(entryCursor);
    entryCursor.expectEnd();
    const parsed = parseAction(clauses.action.tokens, line);
    rules.push({
      line,
      presets,
      entry,
      action: parsed.action,
      actionAt: { line, col: parsed.col },
    });
  }
  return rules;
}

/** Format a parse or evaluation error as `file:line:col: error: message`. */
export function formatError(error, file = 'preset-rules.rules') {
  if (error instanceof RuleError) {
    return `${file}:${error.line}:${error.col}: error: ${error.message}`;
  }
  return `${file}: error: ${error?.message ?? String(error)}`;
}
