/**
 * Gantt View — full-featured execution timeline.
 *
 * Features:
 * - Swimlane rows by activity type (AI responses, tool calls, thinking)
 * - Overview minimap
 * - Zoom/pan (scroll to zoom, drag to pan)
 * - Click bar → detail panel with conversation, tokens, throughput
 * - Playback controls (play/pause, prev/next, speed)
 * - Keyboard navigation (left/right arrows, Esc)
 * - Clickable legend to filter
 * - Time axis with dynamic ticks
 */

import { Trajectory, TrajectoryEvent, getSessionLabel } from "./types";
import { TrajectoryView, ViewOptions } from "./registry";

// ── Types ─────────────────────────────────────────────────────────────

interface TimelineEntry {
  id: number;
  type: "ai_call" | "tool_call" | "tool_result" | "thinking" | "user_message" | "system";
  label: string;
  swimlane: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  color: string;
  event: TrajectoryEvent;
  /** For tool calls: the matching result event */
  resultEvent?: TrajectoryEvent;
  isError: boolean;
  tokens?: { input: number; output: number; cached: number };
  model?: string;
  detail: string;
  /** Running total of input tokens at this point (in K) */
  cumulativeTokensK?: number;
}

interface GanttState {
  entries: TimelineEntry[];
  swimlanes: string[];
  minTime: number;
  maxTime: number;
  totalMs: number;
  // Zoom/pan
  viewStart: number; // 0-1 (fraction of total timeline)
  viewEnd: number;   // 0-1
  isPanning: boolean;
  panStartX: number;
  panStartViewStart: number;
  panStartViewEnd: number;
  // Selection
  selectedId: number | null;
  // Playback
  isPlaying: boolean;
  playbackIndex: number;
  playbackSpeed: number; // ms per step
  playbackTimer: number | null;
  // Filter
  highlightType: string | null;
  // Nav mode
  chronoNav: boolean; // true = chronological, false = within same row
  // Expand all detail panels
  expandAll: boolean;
  // Agent display mode: "split" = one row per agent, "merge" = all in one row, "expand" = full lanes per agent
  agentMode: "split" | "merge" | "expand";
  // Thinking display: "lane" = own row, "inline" = on Assistant row
  thinkingMode: "lane" | "inline";
}

// ── Colors ────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  ai_call: "#4f8ff7",
  tool_call: "#9f7aea",
  tool_result: "#2bcbba",
  thinking: "#f7b731",
  user_message: "#48bb78",
  system: "#778ca3",
};

const SWIMLANE_ORDER = ["Assistant", "Thinking", "Tool Calls", "User", "Compactions", "System"];

/** Some agent transcripts wrap IDE events, hooks, task notifications, and
 * system reminders inside `role: "user"` messages. Without filtering, the
 * User lane shows 11K "prompts" when the human really sent ~1K. This check
 * matches the dashboard's isHumanPrompt logic so counts agree across views.
 *
 * NOTE for the vett-chat lift: the original 5-char minimum-length filter
 * was specific to those transcripts (their automated user-role messages
 * tend to be tiny tags). Vett doesn't have that noise — short prompts like "HI",
 * "ok", "no" come straight from the user. We accept any non-empty
 * non-tag-soup string here. */
function isRealHumanPrompt(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 1) return false;
  if (t.startsWith("<task-notification") || t.startsWith("<task_notification")) return false;
  if (t.startsWith("<system") || t.startsWith("<System")) return false;
  if (t.startsWith("<output-file") || t.startsWith("<tool-use-id")) return false;
  if (t.startsWith("<ide_opened_file>") || t.startsWith("<ide_selection")) return false;
  if (t.startsWith("<ide_") || t.startsWith("<user-prompt-submit-hook")) return false;
  const sample = t.slice(0, 200);
  const tagChars = (sample.match(/<[^>]+>/g) || []).join("").length;
  if (tagChars > sample.length * 0.5) return false;
  return true;
}

// ── View ──────────────────────────────────────────────────────────────

let ganttState: GanttState | null = null;
let containerRef: HTMLElement | null = null;
let optionsRef: ViewOptions | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let panMoveHandler: ((e: MouseEvent) => void) | null = null;
let panUpHandler: (() => void) | null = null;

// Multi-session state
let allSessionEntries: TimelineEntry[] = [];
let allSessionSwimlanes: string[] = [];
let sessionFilterLabels: string[] = []; // labels for each session
let selectedSessionIdx = -1; // -1 = All
let isMultiSession = false;
// Pre-bucketed lookups by session label prefix. Built once when entries are
// loaded; renderGantt() and renderAllSessionsStacked() previously did
// `allSessionEntries.filter(e => e.swimlane.startsWith(prefix))` inside a
// loop over all 1145 sessions, which is O(N×M) = ~286M comparisons every
// click. With these indexes the same lookup is O(1).
let sessionEntriesByLabel: Map<string, TimelineEntry[]> = new Map();
let sessionSwimlanesByLabel: Map<string, string[]> = new Map();
// id → { entry, index } for selectEntry / playbackIndex / detail-panel idx.
// Replaces multiple O(N) findIndex/find/indexOf scans over the 250K-entry
// allSessionEntries array on every click and arrow keypress.
let entryIndexById: Map<number, { entry: TimelineEntry; index: number }> = new Map();
// swimlane → entries lookup. Used by Arrow nav so finding the next lane's
// entries is O(1) instead of an O(N) filter per keypress.
let entriesBySwimlane: Map<string, TimelineEntry[]> = new Map();
// Visual lane order across the whole stacked view, in DOM order:
// ["<label1> / Assistant", "<label1> / Tool Calls", ..., "<label2> / Assistant", ...]
// Populated by renderAllSessionsStacked. Used by ArrowUp/ArrowDown so
// vertical navigation follows what the user sees, not chronological event
// order (which would jump between sessions arbitrarily).
let stackedVisualLanes: string[] = [];
// Maps a *visual* lane key (e.g. "#6 / Agents") → the entries displayed in
// that lane. Necessary because in agentMode=merge, an agent's tool call has
// a raw swimlane like "#6 / SomeAgent / Tool Calls" but is rendered into
// the merged "#6 / Agents" lane. entriesBySwimlane (raw-swimlane keyed)
// would return undefined for "#6 / Agents", causing ArrowDown to get
// stuck. This map preserves the visual rendering grouping.
let entriesByVisualLane: Map<string, TimelineEntry[]> = new Map();
// Reverse: entry.id → visual lane it's rendered in. Used by ArrowUp/Down
// when the entry's raw swimlane doesn't appear in stackedVisualLanes
// (e.g., agent merge: entry swimlane is "#6 / Agent / Tool" but it's
// displayed in "#6 / Agents").
let entryIdToVisualLane: Map<number, string> = new Map();
function rebuildSessionIndexes() {
  sessionEntriesByLabel = new Map();
  sessionSwimlanesByLabel = new Map();
  entryIndexById = new Map();
  entriesBySwimlane = new Map();
  if (isMultiSession) {
    for (const label of sessionFilterLabels) {
      sessionEntriesByLabel.set(label, []);
      sessionSwimlanesByLabel.set(label, []);
    }
    for (let i = 0; i < allSessionEntries.length; i++) {
      const e = allSessionEntries[i];
      entryIndexById.set(e.id, { entry: e, index: i });
      let lanes = entriesBySwimlane.get(e.swimlane);
      if (!lanes) { lanes = []; entriesBySwimlane.set(e.swimlane, lanes); }
      lanes.push(e);
      // swimlane format: "<sessionLabel> / <laneName>"
      const slash = e.swimlane.indexOf(" / ");
      if (slash < 0) continue;
      const label = e.swimlane.slice(0, slash);
      const list = sessionEntriesByLabel.get(label);
      if (list) list.push(e);
    }
    for (const lane of allSessionSwimlanes) {
      const slash = lane.indexOf(" / ");
      if (slash < 0) continue;
      const label = lane.slice(0, slash);
      const list = sessionSwimlanesByLabel.get(label);
      if (list) list.push(lane);
    }
  } else {
    // Single-session: still build the id index + swimlane index for O(1) lookups.
    for (let i = 0; i < allSessionEntries.length; i++) {
      const e = allSessionEntries[i];
      entryIndexById.set(e.id, { entry: e, index: i });
      let lanes = entriesBySwimlane.get(e.swimlane);
      if (!lanes) { lanes = []; entriesBySwimlane.set(e.swimlane, lanes); }
      lanes.push(e);
    }
  }
}

export const ganttView: TrajectoryView = {
  id: "gantt",
  name: "Timeline",
  description: "Execution timeline with zoom, click-to-inspect, and playback",
  icon: "\u2500",
  tier: "core",

  css: `
    .tg {
      font-family: var(--tv-font);
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      overflow-y: auto;
    }

    /* ── Controls ── */
    .tg-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background: var(--tv-bg-card);
      border: 1px solid var(--tv-border);
      border-radius: var(--tv-radius) var(--tv-radius) 0 0;
      flex-wrap: wrap;
      font-size: 12px;
      flex-shrink: 0;
    }
    .tg-controls-group {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .tg-ctrl-btn {
      padding: 4px 10px;
      border: 1px solid var(--tv-border);
      border-radius: 4px;
      background: var(--tv-bg);
      color: var(--tv-text);
      cursor: pointer;
      font-size: 13px;
      transition: all 0.1s;
      line-height: 1.4;
    }
    .tg-ctrl-btn:hover { background: var(--tv-bg-hover); }
    .tg-ctrl-btn.tg-active { background: var(--tv-accent); color: #fff; border-color: var(--tv-accent); }
    .tg-ctrl-btn:disabled { opacity: 0.3; cursor: default; pointer-events: none; }
    .tg-speed-btn { min-width: 30px; text-align: center; font-size: 11px; padding: 3px 6px; }
    .tg-step-counter {
      font-family: var(--tv-mono);
      font-size: 12px;
      color: var(--tv-text-secondary);
      min-width: 60px;
      text-align: center;
      font-weight: 600;
    }
    .tg-spacer { flex: 1; }

    .tg-minimap, .tg-scroll-hint, .tg-time-axis, .tg-swimlanes, .tg-legend {
      flex-shrink: 0;
    }

    /* ── Minimap ── */
    .tg-minimap {
      position: relative;
      height: 32px;
      background: var(--tv-bg-badge);
      border-left: 1px solid var(--tv-border);
      border-right: 1px solid var(--tv-border);
      cursor: pointer;
      overflow: hidden;
    }
    .tg-minimap-bar {
      position: absolute;
      height: 100%;
      opacity: 0.7;
    }
    .tg-minimap-viewport {
      position: absolute;
      top: 0;
      height: 100%;
      background: transparent;
      border: 1.5px solid #fff;
      pointer-events: auto;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35);
      cursor: grab;
      z-index: 2;
    }
    .tg-minimap-viewport:active {
      cursor: grabbing;
    }
    .tg-minimap-label {
      position: absolute;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 10px;
      color: var(--tv-text-muted);
      pointer-events: none;
      z-index: 2;
      background: var(--tv-bg-card, rgba(30,30,30,0.85));
      padding: 1px 6px;
      border-radius: 3px;
    }

    /* ── Scroll Hint ── */
    .tg-scroll-hint {
      font-size: 10px;
      color: var(--tv-text-muted);
      padding: 2px 0 2px 110px;
      background: var(--tv-bg-card);
      border-left: 1px solid var(--tv-border);
      border-right: 1px solid var(--tv-border);
    }

    /* ── Time Axis ── */
    .tg-time-axis {
      position: relative;
      height: 26px;
      background: var(--tv-bg-card);
      border-left: 1px solid var(--tv-border);
      border-right: 1px solid var(--tv-border);
      border-bottom: 1px solid var(--tv-border);
      overflow: hidden;
    }
    .tg-tick {
      position: absolute;
      top: 0;
      font-size: 10px;
      font-family: var(--tv-mono);
      color: var(--tv-text-muted);
      transform: translateX(-50%);
      white-space: nowrap;
      line-height: 26px;
    }

    /* ── Swimlanes ── */
    .tg-swimlanes {
      background: var(--tv-bg-card);
      border-left: 1px solid var(--tv-border);
      border-right: 1px solid var(--tv-border);
      border-bottom: 1px solid var(--tv-border);
      border-radius: 0 0 var(--tv-radius) var(--tv-radius);
      overflow-x: hidden;
      overflow-y: auto;
      max-height: 40vh;
      cursor: grab;
      user-select: none;
    }
    .tg-swimlanes.tg-panning { cursor: grabbing; }
    .tg-session-selector {
      display: flex; align-items: center; gap: 8px; padding: 4px 16px;
      background: var(--tv-bg-card); border-left: 1px solid var(--tv-border); border-right: 1px solid var(--tv-border);
    }
    .tg-session-dropdown {
      padding: 4px 8px; font-size: 12px; border: 1px solid var(--tv-border); border-radius: 4px;
      background: var(--tv-bg); color: var(--tv-text); font-family: var(--tv-font); cursor: pointer;
    }
    .tg-session-header {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      color: var(--tv-text);
      background: color-mix(in srgb, var(--tv-accent) 12%, var(--tv-bg-card));
      border-bottom: 2px solid var(--tv-accent);
      border-top: 1px solid var(--tv-border);
    }
    .tg-session-header:first-child { border-top: none; }
    .tg-agent-header {
      padding: 4px 12px 4px 24px;
      font-size: 11px;
      font-weight: 600;
      color: #ed8936;
      background: color-mix(in srgb, #ed8936 6%, var(--tv-bg-card));
      border-bottom: 1px solid color-mix(in srgb, #ed8936 30%, var(--tv-border));
      border-left: 3px solid #ed8936;
    }
    .tg-swimlane {
      display: flex;
      align-items: stretch;
      min-height: 40px;
      border-bottom: 1px solid var(--tv-border);
    }
    .tg-swimlane:last-child { border-bottom: none; }
    .tg-swimlane:nth-child(even) {
      background: color-mix(in srgb, var(--tv-bg-hover) 50%, transparent);
    }
    .tg-swimlane-label {
      width: 130px;
      padding: 0 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--tv-accent);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      cursor: default;
    }
    .tg-swimlane-label.tg-label-wide { width: 220px; }
    /* Narrow viewports: the 130px / 220px label gutter is most of the
       screen on a phone, leaving the actual timeline unreadably small.
       Trim labels and let bars span more of the width below 600px. */
    @media (max-width: 600px) {
      .tg-swimlane-label { width: 80px; font-size: 9px; padding: 0 4px; }
      .tg-swimlane-label.tg-label-wide { width: 120px; font-size: 9px; }
    }
    .tg-swimlane-track {
      flex: 1;
      position: relative;
      min-height: 36px;
      overflow: hidden;
    }
    .tg-bar {
      position: absolute;
      height: 24px;
      top: 6px;
      border-radius: 3px;
      min-width: 3px;
      cursor: pointer;
      transition: opacity 0.1s, box-shadow 0.1s;
      opacity: 0.9;
    }
    .tg-bar:hover {
      opacity: 1;
      z-index: 5;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    .tg-bar-marker {
      width: 3px !important;
      min-width: 3px;
      border-radius: 1px;
      opacity: 1;
    }
    .tg-bar.tg-selected {
      opacity: 1;
      outline: 2px solid var(--tv-text);
      outline-offset: 1px;
      z-index: 10;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
    }
    .tg-bar.tg-error {
      background-image: repeating-linear-gradient(
        45deg, transparent, transparent 3px,
        rgba(255,255,255,0.2) 3px, rgba(255,255,255,0.2) 6px
      );
      border-bottom: 3px solid var(--tv-error);
    }
    .tg-bar.tg-dimmed { opacity: 0.15; }
    .tg-bar-label {
      font-size: 10px;
      color: #fff;
      padding: 0 5px;
      line-height: 24px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 3px rgba(0,0,0,0.4);
      font-weight: 500;
    }
    .tg-playback-cursor {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--tv-error);
      z-index: 20;
      pointer-events: none;
      box-shadow: 0 0 6px rgba(252, 92, 101, 0.5);
    }

    /* ── Legend ── */
    .tg-legend {
      display: flex;
      gap: 12px;
      padding: 10px 16px;
      flex-wrap: wrap;
      font-size: 12px;
      border-top: 1px solid var(--tv-border);
      border-bottom: 1px solid var(--tv-border);
      background: var(--tv-bg-card);
      border-left: 1px solid var(--tv-border);
      border-right: 1px solid var(--tv-border);
    }
    .tg-legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      padding: 3px 10px;
      border-radius: 4px;
      transition: background 0.1s;
    }
    .tg-legend-item:hover { background: var(--tv-bg-hover); }
    .tg-legend-item.tg-legend-active { background: var(--tv-bg-hover); font-weight: 600; }
    .tg-legend-dot { width: 12px; height: 12px; border-radius: 3px; }

    /* ── Detail Panel ── */
    .tg-detail {
      background: var(--tv-bg-card);
      border: 1px solid var(--tv-border);
      border-radius: var(--tv-radius);
      margin-top: 12px;
      overflow: hidden;
      box-shadow: var(--tv-shadow-lg);
      flex: 1;
      min-height: 250px;
      max-height: 60vh;
      display: flex;
      flex-direction: column;
    }
    .tg-detail-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 20px;
      border-bottom: 1px solid var(--tv-border);
      flex-wrap: wrap;
      font-size: 14px;
      flex-shrink: 0;
    }
    .tg-detail-type {
      font-weight: 700;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tg-detail-type-dot {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      display: inline-block;
    }
    .tg-detail-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 4px;
    }
    .tg-detail-badge-ok { background: #d1fae5; color: #065f46; }
    .tg-detail-badge-err { background: #fee2e2; color: #991b1b; }
    .tg-dark .tg-detail-badge-ok { background: #064e3b; color: #6ee7b7; }
    .tg-dark .tg-detail-badge-err { background: #450a0a; color: #fca5a5; }
    .tg-detail-metrics {
      display: flex;
      gap: 18px;
      font-size: 13px;
      color: var(--tv-text-secondary);
      flex-wrap: wrap;
      align-items: center;
    }
    .tg-detail-metrics span {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .tg-detail-metrics strong { color: var(--tv-text); }
    .tg-detail-nav {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--tv-text-muted);
    }
    .tg-detail-nav-hint {
      font-size: 10px;
      color: var(--tv-text-muted);
      margin-right: 8px;
    }
    .tg-detail-body {
      padding: 0;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .tg-msg {
      padding: 12px 20px;
      border-bottom: 1px solid var(--tv-border);
      font-size: 13px;
    }
    .tg-msg:last-child { border-bottom: none; }
    .tg-msg-role {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tg-msg-role-assistant { color: #48bb78; }
    .tg-msg-role-user { color: #4f8ff7; }
    .tg-msg-role-tool { color: #9f7aea; }
    .tg-msg-role-system { color: #778ca3; }
    .tg-msg-role-thinking { color: #f7b731; }
    .tg-msg-new {
      font-size: 9px;
      font-weight: 700;
      background: #48bb78;
      color: #fff;
      padding: 2px 6px;
      border-radius: 3px;
      letter-spacing: 0.3px;
    }
    .tg-msg-content {
      font-family: var(--tv-mono);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
      color: var(--tv-text-secondary);
      max-height: 200px;
      overflow-y: auto;
    }
    .tg-msg-tool-name {
      font-family: var(--tv-mono);
      font-weight: 600;
      color: #9f7aea;
      background: rgba(159, 122, 234, 0.1);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    .tg-context-toggle {
      padding: 8px 20px;
      font-size: 12px;
      color: var(--tv-text-muted);
      cursor: pointer;
      border-bottom: 1px solid var(--tv-border);
      transition: background 0.1s;
    }
    .tg-context-toggle:hover { background: var(--tv-bg-hover); color: var(--tv-text-secondary); }
    .tg-messages-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--tv-text-secondary);
      padding: 10px 20px 6px;
      border-bottom: 1px solid var(--tv-border);
    }
  `,

  render(container: HTMLElement, trajectories: Trajectory[], options: ViewOptions): void {
    // Clean up stale state from previous render to prevent leaks
    if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
    if (panMoveHandler) { document.removeEventListener("mousemove", panMoveHandler); panMoveHandler = null; }
    if (panUpHandler) { document.removeEventListener("mouseup", panUpHandler); panUpHandler = null; }
    if (ganttState?.playbackTimer) { clearInterval(ganttState.playbackTimer); }

    // Override the global .tv-view-container scroll defaults — the Gantt
    // manages its own internal scroll regions (minimap, swimlanes); having
    // an outer scrollbar here causes a jarring double-scroll layout.
    container.style.overflow = "hidden";

    containerRef = container;
    optionsRef = options;
    container.classList.add("tg");

    // Build entries from all trajectories
    // For multi-session: prefix swimlane names with session label
    const isMulti = trajectories.length > 1;
    const allEntries: TimelineEntry[] = [];

    for (let si = 0; si < trajectories.length; si++) {
      const traj = trajectories[si];
      const sessionLabel = getSessionLabel(traj, si);
      const entries = buildEntries(traj);
      if (isMulti) {
        for (const e of entries) {
          e.swimlane = `${sessionLabel} / ${e.swimlane}`;
        }
      }
      allEntries.push(...entries);
    }

    // Each parser numbers its entries starting at 1, so when 1145 sessions
    // are flat-mapped the same `id` shows up many times. selectEntry stores
    // selectedId as a number, and `entries.find(en => en.id === selectedId)`
    // returns the FIRST match — almost never the entry the user clicked.
    // Rewrite ids to be globally unique by using the array index. Safe
    // because TimelineEntry.id is internal to the gantt view and only used
    // as a selection / DOM key.
    for (let i = 0; i < allEntries.length; i++) allEntries[i].id = i;

    const entries = allEntries;

    if (entries.length === 0) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--tv-text-muted)">No events to display</div>';
      return;
    }

    // Build swimlane order: collect all unique lanes, ordered by group then SWIMLANE_ORDER
    const sessLabels: string[] = [];
    const allLaneNames = new Set(entries.map(e => e.swimlane));

    // Sort lanes: main lanes by SWIMLANE_ORDER, agent lanes after Assistant
    function laneSort(a: string, b: string): number {
      const aIsAgent = a.startsWith("Agent ");
      const bIsAgent = b.startsWith("Agent ");
      const aIdx = SWIMLANE_ORDER.indexOf(a);
      const bIdx = SWIMLANE_ORDER.indexOf(b);
      // Both are standard lanes
      if (!aIsAgent && !bIsAgent) return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      // Agent lanes go after Assistant (index 0) but before Tool Calls (index 1)
      if (aIsAgent && !bIsAgent) return bIdx <= 0 ? 1 : -1; // after Assistant, before everything else
      if (!aIsAgent && bIsAgent) return aIdx <= 0 ? -1 : 1;
      // Both agents: sort alphabetically
      return a.localeCompare(b);
    }

    let swimlanes: string[];
    if (isMulti) {
      swimlanes = [];
      for (let si = 0; si < trajectories.length; si++) {
        const label = getSessionLabel(trajectories[si], si);
        sessLabels.push(label);
        // Find all lanes for this session, sort: main lanes first, agent lanes after Assistant
        const sessionLanes = [...allLaneNames].filter(l => l.startsWith(label + " / ")).sort((a, b) => {
          const aBase = a.slice(label.length + 3); // strip "label / "
          const bBase = b.slice(label.length + 3);
          const aIsAgent = aBase.startsWith("Agent ");
          const bIsAgent = bBase.startsWith("Agent ");
          const aIdx = SWIMLANE_ORDER.indexOf(aBase);
          const bIdx = SWIMLANE_ORDER.indexOf(bBase);
          if (!aIsAgent && !bIsAgent) return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
          if (aIsAgent && !bIsAgent) return bIdx <= 0 ? 1 : -1;
          if (!aIsAgent && bIsAgent) return aIdx <= 0 ? -1 : 1;
          return a.localeCompare(b);
        });
        swimlanes.push(...sessionLanes);
      }
      for (const lane of allLaneNames) {
        if (!swimlanes.includes(lane)) swimlanes.push(lane);
      }
    } else {
      // Single session: main lanes first, then agent lanes sorted
      swimlanes = [...allLaneNames].sort(laneSort);
    }

    // Store multi-session state for renderGantt
    isMultiSession = isMulti;
    allSessionEntries = entries;
    allSessionSwimlanes = swimlanes;
    sessionFilterLabels = sessLabels;
    // Default to "All" — stacked view shows each session independently
    selectedSessionIdx = -1;
    rebuildSessionIndexes();

    const timestamps = entries.flatMap((e) => [e.startMs, e.endMs]).filter((t) => isFinite(t));
    if (timestamps.length === 0) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--tv-text-muted)">No timestamped events to display</div>';
      return;
    }
    let minTime = Infinity, maxTime = -Infinity;
    for (const t of timestamps) { if (t < minTime) minTime = t; if (t > maxTime) maxTime = t; }

    // Preserve existing state if same session (don't reset zoom/selection/
    // playback on re-render). The previous heuristic also required the
    // entry count to match, which failed every time a live update arrived
    // (new event = state nuked, selection lost). minTime alone is a stable
    // identifier for "same session, just with more events now."
    const isSameSession = ganttState && ganttState.minTime === minTime;

    if (isSameSession) {
      // Update entries but keep all interaction state — viewStart/viewEnd
      // (zoom + pan), selectedId, playback position, agentMode, etc.
      ganttState!.entries = entries;
      ganttState!.swimlanes = swimlanes;
      ganttState!.maxTime = maxTime;
      ganttState!.totalMs = maxTime - minTime || 1;
      ganttState!.highlightType = options.filterTool;
    } else {
      // Fresh state for new session
      // Clear any existing playback timer
      if (ganttState?.playbackTimer) {
        clearInterval(ganttState.playbackTimer);
      }
      ganttState = {
        entries,
        swimlanes,
        minTime,
        maxTime,
        totalMs: maxTime - minTime || 1,
        viewStart: 0,
        viewEnd: 1,
        isPanning: false,
        panStartX: 0,
        panStartViewStart: 0,
        panStartViewEnd: 0,
        selectedId: null,
        isPlaying: false,
        playbackIndex: 0,
        playbackSpeed: 5000,
        playbackTimer: null,
        highlightType: options.filterTool,
        chronoNav: true,
        expandAll: false,
        // Default to "expand" (full per-agent lanes) when sub-agents
        // are present so the user immediately sees the researcher /
        // implementer rows split out. Falls back to "merge" for
        // single-agent trajectories where the extra rows are noise.
        agentMode: entries.some(e => e.event.agent) ? "expand" : "merge",
        thinkingMode: "lane",
      };
    }

    renderGantt();
    setupKeyboard();
  },

  destroy() {
    if (ganttState?.playbackTimer) {
      clearInterval(ganttState.playbackTimer);
    }
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
    if (panMoveHandler) {
      document.removeEventListener("mousemove", panMoveHandler);
      panMoveHandler = null;
    }
    if (panUpHandler) {
      document.removeEventListener("mouseup", panUpHandler);
      panUpHandler = null;
    }
    ganttState = null;
    containerRef = null;
    optionsRef = null;
    allSessionEntries = [];
    allSessionSwimlanes = [];
    sessionFilterLabels = [];
    selectedSessionIdx = -1;
    isMultiSession = false;
  },
};

// ── Build Entries ─────────────────────────────────────────────────────

function buildEntries(traj: Trajectory): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const events = traj.events;

  // Pre-build O(1) lookup maps to avoid O(n²) .find() calls in the loop
  const toolResultByCallId = new Map<number, TrajectoryEvent>();
  const timestampByIndex = new Map<number, number>(); // event index → ms

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const ms = new Date(e.timestamp).getTime();
    if (!isNaN(ms)) timestampByIndex.set(i, ms);
    if (e.type === "tool_result" && e.toolResult?.toolCallEventId != null) {
      toolResultByCallId.set(e.toolResult.toolCallEventId, e);
    }
  }

  // Pre-compute "next timestamp" for each event (O(n) single pass)
  const nextTimestampById = new Map<number, number>();
  for (let i = 0; i < events.length - 1; i++) {
    const nextMs = timestampByIndex.get(i + 1);
    if (nextMs != null) nextTimestampById.set(events[i].id, nextMs);
  }

  for (const event of events) {
    const startMs = new Date(event.timestamp).getTime();
    if (isNaN(startMs)) continue;

    switch (event.type) {
      case "message": {
        if (event.role === "assistant") {
          const MAX_AI_BAR_MS = 5 * 60 * 1000; // Cap at 5 min — anything longer is user AFK
          let endMs = nextTimestampById.get(event.id) ?? startMs + 500;
          // If the gap to next event is huge, estimate from latency or token throughput
          if (endMs - startMs > MAX_AI_BAR_MS) {
            endMs = startMs + Math.min(endMs - startMs, event.tokens?.latencyMs ?? MAX_AI_BAR_MS);
          }
          entries.push({
            id: event.id,
            type: "ai_call",
            label: event.model ?? "AI Response",
            swimlane: "Assistant",
            startMs,
            endMs,
            durationMs: endMs - startMs,
            color: TYPE_COLORS.ai_call,
            event,
            isError: false,
            tokens: event.tokens ? {
              input: event.tokens.input ?? 0,
              output: event.tokens.output ?? 0,
              cached: event.tokens.cacheRead ?? 0,
            } : undefined,
            model: event.model,
            detail: event.content?.slice(0, 200) ?? "",
          });
        } else if (event.role === "user") {
          // Split real prompts from IDE/hook/system noise — see isRealHumanPrompt
          // above. Without this, a hyperactive editor stuffs the User lane with
          // tens of thousands of automated events.
          const isReal = isRealHumanPrompt(event.content);
          entries.push({
            id: event.id,
            type: isReal ? "user_message" : "system",
            label: isReal ? "User" : "System",
            swimlane: isReal ? "User" : "System",
            startMs,
            endMs: startMs + 200,
            durationMs: 200,
            color: isReal ? TYPE_COLORS.user_message : TYPE_COLORS.system,
            event,
            isError: false,
            detail: event.content?.slice(0, 200) ?? "",
          });
        }
        break;
      }

      case "tool_call": {
        const resultEvent = toolResultByCallId.get(event.id);
        let endMs = startMs + 500;
        if (resultEvent) {
          const resultMs = new Date(resultEvent.timestamp).getTime();
          if (!isNaN(resultMs) && resultMs > startMs) endMs = resultMs;
        } else if (event.durationMs) {
          endMs = startMs + event.durationMs;
        }

        entries.push({
          id: event.id,
          type: "tool_call",
          label: event.toolCall?.name ?? "Tool",
          swimlane: "Tool Calls",
          startMs,
          endMs,
          durationMs: endMs - startMs,
          color: TYPE_COLORS.tool_call,
          event,
          resultEvent,
          isError: resultEvent?.toolResult?.isError ?? false,
          tokens: event.tokens ? {
            input: event.tokens.input ?? 0,
            output: event.tokens.output ?? 0,
            cached: event.tokens.cacheRead ?? 0,
          } : undefined,
          model: event.model,
          detail: getToolDetail(event),
        });
        break;
      }

      case "thinking": {
        const MAX_THINK_BAR_MS = 2 * 60 * 1000; // Cap at 2 min
        let endMs = nextTimestampById.get(event.id) ?? startMs + 300;
        if (endMs - startMs > MAX_THINK_BAR_MS) {
          endMs = startMs + MAX_THINK_BAR_MS;
        }
        entries.push({
          id: event.id,
          type: "thinking",
          label: "Thinking",
          swimlane: "Thinking",
          startMs,
          endMs,
          durationMs: endMs - startMs,
          color: TYPE_COLORS.thinking,
          event,
          isError: false,
          detail: event.content?.slice(0, 200) ?? "",
        });
        break;
      }

      case "system": {
        // Compaction events go to Compactions lane, not System
        if (event.contextCompacted) break;
        entries.push({
          id: event.id,
          type: "system",
          label: "System",
          swimlane: "System",
          startMs,
          endMs: startMs + 100,
          durationMs: 100,
          color: TYPE_COLORS.system,
          event,
          isError: false,
          detail: event.content?.slice(0, 200) ?? "",
        });
        break;
      }
    }
  }

  // Add compaction markers
  for (const event of events) {
    if (event.contextCompacted) {
      const startMs = new Date(event.timestamp).getTime();
      if (!isNaN(startMs)) {
        entries.push({
          id: event.id,
          type: "system",
          label: "Compaction",
          swimlane: "Compactions",
          startMs,
          endMs: startMs + 500,
          durationMs: 500,
          color: "#fc5c65",
          event,
          isError: false,
          detail: "Context was compressed",
        });
      }
    }
  }

  // Sort by start time
  entries.sort((a, b) => a.startMs - b.startMs);

  // Subagent entries: prefix swimlane with agent label for all event types.
  // The display mode (merged/rows/full) is applied at render time via getLane().
  for (const entry of entries) {
    if (entry.event.agent) {
      entry.swimlane = `${entry.event.agent} / ${entry.swimlane}`;
      if (entry.type === "ai_call") entry.color = "#ed8936"; // Orange for agent AI
    }
  }

  // Compute cumulative token count (running total of input tokens)
  let cumTokens = 0;
  for (const entry of entries) {
    if (entry.tokens) {
      cumTokens += entry.tokens.input + entry.tokens.cached;
    }
    if (cumTokens > 0) {
      entry.cumulativeTokensK = Math.round(cumTokens / 1000);
    }
  }

  return entries;
}

function getToolDetail(event: TrajectoryEvent): string {
  const args = event.toolCall?.arguments;
  if (!args || typeof args === "string") return args ?? "";
  const obj = args as Record<string, unknown>;
  return (obj.command as string) ?? (obj.file_path as string) ?? (obj.path as string) ?? (obj.pattern as string) ?? JSON.stringify(obj).slice(0, 200);
}

/** Get a short description of what an agent was asked to do (first user message or first content) */
function getAgentSummary(entries: TimelineEntry[], agentPrefix: string, maxLen = 120): string {
  // Look for the first user message in this agent's entries
  for (const e of entries) {
    if (e.event.agent === agentPrefix && e.type === "user_message" && e.event.content) {
      const text = e.event.content.replace(/\s+/g, " ").trim();
      return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
    }
  }
  // Fallback: first thinking or assistant content
  for (const e of entries) {
    if (e.event.agent === agentPrefix && (e.type === "thinking" || e.type === "ai_call") && e.event.content) {
      const text = e.event.content.replace(/\s+/g, " ").trim();
      return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
    }
  }
  return "";
}

// ── Render ────────────────────────────────────────────────────────────

let savedSwimlanesScroll = 0;

/** Render all sessions stacked — each session gets its own self-contained timeline section */
function renderAllSessionsStacked() {
  if (!ganttState || !containerRef) return;
  const s = ganttState;
  containerRef.innerHTML = "";
  stackedVisualLanes = [];
  entriesByVisualLane = new Map();
  entryIdToVisualLane = new Map();

  // Session dropdown (keep it so user can switch to single session)
  const controls = el("div", "tg-controls");
  const selectorGroup = el("div", "tg-session-selector");
  const label = el("span", "");
  label.textContent = "Session: ";
  label.style.cssText = "font-size:12px;font-weight:600;color:var(--tv-text-secondary)";
  selectorGroup.appendChild(label);

  const dropdown = document.createElement("select");
  dropdown.className = "tg-session-dropdown";
  const allOpt = document.createElement("option");
  allOpt.value = "-1";
  allOpt.textContent = `All (${sessionFilterLabels.length} sessions)`;
  allOpt.selected = true;
  dropdown.appendChild(allOpt);
  for (let si = 0; si < sessionFilterLabels.length; si++) {
    const opt = document.createElement("option");
    opt.value = String(si);
    opt.textContent = sessionFilterLabels[si];
    dropdown.appendChild(opt);
  }
  dropdown.onchange = () => {
    selectedSessionIdx = Number(dropdown.value);
    s.viewStart = 0; s.viewEnd = 1; s.selectedId = null; s.isPlaying = false;
    if (s.playbackTimer) { clearInterval(s.playbackTimer); s.playbackTimer = null; }
    s.playbackIndex = 0;
    renderGantt();
  };
  selectorGroup.appendChild(dropdown);
  controls.appendChild(selectorGroup);

  const spacer = el("div", "tg-spacer");
  controls.appendChild(spacer);

  // Agent mode toggle
  const hasAgents = allSessionEntries.some(e => e.event.agent);
  if (hasAgents) {
    const modeLabels = { merge: "Agents: Merged", split: "Agents: Rows", expand: "Agents: Full" };
    const modeTooltips = { merge: "All sub-agents combined into one row", split: "One row per sub-agent", expand: "Full lanes per sub-agent (User, Assistant, Tool Calls)" };
    const nextMode = { merge: "split" as const, split: "expand" as const, expand: "merge" as const };
    const agentBtn = el("button", "tg-ctrl-btn");
    agentBtn.textContent = modeLabels[s.agentMode];
    agentBtn.title = modeTooltips[s.agentMode];
    agentBtn.onclick = () => { s.agentMode = nextMode[s.agentMode]; renderGantt(); };
    controls.appendChild(agentBtn);
  }

  // Thinking toggle
  // Thinking-lane toggle hidden by request (Apr 30) — the default
  // ("lane") works for >95% of sessions and the toggle was visual
  // clutter. Mode + handling code kept so we can re-expose it later
  // (e.g. via Settings) if anyone asks.

  // Nav mode toggle — no re-render needed, just update the button text
  const navToggle = el("button", `tg-ctrl-btn ${s.chronoNav ? "tg-active" : ""}`);
  navToggle.textContent = s.chronoNav ? "Nav: Session" : "Nav: Row";
  navToggle.title = s.chronoNav ? "← → navigates chronologically within session" : "← → navigates within same lane";
  navToggle.onclick = () => {
    s.chronoNav = !s.chronoNav;
    navToggle.textContent = s.chronoNav ? "Nav: Session" : "Nav: Row";
    navToggle.title = s.chronoNav ? "← → navigates chronologically within session" : "← → navigates within same lane";
    navToggle.classList.toggle("tg-active", s.chronoNav);
  };
  controls.appendChild(navToggle);

  containerRef.appendChild(controls);

  // Overview minimap — shows all sessions on absolute time axis
  const minimap = el("div", "tg-minimap");
  // Compute global time bounds
  let globalMin = Infinity, globalMax = -Infinity;
  for (const e of allSessionEntries) {
    if (isFinite(e.startMs) && e.startMs < globalMin) globalMin = e.startMs;
    if (isFinite(e.endMs) && e.endMs > globalMax) globalMax = e.endMs;
  }
  const globalSpan = globalMax - globalMin || 1;
  for (const entry of allSessionEntries) {
    const bar = el("div", "tg-minimap-bar");
    const left = ((entry.startMs - globalMin) / globalSpan) * 100;
    const width = Math.max(((entry.durationMs) / globalSpan) * 100, 0.2);
    bar.style.left = `${left}%`;
    bar.style.width = `${width}%`;
    bar.style.background = entry.color;
    minimap.appendChild(bar);
  }
  // Viewport indicator
  const viewport = el("div", "tg-minimap-viewport");
  viewport.style.left = `${s.viewStart * 100}%`;
  viewport.style.width = `${(s.viewEnd - s.viewStart) * 100}%`;
  minimap.appendChild(viewport);

  const mmLabel = el("div", "tg-minimap-label");
  mmLabel.textContent = "Overview";
  minimap.appendChild(mmLabel);

  // Zoom handler for stacked view
  const handleStackedZoom = (evt: WheelEvent) => {
    evt.preventDefault();
    evt.stopPropagation();
    const rect = minimap.getBoundingClientRect();
    const mousePct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
    const anchor = s.viewStart + mousePct * (s.viewEnd - s.viewStart);
    const zoomFactor = evt.deltaY > 0 ? 1.25 : 0.75;
    let newStart = anchor - (anchor - s.viewStart) * zoomFactor;
    let newEnd = anchor + (s.viewEnd - anchor) * zoomFactor;
    const span = newEnd - newStart;
    if (span > 1) { newStart = 0; newEnd = 1; }
    else if (span < 0.005) return;
    else {
      if (newStart < 0) { newEnd += -newStart; newStart = 0; }
      if (newEnd > 1) { newStart -= (newEnd - 1); newEnd = 1; }
    }
    s.viewStart = Math.max(0, newStart);
    s.viewEnd = Math.min(1, newEnd);
    renderGantt();
  };
  minimap.addEventListener("wheel", handleStackedZoom, { passive: false });

  // Click minimap to jump, drag viewport to pan
  let isDraggingViewport = false;
  let dragStartX = 0;
  let dragStartViewStart = 0;

  viewport.style.cursor = "grab";
  viewport.addEventListener("mousedown", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    isDraggingViewport = true;
    dragStartX = evt.clientX;
    dragStartViewStart = s.viewStart;
    viewport.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (evt) => {
    if (!isDraggingViewport) return;
    const rect = minimap.getBoundingClientRect();
    const dx = (evt.clientX - dragStartX) / rect.width;
    const viewWidth = s.viewEnd - s.viewStart;
    let newStart = dragStartViewStart + dx;
    if (newStart < 0) newStart = 0;
    if (newStart + viewWidth > 1) newStart = 1 - viewWidth;
    s.viewStart = newStart;
    s.viewEnd = newStart + viewWidth;
    // Update viewport position without full re-render
    viewport.style.left = `${s.viewStart * 100}%`;
    viewport.style.width = `${(s.viewEnd - s.viewStart) * 100}%`;
  });

  document.addEventListener("mouseup", () => {
    if (isDraggingViewport) {
      isDraggingViewport = false;
      viewport.style.cursor = "grab";
      renderGantt(); // Re-render with new position
    }
  });

  // Click minimap (not on viewport) to jump
  minimap.addEventListener("click", (evt) => {
    if (isDraggingViewport) return;
    if (evt.target === viewport) return;
    const rect = minimap.getBoundingClientRect();
    const pct = (evt.clientX - rect.left) / rect.width;
    const viewWidth = s.viewEnd - s.viewStart;
    s.viewStart = Math.max(0, Math.min(1 - viewWidth, pct - viewWidth / 2));
    s.viewEnd = s.viewStart + viewWidth;
    renderGantt();
  });

  containerRef.appendChild(minimap);

  const scrollHint = el("div", "tg-scroll-hint");
  scrollHint.textContent = "Scroll on overview to zoom · Ctrl+Scroll anywhere to zoom";
  containerRef.appendChild(scrollHint);

  // One shared swimlanes container for all sessions (single scrollbar)
  const sharedSwimlanes = el("div", "tg-swimlanes");

  // Swimlanes: normal scroll to browse, Ctrl+Scroll also zooms (undocumented power-user feature)
  sharedSwimlanes.addEventListener("wheel", (evt) => {
    if (!evt.ctrlKey) return;
    evt.preventDefault();
    evt.stopPropagation();
    const rect = sharedSwimlanes.getBoundingClientRect();
    const mousePct = Math.max(0, Math.min(1, (evt.clientX - rect.left - 100) / (rect.width - 100)));
    const anchor = s.viewStart + mousePct * (s.viewEnd - s.viewStart);
    const zoomFactor = evt.deltaY > 0 ? 1.25 : 0.75;
    let newStart = anchor - (anchor - s.viewStart) * zoomFactor;
    let newEnd = anchor + (s.viewEnd - anchor) * zoomFactor;
    const span = newEnd - newStart;
    if (span > 1) { newStart = 0; newEnd = 1; }
    else if (span < 0.005) return;
    else {
      if (newStart < 0) { newEnd += -newStart; newStart = 0; }
      if (newEnd > 1) { newStart -= (newEnd - 1); newEnd = 1; }
    }
    s.viewStart = Math.max(0, newStart);
    s.viewEnd = Math.min(1, newEnd);
    renderGantt();
  }, { passive: false });

  // Render each session as its own section within the shared container
  for (let si = 0; si < sessionFilterLabels.length; si++) {
    const label = sessionFilterLabels[si];
    const prefix = label + " / ";
    // O(1) lookup vs the previous O(N) per-iteration filter — was the
    // dominant cost for "open" with 1145 sessions.
    const sessionEntries = sessionEntriesByLabel.get(label) ?? [];
    if (sessionEntries.length === 0) continue;

    // Strip the session prefix from swimlane names for display
    const strippedEntries = sessionEntries.map(e => ({ ...e, swimlane: e.swimlane.slice(prefix.length) }));

    // Compute time bounds for this session
    let tMin = Infinity, tMax = -Infinity;
    for (const e of strippedEntries) {
      if (isFinite(e.startMs) && e.startMs < tMin) tMin = e.startMs;
      if (isFinite(e.endMs) && e.endMs > tMax) tMax = e.endMs;
    }
    const tSpan = tMax - tMin || 1;

    // Session header
    const header = el("div", "tg-session-header");
    header.textContent = sessionFilterLabels[si];
    header.style.cursor = "pointer";
    header.title = "Click to view this session";
    header.onclick = () => {
      selectedSessionIdx = si;
      s.viewStart = 0; s.viewEnd = 1; s.selectedId = null;
      renderGantt();
    };
    sharedSwimlanes.appendChild(header);

    // Build lane → entries map for this session
    const sessionLaneMap = new Map<string, typeof strippedEntries>();
    for (const entry of strippedEntries) {
      let lane = entry.swimlane;
      // Apply agent merge mode
      if (entry.event.agent) {
        if (s.agentMode === "merge") {
          lane = "Agents";
        } else if (s.agentMode === "split") {
          const parts = lane.split(" / ");
          const lastPart = parts[parts.length - 1];
          if (SWIMLANE_ORDER.includes(lastPart)) parts.pop();
          lane = parts.join(" / ");
        }
      }
      // Apply thinking inline mode
      if (s.thinkingMode === "inline" && entry.type === "thinking" && (lane === "Thinking" || lane.endsWith(" / Thinking"))) {
        lane = lane.replace("Thinking", "Assistant");
      }
      let arr = sessionLaneMap.get(lane);
      if (!arr) { arr = []; sessionLaneMap.set(lane, arr); }
      arr.push(entry);
    }

    // Order lanes: main lanes first (by SWIMLANE_ORDER), then agent lanes grouped by agent prefix
    const orderedLanes: string[] = [];
    const added = new Set<string>();
    for (const base of SWIMLANE_ORDER) {
      if (sessionLaneMap.has(base) && !added.has(base)) {
        orderedLanes.push(base); added.add(base);
      }
    }
    // Group remaining lanes (agent lanes) by their parent prefix
    const agentGroups = new Map<string, string[]>();
    const ungrouped: string[] = [];
    for (const l of sessionLaneMap.keys()) {
      if (added.has(l)) continue;
      if (l.includes(" / ")) {
        const parts = l.split(" / ");
        const group = parts.slice(0, -1).join(" / ");
        let arr = agentGroups.get(group);
        if (!arr) { arr = []; agentGroups.set(group, arr); }
        arr.push(l);
      } else {
        ungrouped.push(l);
      }
    }
    // Add ungrouped lanes
    for (const l of ungrouped) { orderedLanes.push(l); added.add(l); }
    // Add agent groups: each group's sub-lanes sorted by SWIMLANE_ORDER
    for (const [, lanes] of agentGroups) {
      lanes.sort((a, b) => {
        const aBase = a.split(" / ").pop()!;
        const bBase = b.split(" / ").pop()!;
        const aIdx = SWIMLANE_ORDER.indexOf(aBase);
        const bIdx = SWIMLANE_ORDER.indexOf(bBase);
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      });
      for (const l of lanes) { orderedLanes.push(l); added.add(l); }
    }

    // Render lanes (append to shared container, no separate scroll)
    const swimlanesEl = document.createDocumentFragment();

    const LANE_LABEL_COLORS: Record<string, string> = {
      "Assistant": "#4f8ff7", "Thinking": "#f7b731", "Tool Calls": "#9f7aea",
      "User": "#48bb78", "System": "#778ca3", "Agents": "#ed8936", "Compactions": "#fc5c65",
    };

    let lastAgentGroup = "";
    for (const lane of orderedLanes) {
      const laneEntries = sessionLaneMap.get(lane) || [];
      if (laneEntries.length === 0) continue;
      // Record this lane in the global visual order. Use prefix + lane so
      // it's unique across sessions; ArrowUp/Down navigates this array.
      const visualLaneKey = prefix + lane;
      stackedVisualLanes.push(visualLaneKey);
      // And remember which entries are actually rendered into this lane
      // (in agent merge / thinking inline modes the entries' raw swimlane
      // doesn't match the displayed lane name, so we can't recover this
      // grouping from entriesBySwimlane).
      entriesByVisualLane.set(visualLaneKey, laneEntries);
      for (const e of laneEntries) entryIdToVisualLane.set(e.id, visualLaneKey);

      // Agent group headers (for expand/split modes)
      if (lane.includes(" / ")) {
        const group = lane.split(" / ").slice(0, -1).join(" / ");
        if (group !== lastAgentGroup) {
          lastAgentGroup = group;
          const agentHeader = el("div", "tg-agent-header");
          const summary = getAgentSummary(strippedEntries, group);
          agentHeader.textContent = summary ? `${group} — ${summary}` : group;
          agentHeader.title = summary || group;
          swimlanesEl.appendChild(agentHeader);
        }
      }

      const row = el("div", "tg-swimlane");
      const lbl = el("div", "tg-swimlane-label");
      const baseLane = lane.includes(" / ") ? lane.split(" / ").pop()! : lane;
      const isAgentLane = lane.includes(" / ") && SWIMLANE_ORDER.includes(baseLane);
      lbl.textContent = isAgentLane ? `Agent ${baseLane}` : baseLane;
      if (LANE_LABEL_COLORS[baseLane]) lbl.style.color = LANE_LABEL_COLORS[baseLane];
      else lbl.style.color = "#ed8936"; // agent-specific lanes in orange
      row.appendChild(lbl);

      const track = el("div", "tg-swimlane-track");
      for (const entry of laneEntries) {
        const entryStart = (entry.startMs - tMin) / tSpan;
        const entryEnd = (entry.endMs - tMin) / tSpan;

        // Apply viewport zoom
        if (entryEnd < s.viewStart || entryStart > s.viewEnd) continue;
        const viewWidth = s.viewEnd - s.viewStart;
        const left = ((entryStart - s.viewStart) / viewWidth) * 100;
        const right = ((entryEnd - s.viewStart) / viewWidth) * 100;
        const width = Math.max(right - left, 0.3);

        const bar = el("div", "tg-bar");
        bar.setAttribute("data-entry-id", String(entry.id));
        bar.style.left = `${left}%`;
        bar.style.width = `${width}%`;
        bar.style.background = entry.color;
        if (entry.isError) bar.classList.add("tg-error");
        const tokLabel = entry.cumulativeTokensK ? `${entry.cumulativeTokensK}K` : "";
        bar.title = `${entry.label}${tokLabel ? ` · ${tokLabel} ctx` : ""}`;
        if (width > 5) {
          const barLabel = el("span", "tg-bar-label");
          barLabel.textContent = tokLabel ? `${entry.label} ${tokLabel}` : entry.label;
          bar.appendChild(barLabel);
        }
        bar.onclick = (ev) => {
          ev.stopPropagation();
          if (!ganttState) return;
          // Set selection state so arrow keys know where we are
          ganttState.selectedId = entry.id;
          ganttState.playbackIndex = entryIndexById.get(entry.id)?.index ?? -1;
          // Highlight bar — use live in-DOM container so morphdom-detached
          // refs don't make us query an empty tree.
          const live = liveContainer();
          live?.querySelectorAll(".tg-bar.tg-selected").forEach(b => b.classList.remove("tg-selected"));
          // ev.currentTarget is the bar that was actually clicked in the
          // DOM (which after morphdom may differ from the captured `bar`).
          (ev.currentTarget as HTMLElement)?.classList.add("tg-selected");
          // Render detail panel
          const detailEl = document.getElementById("tg-stacked-detail");
          if (detailEl) {
            detailEl.innerHTML = "";
            detailEl.appendChild(renderDetailPanel(entry, ganttState));
          }
        };
        track.appendChild(bar);
      }
      row.appendChild(track);
      swimlanesEl.appendChild(row);
    }

    sharedSwimlanes.appendChild(swimlanesEl);
  }

  containerRef.appendChild(sharedSwimlanes);

  // Detail panel — updated when a bar is clicked
  const detailContainer = el("div", "tg-stacked-detail");
  detailContainer.id = "tg-stacked-detail";
  containerRef.appendChild(detailContainer);

  // Restore selection if there was one
  if (s.selectedId != null) {
    const selectedBar = containerRef.querySelector(`.tg-bar[data-entry-id="${s.selectedId}"]`);
    if (selectedBar) {
      selectedBar.classList.add("tg-selected");
      const entry = entryIndexById.get(s.selectedId)?.entry;
      if (entry) {
        detailContainer.appendChild(renderDetailPanel(entry, s));
      }
    }
  }
}

function renderGantt() {
  if (!ganttState || !containerRef) return;
  const s = ganttState;
  // Preserve swimlanes scroll position
  const oldSwimlanes = containerRef.querySelector(".tg-swimlanes");
  if (oldSwimlanes) savedSwimlanesScroll = oldSwimlanes.scrollTop;
  containerRef.innerHTML = "";

  // Apply session filter to entries and swimlanes
  const showAllSessions = selectedSessionIdx === -1;

  // Multi-session "All" view: render each session as its own independent timeline section
  if (isMultiSession && showAllSessions) {
    renderAllSessionsStacked();
    return;
  }

  if (isMultiSession && !showAllSessions) {
    const label = sessionFilterLabels[selectedSessionIdx];
    const prefix = label + " / ";
    // O(1) lookup against the pre-built index; previously this was a full
    // O(N) string-prefix scan over allSessionEntries on every renderGantt().
    const sessEntries = sessionEntriesByLabel.get(label) ?? [];
    const sessLanes = sessionSwimlanesByLabel.get(label) ?? [];
    s.entries = sessEntries.map(e => ({ ...e, swimlane: e.swimlane.slice(prefix.length) }));
    s.swimlanes = sessLanes.map(l => l.slice(prefix.length));
  } else {
    s.entries = allSessionEntries;
    s.swimlanes = allSessionSwimlanes;
  }
  // Recalculate time bounds (single-pass to avoid stack overflow on large arrays)
  {
    let tMin = Infinity, tMax = -Infinity;
    for (const e of s.entries) {
      if (isFinite(e.startMs) && e.startMs < tMin) tMin = e.startMs;
      if (isFinite(e.endMs) && e.endMs > tMax) tMax = e.endMs;
    }
    if (isFinite(tMin) && isFinite(tMax)) {
      s.minTime = tMin; s.maxTime = tMax; s.totalMs = tMax - tMin || 1;
    }
  }

  // Render-time swimlane mapping based on agent + thinking display modes
  function getLane(entry: TimelineEntry): string {
    const lane = entry.swimlane;

    // Thinking inline mode: move "Thinking" entries to "Assistant"
    if (s.thinkingMode === "inline" && entry.type === "thinking" && (lane === "Thinking" || lane.endsWith(" / Thinking"))) {
      return lane.replace("Thinking", "Assistant");
    }

    // Check if this is an agent lane by looking at the event, not the lane name
    if (!entry.event.agent) return lane;

    if (s.agentMode === "expand") {
      // Full mode: keep all lanes as-is (agent gets own sub-lanes)
      return lane;
    }
    if (s.agentMode === "split") {
      // Rows mode: all agent events → single row per agent
      const parts = lane.split(" / ");
      const lastPart = parts[parts.length - 1];
      if (SWIMLANE_ORDER.includes(lastPart)) parts.pop();
      return parts.join(" / ");
    }
    // Merge mode: all agent events → single "Agents" row
    const parts = lane.split(" / ");
    const newParts: string[] = [];
    for (const p of parts) {
      if (SWIMLANE_ORDER.includes(p)) continue;
      if (p === entry.event.agent) continue;
      newParts.push(p);
    }
    newParts.push("Agents");
    return newParts.join(" / ");
  }

  // Rebuild effective swimlane list based on mode
  {
    const effectiveLanes = [...new Set(s.entries.map(getLane))];
    // Sort: keep original order structure but with effective names
    // Build ordered list: main lanes first (in SWIMLANE_ORDER), then agent lanes, then merged "Agents"
    const orderedLanes: string[] = [];
    const added = new Set<string>();
    // First: main lanes in order
    for (const base of SWIMLANE_ORDER) {
      if (effectiveLanes.includes(base) && !added.has(base)) {
        orderedLanes.push(base); added.add(base);
      }
    }
    // Then: agent lanes — keep all lanes for ONE agent contiguous instead
    // of stripe-sorting them by lane type. Without this you get
    // "researcher (task-1) / User → researcher (task-2) / User →
    //  researcher (task-1) / Assistant → researcher (task-2) / Assistant"
    // which makes a single agent's work look fractured. Group by the
    // agent prefix (everything before the trailing " / <Lane>") and
    // sort within each agent by SWIMLANE_ORDER.
    const remaining = effectiveLanes.filter(l => !added.has(l));
    const splitAgentLane = (l: string): { prefix: string; suffix: string } => {
      const idx = l.lastIndexOf(" / ");
      if (idx < 0) return { prefix: l, suffix: "" };
      const suf = l.slice(idx + 3);
      // Only treat the trailing segment as a "lane suffix" if it's a
      // recognized lane name. Otherwise the whole string is the prefix
      // (e.g. a merged "Agents" row).
      if (!SWIMLANE_ORDER.includes(suf)) return { prefix: l, suffix: "" };
      return { prefix: l.slice(0, idx), suffix: suf };
    };
    const byAgent = new Map<string, string[]>();
    const agentOrder: string[] = [];
    for (const l of remaining) {
      const { prefix } = splitAgentLane(l);
      if (!byAgent.has(prefix)) {
        byAgent.set(prefix, []);
        agentOrder.push(prefix);
      }
      byAgent.get(prefix)!.push(l);
    }
    for (const prefix of agentOrder) {
      const lanes = byAgent.get(prefix)!;
      lanes.sort((a, b) => {
        const aIdx = SWIMLANE_ORDER.indexOf(splitAgentLane(a).suffix);
        const bIdx = SWIMLANE_ORDER.indexOf(splitAgentLane(b).suffix);
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      });
      for (const lane of lanes) {
        if (!added.has(lane)) { orderedLanes.push(lane); added.add(lane); }
      }
    }
    s.swimlanes = orderedLanes;
  }

  // Precompute lane map for O(1) lookups instead of calling getLane() repeatedly
  const laneMap = new Map<number, string>();
  for (const entry of s.entries) laneMap.set(entry.id, getLane(entry));
  function getEffectiveLane(entry: TimelineEntry): string { return laneMap.get(entry.id) ?? getLane(entry); }

  const hidePlayback = isMultiSession && showAllSessions;

  // ── Controls ──
  const controls = el("div", "tg-controls");

  // Session dropdown (multi-session)
  if (isMultiSession) {
    const selectorGroup = el("div", "tg-session-selector");
    const label = el("span", "");
    label.textContent = "Session: ";
    label.style.cssText = "font-size:12px;font-weight:600;color:var(--tv-text-secondary)";
    selectorGroup.appendChild(label);

    const dropdown = document.createElement("select");
    dropdown.className = "tg-session-dropdown";
    const allOpt = document.createElement("option");
    allOpt.value = "-1";
    allOpt.textContent = `All (${allSessionEntries.length} events)`;
    allOpt.selected = selectedSessionIdx === -1;
    dropdown.appendChild(allOpt);
    for (let si = 0; si < sessionFilterLabels.length; si++) {
      const opt = document.createElement("option");
      opt.value = String(si);
      opt.textContent = sessionFilterLabels[si];
      opt.selected = selectedSessionIdx === si;
      dropdown.appendChild(opt);
    }
    dropdown.onchange = () => {
      selectedSessionIdx = Number(dropdown.value);
      s.viewStart = 0; s.viewEnd = 1; s.selectedId = null; s.isPlaying = false;
      if (s.playbackTimer) { clearInterval(s.playbackTimer); s.playbackTimer = null; }
      s.playbackIndex = 0;
      renderGantt();
    };
    selectorGroup.appendChild(dropdown);
    controls.appendChild(selectorGroup);
  }

  // Playback (hidden when viewing all sessions in multi-session)
  if (!hidePlayback) {
    const playGroup = el("div", "tg-controls-group");
    const playBtn = el("button", `tg-ctrl-btn ${s.isPlaying ? "tg-active" : ""}`);
    playBtn.textContent = s.isPlaying ? "⏸" : "▶";
    playBtn.title = s.isPlaying ? "Pause" : "Play";
    playBtn.onclick = () => togglePlayback();
    playGroup.appendChild(playBtn);

    const prevBtn = el("button", "tg-ctrl-btn");
    prevBtn.textContent = "◀";
    prevBtn.title = "Previous (←)";
    prevBtn.onclick = () => stepPlayback(-1);
    playGroup.appendChild(prevBtn);

    const nextBtn = el("button", "tg-ctrl-btn");
    nextBtn.textContent = "▶";
    nextBtn.title = "Next (→)";
    nextBtn.onclick = () => stepPlayback(1);
    playGroup.appendChild(nextBtn);

    const stopBtn = el("button", "tg-ctrl-btn");
    stopBtn.textContent = "⏹";
    stopBtn.title = "Stop";
    stopBtn.onclick = () => stopPlayback();
    playGroup.appendChild(stopBtn);

    // Speed
    for (const speed of [1, 3, 5, 7]) {
      const btn = el("button", `tg-ctrl-btn tg-speed-btn ${s.playbackSpeed === speed * 1000 ? "tg-active" : ""}`);
      btn.textContent = `${speed}s`;
      btn.onclick = () => { s.playbackSpeed = speed * 1000; renderGantt(); };
      playGroup.appendChild(btn);
    }

    const counter = el("span", "tg-step-counter");
    counter.textContent = `${s.playbackIndex + 1}/${s.entries.length}`;
    playGroup.appendChild(counter);

    controls.appendChild(playGroup);
  }

  const spacer = el("div", "tg-spacer");
  controls.appendChild(spacer);

  // Expand All — hidden for now
  // const expandBtn = ...;

  // Thinking toggle hidden — see note above.

  // Agent mode toggle — cycle: split → merge → expand → split
  const hasAgents = s.entries.some(e => e.event.agent);
  if (hasAgents) {
    const modeLabels = { merge: "Agents: Merged", split: "Agents: Rows", expand: "Agents: Full" };
    const modeTooltips = { merge: "All agents combined into one row", split: "One row per agent", expand: "Full sub-lanes per agent (User, Assistant, Tool Calls)" };
    const nextMode = { merge: "split" as const, split: "expand" as const, expand: "merge" as const };
    const agentBtn = el("button", "tg-ctrl-btn");
    agentBtn.textContent = modeLabels[s.agentMode];
    agentBtn.title = modeTooltips[s.agentMode];
    agentBtn.onclick = () => { s.agentMode = nextMode[s.agentMode]; renderGantt(); };
    controls.appendChild(agentBtn);
  }

  // Nav mode toggle
  const navToggleSingle = el("button", `tg-ctrl-btn ${s.chronoNav ? "tg-active" : ""}`);
  navToggleSingle.textContent = s.chronoNav ? "Nav: Session" : "Nav: Row";
  navToggleSingle.title = s.chronoNav ? "← → navigates chronologically" : "← → navigates within same lane";
  navToggleSingle.onclick = () => {
    s.chronoNav = !s.chronoNav;
    navToggleSingle.textContent = s.chronoNav ? "Nav: Session" : "Nav: Row";
    navToggleSingle.title = s.chronoNav ? "← → navigates chronologically" : "← → navigates within same lane";
    navToggleSingle.classList.toggle("tg-active", s.chronoNav);
  };
  controls.appendChild(navToggleSingle);

  // Zoom reset — only show when zoomed in
  const isZoomed = s.viewStart > 0.001 || s.viewEnd < 0.999;
  if (isZoomed) {
    const zoomReset = el("button", "tg-ctrl-btn");
    zoomReset.textContent = "Reset Zoom";
    zoomReset.onclick = () => { s.viewStart = 0; s.viewEnd = 1; renderGantt(); };
    controls.appendChild(zoomReset);
  }

  containerRef.appendChild(controls);

  // ── Minimap ──
  const minimap = el("div", "tg-minimap");
  for (const entry of s.entries) {
    const bar = el("div", "tg-minimap-bar");
    const left = ((entry.startMs - s.minTime) / s.totalMs) * 100;
    const width = Math.max(((entry.durationMs) / s.totalMs) * 100, 0.2);
    bar.style.left = `${left}%`;
    bar.style.width = `${width}%`;
    bar.style.background = entry.color;
    minimap.appendChild(bar);
  }
  // Viewport indicator with drag support
  const viewport = el("div", "tg-minimap-viewport");
  viewport.style.left = `${s.viewStart * 100}%`;
  viewport.style.width = `${(s.viewEnd - s.viewStart) * 100}%`;
  minimap.appendChild(viewport);

  // Drag viewport to pan
  let isDraggingVP = false;
  let vpDragStartX = 0;
  let vpDragStartView = 0;

  viewport.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingVP = true;
    vpDragStartX = e.clientX;
    vpDragStartView = s.viewStart;
    viewport.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDraggingVP) return;
    const rect = minimap.getBoundingClientRect();
    const dx = (e.clientX - vpDragStartX) / rect.width;
    const viewWidth = s.viewEnd - s.viewStart;
    let newStart = vpDragStartView + dx;
    if (newStart < 0) newStart = 0;
    if (newStart + viewWidth > 1) newStart = 1 - viewWidth;
    s.viewStart = newStart;
    s.viewEnd = newStart + viewWidth;
    viewport.style.left = `${s.viewStart * 100}%`;
  });

  document.addEventListener("mouseup", () => {
    if (isDraggingVP) {
      isDraggingVP = false;
      viewport.style.cursor = "grab";
      renderGantt();
    }
  });

  // Click minimap (not viewport) to jump
  minimap.addEventListener("click", (e) => {
    if (isDraggingVP) return;
    if (e.target === viewport) return;
    const rect = minimap.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const viewWidth = s.viewEnd - s.viewStart;
    s.viewStart = Math.max(0, Math.min(1 - viewWidth, pct - viewWidth / 2));
    s.viewEnd = s.viewStart + viewWidth;
    renderGantt();
  });
  // Overview label
  const mmLabel = el("div", "tg-minimap-label");
  mmLabel.textContent = "Overview";
  minimap.appendChild(mmLabel);
  containerRef.appendChild(minimap);

  // Scroll to zoom hint
  const scrollHint = el("div", "tg-scroll-hint");
  scrollHint.textContent = "Scroll on overview to zoom · Ctrl+Scroll anywhere to zoom";
  containerRef.appendChild(scrollHint);

  // ── Time Axis ──
  const timeAxis = el("div", "tg-time-axis");
  const viewMinMs = s.minTime + s.viewStart * s.totalMs;
  const viewMaxMs = s.minTime + s.viewEnd * s.totalMs;
  const viewSpanMs = viewMaxMs - viewMinMs;
  const tickCount = Math.min(8, Math.max(3, Math.floor(containerRef.offsetWidth / 120)));

  for (let i = 0; i <= tickCount; i++) {
    const t = new Date(viewMinMs + (viewSpanMs * i) / tickCount);
    const tick = el("span", "tg-tick");
    tick.textContent = t.toLocaleTimeString();
    tick.style.left = `${(i / tickCount) * 100}%`;
    // Edge ticks: anchor so the label stays inside the axis. Center ticks
    // use the default centered transform from CSS (translateX(-50%)).
    if (i === 0) {
      tick.style.transform = "translateX(0)"; // left-align
      tick.style.paddingLeft = "2px";
    } else if (i === tickCount) {
      tick.style.transform = "translateX(-100%)"; // right-align
      tick.style.paddingRight = "2px";
    }
    timeAxis.appendChild(tick);
  }
  containerRef.appendChild(timeAxis);

  // ── Zoom handler (shared across minimap, time axis, swimlanes) ──
  const handleZoom = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Use the full container width for mouse position
    const containerRect = containerRef!.getBoundingClientRect();
    const mousePct = Math.max(0, Math.min(1,
      (e.clientX - containerRect.left - 100) / (containerRect.width - 100)
    ));
    const anchor = s.viewStart + mousePct * (s.viewEnd - s.viewStart);

    const zoomFactor = e.deltaY > 0 ? 1.25 : 0.75;
    let newStart = anchor - (anchor - s.viewStart) * zoomFactor;
    let newEnd = anchor + (s.viewEnd - anchor) * zoomFactor;

    const span = newEnd - newStart;
    if (span > 1) { newStart = 0; newEnd = 1; }
    else if (span < 0.005) return;
    else {
      if (newStart < 0) { newEnd += -newStart; newStart = 0; }
      if (newEnd > 1) { newStart -= (newEnd - 1); newEnd = 1; }
    }

    s.viewStart = Math.max(0, newStart);
    s.viewEnd = Math.min(1, newEnd);
    renderGantt();
  };

  // Attach zoom to minimap, scroll hint, time axis
  minimap.addEventListener("wheel", handleZoom, { passive: false });
  scrollHint.addEventListener("wheel", handleZoom, { passive: false });
  timeAxis.addEventListener("wheel", handleZoom, { passive: false });

  // ── Swimlanes ──
  const swimlanesEl = el("div", "tg-swimlanes");

  // Ctrl+Scroll on swimlanes to zoom (plain scroll = natural scroll)
  swimlanesEl.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return; // Let normal scroll work
    e.preventDefault();
    e.stopPropagation();

    const rect = swimlanesEl.getBoundingClientRect();
    const mousePct = Math.max(0, Math.min(1,
      (e.clientX - rect.left - 100) / (rect.width - 100)
    ));
    const anchor = s.viewStart + mousePct * (s.viewEnd - s.viewStart);

    const zoomFactor = e.deltaY > 0 ? 1.25 : 0.75;
    let newStart = anchor - (anchor - s.viewStart) * zoomFactor;
    let newEnd = anchor + (s.viewEnd - anchor) * zoomFactor;

    // Clamp
    const span = newEnd - newStart;
    if (span > 1) { newStart = 0; newEnd = 1; }
    else if (span < 0.005) return;
    else {
      if (newStart < 0) { newEnd += -newStart; newStart = 0; }
      if (newEnd > 1) { newStart -= (newEnd - 1); newEnd = 1; }
    }

    s.viewStart = Math.max(0, newStart);
    s.viewEnd = Math.min(1, newEnd);
    renderGantt();
  }, { passive: false });

  // Pan with drag — clean up old handlers first to prevent leaks
  if (panMoveHandler) document.removeEventListener("mousemove", panMoveHandler);
  if (panUpHandler) document.removeEventListener("mouseup", panUpHandler);

  swimlanesEl.addEventListener("mousedown", (e) => {
    if (e.target !== swimlanesEl && !(e.target as HTMLElement).classList.contains("tg-swimlane-track")) return;
    s.isPanning = true;
    s.panStartX = e.clientX;
    s.panStartViewStart = s.viewStart;
    s.panStartViewEnd = s.viewEnd;
    swimlanesEl.classList.add("tg-panning");
  });
  panMoveHandler = (e: MouseEvent) => {
    if (!s.isPanning) return;
    const rect = swimlanesEl.getBoundingClientRect();
    const dx = (e.clientX - s.panStartX) / (rect.width - 100);
    const viewWidth = s.panStartViewEnd - s.panStartViewStart;
    let newStart = s.panStartViewStart - dx;
    if (newStart < 0) newStart = 0;
    if (newStart + viewWidth > 1) newStart = 1 - viewWidth;
    s.viewStart = newStart;
    s.viewEnd = newStart + viewWidth;
    renderGantt();
  };
  panUpHandler = () => {
    if (s.isPanning) {
      s.isPanning = false;
      swimlanesEl.classList.remove("tg-panning");
    }
  };
  document.addEventListener("mousemove", panMoveHandler);
  document.addEventListener("mouseup", panUpHandler);

  const LANE_LABEL_COLORS: Record<string, string> = {
    "Assistant": "#4f8ff7",
    "Thinking": "#f7b731",
    "Tool Calls": "#9f7aea",
    "User": "#48bb78",
    "System": "#778ca3",
    "Agents": "#ed8936",
    "Compactions": "#fc5c65",
  };

  // Pre-build lane → entries map (O(n) once instead of O(n) per lane)
  const laneEntriesMap = new Map<string, TimelineEntry[]>();
  const agentLanes = new Set<string>();
  for (const entry of s.entries) {
    const lane = getEffectiveLane(entry);
    let arr = laneEntriesMap.get(lane);
    if (!arr) { arr = []; laneEntriesMap.set(lane, arr); }
    arr.push(entry);
    if (entry.event.agent) agentLanes.add(lane);
  }

  // Per-session time bounds for normalized "All" view
  const sessionTimeBounds = new Map<string, { min: number; max: number; span: number }>();
  if (isMultiSession && showAllSessions) {
    for (const entry of s.entries) {
      const lane = getEffectiveLane(entry);
      const group = lane.includes(" / ") ? lane.split(" / ")[0] : "__default__";
      const existing = sessionTimeBounds.get(group);
      if (!existing) {
        sessionTimeBounds.set(group, { min: entry.startMs, max: entry.endMs, span: 0 });
      } else {
        if (entry.startMs < existing.min) existing.min = entry.startMs;
        if (entry.endMs > existing.max) existing.max = entry.endMs;
      }
    }
    for (const [, bounds] of sessionTimeBounds) {
      bounds.span = bounds.max - bounds.min || 1;
    }
  }
  // Pre-compute which groups contain agents
  const agentGroups = new Set<string>();
  for (const entry of s.entries) {
    if (entry.event.agent) {
      const lane = getEffectiveLane(entry);
      if (lane.includes(" / ")) {
        const parts = lane.split(" / ");
        agentGroups.add(parts.slice(0, -1).join(" / "));
      }
    }
  }

  // Debug: always report lane stats
  if (isMultiSession && showAllSessions && (window as any).vscodeDebugReport) {
    let mismatches = 0;
    const missingSamples: string[] = [];
    for (const sl of s.swimlanes) {
      if (!laneEntriesMap.has(sl)) {
        mismatches++;
        if (missingSamples.length < 5) missingSamples.push(sl.slice(0, 40));
      }
    }
    const mapSample = [...laneEntriesMap.keys()].slice(0, 5).map(k => k.slice(0, 40));
    (window as any).vscodeDebugReport(
      `Timeline: ${s.swimlanes.length} lanes, ${s.entries.length} entries, ${laneEntriesMap.size} map keys, ${mismatches} missing. ` +
      (mismatches > 0 ? `Missing: [${missingSamples.join("] [")}] ` : "") +
      `Map: [${mapSample.join("] [")}]`
    );
  }

  let lastGroup = "";
  const hasGroups = s.swimlanes.some(l => l.includes(" / "));
  for (const lane of s.swimlanes) {
    // Group headers for multi-session or agent Full mode
    if (hasGroups && lane.includes(" / ")) {
      const parts = lane.split(" / ");
      const group = parts.slice(0, -1).join(" / ");
      if (group !== lastGroup) {
        lastGroup = group;
        if (agentGroups.has(group)) {
          const agentName = parts.length > 2 ? parts.slice(1, -1).join(" / ") : parts[0];
          const groupHeader = el("div", "tg-agent-header");
          const summary = getAgentSummary(s.entries, group);
          groupHeader.textContent = summary ? `${agentName} — ${summary}` : agentName;
          groupHeader.title = summary || group;
          swimlanesEl.appendChild(groupHeader);
        } else {
          const groupHeader = el("div", "tg-session-header");
          groupHeader.textContent = group;
          groupHeader.title = group;
          swimlanesEl.appendChild(groupHeader);
        }
      }
    }

    // Skip empty lanes (no visible entries) — O(1) lookup
    if (!laneEntriesMap.has(lane)) continue;

    const row = el("div", "tg-swimlane");
    const label = el("div", `tg-swimlane-label${s.agentMode === "expand" ? " tg-label-wide" : ""}`);
    const baseLane = lane.includes(" / ") ? lane.split(" / ").pop()! : lane;
    const isUnderAgent = agentLanes.has(lane);
    label.textContent = isUnderAgent && SWIMLANE_ORDER.includes(baseLane) ? `Agent ${baseLane}` : baseLane;
    label.title = lane; // Full name on hover
    // Color-code: agent lanes orange, standard lanes by type
    if (LANE_LABEL_COLORS[baseLane]) {
      label.style.color = LANE_LABEL_COLORS[baseLane];
    } else if (baseLane !== "Agents") {
      // Non-standard lane (agent with description) — orange
      label.style.color = "#ed8936";
    }
    row.appendChild(label);

    const track = el("div", "tg-swimlane-track");
    const laneEntries = laneEntriesMap.get(lane) || [];

    // Get time bounds — per-session when in "All" multi-session mode, global otherwise
    const laneGroup = lane.includes(" / ") ? lane.split(" / ")[0] : "__default__";
    const timeBounds = (isMultiSession && showAllSessions) ? sessionTimeBounds.get(laneGroup) : null;
    const tMin = timeBounds ? timeBounds.min : s.minTime;
    const tSpan = timeBounds ? timeBounds.span : s.totalMs;

    for (const entry of laneEntries) {
      const entryStart = (entry.startMs - tMin) / tSpan;
      const entryEnd = (entry.endMs - tMin) / tSpan;

      // Skip if outside viewport (use 0-1 range for normalized, viewStart/viewEnd for zoomed)
      const vStart = timeBounds ? 0 : s.viewStart;
      const vEnd = timeBounds ? 1 : s.viewEnd;
      if (entryEnd < vStart || entryStart > vEnd) continue;

      // Map to viewport coordinates
      const viewWidth = timeBounds ? 1 : (s.viewEnd - s.viewStart);
      const viewOffset = timeBounds ? 0 : s.viewStart;
      const left = ((entryStart - viewOffset) / viewWidth) * 100;
      const right = ((entryEnd - viewOffset) / viewWidth) * 100;
      const width = Math.max(right - left, 0.3);

      const bar = el("div", "tg-bar");
      bar.style.left = `${left}%`;
      bar.style.width = `${width}%`;
      bar.style.background = entry.color;

      if (entry.isError) bar.classList.add("tg-error");
      if (s.selectedId === entry.id) bar.classList.add("tg-selected");
      if (s.highlightType && entry.type !== s.highlightType) bar.classList.add("tg-dimmed");
      if (entry.label === "Compaction") bar.classList.add("tg-bar-marker");

      const tokLabel = entry.cumulativeTokensK ? `${entry.cumulativeTokensK}K` : "";
      bar.title = `${entry.label} ${formatDuration(entry.durationMs)}${tokLabel ? ` · ${tokLabel} ctx` : ""}`;
      // Show label if bar is wide enough
      if (width > 5) {
        const barLabel = el("span", "tg-bar-label");
        barLabel.textContent = tokLabel
          ? `${entry.label} ${formatDuration(entry.durationMs)} · ${tokLabel}`
          : `${entry.label} ${formatDuration(entry.durationMs)}`;
        bar.appendChild(barLabel);
      }

      bar.onclick = (e) => {
        e.stopPropagation();
        selectEntry(entry.id);
      };

      track.appendChild(bar);
    }

    // Playback cursor
    if (s.isPlaying || s.selectedId != null) {
      const selectedEntry = s.entries.find((e) => e.id === s.selectedId);
      if (selectedEntry && getEffectiveLane(selectedEntry) === lane) {
        const cursorPct = ((selectedEntry.startMs - s.minTime) / s.totalMs - s.viewStart) / (s.viewEnd - s.viewStart) * 100;
        if (cursorPct >= 0 && cursorPct <= 100) {
          const cursor = el("div", "tg-playback-cursor");
          cursor.style.left = `${cursorPct}%`;
          track.appendChild(cursor);
        }
      }
    }

    row.appendChild(track);
    swimlanesEl.appendChild(row);
  }

  containerRef.appendChild(swimlanesEl);
  // Restore scroll position
  if (savedSwimlanesScroll > 0) swimlanesEl.scrollTop = savedSwimlanesScroll;

  // ── Legend ──
  const legend = el("div", "tg-legend");
  const types = [...new Set(s.entries.map((e) => e.type))];
  for (const type of types) {
    const count = s.entries.filter((e) => e.type === type).length;
    const item = el("div", `tg-legend-item ${s.highlightType === type ? "tg-legend-active" : ""}`);
    // typeLabel() falls through to the raw `type` for anything not in its
    // map, and `type` comes off the event stream (tool names, custom event
    // kinds) rather than from a fixed vocabulary — so it is escaped here
    // like every other interpolated value in this file. The CSP already
    // blocks script execution; this closes DOM/CSS injection and keeps the
    // sink consistent with renderMsg/entry.model a few lines away.
    item.innerHTML = `<div class="tg-legend-dot" style="background:${TYPE_COLORS[type] ?? '#999'}"></div>${escapeHtml(typeLabel(type))} (${count})`;
    item.onclick = () => {
      s.highlightType = s.highlightType === type ? null : type;
      renderGantt();
    };
    legend.appendChild(item);
  }
  if (s.highlightType) {
    const clear = el("div", "tg-legend-item");
    clear.textContent = "[ clear ]";
    clear.style.color = "var(--tv-accent)";
    clear.onclick = () => { s.highlightType = null; renderGantt(); };
    legend.appendChild(clear);
  }
  containerRef.appendChild(legend);

  // ── Detail Panel ──
  if (s.selectedId != null) {
    const entry = s.entries.find((e) => e.id === s.selectedId);
    if (entry) containerRef.appendChild(renderDetailPanel(entry, s));
  }
}

// ── Detail Panel ──────────────────────────────────────────────────────

function renderDetailPanel(entry: TimelineEntry, s: GanttState): HTMLElement {
  const panel = el("div", "tg-detail");
  const idx = s.entries.indexOf(entry);

  // ── Header row 1: type + badge + metrics ──
  const header = el("div", "tg-detail-header");

  const typeEl = el("div", "tg-detail-type");
  typeEl.innerHTML = `<span class="tg-detail-type-dot" style="background:${escapeHtml(entry.color)}"></span>${escapeHtml(typeLabel(entry.type))}`;
  header.appendChild(typeEl);

  if (entry.label !== typeLabel(entry.type)) {
    const labelEl = el("span", "tg-msg-tool-name");
    labelEl.textContent = entry.label;
    header.appendChild(labelEl);
  }

  const badge = el("span", `tg-detail-badge ${entry.isError ? "tg-detail-badge-err" : "tg-detail-badge-ok"}`);
  badge.textContent = entry.isError ? "Error" : "OK";
  header.appendChild(badge);

  // Metrics
  const metrics = el("div", "tg-detail-metrics");
  metrics.innerHTML = `<span><strong>${formatDuration(entry.durationMs)}</strong></span>`;
  if (entry.model) metrics.innerHTML += `<span>${escapeHtml(entry.model)}</span>`;
  if (entry.tokens) {
    const total = entry.tokens.input + entry.tokens.output;
    metrics.innerHTML += `<span><strong>${formatTokens(total)}</strong> (${formatTokens(entry.tokens.input)} in / ${formatTokens(entry.tokens.output)} out${entry.tokens.cached ? ` · ${formatTokens(entry.tokens.cached)} cached` : ""})</span>`;
    if (entry.durationMs > 0 && entry.tokens.output > 0) {
      const tps = (entry.tokens.output / (entry.durationMs / 1000)).toFixed(1);
      metrics.innerHTML += `<span><strong>${tps}</strong> t/s</span>`;
    }
    if (entry.tokens.cached > 0 && entry.tokens.input > 0) {
      const cachePct = ((entry.tokens.cached / (entry.tokens.input + entry.tokens.cached)) * 100).toFixed(0);
      metrics.innerHTML += `<span><strong>${cachePct}%</strong> cache</span>`;
    }
  }
  header.appendChild(metrics);

  // ── Nav: hints + chrono/row toggle + arrows + counter + close ──
  const nav = el("div", "tg-detail-nav");

  const hint = el("span", "tg-detail-nav-hint");
  hint.textContent = "← → next event · ↑ ↓ rows · Esc deselect";
  nav.appendChild(hint);

  // Chrono Nav / Row Nav toggle
  const navToggle = document.createElement("button");
  navToggle.className = `tg-ctrl-btn ${s.chronoNav ? "tg-active" : ""}`;
  navToggle.textContent = s.chronoNav ? "Chrono Nav" : "Row Nav";
  navToggle.title = s.chronoNav ? "Navigate chronologically" : "Navigate within same swimlane";
  navToggle.onclick = () => { s.chronoNav = !s.chronoNav; renderGantt(); };
  nav.appendChild(navToggle);

  const navCounter = el("span", "tg-step-counter");
  navCounter.textContent = `${idx + 1}/${s.entries.length}`;
  nav.appendChild(navCounter);

  const prevNav = document.createElement("button");
  prevNav.className = "tg-ctrl-btn";
  prevNav.textContent = "‹";
  prevNav.disabled = getNavTarget(s, entry, -1) == null;
  prevNav.onclick = () => { const t = getNavTarget(s, entry, -1); if (t != null) selectEntry(t); };
  nav.appendChild(prevNav);

  const nextNav = document.createElement("button");
  nextNav.className = "tg-ctrl-btn";
  nextNav.textContent = "›";
  nextNav.disabled = getNavTarget(s, entry, 1) == null;
  nextNav.onclick = () => { const t = getNavTarget(s, entry, 1); if (t != null) selectEntry(t); };
  nav.appendChild(nextNav);

  const closeNav = document.createElement("button");
  closeNav.className = "tg-ctrl-btn";
  closeNav.textContent = "×";
  closeNav.onclick = () => { s.selectedId = null; renderGantt(); };
  nav.appendChild(closeNav);

  header.appendChild(nav);
  panel.appendChild(header);

  // ── Body: context + 3 messages ──
  const body = el("div", "tg-detail-body");

  // Messages label
  const messagesLabel = el("div", "tg-messages-label");
  messagesLabel.textContent = "Messages";
  body.appendChild(messagesLabel);

  // Context (all entries before this one, scoped to same session in multi-session mode)
  let sessionPrefix = "";
  if (isMultiSession && entry.swimlane.includes(" / ")) {
    // Extract session prefix (e.g., "Session 1" from "Session 1 / Assistant")
    const slashIdx = entry.swimlane.indexOf(" / ");
    sessionPrefix = entry.swimlane.slice(0, slashIdx + 3); // include " / "
  }
  // Count first; defer the actual filter+array allocation until the user
  // expands the context section (most clicks never expand it).
  let contextCount = 0;
  for (const e of s.entries) {
    if (e.startMs < entry.startMs && (!sessionPrefix || e.swimlane.startsWith(sessionPrefix))) {
      contextCount++;
    }
  }
  if (contextCount > 0) {
    const contextToggle = el("div", "tg-context-toggle");
    let contextExpanded = s.expandAll;
    contextToggle.textContent = `${contextExpanded ? "▾" : "▸"} Context (${contextCount} messages)`;

    const contextContainer = el("div", "");
    contextContainer.style.display = contextExpanded ? "block" : "none";

    // Lazy-build context messages on first expand. Previously this loop
    // ran on every selectEntry → renderDetailPanel call, creating DOM
    // for every preceding event in the session even though the section
    // is collapsed by default. With VETT sessions of 1000s of events,
    // the late-in-session clicks were spending most of their time here.
    let contextBuilt = false;
    const buildContext = () => {
      if (contextBuilt) return;
      contextBuilt = true;
      const frag = document.createDocumentFragment();
      for (const ctx of s.entries) {
        if (ctx.startMs >= entry.startMs) continue;
        if (sessionPrefix && !ctx.swimlane.startsWith(sessionPrefix)) continue;
        frag.appendChild(renderMsg(ctx.type, getMessageLabel(ctx), ctx.detail || ctx.event.content || "", false, "60px"));
      }
      contextContainer.appendChild(frag);
    };
    if (contextExpanded) buildContext();

    contextToggle.onclick = () => {
      contextExpanded = !contextExpanded;
      contextToggle.textContent = `${contextExpanded ? "▾" : "▸"} Context (${contextCount} messages)`;
      if (contextExpanded) buildContext();
      contextContainer.style.display = contextExpanded ? "block" : "none";
    };
    body.appendChild(contextToggle);
    body.appendChild(contextContainer);
  }

  // ── Always show 3 messages ──
  // For tool_call:  RESPONSE (AI text) → tool call args → TOOL result [NEW]
  // For ai_call:    RESPONSE [NEW] (AI text) → tool call preview (if next is tool)
  // For thinking:   THINKING content
  // For user:       USER content

  const prevEntry = idx > 0 ? s.entries[idx - 1] : null;
  const nextEntry = idx < s.entries.length - 1 ? s.entries[idx + 1] : null;

  if (entry.type === "tool_call") {
    // 1. RESPONSE — the AI's text that led to this tool call
    if (prevEntry && (prevEntry.type === "ai_call" || prevEntry.type === "thinking")) {
      body.appendChild(renderMsg("ai_call", "RESPONSE", prevEntry.event.content ?? "", false, undefined, new Date(prevEntry.startMs).toLocaleTimeString()));
    }

    // 2. Tool call — show what was called with arguments
    const toolName = entry.event.toolCall?.name ?? "Tool";
    const args = entry.event.toolCall?.arguments;
    const argsStr = typeof args === "string" ? args : JSON.stringify(args, null, 2);
    body.appendChild(renderMsg("ai_call", "RESPONSE", `${toolName}(${argsStr})`, false));

    // 3. TOOL [NEW] — the result
    if (entry.resultEvent) {
      body.appendChild(renderMsg(
        entry.isError ? "system" : "tool_call",
        "TOOL",
        entry.resultEvent.toolResult?.output ?? "",
        true
      ));
    }

    // 4. Next RESPONSE [NEW] if AI responded after this tool
    if (nextEntry && nextEntry.type === "ai_call") {
      body.appendChild(renderMsg("ai_call", "RESPONSE", nextEntry.event.content ?? "", true, undefined, new Date(nextEntry.startMs).toLocaleTimeString()));
    }

  } else if (entry.type === "ai_call") {
    // 1. RESPONSE [NEW] — the AI's text
    body.appendChild(renderMsg("ai_call", "RESPONSE", entry.event.content ?? "", true, undefined, new Date(entry.startMs).toLocaleTimeString()));

    // 2. Next tool call preview if adjacent
    if (nextEntry && nextEntry.type === "tool_call") {
      const toolName = nextEntry.event.toolCall?.name ?? "Tool";
      const args = nextEntry.event.toolCall?.arguments;
      const argsStr = typeof args === "string" ? args : JSON.stringify(args, null, 2);
      body.appendChild(renderMsg("tool_call", toolName, argsStr, true));

      // 3. Tool result if available
      if (nextEntry.resultEvent) {
        body.appendChild(renderMsg(
          nextEntry.isError ? "system" : "tool_call",
          "TOOL",
          nextEntry.resultEvent.toolResult?.output ?? "",
          true
        ));
      }
    }

  } else if (entry.type === "thinking") {
    body.appendChild(renderMsg("thinking", "THINKING", entry.event.content ?? "", true));

    // Show next response if available
    if (nextEntry && nextEntry.type === "ai_call") {
      body.appendChild(renderMsg("ai_call", "RESPONSE", nextEntry.event.content ?? "", true, undefined, new Date(nextEntry.startMs).toLocaleTimeString()));
    }

  } else {
    // User or system message
    const label = entry.type === "user_message" ? "USER" : "SYSTEM";
    body.appendChild(renderMsg(entry.type, label, entry.event.content ?? "", true));

    if (nextEntry) {
      if (nextEntry.type === "ai_call") {
        body.appendChild(renderMsg("ai_call", "RESPONSE", nextEntry.event.content ?? "", true, undefined, new Date(nextEntry.startMs).toLocaleTimeString()));
      } else if (nextEntry.type === "thinking") {
        body.appendChild(renderMsg("thinking", "THINKING", (nextEntry.event.content ?? "").slice(0, 300), true));
      }
    }
  }

  panel.appendChild(body);
  return panel;
}

/** Render a single message block */
function renderMsg(type: string, label: string, content: string, isNew: boolean, maxHeight?: string, time?: string): HTMLElement {
  const msg = el("div", "tg-msg");
  if (!isNew) msg.style.opacity = "0.7";

  const roleClass = type === "ai_call" ? "tg-msg-role-assistant"
    : type === "tool_call" ? "tg-msg-role-tool"
    : type === "thinking" ? "tg-msg-role-thinking"
    : type === "user_message" ? "tg-msg-role-user"
    : "tg-msg-role-system";

  const role = el("div", `tg-msg-role ${roleClass}`);
  let roleHtml = escapeHtml(label);
  if (isNew) roleHtml += ` <span class="tg-msg-new">NEW</span>`;
  if (time) roleHtml += ` <span style="font-weight:400;font-size:10px;color:var(--tv-text-muted)">${time}</span>`;
  role.innerHTML = roleHtml;
  msg.appendChild(role);

  const contentEl = el("div", "tg-msg-content");
  contentEl.textContent = content;
  if (maxHeight) contentEl.style.maxHeight = maxHeight;
  msg.appendChild(contentEl);

  return msg;
}

/** Get navigation target based on Chrono vs Row mode */
function getNavTarget(s: GanttState, current: TimelineEntry, dir: number): number | undefined {
  const idx = s.entries.indexOf(current);

  if (s.chronoNav) {
    // Chronological: just go to next/prev in time order
    const target = s.entries[idx + dir];
    return target?.id;
  } else {
    // Row nav: find next/prev in same swimlane
    const sameLane = s.entries.filter((e) => e.swimlane === current.swimlane);
    const laneIdx = sameLane.indexOf(current);
    const target = sameLane[laneIdx + dir];
    return target?.id;
  }
}

function getMessageLabel(entry: TimelineEntry): string {
  switch (entry.type) {
    case "ai_call": return "RESPONSE";
    case "tool_call": return `TOOL ${entry.label}`;
    case "tool_result": return "RESULT";
    case "thinking": return "THINKING";
    case "user_message": return "USER";
    default: return "SYSTEM";
  }
}

// ── Selection & Playback ──────────────────────────────────────────────

/**
 * Return the gantt container that is CURRENTLY in the DOM. After a morphdom
 * pass that diffed the view container's children, the cached `containerRef`
 * may point to a detached freshly-built element (the one this render's
 * render() received). Click handlers must instead query the in-DOM element
 * so .classList changes are visible to the user.
 */
function liveContainer(): HTMLElement | null {
  if (containerRef?.isConnected) return containerRef;
  return document.querySelector(".tv-view-container") as HTMLElement | null;
}

/** Update state and re-render (single render, no double-calls) */
function selectEntry(id: number | undefined) {
  if (!ganttState || id == null) return;
  ganttState.selectedId = id;
  // O(1) lookup via id index instead of findIndex/find scans over 250K entries
  const indexed = entryIndexById.get(id);
  ganttState.playbackIndex = indexed ? indexed.index : -1;

  // In stacked "All" mode: update detail panel and highlight without full re-render
  const live = liveContainer();
  if (isMultiSession && selectedSessionIdx === -1 && live) {
    const entry = indexed?.entry;
    if (entry) {
      // Update highlight — query the IN-DOM container, not the cached ref
      // (which after morphdom may point to a detached new-tree element).
      live.querySelectorAll(".tg-bar.tg-selected").forEach(b => b.classList.remove("tg-selected"));
      const matchingBar = live.querySelector(`.tg-bar[data-entry-id="${id}"]`);
      if (matchingBar) {
        matchingBar.classList.add("tg-selected");
        matchingBar.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      // Update detail panel
      const detailEl = document.getElementById("tg-stacked-detail");
      if (detailEl) {
        detailEl.innerHTML = "";
        detailEl.appendChild(renderDetailPanel(entry, ganttState));
      }
    }
    return;
  }

  // Single session mode: try to update in place without a full re-render.
  // Full renderGantt() rebuilds every bar, axis tick, and swimlane row —
  // ~1s with 250K entries on the page, even when only the selection changed.
  // Skip it when (a) the entry is already inside the visible viewport, and
  // (b) the bar is mounted in the DOM. Only fall back to full render when
  // we genuinely need to pan.
  const entry = ganttState.entries.find((e) => e.id === id);
  if (!entry) { renderGantt(); return; }

  const entryPct = (entry.startMs - ganttState.minTime) / ganttState.totalMs;
  const needsPan = entryPct < ganttState.viewStart || entryPct > ganttState.viewEnd;

  if (needsPan) {
    const viewWidth = ganttState.viewEnd - ganttState.viewStart;
    ganttState.viewStart = Math.max(0, entryPct - viewWidth * 0.3);
    ganttState.viewEnd = Math.min(1, ganttState.viewStart + viewWidth);
    renderGantt();
    return;
  }

  // In-viewport selection — class swap + detail panel only
  const liveSingle = liveContainer();
  if (!liveSingle) { renderGantt(); return; }

  const matchingBar = liveSingle.querySelector(`.tg-bar[data-entry-id="${id}"]`);
  if (!matchingBar) { renderGantt(); return; }

  liveSingle.querySelectorAll(".tg-bar.tg-selected").forEach(b => b.classList.remove("tg-selected"));
  matchingBar.classList.add("tg-selected");

  // Replace any existing detail panel; otherwise append a new one.
  const existingDetail = liveSingle.querySelector(".tg-detail");
  const newDetail = renderDetailPanel(entry, ganttState);
  if (existingDetail) existingDetail.replaceWith(newDetail);
  else liveSingle.appendChild(newDetail);
}

function togglePlayback() {
  if (!ganttState) return;
  if (ganttState.isPlaying) {
    // Pause
    ganttState.isPlaying = false;
    if (ganttState.playbackTimer) {
      clearInterval(ganttState.playbackTimer);
      ganttState.playbackTimer = null;
    }
    renderGantt();
  } else {
    // Play
    ganttState.isPlaying = true;
    if (ganttState.playbackIndex >= ganttState.entries.length - 1) {
      ganttState.playbackIndex = 0;
    }
    // Select first entry without starting timer yet
    ganttState.selectedId = ganttState.entries[ganttState.playbackIndex]?.id ?? null;
    // Start timer
    ganttState.playbackTimer = window.setInterval(() => {
      stepPlayback(1);
    }, ganttState.playbackSpeed);
    renderGantt(); // single render
  }
}

function stopPlayback() {
  if (!ganttState) return;
  if (ganttState.playbackTimer) {
    clearInterval(ganttState.playbackTimer);
    ganttState.playbackTimer = null;
  }
  ganttState.isPlaying = false;
  ganttState.playbackIndex = 0;
  ganttState.selectedId = null;
  renderGantt(); // single render
}

function stepPlayback(dir: number) {
  if (!ganttState) return;
  let idx = ganttState.playbackIndex + dir;
  if (idx < 0) idx = 0;
  if (idx >= ganttState.entries.length) {
    // Reached end — stop
    if (ganttState.playbackTimer) {
      clearInterval(ganttState.playbackTimer);
      ganttState.playbackTimer = null;
    }
    ganttState.isPlaying = false;
    renderGantt();
    return;
  }
  ganttState.playbackIndex = idx;
  selectEntry(ganttState.entries[idx]?.id);
}

// ── Keyboard ──────────────────────────────────────────────────────────

function setupKeyboard() {
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = (e: KeyboardEvent) => {
    if (!ganttState) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    const s = ganttState;
    const current = s.selectedId != null ? s.entries.find((en) => en.id === s.selectedId) : null;

    // In stacked mode, use allSessionEntries for navigation
    const inStackedMode = isMultiSession && selectedSessionIdx === -1;
    const entries = inStackedMode ? allSessionEntries : s.entries;
    const currentEntry = s.selectedId != null ? entries.find((en) => en.id === s.selectedId) : null;

    switch (e.key) {
      case "ArrowRight":
      case "ArrowLeft": {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (currentEntry) {
          if (s.chronoNav) {
            // Session nav: next/prev in chronological order
            const idx = entries.indexOf(currentEntry);
            const nextIdx = idx + dir;
            if (nextIdx >= 0 && nextIdx < entries.length) {
              selectEntry(entries[nextIdx].id);
            }
          } else {
            // Row nav: next/prev in same swimlane
            const sameLane = entries.filter(en => en.swimlane === currentEntry.swimlane);
            const laneIdx = sameLane.indexOf(currentEntry);
            const nextIdx = laneIdx + dir;
            if (nextIdx >= 0 && nextIdx < sameLane.length) {
              selectEntry(sameLane[nextIdx].id);
            }
          }
        } else if (entries.length > 0) {
          selectEntry(entries[0].id);
        }
        break;
      }
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        if (!currentEntry) break;
        const dir = e.key === "ArrowUp" ? -1 : 1;
        // In stacked mode, use the *visual* lane order populated during
        // render (sessions in dropdown order, lanes in displayed order
        // within each session). The previous code used insertion order
        // of entries in `allSessionEntries`, which is chronological by
        // event timestamp — so user msgs from session 5 arriving before
        // assistant msgs from session 1 would put session 5's lanes
        // before session 1's in the navigation order, making ArrowUp
        // jump between sessions arbitrarily.
        const swimlanes = inStackedMode
          ? (stackedVisualLanes.length > 0 ? stackedVisualLanes : [...new Set(entries.map(en => en.swimlane))])
          : s.swimlanes;
        // In stacked mode, the entry's raw swimlane may not match any
        // visual lane (agent merge, thinking inline). Resolve via the
        // entry-id → visual-lane map first; fall back to the raw
        // swimlane otherwise.
        const currentVisualLane = inStackedMode
          ? (entryIdToVisualLane.get(currentEntry.id) ?? currentEntry.swimlane)
          : currentEntry.swimlane;
        const laneIdx = swimlanes.indexOf(currentVisualLane);
        const targetIdx = laneIdx + dir;
        if (targetIdx >= 0 && targetIdx < swimlanes.length) {
          const targetLane = swimlanes[targetIdx];
          // Stacked mode: use the visual-lane map (handles merge / inline
          // remapping). Other modes: use raw swimlane bucket.
          const laneEntries = inStackedMode
            ? (entriesByVisualLane.get(targetLane) ?? [])
            : (entriesBySwimlane.get(targetLane) ?? entries.filter(en => en.swimlane === targetLane));
          if (laneEntries.length > 0) {
            // Find closest by time position
            const closest = laneEntries.reduce((best, en) =>
              Math.abs(en.startMs - currentEntry.startMs) < Math.abs(best.startMs - currentEntry.startMs) ? en : best
            );
            selectEntry(closest.id);
          }
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        s.selectedId = null;
        if (s.playbackTimer) {
          clearInterval(s.playbackTimer);
          s.playbackTimer = null;
        }
        s.isPlaying = false;
        if (inStackedMode) {
          const detailEl = document.getElementById("tg-stacked-detail");
          if (detailEl) detailEl.innerHTML = "";
          containerRef?.querySelectorAll(".tg-bar.tg-selected").forEach(b => b.classList.remove("tg-selected"));
        } else {
          renderGantt();
        }
        break;
      case " ":
        e.preventDefault();
        togglePlayback();
        break;
    }
  };
  document.addEventListener("keydown", keyHandler);
}

// ── Helpers ───────────────────────────────────────────────────────────

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    ai_call: "AI Call",
    tool_call: "Tool Call",
    tool_result: "Tool Result",
    thinking: "Thinking",
    user_message: "User Message",
    system: "System",
  };
  return labels[type] ?? type;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
