/**
 * Pure helpers for the smart-actions surfaces (CodeLens, QuickFix).
 * Lives separately from the provider module so vitest can cover the
 * format/decision logic without a vscode mock.
 */

/**
 * Truncate a label string for use in a CodeLens / CodeAction title.
 * VS Code renders long titles awkwardly (no wrapping in lens; ellipsis
 * in code-action menus). We cap at a reasonable visual width and add
 * an ellipsis when we cut. Trims whitespace + collapses inner runs of
 * whitespace so multi-line diagnostic messages render on one line.
 */
export function truncateForLensTitle(text: string, max = 80): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Build the prefilled instruction for "Fix with Vett" — the QuickFix
 * action that surfaces on every diagnostic. The instruction is sent
 * verbatim to `vett edit`'s system-prompted "rewrite this selection"
 * loop, so it has to read like a directive, not a question.
 *
 * We include the diagnostic message but not the source / code (the
 * VS Code DiagnosticSeverity / source identifiers add noise that the
 * model usually doesn't need — TS-server-named codes like "TS2304"
 * mean nothing without a dictionary lookup). The model gets the line
 * range + surrounding file via the standard inline-edit envelope, so
 * "Fix the following error/warning" is enough framing.
 */
export function buildFixInstruction(message: string, severityLabel: 'error' | 'warning' | 'info' | 'hint' = 'error'): string {
  const cleaned = message.replace(/\s+/g, ' ').trim();
  // Verb at the front so the model lands on action mode immediately.
  // Capital letter + period at the end so the directive parses as a
  // complete sentence — small, but it nudges the model away from
  // chat-tuned "Sure! Here's how I'd fix it…" preambles.
  return `Fix the following ${severityLabel}: ${cleaned}`;
}

/**
 * Build the prefilled instruction for "Generate docstring" — for
 * functions / methods / classes that don't yet have a doc comment.
 * Used by the `📝 Document` CodeLens (alongside `✨ Edit` and `ℹ Explain`).
 */
export function buildDocstringInstruction(symbolKind: 'function' | 'method' | 'class' | 'interface' | 'constructor'): string {
  return (
    `Add a comprehensive doc comment for this ${symbolKind} using the language's idiomatic ` +
    `documentation style (JSDoc for TS/JS, /// XML doc for C#, """ for Python, /// for Rust, etc). ` +
    `Describe what it does, its parameters, and what it returns. Keep the existing implementation ` +
    `unchanged — only add the doc comment immediately above the declaration.`
  );
}

/**
 * Symbol kinds (as VS Code's numeric SymbolKind enum) that we want
 * code lenses on. Top-level constructs only — variables, properties,
 * fields, etc don't get a lens because they're rarely worth a
 * "rewrite this" lens (and the visual noise would be high).
 *
 * Numbers match `vscode.SymbolKind` so callers can pass kind values
 * straight through without an enum import (lets this file stay
 * vscode-import-free for vitest).
 *
 * VS Code SymbolKind reference (the values we accept):
 *   4  = Class
 *   5  = Method
 *   8  = Constructor
 *   10 = Interface
 *   11 = Function
 */
export const LENS_WORTHY_SYMBOL_KINDS: ReadonlySet<number> = new Set([4, 5, 8, 10, 11]);

/** True if a symbol kind (numeric) should get an "Edit with Vett" lens. */
export function isLensWorthySymbolKind(kind: number): boolean {
  return LENS_WORTHY_SYMBOL_KINDS.has(kind);
}

/**
 * URI schemes the smart-actions providers should run for. Skip vett's
 * own virtual schemes (proposal docs, diff right-pane content), output
 * channels, settings JSON synthesis, etc — running symbol providers
 * against those wastes cycles and may produce nonsense.
 */
export const SMART_ACTION_SCHEMES: ReadonlySet<string> = new Set(['file', 'vscode-vfs', 'vscode-userdata']);

export function isSmartActionScheme(scheme: string): boolean {
  return SMART_ACTION_SCHEMES.has(scheme);
}

/**
 * Map a numeric `vscode.SymbolKind` to the docstring-instruction tag.
 * Pure / vscode-import-free for vitest. Numeric mappings:
 *   4  = Class      → "class"
 *   5  = Method     → "method"
 *   8  = Constructor → "constructor"
 *   10 = Interface  → "interface"
 *   11 = Function   → "function"
 * Anything else falls back to "function" — every lens-worthy kind has
 * a more specific mapping, so the fallback is just defensive.
 */
export function symbolKindToDocstringKind(kind: number): 'function' | 'method' | 'class' | 'interface' | 'constructor' {
  switch (kind) {
    case 4: return 'class';
    case 5: return 'method';
    case 8: return 'constructor';
    case 10: return 'interface';
    case 11: return 'function';
    default: return 'function';
  }
}

/**
 * Build the chat-handoff text for the "Explain with Vett" code lens.
 * Sent to a fresh chat panel via the prefillInput primitive (#7
 * close-out) so the user sees a populated prompt the moment the panel
 * opens. Format pinned by tests so future copy changes are deliberate.
 */
export function buildExplainHandoff(args: {
  workspaceRelativePath: string;
  startLine: number;
  endLine: number;
  language: string;
  code: string;
}): string {
  const lines = `${args.startLine}-${args.endLine}`;
  const fenceLang = args.language || '';
  return (
    `Explain the following code from \`${args.workspaceRelativePath}\` (lines ${lines}):\n\n` +
    `\`\`\`${fenceLang}\n${args.code}\n\`\`\`\n\n` +
    `Walk through what it does, what each significant line contributes, ` +
    `and any non-obvious gotchas a maintainer should know about.`
  );
}
