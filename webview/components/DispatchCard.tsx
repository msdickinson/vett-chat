import type { Dispatch, ToolCall, VettEvent } from '../../src/shared/types';
import { dispatches, dispatchViewStyle } from '../state/signals';
import { ToolCallCard } from './ToolCallCard';
import { renderMarkdown } from '../utils/markdown';

interface Props {
  dispatch: Dispatch;
}

/**
 * Inline card representing one sub-agent dispatch. Appears in the chat
 * stream the moment vett emits dispatch_start; updates live as the
 * member's events flow in. Click to expand and see what the member
 * actually did (its tool calls, assistant text). Collapsed by default
 * so a long sub-agent run doesn't visually overwhelm the parent
 * conversation.
 *
 * Tabbed thread switching — where the user could jump into a separate
 * tab for the sub-agent — is a possible follow-up. This is the
 * simpler v1 that gets the data on screen.
 */
export function DispatchCard({ dispatch }: Props) {
  const toggle = () => {
    // Compare by threadId, not reference. Every appendToDispatch event
    // rebuilds the Dispatch object, so the prop points at a stale copy
    // and `d === dispatch` never matches — clicks would silently no-op.
    dispatches.value = dispatches.value.map((d) =>
      d.threadId === dispatch.threadId ? { ...d, expanded: !d.expanded } : d,
    );
  };

  const statusIcon = dispatch.active ? '⟳' : dispatch.stopReason === 'max_iterations' ? '⚠' : '✓';
  const statusColor = dispatch.active
    ? 'var(--vscode-charts-blue)'
    : dispatch.stopReason === 'max_iterations'
      ? 'var(--vscode-charts-yellow)'
      : 'var(--vscode-charts-green)';

  // Live counts derived from the events array — these update while the
  // member is still running so the card shows progress instead of a
  // static spinner. dispatch.iterations only gets set on dispatch_end,
  // so we count iteration_start events directly.
  const liveIterations = dispatch.events.filter((e) => e.type === 'iteration_start').length;
  const toolCount = dispatch.events.filter((e) => e.type === 'tool_call_start').length;
  const iterCount = dispatch.iterations ?? liveIterations;

  // Most recent in-flight tool — useful as the "what's happening right
  // now" hint on the collapsed card while the dispatch is active.
  const lastToolStart = [...dispatch.events]
    .reverse()
    .find((e) => e.type === 'tool_call_start');
  const lastAssistant = [...dispatch.events]
    .reverse()
    .find((e) => e.type === 'assistant_text');
  const previewText = lastAssistant?.text ?? '';
  const liveHint = dispatch.active && lastToolStart
    ? `running ${String(lastToolStart.data?.tool_name ?? '?')}…`
    : null;

  return (
    <div style={cardStyle}>
      <div style={headerStyle} onClick={toggle}>
        <span style={{ color: statusColor, fontWeight: 'bold', minWidth: '14px' }}>{statusIcon}</span>
        <span style={{ color: 'var(--vscode-descriptionForeground)' }}>↳ Dispatched to</span>
        <strong>{dispatch.memberName}</strong>
        {/* Task id pill — distinguishes parallel dispatches to the same
            member at a glance. Same id surfaces in continue_task tool
            args so you can correlate which researcher you're chatting to. */}
        <span style={{
          fontSize: '10px',
          padding: '1px 5px',
          borderRadius: '8px',
          background: 'var(--vscode-badge-background)',
          color: 'var(--vscode-badge-foreground)',
          fontFamily: 'var(--vscode-editor-font-family)',
        }}>{dispatch.threadId}</span>
        <span style={{
          flex: 1,
          color: 'var(--vscode-descriptionForeground)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{dispatch.task}</span>
        {/* Live counts — visible whether running or done. While active
            this updates as iteration_start / tool_call_start events
            arrive so the collapsed card still feels alive. */}
        {(iterCount > 0 || toolCount > 0) && (
          <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '10px' }}>
            iter {iterCount} · {toolCount} call{toolCount === 1 ? '' : 's'}
          </span>
        )}
        <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '10px' }}>
          {dispatch.expanded ? '▾' : '▸'}
        </span>
      </div>

      {/* Collapsed preview: while active, show the current tool the
          member is running. After it finishes, show the member's final
          reply as a single line. Either way the unexpanded card hints
          at "something is happening" / "this is what came back". */}
      {!dispatch.expanded && (liveHint || previewText) && (
        <div style={previewStyle} title={liveHint ?? previewText}>
          {liveHint ?? previewText.split('\n')[0].slice(0, 200)}
        </div>
      )}

      {dispatch.expanded && (
        <div style={expandedStyle}>
          <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginBottom: '6px' }}>
            {dispatch.events.length} events · {toolCount} tool calls · started {fmtTime(dispatch.startedAt)}
            {dispatch.completedAt && ` · finished ${fmtTime(dispatch.completedAt)}`}
            {dispatch.stopReason && ` · stop: ${dispatch.stopReason}`}
          </div>
          {dispatchViewStyle.value === 'structured'
            ? <StructuredEvents events={dispatch.events} threadId={dispatch.threadId} />
            : <ThreadEvents events={dispatch.events} />}
        </div>
      )}
    </div>
  );
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

/**
 * Structured-view renderer: walks a sub-agent's event stream and
 * renders it with the same vocabulary the main chat uses — assistant
 * text becomes a message bubble; tool_call_start/end pairs become
 * ToolCallCard cards with IN/OUT preview + click-to-expand. Iteration
 * markers, llm_request, and llm_response are deliberately hidden
 * (they're noise once the user has proper cards). Errors and
 * cancellation still surface as inline pills.
 *
 * Per-card expand state is local to this dispatch — keyed by
 * (threadId + callId) so reopening a different dispatch doesn't share
 * which-card-is-expanded state across them. Survives parent re-renders
 * because it lives in a module-scope Map; cleared on resetChatState
 * since the dispatch's events are wiped at that point too.
 */
const cardExpansion = new Map<string, boolean>();

interface StructuredEventsProps {
  events: VettEvent[];
  threadId: string;
}

function StructuredEvents({ events, threadId }: StructuredEventsProps) {
  // Build the rendered list in one pass. tool_call_start opens a card;
  // a matching tool_call_end (by call_id) fills in result + success +
  // duration. tool_call_end without a prior start is rare (out-of-order
  // events) but rendered as a fallback "result-only" card.
  type Item =
    | { kind: 'message'; text: string; ts: string }
    | { kind: 'tool'; call: ToolCall }
    | { kind: 'note'; ts: string; text: string; color: string }; // errors / cancellation
  const items: Item[] = [];
  const callsByIdx: Record<string, number> = {};

  for (const e of events) {
    if (e.type === 'assistant_text' && e.text) {
      items.push({ kind: 'message', text: e.text, ts: e.timestamp ?? '' });
      continue;
    }
    if (e.type === 'tool_call_start') {
      const d = e.data ?? {};
      const callId = String(d.call_id ?? `_${items.length}`);
      const tc: ToolCall = {
        callId,
        toolName: String(d.tool_name ?? '?'),
        arguments: (d.arguments && typeof d.arguments === 'object')
          ? (d.arguments as Record<string, unknown>)
          : undefined,
        expanded: cardExpansion.get(threadId + ':' + callId) === true,
        startedAt: e.timestamp,
      };
      callsByIdx[callId] = items.length;
      items.push({ kind: 'tool', call: tc });
      continue;
    }
    if (e.type === 'tool_call_end') {
      const d = e.data ?? {};
      const callId = String(d.call_id ?? '');
      const idx = callsByIdx[callId];
      const result = String(d.result_preview ?? d.result ?? '');
      // Capture the full result alongside the preview so the expanded
      // card shows complete output instead of the 200-char head+tail.
      const fullResult = typeof d.result === 'string' ? d.result : undefined;
      const success = typeof d.success === 'boolean' ? d.success : undefined;
      const duration = typeof d.duration_ms === 'number' ? d.duration_ms : undefined;
      const truncated = d.result_truncated === true;
      const length = typeof d.result_length === 'number' ? d.result_length : undefined;
      if (idx !== undefined && items[idx]?.kind === 'tool') {
        const tc = (items[idx] as Extract<Item, { kind: 'tool' }>).call;
        tc.result = result;
        tc.resultFull = fullResult;
        tc.success = success;
        tc.durationMs = duration;
        tc.resultTruncated = truncated;
        tc.resultLength = length;
      } else {
        // Orphan end — render as a result-only synthetic card so the
        // user still sees the output. Rare; usually only happens if
        // the start event was dropped mid-stream.
        const tc: ToolCall = {
          callId: callId || `_orphan_${items.length}`,
          toolName: String(d.tool_name ?? '?'),
          result,
          resultFull: fullResult,
          success,
          durationMs: duration,
          resultTruncated: truncated,
          resultLength: length,
          expanded: false,
        };
        items.push({ kind: 'tool', call: tc });
      }
      continue;
    }
    if (e.type === 'error') {
      const d = e.data ?? {};
      items.push({
        kind: 'note',
        ts: e.timestamp ?? '',
        text: String(d.message ?? 'error'),
        color: 'var(--vscode-charts-red)',
      });
      continue;
    }
    if (e.type === 'cancelled') {
      items.push({
        kind: 'note',
        ts: e.timestamp ?? '',
        text: 'cancelled',
        color: 'var(--vscode-charts-red)',
      });
      continue;
    }
    // iteration_start / iteration_end / llm_request / llm_response /
    // dispatch_start / dispatch_end / report_progress: hidden in
    // structured view. The leader-side `report_progress` already
    // surfaces in the parent chat as its own line.
  }

  if (items.length === 0) {
    return (
      <div style={{ color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', fontSize: '11px' }}>
        (no assistant text or tool calls yet)
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {items.map((item, i) => {
        if (item.kind === 'message') {
          return (
            <div key={`m-${i}`} style={messageBubbleStyle}>
              <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginBottom: '2px' }}>
                {formatTimeSec(item.ts)}
              </div>
              <div style={{ fontSize: '12px' }}>{renderMarkdown(item.text)}</div>
            </div>
          );
        }
        if (item.kind === 'tool') {
          const call = item.call;
          return (
            <ToolCallCard
              key={`t-${call.callId}-${i}`}
              call={call}
              onToggle={() => {
                const key = threadId + ':' + call.callId;
                cardExpansion.set(key, !cardExpansion.get(key));
                // Force a re-render by mutating the dispatches signal
                // shallowly — same trick the header toggle uses.
                dispatches.value = [...dispatches.value];
              }}
            />
          );
        }
        return (
          <div
            key={`n-${i}`}
            style={{ ...notePillStyle, color: item.color, borderColor: item.color }}
          >
            <span style={{ fontSize: '10px', opacity: 0.7 }}>{formatTimeSec(item.ts)}</span>
            <span style={{ marginLeft: '8px' }}>{item.text}</span>
          </div>
        );
      })}
    </div>
  );
}

const messageBubbleStyle = {
  padding: '6px 10px',
  background: 'var(--vscode-textBlockQuote-background)',
  borderRadius: '6px',
  border: '1px solid var(--vscode-panel-border)',
};

const notePillStyle = {
  padding: '4px 10px',
  fontSize: '11px',
  border: '1px solid currentColor',
  borderRadius: '4px',
  background: 'var(--vscode-editor-background)',
};

interface ThreadEventsProps { events: VettEvent[]; }

/**
 * Compact event log for a sub-agent dispatch. Renders enough of each
 * event that the user can see "what is the member doing right now?"
 * without switching to the global Logs view: tool args, tool results
 * (truncated), assistant text, iteration boundaries. Same styling
 * vocabulary as VerboseView so flipping between them feels coherent.
 */
function ThreadEvents({ events }: ThreadEventsProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {events.map((e, i) => <ThreadEventLine key={i} event={e} />)}
    </div>
  );
}

/**
 * Single row in Logs-view-style: timestamp column · glyph column · body.
 * Matches VerboseView's `meta()` formatting so flipping between Live's
 * dispatch card and the Logs view feels coherent.
 */
function row(time: string, glyph: string, glyphColor: string, body: preact.ComponentChildren, opts?: { extra?: preact.ComponentChildren; muted?: boolean; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '6px', padding: '1px 4px', alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--vscode-descriptionForeground)', minWidth: '64px', flexShrink: 0 }}>{time}</span>
      <span style={{ color: glyphColor, minWidth: '14px', flexShrink: 0, textAlign: 'center' }}>{glyph}</span>
      <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word', color: opts?.muted ? 'var(--vscode-descriptionForeground)' : undefined, fontWeight: opts?.bold ? 'bold' : undefined }}>
        {body}
        {opts?.extra}
      </div>
    </div>
  );
}

function ThreadEventLine({ event: e }: { event: VettEvent }) {
  const ts = e.timestamp ? formatTimeSec(e.timestamp) : '';
  const purple = 'var(--vscode-charts-purple)';
  const muted = 'var(--vscode-descriptionForeground)';

  if (e.type === 'dispatch_start') {
    const d = e.data ?? {};
    return row(ts, '⇒', purple, <span style={{ color: purple }}>↳ dispatch start · <strong>{String(d.member ?? '')}</strong> · {String(d.task ?? '')}</span>);
  }

  if (e.type === 'dispatch_end') {
    const d = e.data ?? {};
    return row(ts, '⇐', purple, <span style={{ color: purple }}>↰ dispatch end · {String(d.member ?? '')} · {d.iterations == null ? 'unmeasured' : String(d.iterations)} iters · {String(d.stop_reason ?? '')}</span>);
  }

  if (e.type === 'iteration_start') {
    const d = e.data ?? {};
    return row(ts, '·', muted, <span style={{ color: muted }}>iter {String(d.iteration ?? '')}</span>, { muted: true });
  }

  if (e.type === 'iteration_end') {
    return row(ts, '·', muted, 'iter end', { muted: true });
  }

  if (e.type === 'llm_request') {
    const d = e.data ?? {};
    return row(ts, '↗', muted, <span style={{ color: muted }}>llm request · {String(d.message_count ?? 0)} msgs · {String(d.tool_count ?? 0)} tools</span>);
  }

  if (e.type === 'llm_response') {
    const d = e.data ?? {};
    return row(ts, '⇄', muted, <span style={{ color: muted }}>llm: {Number(d.input_tokens ?? 0).toLocaleString()} in / {Number(d.output_tokens ?? 0).toLocaleString()} out</span>);
  }

  if (e.type === 'assistant_text' && e.text) {
    return row(ts, '◀', 'var(--vscode-charts-green)', <span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>);
  }

  if (e.type === 'tool_call_start') {
    const d = e.data ?? {};
    const args = d.arguments as Record<string, unknown> | undefined;
    return row(
      ts,
      '▶',
      'var(--vscode-charts-blue)',
      <span><code>{String(d.tool_name ?? '?')}</code>{args && <span style={{ marginLeft: '8px', color: muted }}>{previewToolArgs(args)}</span>}</span>,
    );
  }

  if (e.type === 'tool_call_end') {
    const d = e.data ?? {};
    const success = Boolean(d.success);
    const preview = String(d.result_preview ?? '');
    return row(
      ts,
      success ? '✓' : '✗',
      success ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red)',
      <span><code>{String(d.tool_name ?? '?')}</code> <span style={{ color: muted, fontSize: '10px' }}>{Number(d.duration_ms ?? 0)}ms</span></span>,
      { extra: preview ? <pre style={threadPreStyle}>{preview}</pre> : null },
    );
  }

  if (e.type === 'error') {
    const d = e.data ?? {};
    return row(ts, '!', 'var(--vscode-charts-red)', <span style={{ color: 'var(--vscode-charts-red)' }}>{String(d.message ?? '')}</span>);
  }

  if (e.type === 'cancelled') {
    return row(ts, '✗', 'var(--vscode-charts-red)', <span style={{ color: 'var(--vscode-charts-red)' }}>cancelled</span>);
  }

  // stderr / unknown: just dim it so we don't lose information but
  // don't visually compete with the meaningful events.
  return null;
}

function formatTimeSec(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false }).slice(0, 8);
  } catch {
    return '';
  }
}

function previewToolArgs(args: Record<string, unknown>): string {
  if (typeof args.command === 'string') {
    return args.command.length > 100 ? args.command.slice(0, 100) + '…' : args.command;
  }
  if (args.command_name && args.path) {
    return `${args.command_name} ${args.path}`;
  }
  const json = JSON.stringify(args);
  return json.length > 100 ? json.slice(0, 100) + '…' : json;
}

const cardStyle = {
  margin: '4px 0',
  border: '1px solid var(--vscode-panel-border)',
  borderLeft: '3px solid var(--vscode-charts-purple)',
  borderRadius: '4px',
  overflow: 'hidden',
  background: 'var(--vscode-editor-background)',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: '12px',
  background: 'var(--vscode-textBlockQuote-background)',
  // Without this, clicking inline text inside the header (memberName,
  // task) selects the text instead of triggering the onClick toggle —
  // the user has to click the tiny ▸ chevron specifically. The body
  // remains selectable when expanded.
  userSelect: 'none' as const,
};

const previewStyle = {
  padding: '4px 10px',
  fontSize: '11px',
  color: 'var(--vscode-descriptionForeground)',
  fontStyle: 'italic' as const,
  borderTop: '1px solid var(--vscode-panel-border)',
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
};

const expandedStyle = {
  padding: '8px 10px',
  fontSize: '11px',
  fontFamily: 'var(--vscode-editor-font-family)',
  borderTop: '1px solid var(--vscode-panel-border)',
};

const threadPreStyle = {
  margin: '4px 0 0 22px',
  padding: '4px 6px',
  background: 'var(--vscode-editor-background)',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '3px',
  fontSize: '11px',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  maxHeight: '160px',
  overflow: 'auto' as const,
};
