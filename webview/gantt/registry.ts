/**
 * Plugin Registry — the core of the drop-in system.
 *
 * Both parsers and views register themselves here.
 * The app never imports parsers or views directly — it asks the registry.
 *
 * To add a new parser or view:
 *   1. Create your file in src/parsers/ or src/views/
 *   2. Call registerParser() or registerView() in your file
 *   3. Import your file in src/plugins.ts (the single plugin manifest)
 *   4. Done. The app discovers it automatically.
 *
 * This is the Doom WAD model:
 *   - Engine (app.ts) = fixed
 *   - Parsers = WADs for reading different trajectory formats
 *   - Views = WADs for rendering the data differently
 */

import { Trajectory, TrajectoryParser } from "./types";

// ── View Interface ────────────────────────────────────────────────────

export interface TrajectoryView {
  /** Unique ID for this view */
  id: string;
  /** Display name shown in the view switcher */
  name: string;
  /** Short description */
  description: string;
  /** Icon (single character) */
  icon: string;
  /**
   * View tier — controls default visibility.
   * "core": always shown in tab bar (Dashboard, Gantt, AI Calls, Tools, Table)
   * "standard": shown if user hasn't customized (Errors, Diffs, Chat, Benchmark, Findings, etc.)
   * "advanced": hidden by default, enable in Settings (most specialized views)
   */
  tier?: "core" | "standard" | "advanced";
  /**
   * What data this view needs to be useful.
   * Used to gray out the tab and show info when data is missing.
   */
  requires?: Array<"tokens" | "tools" | "thinking" | "status" | "cost" | "analysis" | "testResults" | "multiSession">;
  /**
   * Optional CSS that this view needs.
   */
  css?: string;
  /**
   * Render into the container. Container is cleared before each call.
   * Receives an array of trajectories — single session = array of 1.
   * Views should handle both single and multi-session gracefully.
   */
  render(container: HTMLElement, trajectories: Trajectory[], options: ViewOptions): void;
  /**
   * Optional cleanup (event listeners, timers, etc.)
   */
  destroy?(): void;
}

export interface ViewOptions {
  darkMode: boolean;
  filterTool: string | null;
  expandedEvents: Set<number>;
  onStateChange: (update: Partial<ViewStateUpdate>) => void;
  /** All loaded trajectories (not just selected) — for aggregate stats */
  allTrajectories?: Trajectory[];
}

export interface ViewStateUpdate {
  filterTool: string | null;
  expandedEvents: Set<number>;
  /** Switch to a different view by ID */
  switchView?: string;
}

// ── Parser Registry ───────────────────────────────────────────────────

const parsers: TrajectoryParser[] = [];

export function registerParser(parser: TrajectoryParser): void {
  parsers.push(parser);
}

export function getParsers(): readonly TrajectoryParser[] {
  return parsers;
}

/**
 * Auto-detect format and parse a file.
 * Tries each registered parser in order.
 */
export function parseFile(contents: string, filename: string): Trajectory[] {
  const firstLine = contents.split("\n").find((l) => l.trim()) ?? "";

  for (const parser of parsers) {
    if (parser.canParse(filename, firstLine)) {
      try {
        return parser.parse(contents, filename);
      } catch (e) {
        console.error(`Parser failed for ${filename}:`, e);
      }
    }
  }

  return [];
}

export function parseFiles(
  files: Array<{ name: string; contents: string }>
): Trajectory[] {
  const results: Trajectory[] = [];
  for (const file of files) {
    results.push(...parseFile(file.contents, file.name));
  }
  return results;
}

// ── View Registry ─────────────────────────────────────────────────────

const views = new Map<string, TrajectoryView>();
let defaultViewId = "dashboard";

export function registerView(view: TrajectoryView): void {
  views.set(view.id, view);
}

export function getView(id: string): TrajectoryView | undefined {
  return views.get(id);
}

export function getAllViews(): TrajectoryView[] {
  return Array.from(views.values());
}

export function getDefaultViewId(): string {
  return views.has(defaultViewId) ? defaultViewId : (views.keys().next().value ?? "gantt");
}

export function setDefaultViewId(id: string): void {
  defaultViewId = id;
}

// ── Data Source Registry ──────────────────────────────────────────────

/**
 * Data source plugin — how trajectories get into the viewer.
 *
 * Built-in: FileSource (reads local files via File System Access API)
 * Future:   SignalRSource, WebSocketSource, RestApiSource, InMemorySource
 *
 * Each source implements start/stop and emits trajectories via onData callback.
 * The viewer doesn't care where data comes from — it just receives Trajectory objects.
 */
export interface DataSource {
  /** Unique ID */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Whether this source supports live streaming (vs one-time load) */
  supportsLive: boolean;
  /**
   * Start the source. Call onData whenever new trajectories are available.
   * Call onError if the source encounters a problem.
   */
  start(config: DataSourceConfig, callbacks: DataSourceCallbacks): void;
  /** Stop the source and clean up connections */
  stop(): void;
  /**
   * Optional: render configuration UI into the given container.
   * Called when the user selects this source in the source picker.
   */
  renderConfig?(container: HTMLElement): void;
}

export interface DataSourceConfig {
  [key: string]: unknown;
}

/**
 * Lifecycle state of a live source — drives banner color and actions.
 *   connecting   — opening / waiting for first event
 *   live         — connected, receiving events
 *   reconnecting — connection dropped; transient retry in progress
 *   ended        — source has finished or is no longer reachable; no
 *                  auto-retry. UI should offer manual Reconnect.
 */
export type DataSourcePhase = "connecting" | "live" | "reconnecting" | "ended";

export interface DataSourceCallbacks {
  onData(trajectories: Trajectory[]): void;
  onError(message: string): void;
  /** Status text plus optional phase. Phase drives banner color/actions. */
  onStatus(message: string, phase?: DataSourcePhase): void;
}

const dataSources = new Map<string, DataSource>();

export function registerDataSource(source: DataSource): void {
  dataSources.set(source.id, source);
}

export function getDataSource(id: string): DataSource | undefined {
  return dataSources.get(id);
}

export function getAllDataSources(): DataSource[] {
  return Array.from(dataSources.values());
}

// ── Data Availability ─────────────────────────────────────────────────

export interface DataAvailability {
  tokens: boolean;
  tools: boolean;
  thinking: boolean;
  status: boolean;
  cost: boolean;
  analysis: boolean;
  testResults: boolean;
  multiSession: boolean;
}

const requirementLabels: Record<string, string> = {
  tokens: "Token usage data (input/output counts)",
  tools: "Tool calls (Read, Edit, Bash, etc.)",
  thinking: "Thinking/reasoning blocks",
  status: "Pass/fail status",
  cost: "Cost tracking data",
  analysis: "AI analysis attached",
  testResults: "Test results attached",
  multiSession: "Multiple sessions selected",
};

export function getRequirementLabel(req: string): string {
  return requirementLabels[req] ?? req;
}

export function checkDataAvailability(trajectories: Trajectory[]): DataAvailability {
  const allEvents = trajectories.flatMap((t) => t.events);
  return {
    tokens: allEvents.some((e) => e.tokens && ((e.tokens.input ?? 0) > 0 || (e.tokens.output ?? 0) > 0)),
    tools: allEvents.some((e) => e.type === "tool_call"),
    thinking: allEvents.some((e) => e.type === "thinking"),
    status: trajectories.some((t) => t.session.status != null),
    cost: trajectories.some((t) => t.session.cost != null),
    analysis: trajectories.some((t) => t.analysis != null),
    testResults: trajectories.some((t) => t.testResults != null),
    multiSession: trajectories.length > 1,
  };
}

export function isViewUsable(view: TrajectoryView, availability: DataAvailability): { usable: boolean; missing: string[] } {
  if (!view.requires || view.requires.length === 0) return { usable: true, missing: [] };
  const missing = view.requires.filter((req) => !availability[req]);
  return { usable: missing.length === 0, missing };
}

// ── Plugin Info ───────────────────────────────────────────────────────

export function getPluginInfo(): { parsers: number; views: number; dataSources: number } {
  return { parsers: parsers.length, views: views.size, dataSources: dataSources.size };
}
