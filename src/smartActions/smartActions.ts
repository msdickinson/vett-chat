import * as vscode from 'vscode';
import { InlineEditController } from '../inlineEdit/inlineEditController';
import {
  buildDocstringInstruction,
  buildFixInstruction,
  buildExplainHandoff,
  isLensWorthySymbolKind,
  isSmartActionScheme,
  symbolKindToDocstringKind,
  truncateForLensTitle,
} from './smartActionsHelpers';

/**
 * Smart actions: CodeLens "✨ Edit with Vett" above functions / methods
 * / classes, and a CodeAction QuickFix "Fix with Vett: <diagnostic>"
 * on every diagnostic. Both surfaces ride on the existing `vett edit`
 * subcommand via {@link InlineEditController.runOnRange} — so they
 * inherit the same Diff → Apply / Cancel / Iterate flow as Cmd+I.
 *
 * Both providers are gated by the `vett-chat.smartActionsEnabled`
 * setting (default true). Toggling the setting refreshes the lenses
 * live; the QuickFix provider just stops returning actions.
 */

export class SmartActionsCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor() {
    // Refresh when the gating setting flips so users don't have to
    // reload the window after disabling lenses.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vett-chat.smartActionsEnabled')) {
        this._onDidChange.fire();
      }
    });
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (!isEnabled()) return [];
    if (!isSmartActionScheme(document.uri.scheme)) return [];

    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
    } catch {
      // Some language servers throw when asked too early. Silent skip
      // is correct — VS Code will retry later when the server warms up.
      return [];
    }
    if (token.isCancellationRequested) return [];
    if (!symbols || symbols.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    const visit = (syms: vscode.DocumentSymbol[]): void => {
      for (const sym of syms) {
        if (isLensWorthySymbolKind(sym.kind)) {
          // selectionRange points at the identifier; .range covers the
          // whole body. We anchor the lens at selectionRange so it
          // floats just above the symbol name (where users look),
          // but pass `.range` to the command so the rewrite covers
          // the full body.
          lenses.push(
            new vscode.CodeLens(sym.selectionRange, {
              title: '$(sparkle) Edit with Vett',
              tooltip: 'Open Vett inline-edit on this symbol',
              command: 'vett-chat.editSymbol',
              arguments: [document.uri, sym.range],
            }),
            // Generate-docstring lens fires `vett-chat.documentSymbol`
            // which prefills "Add a comprehensive doc comment for this
            // <kind>…" instead of opening the input box. The user gets
            // the standard Diff / Apply / Cancel / Iterate flow, but
            // doesn't have to type "add docs."
            new vscode.CodeLens(sym.selectionRange, {
              title: '$(comment) Document',
              tooltip: 'Generate a doc comment for this symbol with Vett',
              command: 'vett-chat.documentSymbol',
              arguments: [document.uri, sym.range, sym.kind],
            }),
            // Explain-symbol lens hands off to a fresh chat panel via
            // the prefillInput primitive — different shape than Edit
            // / Document because the answer is conversational, not a
            // code rewrite.
            new vscode.CodeLens(sym.selectionRange, {
              title: '$(info) Explain',
              tooltip: 'Open a chat with this symbol pre-loaded so Vett can walk through it',
              command: 'vett-chat.explainSymbol',
              arguments: [document.uri, sym.range],
            }),
          );
        }
        if (sym.children?.length) visit(sym.children);
      }
    };
    visit(symbols);
    return lenses;
  }
}

export class SmartActionsQuickFixProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!isEnabled()) return [];
    if (!isSmartActionScheme(document.uri.scheme)) return [];
    if (context.diagnostics.length === 0) return [];

    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      const title = `$(sparkle) Fix with Vett: ${truncateForLensTitle(diag.message, 60)}`;
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.command = {
        title: 'Fix with Vett',
        command: 'vett-chat.fixWithVett',
        arguments: [document.uri, diag.range, diag.message, diag.severity],
      };
      // isPreferred = true would auto-elevate this action over native
      // language-server fixes, which isn't right — TS Server's
      // automated fixes are usually faster + more predictable than
      // an LLM call. Leave isPreferred unset so the user picks.
      actions.push(action);
    }
    return actions;
  }
}

/** Map VS Code's numeric DiagnosticSeverity to a human-readable label
 *  for the prefilled instruction. */
function severityLabel(sev?: number): 'error' | 'warning' | 'info' | 'hint' {
  // vscode.DiagnosticSeverity: 0 = Error, 1 = Warning, 2 = Information, 3 = Hint
  switch (sev) {
    case 0: return 'error';
    case 1: return 'warning';
    case 2: return 'info';
    case 3: return 'hint';
    default: return 'error';
  }
}

/** Read the gating setting. Pulled into a helper so the providers
 *  share the exact same default + key. */
function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('vett-chat').get<boolean>('smartActionsEnabled', true);
}

/** Wire up both providers + the two backing commands they invoke.
 *  Called once at activation. */
export function registerSmartActions(
  context: vscode.ExtensionContext,
  controller: InlineEditController,
): void {
  // Universal language registration via the catch-all selector. The
  // providers gate themselves on URI scheme + symbol availability —
  // running on plain-text files just yields zero lenses, no harm.
  const selector: vscode.DocumentSelector = { scheme: 'file' };
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(selector, new SmartActionsCodeLensProvider()),
    vscode.languages.registerCodeActionsProvider(selector, new SmartActionsQuickFixProvider(), {
      providedCodeActionKinds: SmartActionsQuickFixProvider.providedCodeActionKinds,
    }),
  );

  // CodeLens-invoked: "Edit with Vett" — opens the standard input box
  // (no prefilled instruction) but with the symbol's full body range
  // pre-selected, so the user types only the rewrite directive.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vett-chat.editSymbol',
      async (uri: vscode.Uri, range: vscode.Range) => {
        if (!uri || !range) return;
        await controller.runOnRange({ uri, range: rehydrateRange(range) });
      },
    ),
  );

  // QuickFix-invoked: "Fix with Vett" — runs with a prefilled "Fix the
  // following <severity>: <message>" instruction. Range expands to
  // full lines so the model sees complete syntax even if the
  // diagnostic's range is character-precise (e.g. underlining a
  // single token).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vett-chat.fixWithVett',
      async (uri: vscode.Uri, diagRange: vscode.Range, message: string, severity?: number) => {
        if (!uri || !diagRange || !message) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        const dr = rehydrateRange(diagRange);
        // Defensive clamp: a diagnostic with start.line past EOF would
        // throw on Position construction. Real diagnostics rarely
        // trigger this but pinning the bound costs nothing.
        const lastLine = Math.max(0, doc.lineCount - 1);
        const expanded = new vscode.Range(
          new vscode.Position(Math.min(dr.start.line, lastLine), 0),
          doc.lineAt(Math.min(dr.end.line, lastLine)).range.end,
        );
        const instruction = buildFixInstruction(message, severityLabel(severity));
        await controller.runOnRange({
          uri,
          range: expanded,
          prefilledInstruction: instruction,
        });
      },
    ),
  );

  // CodeLens-invoked: "Document" — runs with a prefilled "Add a
  // comprehensive doc comment for this <symbolKind>…" instruction.
  // Same Diff / Apply / Cancel / Iterate flow as Edit with Vett, but
  // skips the input box.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vett-chat.documentSymbol',
      async (uri: vscode.Uri, range: vscode.Range, symbolKind?: number) => {
        if (!uri || !range) return;
        const r = rehydrateRange(range);
        const docKind = symbolKindToDocstringKind(typeof symbolKind === 'number' ? symbolKind : 11);
        await controller.runOnRange({
          uri,
          range: r,
          prefilledInstruction: buildDocstringInstruction(docKind),
        });
      },
    ),
  );

  // CodeLens-invoked: "Explain" — different from Edit / Document. The
  // answer is conversational, not a code rewrite, so we hand off to a
  // fresh chat panel via the prefillInput primitive (#7) instead of
  // running through `vett edit`. The user gets the symbol's code
  // pre-loaded in the chat input + a "explain this" framing.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vett-chat.explainSymbol',
      async (uri: vscode.Uri, range: vscode.Range) => {
        if (!uri || !range) return;
        const r = rehydrateRange(range);
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText(r);
        if (text.trim().length === 0) return;
        const handoff = buildExplainHandoff({
          workspaceRelativePath: vscode.workspace.asRelativePath(uri),
          startLine: r.start.line + 1,
          endLine: r.end.line + 1,
          language: doc.languageId,
          code: text,
        });
        await vscode.commands.executeCommand('vett-chat.openInEditorWithPrefill', handoff);
      },
    ),
  );
}

/** Defensively re-hydrate a Range that came across a command boundary
 *  as a plain object. `range instanceof vscode.Range` is true when
 *  invoked from a CodeLens (VS Code preserves the instance), but
 *  could be a plain shape if invoked programmatically. */
function rehydrateRange(range: vscode.Range): vscode.Range {
  if (range instanceof vscode.Range) return range;
  const r = range as { start: { line: number; character: number }; end: { line: number; character: number } };
  return new vscode.Range(
    new vscode.Position(r.start.line, r.start.character),
    new vscode.Position(r.end.line, r.end.character),
  );
}
