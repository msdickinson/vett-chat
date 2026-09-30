/**
 * Common trajectory format for AI coding tool sessions.
 * All parsers convert their native format into this structure.
 * The UI only reads this format — it never knows the source.
 */

export interface Trajectory {
  /** Format version */
  version: "1.0";
  /** Which tool generated the original data */
  source: "vett" | "unknown";
  /** Session-level metadata */
  session: SessionInfo;
  /** Ordered list of events */
  events: TrajectoryEvent[];
  /** Aggregated metrics (computed after parsing) */
  summary?: TrajectorySummary;
  /** For subagent sessions: parent session ID to merge into */
  parentSessionId?: string;
  /** For subagent sessions: uuid of the Task tool_use that spawned this
   * subagent. Found on the subagent's first line's `parentUuid` field.
   * Cross-referenced against `toolUseUuids` of other trajectories to find
   * the *actual* parent session — path-based parent UUID is unreliable
   * because some agents store all of a project's subagents under the
   * project's first session UUID, not the spawning session. */
  spawnToolUseUuid?: string;
  /** Set of tool_use block uuids that occurred in this trajectory. Used to
   * match subagents → parent: a subagent's `spawnToolUseUuid` will appear
   * in exactly one trajectory's `toolUseUuids`, and that trajectory is the
   * real parent that spawned it. */
  toolUseUuids?: string[];
  /** Test results from build/test execution (e.g., a verification step) */
  testResults?: TestResults;
  /** AI-generated analysis — structured review of the session (why it passed/failed) */
  analysis?: SessionAnalysis;
}

// ── Test Results ──────────────────────────────────────────────────────

export interface TestResults {
  /** Overall pass/fail */
  passed: boolean;
  /** Total tests */
  total: number;
  /** Passed tests */
  passedCount: number;
  /** Failed tests */
  failedCount: number;
  /** Skipped tests */
  skippedCount?: number;
  /** Duration of test run in ms */
  durationMs?: number;
  /** Test framework (jest, pytest, dotnet test, etc.) */
  framework?: string;
  /** Raw test output (stdout/stderr) */
  rawOutput?: string;
  /** Individual test cases */
  tests?: TestCase[];
}

export interface TestCase {
  name: string;
  suite?: string;
  status: "passed" | "failed" | "skipped" | "error";
  durationMs?: number;
  /** Failure message / assertion error */
  failureMessage?: string;
  /** Stack trace */
  stackTrace?: string;
}

// ── AI Analysis ───────────────────────────────────────────────────────

/**
 * Structured AI review of a session.
 * Generated offline by any model, local or hosted.
 * Loaded as a sidecar file alongside the trajectory.
 *
 * Use case: Run benchmarks → export failed instances → ask AI to review
 * each failure → attach the analysis → share the export with analysis.
 */
export interface SessionAnalysis {
  /** Which model generated this analysis */
  analyzedBy: string;
  /** When the analysis was generated */
  analyzedAt: string;
  /** Overall verdict */
  verdict: "correct" | "incorrect" | "partial" | "inconclusive";
  /** Confidence 0-1 */
  confidence?: number;
  /** One-line summary */
  summary: string;
  /** Detailed explanation of what happened */
  explanation: string;
  /** Root cause category */
  rootCause?: string;
  /** What went wrong (for failures) */
  failureReasons?: string[];
  /** What went right (for successes) */
  strengths?: string[];
  /** Suggestions for improvement */
  recommendations?: string[];
  /** Tags for categorization */
  tags?: string[];
  /** For benchmarks: was the patch correct? */
  patchCorrectness?: "correct" | "incorrect" | "partial" | "no_patch";
  /** For benchmarks: did it match the expected approach? */
  approachMatch?: "exact" | "alternative_valid" | "wrong_approach";
  /** Raw analysis text (if not structured) */
  rawText?: string;

  // ── Learning / Pattern Detection ──

  /** Specific tool calls that caused problems */
  problematicToolCalls?: Array<{
    eventId: number;
    toolName: string;
    issue: string;
  }>;
  /** Key decision points where the agent chose correctly or incorrectly */
  decisionPoints?: Array<{
    eventId: number;
    description: string;
    wasCorrect: boolean;
    betterAlternative?: string;
  }>;
  /** Iteration count — how many edit→test→fix cycles */
  iterationCount?: number;
  /** Did the agent's approach change mid-session? */
  strategyPivots?: string[];
  /** Difficulty assessment of the task */
  taskDifficulty?: "easy" | "medium" | "hard" | "very_hard";
  /** Time spent on exploration vs implementation vs debugging */
  phaseBreakdown?: {
    exploration?: number; // percentage
    implementation?: number;
    debugging?: number;
    verification?: number;
  };
}

export interface SessionInfo {
  id: string;
  startTime: string; // ISO 8601
  endTime?: string;
  model?: string;
  cwd?: string;
  gitBranch?: string;
  /** Agent/team member who ran this session */
  agent?: AgentInfo;
  /** Cost tracking */
  cost?: CostInfo;
  /** Result status */
  status?: "running" | "succeeded" | "failed" | "error" | "cancelled" | "timeout" | "unknown";
  /** Source-specific metadata (instance_id for benchmarks, etc.) */
  metadata?: Record<string, unknown>;
}

/** Agent/team member info — supports multi-agent workflows */
export interface AgentInfo {
  name: string;
  role?: string;
  /** Team this agent belongs to */
  team?: string;
}

/** Cost tracking */
export interface CostInfo {
  /** Total cost in USD */
  totalUsd?: number;
  /** Per-model cost breakdown */
  perModel?: Record<string, number>;
}

export interface TrajectoryEvent {
  id: number;
  timestamp: string; // ISO 8601
  type: "message" | "tool_call" | "tool_result" | "thinking" | "system" | "error";
  role: "user" | "assistant" | "system" | "environment";
  content?: string;
  /** Present when type === "tool_call" */
  toolCall?: {
    name: string;
    arguments?: Record<string, unknown> | string;
  };
  /** Present when type === "tool_result" */
  toolResult?: {
    output?: string;
    isError: boolean;
    /** Link back to the tool_call event */
    toolCallEventId?: number;
  };
  /** Token usage for this event (if available) */
  tokens?: TokenUsage;
  /** Which model produced this event */
  model?: string;
  /** Duration in ms (for tool results: how long the tool took) */
  durationMs?: number;
  /** Agent/team member who produced this event (multi-agent support) */
  agent?: string;
  /** Whether context compaction was triggered */
  contextCompacted?: boolean;
  /** Stage in the pipeline: queue, processing, verify, etc. */
  stage?: string;
  /** Throughput: output tokens per second for this event */
  throughputTps?: number;
  /** Conversation turn index (for grouping related events) */
  turnIndex?: number;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** Response latency in ms (time to first token or full response) */
  latencyMs?: number;
}

export interface TrajectorySummary {
  totalEvents: number;
  totalToolCalls: number;
  uniqueTools: string[];
  toolCallCounts: Record<string, number>;
  totalTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  durationMs: number;
  errorCount: number;
  /** Per-tool average duration */
  toolAvgDurationMs: Record<string, number>;
  /** Effective throughput: output tokens / active seconds */
  effectiveTps?: number;
  /** Cache hit rate (0-1) */
  cacheHitRate?: number;
  /** Total cost in USD */
  totalCostUsd?: number;
  /** Peak concurrency (for multi-agent/multi-ticket runs) */
  peakConcurrency?: number;
  /** Per-agent event counts */
  agentEventCounts?: Record<string, number>;
  /** Per-model usage */
  modelUsage?: Record<string, { calls: number; tokens: number }>;
  /** Response time percentiles in ms */
  responseTimePercentiles?: {
    p50?: number;
    p95?: number;
    min?: number;
    max?: number;
  };
  /** Context compaction count */
  compactionCount?: number;
}

// ── Benchmark Integration ─────────────────────────────────────────────

export interface BenchmarkRun {
  name: string;
  harness: string;
  date: string;
  config?: Record<string, unknown>;
  instances: BenchmarkInstance[];
}

export interface BenchmarkInstance {
  instanceId: string;
  sessionId: string;
  status: "passed" | "failed" | "error" | "timeout" | "running" | "unknown";
  verificationLog?: string;
  patchApplied?: boolean;
  notes?: string;
}

// ── Export Package ────────────────────────────────────────────────────

export interface ExportPackage {
  version: "1.0";
  exportedAt: string;
  title: string;
  logoBase64?: string;
  darkModeForced?: "dark" | "light" | null;
  enabledViews: string[];
  showSidebar: boolean;
  /**
   * For small exports (<50 sessions): full trajectory data inline.
   * For large exports (50+): only summaries inline, full events on demand.
   */
  trajectories: Trajectory[];
  /** Lightweight session list for large exports (summary only, no events) */
  sessionIndex?: TrajectoryIndex[];
  benchmark?: BenchmarkRun;
  about?: string;
}

/** Lightweight session info for large export indexes (no events) */
export interface TrajectoryIndex {
  sessionId: string;
  source: string;
  startTime: string;
  endTime?: string;
  model?: string;
  summary: TrajectorySummary;
  benchmarkStatus?: string;
  /** If true, full events are in trajectories[]. If false, need lazy load. */
  hasFullData: boolean;
  /** URL to fetch full trajectory data on demand */
  dataUrl?: string;
}

/** Parser interface — each source implements this */
export interface TrajectoryParser {
  /** Can this parser handle the given file? */
  canParse(filename: string, firstLine?: string): boolean;
  /** Parse file contents into common format */
  parse(contents: string, filename: string): Trajectory[];
}

/** Safely convert a value to ISO timestamp string. Returns fallback on invalid input. */
export function safeTimestamp(value: unknown, fallback?: string): string {
  if (value == null) return fallback ?? new Date().toISOString();
  // Only string and number are reliably convertible to Date. Anything
  // else (object, boolean, etc.) is almost certainly malformed input.
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback ?? new Date().toISOString();
  }
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return fallback ?? new Date().toISOString();
    return d.toISOString();
  } catch {
    return fallback ?? new Date().toISOString();
  }
}

/** Fill in durationMs for events that don't have one, using gap to next event */
export function fillEventDurations(events: TrajectoryEvent[]): void {
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].durationMs != null) continue;
    const thisTs = new Date(events[i].timestamp).getTime();
    const nextTs = new Date(events[i + 1].timestamp).getTime();
    if (!isNaN(thisTs) && !isNaN(nextTs) && nextTs > thisTs) {
      const dur = nextTs - thisTs;
      // Cap at 5 min — anything longer is likely user AFK, not event duration
      if (dur < 5 * 60 * 1000) {
        events[i].durationMs = dur;
      }
    }
  }
}

/** Memoized computeSummary — caches result by events array reference */
const summaryCache = new WeakMap<TrajectoryEvent[], TrajectorySummary>();

/** Compute summary from events (memoized — same array reference returns cached result) */
export function computeSummary(events: TrajectoryEvent[]): TrajectorySummary {
  const cached = summaryCache.get(events);
  if (cached) return cached;
  const toolCalls = events.filter((e) => e.type === "tool_call");
  const toolResults = events.filter((e) => e.type === "tool_result");
  const errors = events.filter(
    (e) => e.type === "error" || (e.toolResult?.isError ?? false)
  );

  const toolCallCounts: Record<string, number> = {};
  const toolDurations: Record<string, number[]> = {};

  // Pre-build O(1) lookup for linking tool results to their calls
  const eventById = new Map<number, TrajectoryEvent>();
  for (const e of events) eventById.set(e.id, e);

  for (const tc of toolCalls) {
    const name = tc.toolCall?.name ?? "unknown";
    toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
  }

  for (const tr of toolResults) {
    if (tr.durationMs != null && tr.toolResult?.toolCallEventId != null) {
      const callEvent = eventById.get(tr.toolResult.toolCallEventId);
      const name = callEvent?.toolCall?.name ?? "unknown";
      if (!toolDurations[name]) toolDurations[name] = [];
      toolDurations[name].push(tr.durationMs);
    }
  }

  const toolAvgDurationMs: Record<string, number> = {};
  for (const [name, durations] of Object.entries(toolDurations)) {
    toolAvgDurationMs[name] =
      durations.reduce((a, b) => a + b, 0) / durations.length;
  }

  const totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const e of events) {
    if (e.tokens) {
      totalTokens.input += e.tokens.input ?? 0;
      totalTokens.output += e.tokens.output ?? 0;
      totalTokens.cacheRead += e.tokens.cacheRead ?? 0;
      totalTokens.cacheWrite += e.tokens.cacheWrite ?? 0;
    }
  }

  // Single-pass min/max to avoid stack overflow on large arrays (Math.max(...50K) crashes)
  let minTs = Infinity, maxTs = -Infinity;
  for (const e of events) {
    const t = new Date(e.timestamp).getTime();
    if (!isNaN(t)) {
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }
  }
  const durationMs = isFinite(minTs) && isFinite(maxTs) ? maxTs - minTs : 0;

  const result: TrajectorySummary = {
    totalEvents: events.length,
    totalToolCalls: toolCalls.length,
    uniqueTools: Object.keys(toolCallCounts),
    toolCallCounts,
    totalTokens,
    durationMs,
    errorCount: errors.length,
    toolAvgDurationMs,
  };

  summaryCache.set(events, result);
  return result;
}

/** Get a human-readable label for a session — first user prompt or fallback to session ID */
export function getSessionLabel(t: Trajectory, index?: number): string {
  const fp = t.events.find(e => e.role === "user" && e.type === "message" && e.content && e.content.length > 5 && !e.content.startsWith("<"));
  const prompt = fp?.content?.trim().split("\n")[0].slice(0, 60) ?? "";
  const prefix = index != null ? `#${index + 1} ` : "";
  return prefix + (prompt || t.session.model || t.session.id.slice(0, 20));
}
