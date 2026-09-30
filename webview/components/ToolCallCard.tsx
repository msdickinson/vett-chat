import type { ToolCall } from '../../src/shared/types';
import { describeToolCall } from '../utils/toolDescription';
import { toolCardDensity, type ToolCardDensity } from '../state/signals';

/**
 * ToolCallCard — visual display for one tool call in the Live chat view.
 *
 * Three density modes (`vett-chat.toolCardDensity` setting):
 *
 *   compact  — one line: "● Bash · List home dir   ✓ 120ms"
 *   default  — header card + IN / OUT preview blocks (truncated,
 *              expandable to full data)
 *   verbose  — same layout as default but IN + OUT shown in full inline
 *              (no truncation regardless of click state)
 *
 * The signal is read here directly so the card live-updates if the user
 * changes the density mid-chat. Compact mode ignores the expanded flag
 * because there's no body to expand into.
 */

interface Props {
  call: ToolCall;
  onToggle: () => void;
}

export function ToolCallCard({ call, onToggle }: Props) {
  const density = toolCardDensity.value;
  if (density === 'compact') return <CompactCard call={call} onToggle={onToggle} />;
  return <FullCard call={call} onToggle={onToggle} density={density} />;
}

// ---- shared bits ----

function statusDot(success: boolean | undefined): string {
  return success === undefined
    ? 'var(--vscode-charts-blue)' // running
    : success
      ? 'var(--vscode-charts-green)'
      : 'var(--vscode-charts-red)';
}

function StatusDot({ success }: { success: boolean | undefined }) {
  return (
    <span
      style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: statusDot(success),
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

function StatusGlyph({ success }: { success: boolean | undefined }) {
  const ch = success === undefined ? '▶' : success ? '✓' : '✗';
  return (
    <span style={{ color: statusDot(success), fontWeight: 'bold' }}>{ch}</span>
  );
}

// ---- compact (one-liner) ----

function CompactCard({ call, onToggle }: { call: ToolCall; onToggle: () => void }) {
  const desc = describeToolCall(call.toolName, call.arguments);
  const id = extractTaskId(call);
  return (
    <div
      onClick={onToggle}
      title={desc || call.toolName}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '2px 8px',
        margin: '2px 0',
        cursor: 'pointer',
        fontSize: '12px',
        fontFamily: 'var(--vscode-editor-font-family)',
        borderLeft: `2px solid ${statusDot(call.success)}`,
        background: 'transparent',
      }}
    >
      <StatusGlyph success={call.success} />
      <span style={{ fontWeight: 600 }}>{prettyToolName(call.toolName)}</span>
      {desc && (
        <span style={{ color: 'var(--vscode-descriptionForeground)' }}>· {desc}</span>
      )}
      {id && <TaskIdBadge id={id} />}
      {call.durationMs !== undefined && (
        <span style={{
          marginLeft: 'auto',
          color: 'var(--vscode-descriptionForeground)',
          fontSize: '11px',
        }}>
          {formatDuration(call.durationMs)}
        </span>
      )}
    </div>
  );
}

// ---- default + verbose (full card) ----

function FullCard({
  call,
  onToggle,
  density,
}: {
  call: ToolCall;
  onToggle: () => void;
  density: ToolCardDensity;
}) {
  const desc = describeToolCall(call.toolName, call.arguments);
  const id = extractTaskId(call);
  // Verbose ignores expanded — always shows full data.
  const showBody = density === 'verbose' || call.expanded;
  // Always show preview rows in 'default' mode (collapsed = preview,
  // expanded = full); 'verbose' renders the full bodies inline at all
  // times. Header always shows IN as a 1-line preview so even
  // collapsed cards convey what the tool was doing.
  const inPreview = formatInPreview(call);

  return (
    <div
      style={{
        margin: '4px 0',
        border: '1px solid var(--vscode-panel-border)',
        borderRadius: '4px',
        overflow: 'hidden',
        borderLeft: `3px solid ${statusDot(call.success)}`,
      }}
    >
      <div
        onClick={onToggle}
        style={{
          padding: '6px 10px',
          cursor: density === 'verbose' ? 'default' : 'pointer',
          background: 'var(--vscode-editor-background)',
          fontSize: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <StatusDot success={call.success} />
          <span style={{
            fontWeight: 600,
            padding: '1px 6px',
            background: 'var(--vscode-badge-background)',
            color: 'var(--vscode-badge-foreground)',
            borderRadius: '3px',
            fontSize: '11px',
            letterSpacing: '0.3px',
          }}>
            {prettyToolName(call.toolName)}
          </span>
          {desc && (
            <span style={{
              color: 'var(--vscode-foreground)',
              opacity: 0.85,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {desc}
            </span>
          )}
          {id && <TaskIdBadge id={id} />}
          {call.durationMs !== undefined && (
            <span style={{
              marginLeft: 'auto',
              color: 'var(--vscode-descriptionForeground)',
              fontSize: '11px',
              flexShrink: 0,
            }}>
              {formatDuration(call.durationMs)}
            </span>
          )}
          {density !== 'verbose' && (
            <span style={{
              color: 'var(--vscode-descriptionForeground)',
              fontSize: '11px',
              // Push the chevron right when there's no duration tag
              // taking the auto margin; otherwise let it sit snug
              // against the duration.
              marginLeft: call.durationMs !== undefined ? '4px' : 'auto',
            }}>
              {call.expanded ? '▾' : '▸'}
            </span>
          )}
        </div>
      </div>

      {(showBody || inPreview) && (
        <div style={{
          background: 'var(--vscode-textBlockQuote-background)',
          borderTop: '1px solid var(--vscode-panel-border)',
          padding: '6px 10px',
          fontSize: '11px',
          fontFamily: 'var(--vscode-editor-font-family)',
        }}>
          {/* IN block — shown in default mode whenever there's content,
              full args in verbose, single-line preview when collapsed. */}
          {call.arguments && (
            <Row label="IN">
              <pre style={preStyle(showBody ? 'auto' : 'hidden')}>
                {showBody ? formatArgsFull(call.arguments) : inPreview ?? ''}
              </pre>
            </Row>
          )}
          {/* OUT block — only when we have a result. Collapsed shows a
              first-N-line snippet of the preview; expanded / verbose
              shows the full untruncated text from `resultFull` if vett
              shipped it (it does for chat mode, see AgentLoop.cs
              tool_call_end), falling back to the preview if absent. */}
          {call.result && (
            <Row
              label="OUT"
              hint={
                call.resultTruncated && call.resultLength !== undefined && !call.resultFull
                  ? `truncated · full ${call.resultLength.toLocaleString()} chars in session log`
                  : undefined
              }
            >
              <pre style={preStyle('auto')}>
                {showBody
                  ? (call.resultFull ?? call.result)
                  : truncateLines(call.result, 5)}
              </pre>
            </Row>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', marginBottom: '4px' }}>
      <span style={{
        color: 'var(--vscode-descriptionForeground)',
        fontSize: '10px',
        fontWeight: 600,
        letterSpacing: '0.5px',
        flexShrink: 0,
        width: '28px',
        textAlign: 'right',
        paddingTop: '2px',
      }}>
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {children}
        {hint && (
          <div style={{
            color: 'var(--vscode-descriptionForeground)',
            fontSize: '10px',
            marginTop: '2px',
            fontStyle: 'italic',
          }}>
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

function preStyle(overflow: 'auto' | 'hidden') {
  return {
    margin: 0,
    padding: '4px 6px',
    background: 'var(--vscode-editor-background)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '3px',
    whiteSpace: overflow === 'auto' ? ('pre-wrap' as const) : ('nowrap' as const),
    wordBreak: 'break-word' as const,
    overflow: overflow === 'auto' ? ('auto' as const) : ('hidden' as const),
    textOverflow: overflow === 'hidden' ? ('ellipsis' as const) : undefined,
    maxHeight: overflow === 'auto' ? '300px' : undefined,
  };
}

function TaskIdBadge({ id }: { id: string }) {
  return (
    <span style={{
      fontSize: '10px',
      padding: '1px 5px',
      borderRadius: '8px',
      background: 'var(--vscode-badge-background)',
      color: 'var(--vscode-badge-foreground)',
      fontFamily: 'var(--vscode-editor-font-family)',
    }}>
      {id}
    </span>
  );
}

// ---- formatters ----

/** Pretty-print tool name for the badge — terminal → "Bash" reads better
 *  than "terminal", file_editor → "Edit" / "Read" depends on op which we
 *  don't have here, so leave file_editor as-is. */
function prettyToolName(name: string): string {
  if (name === 'terminal') return 'Bash';
  if (name === 'file_editor') return 'File';
  if (name === 'think') return 'Think';
  if (name === 'finish') return 'Finish';
  if (name === 'task_tracker') return 'Tasks';
  return name;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function formatArgsFull(args: Record<string, unknown>): string {
  // For terminal commands, show the command verbatim — that's what users
  // actually want to read. Same for file_editor's primary args.
  if (typeof args.command === 'string' && Object.keys(args).length === 1) {
    return args.command;
  }
  return JSON.stringify(args, null, 2);
}

function formatInPreview(call: ToolCall): string | null {
  const args = call.arguments;
  if (!args) return null;
  if (typeof args.command === 'string') {
    const c = args.command.trim();
    return c.length > 100 ? c.slice(0, 99) + '…' : c;
  }
  if (args.command_name && args.path) {
    return `${args.command_name} ${args.path}`;
  }
  // Fallback: first string-valued arg.
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) {
      const t = v.trim();
      return t.length > 100 ? t.slice(0, 99) + '…' : t;
    }
  }
  return null;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, maxLines).join('\n');
  return `${head}\n… (${lines.length - maxLines} more line${lines.length - maxLines === 1 ? '' : 's'} · click to expand)`;
}

/** Pull a task id out of a delegation tool call so the badge can show
 *  which dispatch is being referenced. continue_task / wait_task /
 *  check_task pass it in `arguments`; assign_task / assign_async return
 *  it in the result body ("researcher-1 assigned to researcher…"). */
function extractTaskId(call: ToolCall): string | null {
  const argsTaskId = (call.arguments as { task_id?: unknown } | undefined)?.task_id;
  if (typeof argsTaskId === 'string' && argsTaskId.length > 0) return argsTaskId;
  const result = call.result ?? '';
  let m = /([a-z][a-z0-9-]*-\d+)\s+assigned\b/i.exec(result);
  if (m) return m[1];
  m = /\[([a-z][a-z0-9-]*-\d+)\b/i.exec(result);
  if (m) return m[1];
  return null;
}
