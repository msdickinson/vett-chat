import { rawEvents, viewMode } from '../state/signals';
import type { VettEvent } from '../../src/shared/types';

/**
 * Raw-event view: every event vett emitted, in chronological order.
 * Tool calls expanded, iteration boundaries shown, llm_response
 * token counts visible, dispatch markers inline. The default chat
 * shows curated content; toggling verbose mode swaps to this for
 * debugging or if the user wants the full agent trace.
 *
 * Events that arrived from sub-agents (thread_id != "main") are
 * indented and color-coded so it's obvious what came from where.
 */
export function VerboseView() {
  return (
    <div style={{ padding: '4px', fontFamily: 'var(--vscode-editor-font-family)', fontSize: '11px' }}>
      {rawEvents.value.map((entry, i) => (
        <EventLine key={i} event={entry.event} ts={entry.ts} />
      ))}
      {rawEvents.value.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
          No events yet — start a chat or wait for the next agent action.
        </div>
      )}
    </div>
  );
}

interface LineProps {
  event: VettEvent;
  ts: string;
}

function EventLine({ event, ts }: LineProps) {
  const threadId = (event.data as { thread_id?: string } | undefined)?.thread_id;
  const isSubAgent = !!threadId && threadId !== 'main';
  const time = formatTime(ts);

  const indent = isSubAgent ? 16 : 0;
  const accent = isSubAgent ? 'var(--vscode-charts-purple)' : 'transparent';

  const meta = (color: string, glyph: string, body: preact.JSX.Element | string) => (
    <div style={{ display: 'flex', gap: '6px', padding: '1px 4px', marginLeft: indent, borderLeft: `2px solid ${accent}` }}>
      <span style={{ color: 'var(--vscode-descriptionForeground)', minWidth: '52px' }}>{time}</span>
      <span style={{ color, minWidth: '14px', textAlign: 'center' }}>{glyph}</span>
      <span style={{ flex: 1, wordBreak: 'break-word' }}>{body}</span>
    </div>
  );

  switch (event.type) {
    case 'session_start':
    case 'session_resumed': {
      return meta('var(--vscode-charts-blue)', '◆', <strong>{event.type}</strong>);
    }
    case 'ready': {
      const d = event.data ?? {};
      return meta('var(--vscode-charts-green)', '◆', <span>ready · cwd={String(d.cwd ?? '')}{d.resumed ? ' · resumed' : ''}</span>);
    }
    case 'user_message': {
      return meta('var(--vscode-button-background)', '▷', <span style={{ whiteSpace: 'pre-wrap' }}>{String(event.text ?? (event.data as { text?: string })?.text ?? '')}</span>);
    }
    case 'assistant_text': {
      return meta('var(--vscode-charts-green)', '◀', <span style={{ whiteSpace: 'pre-wrap' }}>{String(event.text ?? (event.data as { text?: string })?.text ?? '')}</span>);
    }
    case 'iteration_start': {
      const d = event.data ?? {};
      return meta('var(--vscode-descriptionForeground)', '·', <span style={{ color: 'var(--vscode-descriptionForeground)' }}>iter {String(d.iteration ?? '')} {threadId ? `(${threadId})` : ''}</span>);
    }
    case 'iteration_end': {
      return meta('var(--vscode-descriptionForeground)', '·', <span style={{ color: 'var(--vscode-descriptionForeground)' }}>iter end</span>);
    }
    case 'llm_request': {
      const d = event.data ?? {};
      const isRaw = viewMode.value === 'raw';
      const msgCount = Number(d.message_count ?? 0);
      const toolCount = Number(d.tool_count ?? 0);
      if (!isRaw) {
        // Logs view: just a one-liner that an outbound call is being made.
        return meta('var(--vscode-charts-blue)', '↗', (
          <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
            llm request · {msgCount} msg{msgCount === 1 ? '' : 's'} · {toolCount} tool{toolCount === 1 ? '' : 's'}
          </span>
        ));
      }
      // Raw view: dump the full message list verbatim. This is what
      // the LLM literally sees on this turn — system prompt, every
      // prior user/assistant/tool turn, every tool call + result.
      const messages = (d.messages as Array<Record<string, unknown>>) ?? [];
      return meta('var(--vscode-charts-blue)', '↗', (
        <div>
          <strong>llm request</strong>
          <span style={{ marginLeft: '8px', color: 'var(--vscode-descriptionForeground)' }}>
            model={String(d.model ?? '')} · temp={String(d.temperature ?? '')} · {msgCount} msgs · {toolCount} tools
          </span>
          <pre style={rawPreStyle}>{messages.map(formatRawMessage).join('\n\n---\n\n')}</pre>
        </div>
      ));
    }
    case 'llm_response': {
      const d = event.data ?? {};
      const inT = Number(d.input_tokens ?? 0);
      const outT = Number(d.output_tokens ?? 0);
      const isRaw = viewMode.value === 'raw';
      if (!isRaw) {
        return meta('var(--vscode-charts-blue)', '⇄', (
          <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
            llm: {inT.toLocaleString()} in / {outT.toLocaleString()} out
          </span>
        ));
      }
      const fullContent = d.content as Record<string, unknown> | undefined;
      return meta('var(--vscode-charts-blue)', '⇄', (
        <div>
          <strong>llm response</strong>
          <span style={{ marginLeft: '8px', color: 'var(--vscode-descriptionForeground)' }}>
            {inT.toLocaleString()} in / {outT.toLocaleString()} out
          </span>
          {fullContent && (
            <pre style={rawPreStyle}>{formatRawMessage(fullContent)}</pre>
          )}
        </div>
      ));
    }
    case 'tool_call_start': {
      const d = event.data ?? {};
      // Logs view: short args summary inline. Raw view: full args
      // dumped as JSON in a pre block so nothing is hidden.
      const isRaw = viewMode.value === 'raw';
      return meta('var(--vscode-charts-yellow)', '▶', (
        <span>
          <strong>{String(d.tool_name ?? '?')}</strong>
          {d.arguments && !isRaw && (
            <span style={{ marginLeft: '8px', color: 'var(--vscode-descriptionForeground)' }}>
              {previewArgs(d.arguments as Record<string, unknown>)}
            </span>
          )}
          {d.arguments && isRaw && (
            <pre style={preStyle}>{JSON.stringify(d.arguments, null, 2)}</pre>
          )}
        </span>
      ));
    }
    case 'tool_call_end': {
      const d = event.data ?? {};
      const success = Boolean(d.success);
      // Raw view shows the FULL result text (vett's `result` field —
      // emitted alongside the truncated `result_preview` exactly so
      // this view exists). Logs view shows the preview.
      const isRaw = viewMode.value === 'raw';
      const body = isRaw
        ? (d.result ?? d.result_preview)
        : d.result_preview;
      return meta(success ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red)', success ? '✓' : '✗', (
        <span>
          <strong>{String(d.tool_name ?? '?')}</strong>
          <span style={{ marginLeft: '8px', color: 'var(--vscode-descriptionForeground)' }}>
            {Number(d.duration_ms ?? 0)}ms
          </span>
          {body && (
            <pre style={isRaw ? rawPreStyle : preStyle}>
              {String(body)}
            </pre>
          )}
        </span>
      ));
    }
    case 'dispatch_start': {
      const d = event.data ?? {};
      return meta('var(--vscode-charts-purple)', '⇒', <span><strong>↳ dispatch start</strong> · {String(d.member ?? '')} · {String(d.task ?? '')}</span>);
    }
    case 'dispatch_end': {
      const d = event.data ?? {};
      // COULD-NOT-MEASURE IS NOT MEASURED-ZERO — see the long note in
      // webview/state/signals.ts. A cancelled dispatch arrives with
      // `iterations: null` + `counters_measured: false`; rendering that as
      // "0 iters" makes it indistinguishable from a member that ran and did
      // nothing, which is the exact thing the harness change removed.
      return meta('var(--vscode-charts-purple)', '⇐', <span><strong>↰ dispatch end</strong> · {String(d.member ?? '')} · {d.iterations == null ? 'unmeasured' : String(d.iterations)} iters · {String(d.stop_reason ?? '')}</span>);
    }
    case 'compacted': {
      const d = event.data ?? {};
      return meta('var(--vscode-charts-yellow)', '⚙', <span>compacted ({String(d.reason ?? '')}) · {String(d.before ?? 0)} → {String(d.after ?? 0)}</span>);
    }
    case 'cancelled': {
      const d = event.data ?? {};
      return meta('var(--vscode-charts-red)', '✗', <span>cancelled ({String(d.reason ?? '')})</span>);
    }
    case 'user_input_needed': {
      return meta('var(--vscode-descriptionForeground)', '·', <span style={{ color: 'var(--vscode-descriptionForeground)' }}>waiting for user input</span>);
    }
    case 'stderr': {
      return meta('var(--vscode-charts-red)', '!', <span style={{ color: 'var(--vscode-charts-red)', whiteSpace: 'pre-wrap' }}>{String(event.text ?? '')}</span>);
    }
    case 'error': {
      const d = event.data ?? {};
      return meta('var(--vscode-charts-red)', '!', <span style={{ color: 'var(--vscode-charts-red)' }}>error: {String(d.message ?? '')}</span>);
    }
    case 'done': {
      const d = event.data ?? {};
      return meta('var(--vscode-charts-blue)', '◆', <span><strong>done</strong> · {String(d.stop_reason ?? '')} · {d.iterations == null ? 'unmeasured' : String(d.iterations)} iter</span>);
    }
    default: {
      // Unknown event types are rendered as raw JSON so nothing's hidden.
      return meta('var(--vscode-descriptionForeground)', '?', <code style={{ fontSize: '10px' }}>{event.type} {JSON.stringify(event.data ?? {}).slice(0, 200)}</code>);
    }
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour12: false }).slice(0, 8);
  } catch {
    return '';
  }
}

function previewArgs(args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command.slice(0, 100);
  if (args.command_name && args.path) return `${args.command_name} ${args.path}`;
  const json = JSON.stringify(args);
  return json.length > 100 ? json.slice(0, 100) + '…' : json;
}

/**
 * Render a serialized ChatMessage from vett's llm_request / llm_response
 * events as plain text suitable for a <pre> block. Designed for the Raw
 * view: every byte that went to or from the LLM, no truncation.
 *
 * Format:
 *
 *   role:
 *     [text]
 *       <full text, multi-line preserved>
 *     [call] tool_name  call_id=...
 *       {
 *         "arg1": "...",
 *         "arg2": ...
 *       }
 *     [result] call_id=...
 *       <full untruncated result text>
 *
 * - Function-call arguments are pretty-printed JSON, indented under
 *   the call line.
 * - Some providers send arguments as a JSON-encoded string instead of
 *   an object — we try to JSON.parse + re-pretty-print, falling back
 *   to the raw string if the parse fails.
 * - Tool results are emitted verbatim (whatever the tool returned).
 *   If the agent saw a 5K-line file dump, you see all 5K lines.
 */
function formatRawMessage(msg: Record<string, unknown>): string {
  const role = String(msg.role ?? '?');
  const contents = (msg.content as Array<Record<string, unknown>>) ?? [];
  if (contents.length === 0) {
    return `${role}:\n${indentBlock(JSON.stringify(msg, null, 2), 2)}`;
  }
  const lines: string[] = [`${role}:`];
  for (const c of contents) {
    const type = String(c.type ?? '?');
    if (type === 'text') {
      lines.push('  [text]');
      lines.push(indentBlock(String(c.text ?? ''), 4));
    } else if (type === 'function_call') {
      lines.push(`  [call] ${String(c.name ?? '?')}  call_id=${String(c.call_id ?? '')}`);
      lines.push(indentBlock(prettyArgs(c.arguments), 4));
    } else if (type === 'function_result') {
      lines.push(`  [result] call_id=${String(c.call_id ?? '')}`);
      lines.push(indentBlock(String(c.result ?? ''), 4));
    } else {
      lines.push(`  [${type}]`);
      lines.push(indentBlock(JSON.stringify(c, null, 2), 4));
    }
  }
  return lines.join('\n');
}

/** Pretty-print function-call arguments. Handles the case where the
 * provider sent them as a JSON-encoded string. */
function prettyArgs(args: unknown): string {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args ?? {}, null, 2);
}

/** Indent every line of `text` by `width` spaces. Preserves blank
 * lines so multi-paragraph content reads naturally. */
function indentBlock(text: string, width: number): string {
  const pad = ' '.repeat(width);
  return text.split('\n').map((l) => pad + l).join('\n');
}

const preStyle = {
  marginTop: '2px',
  marginBottom: '0',
  padding: '4px 6px',
  background: 'var(--vscode-textBlockQuote-background)',
  borderRadius: '3px',
  fontSize: '10px',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  maxHeight: '200px',
  overflow: 'auto' as const,
};

// Raw mode: same look but with a much taller cap so big results
// (5K-line file reads, full bash transcripts) are usable in-line.
const rawPreStyle = {
  ...preStyle,
  maxHeight: '600px',
};
