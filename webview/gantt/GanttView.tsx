import { useEffect, useRef } from 'preact/hooks';
import { rawEvents, sessionLogPath } from '../state/signals';
import { ganttView } from './gantt';
import { VettParser } from './vett-parser';
import type { Trajectory } from './types';

/**
 * Embeds AI Timeline's gantt view into vett-chat as a 4th panel mode.
 *
 * Lift strategy: the gantt's render code is vanilla DOM (no Preact),
 * so we mount a plain container div and let the lifted view manipulate
 * it directly. We feed it a synthesized `Trajectory[]` built from the
 * webview's `rawEvents` signal — the same pipeline AI Timeline's
 * VettLiveDataSource uses, just sourced from in-memory events instead
 * of Server-Sent Events from `vett run --live-port`.
 *
 * Updates are debounced. The gantt is expensive to re-render (full
 * SVG rebuild + virtualization recalc), and rawEvents lands at most
 * dozens of times per second during a busy turn — debouncing to ~500ms
 * keeps the timeline feeling live without burning the main thread.
 */
const DEBOUNCE_MS = 500;

export function GanttView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);

  // Inject the gantt's bundled CSS once. The view exposes a `css`
  // string instead of a stylesheet file so it travels with the view —
  // we just append it to <head> and let it cover all gantt instances.
  useEffect(() => {
    if (!styleRef.current) {
      const style = document.createElement('style');
      style.textContent = ganttView.css ?? '';
      document.head.appendChild(style);
      styleRef.current = style;
    }
    return () => {
      // Clean up CSS when the component fully unmounts (the panel is
      // closed, not on view-mode toggle which preserves React DOM).
      // Practically the webview tears down; this is mostly correctness.
      if (styleRef.current) {
        styleRef.current.remove();
        styleRef.current = null;
      }
    };
  }, []);

  // Mount + render. Re-runs whenever rawEvents changes (debounced).
  useEffect(() => {
    if (!containerRef.current) return;

    let timer: number | null = null;
    let cancelled = false;

    const renderNow = () => {
      if (cancelled || !containerRef.current) return;
      const trajectory = buildTrajectory(rawEvents.value);
      // Clear container first — the gantt view itself sets cleanupFn
      // and handles re-render, but for simplicity we always wipe and
      // re-render on each refresh.
      containerRef.current.innerHTML = '';
      try {
        ganttView.render(containerRef.current, trajectory ? [trajectory] : [], {
          darkMode: true,
          filterTool: null,
          expandedEvents: new Set(),
          onStateChange: () => { /* no-op; vett-chat doesn't persist gantt state */ },
        });
      } catch (err) {
        // The gantt expects the AI Timeline runtime around it (theme
        // CSS vars, registry helpers, etc.). If anything blows up,
        // surface it inline rather than killing the whole panel.
        containerRef.current.innerHTML = '';
        const msg = document.createElement('pre');
        msg.style.padding = '12px';
        msg.style.color = 'var(--vscode-charts-red)';
        msg.style.whiteSpace = 'pre-wrap';
        msg.textContent =
          'Gantt render failed:\n' +
          ((err as Error)?.stack ?? String(err));
        containerRef.current.appendChild(msg);
      }
    };

    // Initial render uses requestAnimationFrame so the container is
    // sized before the gantt measures viewport height (some of its
    // virtualization breaks against zero-height containers).
    const initial = requestAnimationFrame(renderNow);

    // Subscribe to rawEvents — debounced re-render on update.
    const unsubscribe = rawEvents.subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(renderNow, DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(initial);
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      try { ganttView.destroy?.(); } catch { /* best-effort */ }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        // The gantt expects to color against a few CSS custom properties
        // it inherits from AI Timeline. We map them to VS Code theme
        // tokens so the gantt looks at home in the chat panel.
        // These are merged into existing styles; absent values fall
        // through to the gantt CSS defaults.
        '--tv-bg': 'var(--vscode-editor-background)',
        '--tv-card-bg': 'var(--vscode-editorWidget-background)',
        '--tv-text': 'var(--vscode-foreground)',
        '--tv-text-muted': 'var(--vscode-descriptionForeground)',
        '--tv-border': 'var(--vscode-panel-border)',
        '--tv-accent': 'var(--vscode-textLink-foreground)',
        '--tv-mono': 'var(--vscode-editor-font-family)',
      }}
    />
  );
}

/**
 * Convert vett-chat's `rawEvents` array into a single Trajectory by
 * re-emitting the events as the JSONL envelope shape vett's logger
 * writes ({seq, ts, type, instance_id, data}) and feeding the result
 * through the VettParser. Returns null if there are no events worth
 * rendering yet (initial empty session).
 */
function buildTrajectory(events: { ts: string; event: { type: string; data?: Record<string, unknown>; text?: string } }[]): Trajectory | null {
  if (events.length === 0) return null;

  // Synthesize a stable instance_id derived from the active session
  // log path — keeps the gantt happy across re-renders with the same
  // event stream (otherwise it'd treat each render as a new session).
  const instanceId = sessionLogPath.value
    ? sessionLogPath.value.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? 'live'
    : 'live';

  const lines: string[] = [];
  let seq = 0;
  for (const { ts, event } of events) {
    seq++;
    // The data payload includes type internally too (vett emits both),
    // matching what the JSONL on disk looks like. The parser is
    // forgiving about either shape.
    const data = event.data ?? {};
    if (event.text !== undefined && (data as Record<string, unknown>).text === undefined) {
      (data as Record<string, unknown>).text = event.text;
    }
    const envelope = {
      seq,
      ts,
      type: event.type,
      instance_id: instanceId,
      data,
    };
    lines.push(JSON.stringify(envelope));
  }
  const jsonl = lines.join('\n');

  try {
    const parser = new VettParser();
    const result = parser.parse(jsonl, `${instanceId}.jsonl`);
    return result.length > 0 ? result[0] : null;
  } catch {
    return null;
  }
}
