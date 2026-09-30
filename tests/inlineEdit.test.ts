import { describe, it, expect } from 'vitest';
import { buildEditPayload, buildIteratePrefillText } from '../src/inlineEdit/inlineEditPrompt';

/**
 * Pure-helper coverage for the inline-edit module. The controller
 * itself imports `vscode` and orchestrates the editor surface; the
 * helpers in inlineEditPrompt.ts are deliberately split out so this
 * test file doesn't need a vscode shim.
 *
 * The C# `vett edit` subcommand has its own xunit suite for prompt
 * construction and code-block extraction (EditCommandTests.cs in the
 * VETT repo). Together the two cover both ends of the wire
 * — TS produces the JSON, C# parses it.
 */
describe('inlineEditPrompt', () => {
  describe('buildEditPayload', () => {
    it('translates 0-based line numbers to 1-based for the wire format', () => {
      const p = buildEditPayload({
        instruction: 'extract',
        selection: 'foo()',
        startLine0: 9,  // line 10 in human terms
        endLine0: 14,   // line 15 in human terms
        fileContent: 'whole file',
        language: 'typescript',
        filePath: 'src/foo.ts',
      });
      expect(p.selection_start_line).toBe(10);
      expect(p.selection_end_line).toBe(15);
    });

    it('trims surrounding whitespace from the instruction but preserves selection bytes', () => {
      const p = buildEditPayload({
        instruction: '   add error handling   \n',
        selection: '  foo()  \n',  // leading whitespace = real indent the user has
        startLine0: 0,
        endLine0: 0,
        fileContent: '',
        language: '',
        filePath: '',
      });
      expect(p.instruction).toBe('add error handling');
      expect(p.selection).toBe('  foo()  \n');
    });

    it('passes language + path + file content through unchanged', () => {
      const p = buildEditPayload({
        instruction: 'x',
        selection: 'y',
        startLine0: 0,
        endLine0: 0,
        fileContent: 'line 1\nline 2\n',
        language: 'rust',
        filePath: 'src/main.rs',
      });
      expect(p.language).toBe('rust');
      expect(p.file_path).toBe('src/main.rs');
      expect(p.file_content).toBe('line 1\nline 2\n');
    });

    it('uses snake_case keys to match the C# parser contract', () => {
      const p = buildEditPayload({
        instruction: 'x', selection: 'y',
        startLine0: 0, endLine0: 0,
        fileContent: '', language: '', filePath: '',
      });
      // Spot-check the exact key names — the C# parser tries
      // snake_case first, so getting these wrong silently sends
      // missing fields.
      expect(p).toHaveProperty('selection_start_line');
      expect(p).toHaveProperty('selection_end_line');
      expect(p).toHaveProperty('file_content');
      expect(p).toHaveProperty('file_path');
    });
  });

  describe('buildIteratePrefillText', () => {
    it('includes file path, line range, instruction, original, and proposal blocks', () => {
      const text = buildIteratePrefillText({
        workspaceRelativePath: 'src/foo.ts',
        startLine: 10,
        endLine: 15,
        instruction: 'extract into a function',
        originalText: 'const x = 1;\nconst y = 2;',
        proposalText: 'function makeXY() { return [1, 2]; }',
      });

      expect(text).toContain('`src/foo.ts`');
      expect(text).toContain('lines 10-15');
      expect(text).toContain('Original instruction: extract into a function');
      expect(text).toContain('const x = 1;');
      expect(text).toContain('function makeXY()');
      // Three fenced blocks: original + proposal + the one we wrap each in.
      // We only emit two ``` pairs — count them.
      const fences = (text.match(/```/g) || []).length;
      expect(fences).toBe(4); // open + close × 2 pairs
    });

    it('ends with a "Refine the proposal:" suffix so the user pastes and continues typing', () => {
      const text = buildIteratePrefillText({
        workspaceRelativePath: 'a.ts',
        startLine: 1, endLine: 1,
        instruction: 'x',
        originalText: 'a', proposalText: 'b',
      });
      expect(text).toMatch(/Refine the proposal: $/);
    });

    it('handles single-line selections', () => {
      const text = buildIteratePrefillText({
        workspaceRelativePath: 'x.py',
        startLine: 42, endLine: 42,
        instruction: 'rename',
        originalText: 'def foo():', proposalText: 'def bar():',
      });
      expect(text).toContain('lines 42-42');
    });

    it('preserves backticks inside the original/proposal text (the wrapping fences are open-ended)', () => {
      // Edge case worth flagging — markdown gets wonky if the original
      // contains its own ``` block. The test pins current v1 behavior:
      // we naively wrap in fences. v2 might switch to indented blocks
      // if a user runs into rendering issues.
      const text = buildIteratePrefillText({
        workspaceRelativePath: 'a.md',
        startLine: 1, endLine: 1,
        instruction: 'x',
        originalText: '```\nnested\n```',
        proposalText: 'plain',
      });
      expect(text).toContain('```\nnested\n```');
    });
  });
});
