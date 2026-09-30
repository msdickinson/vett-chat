import { describe, it, expect } from 'vitest';
import {
  buildDocstringInstruction,
  buildExplainHandoff,
  buildFixInstruction,
  isLensWorthySymbolKind,
  isSmartActionScheme,
  LENS_WORTHY_SYMBOL_KINDS,
  symbolKindToDocstringKind,
  truncateForLensTitle,
} from '../src/smartActions/smartActionsHelpers';

/**
 * Pure-helper coverage for the smart-actions surfaces. The provider
 * module imports `vscode` so it can't load under vitest; the helpers
 * are deliberately split out so the format/decision contracts stay
 * pinned without a vscode shim.
 */
describe('smartActions helpers', () => {
  describe('truncateForLensTitle', () => {
    it('returns input unchanged when shorter than max', () => {
      expect(truncateForLensTitle('short', 20)).toBe('short');
    });

    it('collapses whitespace runs to a single space', () => {
      expect(truncateForLensTitle('a  b\n\nc\td', 80)).toBe('a b c d');
    });

    it('trims leading + trailing whitespace', () => {
      expect(truncateForLensTitle('  hello  ', 80)).toBe('hello');
    });

    it('truncates with an ellipsis when over max', () => {
      const out = truncateForLensTitle('this is a very long diagnostic message that goes on', 20);
      expect(out.length).toBeLessThanOrEqual(20);
      expect(out.endsWith('…')).toBe(true);
    });

    it('does not produce a trailing-space ellipsis when the cut lands on whitespace', () => {
      const out = truncateForLensTitle('foo bar baz qux', 8);
      expect(out).not.toMatch(/ …$/);
      expect(out.endsWith('…')).toBe(true);
    });

    it('uses default max of 80 when not specified', () => {
      const long = 'x'.repeat(120);
      const out = truncateForLensTitle(long);
      expect(out.length).toBeLessThanOrEqual(80);
    });
  });

  describe('buildFixInstruction', () => {
    it('formats a directive with severity + message', () => {
      const out = buildFixInstruction("Property 'foo' does not exist on type 'Bar'", 'error');
      expect(out).toContain("Fix the following error:");
      expect(out).toContain("Property 'foo' does not exist on type 'Bar'");
    });

    it('defaults severity to "error" when not specified', () => {
      const out = buildFixInstruction('something');
      expect(out).toContain('Fix the following error:');
    });

    it('uses the chosen severity label', () => {
      expect(buildFixInstruction('x', 'warning')).toContain('Fix the following warning:');
      expect(buildFixInstruction('x', 'info')).toContain('Fix the following info:');
      expect(buildFixInstruction('x', 'hint')).toContain('Fix the following hint:');
    });

    it('collapses internal whitespace in the diagnostic message', () => {
      const out = buildFixInstruction("multi\nline\n\nmessage  with  spaces");
      expect(out).toContain('multi line message with spaces');
      expect(out).not.toContain('\n');
    });

    it('starts with the verb so chat-tuned models land on action mode', () => {
      // Pinning the leading word — if a future refactor changes the
      // copy, the test forces an explicit decision rather than a
      // silent regression.
      expect(buildFixInstruction('x')).toMatch(/^Fix /);
    });
  });

  describe('buildDocstringInstruction', () => {
    it('mentions the symbol kind so the model knows what it is documenting', () => {
      expect(buildDocstringInstruction('function')).toContain('function');
      expect(buildDocstringInstruction('class')).toContain('class');
      expect(buildDocstringInstruction('method')).toContain('method');
      expect(buildDocstringInstruction('interface')).toContain('interface');
      expect(buildDocstringInstruction('constructor')).toContain('constructor');
    });

    it('asks the model not to change the implementation', () => {
      const out = buildDocstringInstruction('function');
      expect(out).toMatch(/implementation unchanged/i);
    });

    it('mentions multiple language idioms so polyglot files work', () => {
      const out = buildDocstringInstruction('function');
      expect(out).toContain('JSDoc');
      expect(out).toContain('XML');
      expect(out).toContain('"""');
    });
  });

  describe('isLensWorthySymbolKind', () => {
    it('accepts the canonical structural kinds (Class/Method/Constructor/Interface/Function)', () => {
      // Numbers correspond to vscode.SymbolKind:
      //   4=Class, 5=Method, 8=Constructor, 10=Interface, 11=Function
      expect(isLensWorthySymbolKind(4)).toBe(true);
      expect(isLensWorthySymbolKind(5)).toBe(true);
      expect(isLensWorthySymbolKind(8)).toBe(true);
      expect(isLensWorthySymbolKind(10)).toBe(true);
      expect(isLensWorthySymbolKind(11)).toBe(true);
    });

    it('rejects field / variable / property / namespace / enum kinds', () => {
      // 12=Variable, 6=Property, 7=Field, 2=Namespace, 9=Enum, 13=Constant — all should not get a lens.
      for (const kind of [12, 6, 7, 2, 9, 13]) {
        expect(isLensWorthySymbolKind(kind)).toBe(false);
      }
    });

    it('exposes the underlying set as a readable export', () => {
      expect(LENS_WORTHY_SYMBOL_KINDS.size).toBe(5);
    });
  });

  describe('symbolKindToDocstringKind', () => {
    it('maps the canonical lens-worthy kinds', () => {
      expect(symbolKindToDocstringKind(4)).toBe('class');
      expect(symbolKindToDocstringKind(5)).toBe('method');
      expect(symbolKindToDocstringKind(8)).toBe('constructor');
      expect(symbolKindToDocstringKind(10)).toBe('interface');
      expect(symbolKindToDocstringKind(11)).toBe('function');
    });

    it('falls back to "function" for unknown kinds', () => {
      expect(symbolKindToDocstringKind(0)).toBe('function');
      expect(symbolKindToDocstringKind(99)).toBe('function');
      expect(symbolKindToDocstringKind(-1)).toBe('function');
    });
  });

  describe('buildExplainHandoff', () => {
    it('includes file path, line range, language fence, and walk-through framing', () => {
      const text = buildExplainHandoff({
        workspaceRelativePath: 'src/utils/foo.ts',
        startLine: 10,
        endLine: 25,
        language: 'typescript',
        code: 'function foo() { return 42; }',
      });
      expect(text).toContain('`src/utils/foo.ts`');
      expect(text).toContain('lines 10-25');
      expect(text).toContain('```typescript');
      expect(text).toContain('function foo()');
      expect(text).toMatch(/Walk through what it does/);
    });

    it('omits the language tag when empty for plain-text handoff', () => {
      const text = buildExplainHandoff({
        workspaceRelativePath: 'a.txt',
        startLine: 1,
        endLine: 1,
        language: '',
        code: 'hello',
      });
      // Empty language → opening fence is just ``` without a tag.
      // Match that exactly so we don't accidentally write "```\n```".
      expect(text).toMatch(/```\nhello\n```/);
    });

    it('handles single-line spans', () => {
      const text = buildExplainHandoff({
        workspaceRelativePath: 'a.py',
        startLine: 5,
        endLine: 5,
        language: 'python',
        code: 'x = 1',
      });
      expect(text).toContain('lines 5-5');
    });
  });

  describe('isSmartActionScheme', () => {
    it('accepts file + remote workspace schemes', () => {
      expect(isSmartActionScheme('file')).toBe(true);
      expect(isSmartActionScheme('vscode-vfs')).toBe(true);
      expect(isSmartActionScheme('vscode-userdata')).toBe(true);
    });

    it('rejects vett virtual schemes (proposal docs, empty diff sides)', () => {
      expect(isSmartActionScheme('vett-inline-edit')).toBe(false);
      expect(isSmartActionScheme('vett-empty')).toBe(false);
    });

    it('rejects untitled / output / git diff schemes', () => {
      expect(isSmartActionScheme('untitled')).toBe(false);
      expect(isSmartActionScheme('output')).toBe(false);
      expect(isSmartActionScheme('git')).toBe(false);
    });
  });
});
