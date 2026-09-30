/**
 * Pure helpers for inline-edit text construction. Kept separate from
 * inlineEditController.ts (which imports `vscode`) so vitest can cover
 * the prompt-format contract without a VS Code mock.
 */

/** Build the prefill text used when the user picks "Iterate in chat"
 *  after an inline edit. Sent verbatim to a fresh chat panel via the
 *  `prefillInput` primitive — no clipboard hop. Format is deliberately
 *  verbose so the agent has every piece of context: the file, the line
 *  span, the original instruction, the original code, and the proposal
 *  it's about to refine.
 *
 *  Markdown fences are used inside the prompt body — the chat renders
 *  them, and the agent can read them back as code blocks. */
export function buildIteratePrefillText(args: {
  workspaceRelativePath: string;
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
  instruction: string;
  originalText: string;
  proposalText: string;
}): string {
  const lines = `${args.startLine}-${args.endLine}`;
  return (
    `Iterating on an inline edit for \`${args.workspaceRelativePath}\` (lines ${lines}).\n\n` +
    `Original instruction: ${args.instruction}\n\n` +
    `Original selection:\n\`\`\`\n${args.originalText}\n\`\`\`\n\n` +
    `Proposed rewrite:\n\`\`\`\n${args.proposalText}\n\`\`\`\n\n` +
    `Refine the proposal: `
  );
}

/** Build the JSON payload sent on stdin to `vett edit`. Snake_case
 *  keys match the C# `EditCommand.ParseRequest` contract. Returning a
 *  plain object (not a JSON string) so tests can assert structure
 *  without re-parsing. */
export interface InlineEditPayload {
  instruction: string;
  selection: string;
  selection_start_line: number; // 1-based, inclusive
  selection_end_line: number;   // 1-based, inclusive
  file_content: string;
  language: string;
  file_path: string;
}

export function buildEditPayload(args: {
  instruction: string;
  selection: string;
  startLine0: number; // 0-based (VS Code convention)
  endLine0: number;   // 0-based (VS Code convention)
  fileContent: string;
  language: string;
  filePath: string;
}): InlineEditPayload {
  return {
    instruction: args.instruction.trim(),
    selection: args.selection,
    // C# / human-facing line numbers are 1-based; VS Code is 0-based.
    // Translate at the boundary so the model sees what the user sees.
    selection_start_line: args.startLine0 + 1,
    selection_end_line: args.endLine0 + 1,
    file_content: args.fileContent,
    language: args.language,
    file_path: args.filePath,
  };
}
