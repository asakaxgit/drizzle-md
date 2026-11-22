import {
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  parseDocument,
} from 'yaml';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';

export interface MarkdownFile {
  readonly data: JsonObject;
  readonly body: string;
}

export type ParseResult =
  | { readonly ok: true; readonly file: MarkdownFile }
  | { readonly ok: false; readonly message: string };

const OPEN_FENCE = /^---[ \t]*\r?\n/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;
const LEADING_LINE_BREAKS = /^(?:\r?\n)+/;

const toJson = (node: Node, doc: Document): JsonValue => {
  if (isAlias(node)) {
    const target = node.resolve(doc);
    if (target === undefined) {
      throw new Error(`unresolved alias *${node.source}`);
    }
    return toJson(target, doc);
  }
  if (isScalar(node)) {
    const { value } = node;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`non-finite number ${String(value)} is not supported`);
      }
      return value;
    }
    throw new Error(`unsupported YAML scalar ${String(value)}`);
  }
  if (isSeq(node)) {
    return node.items.map((item) => (isNode(item) ? toJson(item, doc) : null));
  }
  if (isMap(node)) {
    const entries = node.items.map((pair): readonly [string, JsonValue] => {
      if (!isScalar(pair.key)) {
        throw new Error('only plain scalar keys are supported in frontmatter');
      }
      const key = String(pair.key.value);
      return [key, isNode(pair.value) ? toJson(pair.value, doc) : null];
    });
    // Object.fromEntries defines own properties, so a "__proto__" key cannot change the prototype.
    return Object.fromEntries(entries);
  }
  throw new Error('unsupported YAML node');
};

/** Parses a YAML document into JSON-like values. Dates stay strings (YAML 1.2 core schema). */
export const parseYaml = (source: string): JsonValue => {
  const doc = parseDocument(source, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  const [error] = doc.errors;
  if (error !== undefined) {
    throw new Error(error.message);
  }
  return doc.contents === null ? null : toJson(doc.contents, doc);
};

/**
 * Splits a markdown file into its YAML frontmatter and body. A file without a leading `---` fence
 * has no frontmatter and its whole content is the body.
 */
export const parseMarkdown = (source: string): ParseResult => {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const open = OPEN_FENCE.exec(text);
  if (open === null) {
    return { ok: true, file: { data: {}, body: text } };
  }
  const rest = text.slice(open[0].length);
  const close = CLOSE_FENCE.exec(rest);
  if (close === null) {
    return { ok: false, message: 'frontmatter opened with --- but never closed' };
  }
  const yamlSource = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length).replace(LEADING_LINE_BREAKS, '');
  let data: JsonValue;
  try {
    data = parseYaml(yamlSource);
  } catch (error) {
    return {
      ok: false,
      message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (data === null) {
    return { ok: true, file: { data: {}, body } };
  }
  if (!isJsonObject(data)) {
    return { ok: false, message: 'frontmatter must be a YAML mapping' };
  }
  return { ok: true, file: { data, body } };
};
