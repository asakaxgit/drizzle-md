import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/index.js';

describe('parseMarkdown', () => {
  it('splits frontmatter and body', () => {
    expect(parseMarkdown('---\ntitle: Hi\ncount: 2\n---\n\nBody\n')).toEqual({
      ok: true,
      file: { data: { title: 'Hi', count: 2 }, body: 'Body\n' },
    });
  });

  it('treats a file without a fence as body only', () => {
    expect(parseMarkdown('# Just markdown\n')).toEqual({
      ok: true,
      file: { data: {}, body: '# Just markdown\n' },
    });
  });

  it('accepts a BOM, CRLF line endings, an empty block and a ... closing fence', () => {
    expect(parseMarkdown('\uFEFF---\r\na: 1\r\n...\r\nText')).toEqual({
      ok: true,
      file: { data: { a: 1 }, body: 'Text' },
    });
    expect(parseMarkdown('---\n---\nText')).toEqual({ ok: true, file: { data: {}, body: 'Text' } });
  });

  it('keeps dates as strings and resolves nested values and aliases', () => {
    const result = parseMarkdown(
      '---\nwhen: 2026-11-23\nbase: &b { x: 1 }\ncopy: *b\nlist: [1, "two", null, true]\nempty:\n---\n',
    );
    expect(result).toEqual({
      ok: true,
      file: {
        data: {
          when: '2026-11-23',
          base: { x: 1 },
          copy: { x: 1 },
          list: [1, 'two', null, true],
          empty: null,
        },
        body: '',
      },
    });
  });

  it('does not let a __proto__ key change the prototype', () => {
    const result = parseMarkdown('---\n__proto__: { polluted: true }\n---\n');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.file.data)).toBe(Object.prototype);
      expect(Object.hasOwn(result.file.data, '__proto__')).toBe(true);
    }
  });

  it.each([
    ['an unclosed block', '---\ntitle: x\n', 'never closed'],
    ['invalid YAML', '---\ntitle: [unclosed\n---\n', 'invalid YAML'],
    ['duplicate keys', '---\na: 1\na: 2\n---\n', 'invalid YAML'],
    ['a list instead of a mapping', '---\n- a\n- b\n---\n', 'must be a YAML mapping'],
    ['a complex key', '---\n? [a, b]\n: 1\n---\n', 'plain scalar keys'],
    ['a non-finite number', '---\nn: .inf\n---\n', 'non-finite'],
  ])('rejects %s', (_, source, message) => {
    const result = parseMarkdown(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(message);
    }
  });
});
