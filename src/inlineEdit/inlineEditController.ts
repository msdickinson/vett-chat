import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { resolveVettPath } from '../process/vettPath';
import { buildEditPayload, buildIteratePrefillText, type InlineEditPayload } from './inlineEditPrompt';

/**
 * Cmd+I "inline edit". User selects code,
 * hits the hotkey, types a one-line instruction, and gets a focused
 * rewrite proposed as a diff. Three actions: Apply / Cancel / Iterate.
 *
 * Architecture:
 *   - Editor selection (or current line if no selection) becomes the
 *     "rewrite this region" input.
 *   - Instruction comes from a `showInputBox` floated near the cursor.
 *   - vett's `edit` subcommand does a single LLM call (no agent loop,
 *     no tools) and writes the rewritten code to stdout.
 *   - The proposal is stashed in an in-memory `Map<uri, string>`,
 *     surfaced through a `vett-inline-edit:` content provider, and
 *     opened as a side-by-side diff against the user's actual file.
 *   - QuickPick after the diff lets the user Apply (WorkspaceEdit) /
 *     Cancel (cleanup) / Iterate (open chat with selection + instruction).
 *
 * Worktree note: inline edit deliberately operates against the user's
 * real file, NOT a chat panel's worktree. The hotkey lives in the
 * editor, the user expects the change to land where they're looking.
 */
export class InlineEditController {
  static readonly SCHEME = 'vett-inline-edit';

  private readonly proposals = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  private nextId = 1;
  private context: vscode.ExtensionContext | null = null;

  /** Register the proposal-content provider. Idempotent — call once at
   *  activation; the controller is itself a singleton. The context is
   *  retained so the spawn path can read SecretStorage at edit time
   *  (mirrors ChatPanelProvider.preloadCloudSecrets). */
  register(context: vscode.ExtensionContext): void {
    this.context = context;
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: this._onDidChange.event,
      provideTextDocumentContent: (uri) => this.proposals.get(uri.toString()) ?? '',
    };
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(InlineEditController.SCHEME, provider),
    );
    context.subscriptions.push(this._onDidChange);
  }

  /** Entry point — wired to the `vett-chat.inlineEdit` command. Uses
   *  the active editor's selection (or current-line fallback) and
   *  prompts the user for an instruction. */
  async run(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file and select some code to use Vett inline edit.');
      return;
    }

    // Selection rules: if there's a non-empty selection, use it. If the
    // cursor is on a line with no selection, fall back to the current
    // line — avoids a "select something
    // first" friction prompt.
    const selectionRange = resolveSelectionRange(editor);
    await this.runOnRange({
      uri: editor.document.uri,
      range: selectionRange,
      // No prefilled instruction — the input box prompts.
    });
  }

  /** Programmatic entry point used by the smart-actions surfaces
   *  (CodeLens "Edit with Vett", QuickFix "Fix with Vett") and any
   *  future caller that wants to drive an inline edit without going
   *  through the user's active selection. The flow is otherwise
   *  identical to {@link run}: validate selection, get instruction,
   *  call `vett edit`, render the diff, run the Accept / Cancel /
   *  Iterate picker.
   *
   *  Pass `prefilledInstruction` to skip the input box and run with
   *  a canned instruction (e.g. "Fix the following error: ...").
   *  Otherwise the input box opens with the supplied `inputBoxPrompt`
   *  if any. */
  async runOnRange(args: {
    uri: vscode.Uri;
    range: vscode.Range;
    prefilledInstruction?: string;
    inputBoxPrompt?: string;
    inputBoxTitle?: string;
  }): Promise<void> {
    const document = await vscode.workspace.openTextDocument(args.uri);
    const selectionText = document.getText(args.range);
    if (selectionText.trim().length === 0) {
      vscode.window.showInformationMessage('Vett inline edit needs a non-empty selection or a line with code.');
      return;
    }

    let instruction = args.prefilledInstruction?.trim();
    if (!instruction) {
      const typed = await vscode.window.showInputBox({
        title: args.inputBoxTitle ?? 'Vett: edit selection',
        prompt: args.inputBoxPrompt ?? 'Describe the change you want — e.g. "extract into a helper", "add error handling", "convert to async".',
        placeHolder: 'Edit instruction…',
        ignoreFocusOut: true,
        validateInput: (v) => (v && v.trim().length > 0 ? null : 'An instruction is required (Esc to cancel).'),
      });
      if (!typed) return;
      instruction = typed.trim();
    }

    const filePath = document.uri.fsPath;
    const language = document.languageId;
    const fileContent = document.getText();

    const extraEnv = await loadCloudSecretEnv(this.context);
    const payload = buildEditPayload({
      instruction,
      selection: selectionText,
      startLine0: args.range.start.line,
      endLine0: args.range.end.line,
      fileContent,
      language,
      filePath,
    });
    const rewritten = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Vett: rewriting selection…', cancellable: true },
      async (_progress, token) => callVettEdit(payload, token, extraEnv),
    );
    if (!rewritten) return; // Cancelled or errored — host already toasted the user.

    if (rewritten.trim() === selectionText.trim()) {
      vscode.window.showInformationMessage('Vett returned the selection unchanged. Try a more specific instruction.');
      return;
    }

    await this.presentProposal(document.uri, args.range, selectionText, rewritten, instruction, language);
  }

  /** Stash the proposal under a fresh URI, open a side-by-side diff,
   *  then run the Accept / Cancel / Iterate picker. */
  private async presentProposal(
    documentUri: vscode.Uri,
    range: vscode.Range,
    originalText: string,
    proposalText: string,
    instruction: string,
    language: string,
  ): Promise<void> {
    const id = this.nextId++;
    // Build a "filesystem-ish" path for the proposal URI so VS Code's
    // diff viewer can pick a sensible language id from the extension.
    // Real disk content lives in the proposals map; the URI is just a
    // handle.
    const baseName = vscode.workspace.asRelativePath(documentUri).replace(/[\\/]/g, '-') || 'inline-edit';
    const proposalUri = vscode.Uri.parse(`${InlineEditController.SCHEME}:/${encodeURIComponent(baseName)}.proposal-${id}?lang=${encodeURIComponent(language)}`);
    this.proposals.set(proposalUri.toString(), proposalText);
    // Fire change notification in case the URI is reused (it isn't, but
    // future-proof in case the id strategy changes).
    this._onDidChange.fire(proposalUri);

    // The diff: left = current file (the real source), right = proposal.
    // Convention matches the worktree review picker — "current → proposal".
    await vscode.commands.executeCommand(
      'vscode.diff',
      documentUri,
      proposalUri,
      `Vett inline edit: ${baseName} (proposed)`,
      { preview: true },
    );

    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(check) Apply', description: 'Replace the selection with the proposed code', value: 'apply' as const },
        { label: '$(discard) Cancel', description: 'Discard the proposal, leave the file unchanged', value: 'cancel' as const },
        { label: '$(comment-discussion) Iterate in chat', description: 'Open a chat panel pre-loaded with this selection + instruction for follow-up edits', value: 'iterate' as const },
      ],
      { placeHolder: 'Apply the inline edit?', ignoreFocusOut: true },
    );

    try {
      if (!choice || choice.value === 'cancel') {
        return;
      }
      if (choice.value === 'apply') {
        await applyProposal(documentUri, range, proposalText);
        return;
      }
      if (choice.value === 'iterate') {
        await iterateInChat(documentUri, range, originalText, proposalText, instruction);
        return;
      }
    } finally {
      // Clean up the proposal-URI mapping. Closing the diff editor is
      // best-effort — VS Code doesn't expose a clean "close this specific
      // tab" API; the user will close it manually if they want to.
      this.proposals.delete(proposalUri.toString());
    }
  }
}

/** Resolve the editor's editable range. Non-empty selection wins;
 *  otherwise expand the cursor's line to a full-line range. */
function resolveSelectionRange(editor: vscode.TextEditor): vscode.Range {
  if (!editor.selection.isEmpty) {
    return new vscode.Range(editor.selection.start, editor.selection.end);
  }
  const line = editor.document.lineAt(editor.selection.active.line);
  return line.range;
}

/** Apply the rewrite via WorkspaceEdit. Single replacement against the
 *  selected range. The resulting modification lands as an undoable edit
 *  in the user's normal undo stack — Ctrl+Z reverts cleanly. */
async function applyProposal(uri: vscode.Uri, range: vscode.Range, replacement: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, replacement);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage('Vett: failed to apply the inline edit. Your file is unchanged.');
  }
}

/** Iterate-in-chat: the user wants to keep tweaking the proposal
 *  conversationally. Uses the `prefillInput` primitive: opens a fresh
 *  chat panel via the `openInEditorWithPrefill` command and the
 *  textarea populates the moment the webview signals ready. No
 *  clipboard hop, no Ctrl+V, no toast asking the user to paste. */
async function iterateInChat(
  uri: vscode.Uri,
  range: vscode.Range,
  originalText: string,
  proposalText: string,
  instruction: string,
): Promise<void> {
  const followUp = buildIteratePrefillText({
    workspaceRelativePath: vscode.workspace.asRelativePath(uri),
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    instruction,
    originalText,
    proposalText,
  });
  await vscode.commands.executeCommand('vett-chat.openInEditorWithPrefill', followUp);
}

/** Read every cloud-provider key out of SecretStorage and return them
 *  as an env-var bag suitable for merging onto the spawn env. Mirrors
 *  ChatPanelProvider.preloadCloudSecrets — kept inline so this module
 *  doesn't reach across to the chat-panel code. process.env wins on
 *  merge so a shell-exported key still beats a stale stored one. */
async function loadCloudSecretEnv(context: vscode.ExtensionContext | null): Promise<Record<string, string>> {
  if (!context) return {};
  const out: Record<string, string> = {};
  const map: Array<[string, string]> = [
    ['vett-chat.openai_api_key', 'OPENAI_API_KEY'],
    ['vett-chat.anthropic_api_key', 'ANTHROPIC_API_KEY'],
    ['vett-chat.gemini_api_key', 'GEMINI_API_KEY'],
  ];
  for (const [secretKey, envName] of map) {
    try {
      const v = await context.secrets.get(secretKey);
      if (v) out[envName] = v;
    } catch { /* skip — best-effort */ }
  }
  return out;
}

/** Spawn `vett edit` and pipe the JSON request on stdin. Returns the
 *  rewritten text on success, or null if the user cancelled via the
 *  progress notification. Errors surface as toast + null return. */
async function callVettEdit(
  payload: InlineEditPayload,
  token: vscode.CancellationToken,
  extraEnv: Record<string, string>,
): Promise<string | null> {
  const config = vscode.workspace.getConfiguration('vett-chat');
  const configured = config.get<string>('vettPath', '');
  const resolved = resolveVettPath(configured);
  if (!resolved.path) {
    vscode.window.showErrorMessage(
      `VETT binary not found. Searched:\n  ${resolved.searched.join('\n  ')}\n\n` +
      'Set vett-chat.vettPath, or install vett.',
    );
    return null;
  }

  const profile = config.get<string>('profile', 'coding');
  const args = ['edit', '--profile', profile];

  return new Promise<string | null>((resolve) => {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(extraEnv)) {
      if (!mergedEnv[k]) mergedEnv[k] = v;
    }
    const proc = spawn(resolved.path!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let cancelled = false;
    let resolved_ = false;

    const finish = (value: string | null) => {
      if (resolved_) return;
      resolved_ = true;
      resolve(value);
    };

    proc.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

    proc.on('error', (err) => {
      vscode.window.showErrorMessage(`Vett: failed to spawn vett — ${err.message}`);
      finish(null);
    });

    proc.on('close', (code) => {
      if (cancelled) {
        finish(null);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const detail = stderr.trim() || `exit ${code}`;
        vscode.window.showErrorMessage(`Vett: inline edit failed — ${detail}`);
        finish(null);
        return;
      }
      if (stdout.length === 0) {
        vscode.window.showErrorMessage('Vett: inline edit produced an empty response.');
        finish(null);
        return;
      }
      finish(stdout);
    });

    token.onCancellationRequested(() => {
      cancelled = true;
      try { proc.kill(); } catch { /* already gone */ }
      finish(null);
    });

    // Send the request and close stdin so vett's ReadToEndAsync returns.
    try {
      proc.stdin?.write(JSON.stringify(payload));
      proc.stdin?.end();
    } catch (e) {
      vscode.window.showErrorMessage(`Vett: couldn't send request — ${(e as Error).message}`);
      finish(null);
    }
  });
}

