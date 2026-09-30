import vscode from '../vscode';
import {
  messageText,
  messages,
  currentProfile,
  totalInputTokens,
  totalOutputTokens,
  currentIteration,
  toolCalls,
  cwd,
  profile as profileSignal,
  sessionLogPath,
  totalCostUsd,
  addUserMessage,
  chatMode,
} from '../state/signals';
import { formatCost, getPricing, isLikelyLocalModel } from '../utils/pricing';

export interface SlashCommand {
  name: string;
  description: string;
  /** When true, the command takes free-text args after the command name. */
  takesArgs?: boolean;
  /** Run the command. Either fires a host message, mutates local state,
   * or both. Should always clear the input after running. */
  run: (args: string) => void;
}

/**
 * The full list of slash commands. Designed so adding one is touching
 * one array; everything else (menu rendering, dispatch, autocomplete)
 * derives from this.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/new',
    description: 'Start a fresh chat in a new editor tab',
    run: () => {
      vscode.postMessage({ type: 'slashCommand', data: { command: 'new' } });
      messageText.value = '';
    },
  },
  {
    name: '/clear',
    description: 'Clear this panel’s chat history (keeps the subprocess alive)',
    run: () => {
      vscode.postMessage({ type: 'slashCommand', data: { command: 'clear' } });
      messageText.value = '';
    },
  },
  {
    name: '/profile',
    description: 'Pick a different vett profile',
    run: () => {
      vscode.postMessage({ type: 'pickProfile' });
      messageText.value = '';
    },
  },
  {
    name: '/init',
    description: 'Create a starter VETT.md at the workspace root (project rules vett auto-loads)',
    run: () => {
      vscode.postMessage({ type: 'slashCommand', data: { command: 'init' } });
      messageText.value = '';
    },
  },
  {
    name: '/model',
    description: 'Show the active model and endpoint',
    run: () => {
      const cur = currentProfile.value;
      const text = cur
        ? `Active profile: ${cur.name}\n  model:    ${cur.model || '—'}\n  endpoint: ${cur.endpoint || '(provider default)'}\n  provider: ${cur.provider}`
        : 'No profile resolved yet.';
      messages.value = [
        ...messages.value,
        { role: 'assistant', text, timestamp: new Date().toISOString() },
      ];
      messageText.value = '';
    },
  },
  {
    name: '/compact',
    description: 'Compact the conversation history (force a checkpoint)',
    run: () => {
      vscode.postMessage({ type: 'slashCommand', data: { command: 'compact' } });
      messageText.value = '';
    },
  },
  {
    name: '/stats',
    description: 'Show session statistics inline',
    run: () => {
      const cur = currentProfile.value;
      const tin = totalInputTokens.value;
      const tout = totalOutputTokens.value;
      const iter = currentIteration.value?.iteration ?? 0;
      const calls = toolCalls.value.length;
      const succ = toolCalls.value.filter((tc) => tc.success === true).length;
      const fail = toolCalls.value.filter((tc) => tc.success === false).length;
      const lines = [
        `Profile:  ${profileSignal.value}`,
        `Model:    ${cur?.model || '—'}`,
        `Endpoint: ${cur?.endpoint || '(provider default)'}`,
        `Provider: ${cur?.provider || '—'}`,
        `Cwd:      ${cwd.value || '—'}`,
        '',
        `Iterations:  ${iter}`,
        `Tokens:      ${tin.toLocaleString()} in / ${tout.toLocaleString()} out  (${(tin + tout).toLocaleString()} total)`,
        `Tool calls:  ${calls}  (${succ} ok, ${fail} failed)`,
        sessionLogPath.value ? `Log:         ${sessionLogPath.value}` : '',
      ].filter(Boolean).join('\n');
      messages.value = [
        ...messages.value,
        { role: 'assistant', text: lines, timestamp: new Date().toISOString() },
      ];
      messageText.value = '';
    },
  },
  {
    name: '/plan',
    description: 'Switch to plan mode (read-only — propose a plan, no state changes)',
    run: () => {
      if (chatMode.value === 'plan') {
        messages.value = [
          ...messages.value,
          { role: 'assistant', text: 'Already in plan mode.', timestamp: new Date().toISOString() },
        ];
      } else {
        // Optimistic local flip + tell host to respawn vett with --mode plan.
        // The header's Plan/Exec toggle reflects the change immediately.
        chatMode.value = 'plan';
        vscode.postMessage({ type: 'setChatMode', data: { mode: 'plan' } });
        messages.value = [
          ...messages.value,
          {
            role: 'assistant',
            text: '[Switched to PLAN mode — restarting agent. Vett will produce a markdown plan instead of modifying state. Toggle back via /execute or the header switch.]',
            timestamp: new Date().toISOString(),
          },
        ];
      }
      messageText.value = '';
    },
  },
  {
    name: '/execute',
    description: 'Switch to execute mode (default — full tool access)',
    run: () => {
      if (chatMode.value === 'execute') {
        messages.value = [
          ...messages.value,
          { role: 'assistant', text: 'Already in execute mode.', timestamp: new Date().toISOString() },
        ];
      } else {
        chatMode.value = 'execute';
        vscode.postMessage({ type: 'setChatMode', data: { mode: 'execute' } });
        messages.value = [
          ...messages.value,
          {
            role: 'assistant',
            text: '[Switched to EXECUTE mode — restarting agent with full tool access.]',
            timestamp: new Date().toISOString(),
          },
        ];
      }
      messageText.value = '';
    },
  },
  {
    name: '/cost',
    description: 'Show session token + dollar cost breakdown',
    run: () => {
      const cur = currentProfile.value;
      const tin = totalInputTokens.value;
      const tout = totalOutputTokens.value;
      const cost = totalCostUsd.value;
      const pricing = getPricing(cur?.model);
      const isLocal = isLikelyLocalModel(cur?.model);
      const lines = [
        `Model:    ${cur?.model || '—'}`,
        `Provider: ${cur?.provider || '—'}`,
        '',
        `Tokens:   ${tin.toLocaleString()} in / ${tout.toLocaleString()} out  (${(tin + tout).toLocaleString()} total)`,
        pricing
          ? `Pricing:  $${pricing.inputPer1M.toFixed(2)} / 1M in · $${pricing.outputPer1M.toFixed(2)} / 1M out`
          : isLocal
            ? `Pricing:  $0 (self-hosted)`
            : `Pricing:  unknown — model not in table`,
        `Cost:     ${pricing ? formatCost(cost) : isLocal ? '$0.00' : '—'}`,
      ].join('\n');
      messages.value = [
        ...messages.value,
        { role: 'assistant', text: lines, timestamp: new Date().toISOString() },
      ];
      messageText.value = '';
    },
  },

  // ---- Templated-prompt commands -----------------------------------
  // These five (/commit, /explain, /fix, /review, /tests) build a
  // prompt and send it as a regular user message so the agent picks it
  // up the same way it would a typed prompt. The prompts are tuned
  // toward "do the thing" rather than "describe how I would" so they
  // produce action, not lecture.

  {
    name: '/commit',
    description: 'Generate a commit message and run git commit on staged changes',
    run: () => {
      sendTemplated(
        `Generate a concise, conventional-commit-style message for the currently staged changes.\n` +
        `Steps:\n` +
        `1. Run \`git status --short\` to see what's staged.\n` +
        `2. Run \`git diff --staged\` to see the actual changes.\n` +
        `3. Draft a commit message: short title (≤72 chars), then a body paragraph if needed.\n` +
        `4. Run \`git commit -m\` with the message you drafted.\n` +
        `If nothing is staged, tell me — don't stage files yourself.`,
      );
    },
  },
  {
    name: '/explain',
    description: 'Explain code or a concept (pass selection or text after the command)',
    takesArgs: true,
    run: (args) => {
      const subject = args.trim();
      if (!subject) {
        // No selection plumbing yet (#9 in roadmap), so without args
        // we ask the user to provide one rather than guessing.
        messages.value = [
          ...messages.value,
          {
            role: 'assistant',
            text: `Usage: /explain <code or concept>\n\nExample:\n  /explain async iterators in TypeScript\n\n(Auto-pick of editor selection coming with the @-mention work.)`,
            timestamp: new Date().toISOString(),
          },
        ];
        messageText.value = '';
        return;
      }
      sendTemplated(
        `Explain the following clearly. Cover what it does, when you'd use it, and any non-obvious gotchas. Keep it tight — no fluff.\n\n${subject}`,
      );
    },
  },
  {
    name: '/fix',
    description: 'Diagnose and fix an error (paste the error after the command)',
    takesArgs: true,
    run: (args) => {
      const err = args.trim();
      if (!err) {
        messages.value = [
          ...messages.value,
          {
            role: 'assistant',
            text: `Usage: /fix <error message or stack trace>\n\nExample:\n  /fix TypeError: Cannot read properties of undefined (reading 'foo') at bar.ts:42`,
            timestamp: new Date().toISOString(),
          },
        ];
        messageText.value = '';
        return;
      }
      sendTemplated(
        `Diagnose and fix this error. Read whatever files you need to understand the cause, then apply a targeted fix. Don't rewrite unrelated code.\n\n` +
        '```\n' + err + '\n```',
      );
    },
  },
  {
    name: '/review',
    description: 'Review the current branch (diff against main + analysis)',
    run: () => {
      sendTemplated(
        `Review my current branch's changes:\n` +
        `1. Detect the base branch (\`git symbolic-ref refs/remotes/origin/HEAD\` or fall back to main).\n` +
        `2. Run \`git diff <base>...HEAD\` to see the full change set.\n` +
        `3. Walk file-by-file and call out:\n` +
        `   - Bugs / correctness issues (highest priority)\n` +
        `   - Security concerns\n` +
        `   - API / behavior changes the diff doesn't make obvious\n` +
        `   - Test coverage gaps\n` +
        `   - Style or maintainability nits (lowest priority, only flag if material)\n` +
        `Skip uncontroversial changes. Be direct.`,
      );
    },
  },
  {
    name: '/tests',
    description: 'Generate or extend tests for the staged / current changes',
    run: () => {
      sendTemplated(
        `Add or extend tests covering my current changes:\n` +
        `1. Run \`git diff --staged\` (or \`git diff\` if nothing's staged) to see what changed.\n` +
        `2. Find the existing test files for the touched modules.\n` +
        `3. Add tests covering the new / modified behavior — including at least one edge case.\n` +
        `4. Run the test suite and fix any failures introduced by your additions.`,
      );
    },
  },

  {
    name: '/restore',
    description: 'Restore worktree files to an earlier checkpoint',
    run: () => {
      vscode.postMessage({ type: 'restoreCheckpoint' });
      messageText.value = '';
    },
  },
  {
    name: '/diff',
    description: 'Review agent changes per-file with Accept / Reject',
    run: () => {
      vscode.postMessage({ type: 'worktreeReviewChanges' });
      messageText.value = '';
    },
  },

  {
    name: '/help',
    description: 'List slash commands',
    run: () => {
      // Group commands so the help reads as a quick reference rather
      // than an undifferentiated list. Anything not explicitly named
      // is grouped as "session" — keeps the table maintainable.
      const groupOf = (name: string): 'Session' | 'Mode' | 'Inspect' | 'Action' => {
        if (['/commit', '/explain', '/fix', '/review', '/tests', '/restore', '/diff'].includes(name)) return 'Action';
        if (['/plan', '/execute'].includes(name)) return 'Mode';
        if (['/model', '/stats', '/cost', '/help'].includes(name)) return 'Inspect';
        return 'Session';
      };
      const groups: Record<string, string[]> = { Session: [], Mode: [], Inspect: [], Action: [] };
      for (const c of SLASH_COMMANDS) {
        groups[groupOf(c.name)].push(`  ${c.name.padEnd(10)} ${c.description}`);
      }
      const sections = Object.entries(groups)
        .filter(([, lines]) => lines.length > 0)
        .map(([g, lines]) => `${g}:\n${lines.join('\n')}`)
        .join('\n\n');
      messages.value = [
        ...messages.value,
        { role: 'assistant', text: `Available slash commands:\n\n${sections}`, timestamp: new Date().toISOString() },
      ];
      messageText.value = '';
    },
  },
];

/** Build a templated user prompt and route it through the same path as
 *  a typed message — append to the chat with `addUserMessage` (which
 *  handles the queued-while-busy case), and post `sendMessage` to the
 *  host when send-immediately succeeds. */
function sendTemplated(prompt: string): void {
  const sentNow = addUserMessage(prompt);
  if (sentNow !== null) {
    vscode.postMessage({ type: 'sendMessage', data: { text: sentNow } });
  }
}

/** Match commands whose name starts with the partial token (e.g. "/p"
 * matches /profile). Empty string → all commands. */
export function matchSlashCommands(prefix: string): SlashCommand[] {
  const p = prefix.trim().toLowerCase();
  if (!p.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p));
}

/** True when the textarea currently holds a slash command (first
 * non-whitespace char is `/`). */
export function isSlashing(text: string): boolean {
  return text.trimStart().startsWith('/');
}

/**
 * Try to dispatch the textarea contents as a slash command. Returns
 * true if dispatched (caller should NOT also send to the agent).
 */
export function tryDispatchSlash(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const space = trimmed.indexOf(' ');
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const args = space === -1 ? '' : trimmed.slice(space + 1);
  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    // Unknown command — surface in chat so the user knows.
    messages.value = [
      ...messages.value,
      {
        role: 'assistant',
        text: `Unknown command: ${name}. Try /help for the list.`,
        timestamp: new Date().toISOString(),
      },
    ];
    messageText.value = '';
    return true;
  }
  cmd.run(args);
  return true;
}

interface MenuProps {
  /** Open / closed. */
  visible: boolean;
  /** Current textarea value, used to filter the command list. */
  query: string;
  /** Callback when the user clicks a command. */
  onPick: (cmd: SlashCommand) => void;
}

/**
 * Compact pop-up menu shown above the input when the user types `/`.
 * Filtered live by the current input. Click → fill / dispatch.
 */
export function SlashCommandMenu({ visible, query, onPick }: MenuProps) {
  if (!visible) return null;
  const matches = matchSlashCommands(query);
  if (matches.length === 0) return null;
  return (
    <div style={menuStyle}>
      {matches.map((c) => (
        <div
          key={c.name}
          onMouseDown={(e) => {
            // mousedown so the click registers before the textarea blurs.
            e.preventDefault();
            onPick(c);
          }}
          style={itemStyle}
          onMouseOver={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-list-hoverBackground)'; }}
          onMouseOut={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
        >
          <span style={{ fontWeight: 'bold', color: 'var(--vscode-textLink-foreground)' }}>{c.name}</span>
          <span style={{ marginLeft: '8px', color: 'var(--vscode-descriptionForeground)', fontSize: '11px' }}>
            {c.description}
          </span>
        </div>
      ))}
    </div>
  );
}

const menuStyle = {
  position: 'absolute' as const,
  bottom: '100%',
  left: 0,
  right: 0,
  marginBottom: '4px',
  maxHeight: '180px',
  overflowY: 'auto' as const,
  background: 'var(--vscode-editorWidget-background)',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '4px',
  fontSize: '12px',
  zIndex: 10,
  boxShadow: '0 -2px 8px rgba(0,0,0,0.2)',
};

const itemStyle = {
  padding: '6px 10px',
  cursor: 'pointer',
  borderBottom: '1px solid var(--vscode-panel-border)',
};
