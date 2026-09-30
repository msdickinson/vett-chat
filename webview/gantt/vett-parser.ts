import {
  Trajectory,
  TrajectoryEvent,
  TrajectoryParser,
  computeSummary,
  fillEventDurations,
} from "./types";

/**
 * Parser for Vett benchmark run exports.
 *
 * Vett (https://github.com/msdickinson/vett) is a lean benchmark
 * harness for AI coding agents. Each run produces a single JSON file
 * containing a RunResult with one or more InstanceResults inside.
 *
 * File pattern: results/{suite}_{profile}_{timestamp}.json
 *
 * The Vett export is a summary format — it stores aggregate stats per
 * step + tool call counts + the final patch, but NOT the full message
 * history. For full per-iteration traces, users should enable Vett's
 * jsonl-telemetry middleware (which produces a separate `.jsonl` file
 * the existing parsers can already read).
 *
 * Each InstanceResult becomes one Trajectory. Synthetic events are
 * generated for: session start, per-step summary, per tool-call,
 * the final patch, and the verification result.
 */

interface VettRunResult {
  suite_name?: string;
  profile_name?: string;
  model?: string;
  total?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  accuracy?: number;
  avg_confidence?: number;
  calibration_error?: number;
  total_duration_seconds?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  started_at?: string;
  completed_at?: string;
  instances?: VettInstanceResult[];
}

interface VettInstanceResult {
  instance_id?: string;
  suite_name?: string;
  passed?: boolean;
  confidence?: number;
  confidence_scores?: Array<{ source: string; score: number; summary?: string }>;
  patch?: string | null;
  failure_reason?: string | null;
  total_iterations?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  duration_seconds?: number;
  started_at?: string;
  completed_at?: string;
  steps?: VettStepTrace[];
}

interface VettStepTrace {
  step_name?: string;
  iterations?: number;
  input_tokens?: number;
  output_tokens?: number;
  duration_seconds?: number;
  tool_calls?: Array<{ tool_name: string; duration_ms?: number; success?: boolean }>;
}

export class VettParser implements TrajectoryParser {
  readonly source = "vett" as const;

  canParse(filename: string, firstLine: string): boolean {
    const lower = filename.toLowerCase();

    // Aggregate RunResult JSON (thin trajectories, one per instance)
    if (lower.endsWith(".json") &&
        firstLine.includes('"profile_name"') &&
        firstLine.includes('"instances"')) {
      return true;
    }

    // Vett CS3 LiveSink event-stream JSONL (vett run --trajectory-dir / --live-port).
    // One JSON object per line, envelope shape: {seq, ts, type, instance_id, data}.
    // Mixed-instance run-level events.jsonl OR per-instance instances/<id>/events.jsonl.
    // Detected by the presence of the "seq" + "type" + "data" envelope keys, which
    // are unique to the CS3 sink.
    if (lower.endsWith(".jsonl") &&
        firstLine.includes('"seq"') &&
        firstLine.includes('"type"') &&
        firstLine.includes('"data"')) {
      return true;
    }

    // Legacy full-history trace JSONL (older `vett run --trace`).
    // Each line is a per-iteration snapshot with a messages[] array.
    if (lower.endsWith(".jsonl") &&
        firstLine.includes('"iteration"') &&
        firstLine.includes('"messages"') &&
        firstLine.includes('"assistant_content"')) {
      return true;
    }

    return false;
  }

  parse(contents: string, filename: string): Trajectory[] {
    // CS3 LiveSink event stream — sniff by content (envelope keys) so the same
    // .jsonl extension can dispatch to the right parser.
    if (filename.toLowerCase().endsWith(".jsonl")) {
      const firstLine = contents.split("\n", 1)[0] ?? "";
      if (firstLine.includes('"seq"') && firstLine.includes('"type"') && firstLine.includes('"data"')) {
        return this.parseLiveSinkJsonl(contents, filename);
      }
      // Legacy trace JSONL path: rich per-instance trajectory from full message history
      const trajectory = this.parseTraceJsonl(contents, filename);
      return trajectory ? [trajectory] : [];
    }

    // Aggregate JSON path: thin per-instance trajectories
    let data: VettRunResult;
    try {
      data = JSON.parse(contents) as VettRunResult;
    } catch {
      return [];
    }

    if (!data.instances || data.instances.length === 0) return [];

    return data.instances.map(inst => this.buildTrajectory(inst, data, filename));
  }

  /**
   * Build a rich trajectory from a Vett `--trace` JSONL file.
   * Each line is a self-contained snapshot of the conversation after
   * iteration N. The LAST line has the most complete message history,
   * so we use it as the source of truth for events.
   */
  private parseTraceJsonl(contents: string, filename: string): Trajectory | null {
    const lines = contents.split("\n").filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;

    let lastSnapshot: any = null;
    const perIterSnapshots: any[] = [];
    for (const line of lines) {
      try {
        const snap = JSON.parse(line);
        perIterSnapshots.push(snap);
        lastSnapshot = snap;
      } catch {
        // skip malformed line
      }
    }

    if (!lastSnapshot || !Array.isArray(lastSnapshot.messages)) return null;

    // Instance id is derived from the filename:
    //   {suite}_{profile}_{timestamp}_{instance_id}.jsonl
    // Split on "_" and take the tail after the timestamp (best-effort).
    const base = filename.replace(/\.jsonl$/i, "").split(/[\\/]/).pop() ?? filename;
    const parts = base.split("_");
    const instanceId = parts.slice(4).join("_") || base;

    // Use the last snapshot's messages as the canonical history, then
    // synthesize TrajectoryEvents with timestamps derived from the per-iter
    // snapshots so the timeline view can order them.
    const events: TrajectoryEvent[] = [];
    let nextId = 1;
    const startMs = perIterSnapshots[0]?.timestamp
      ? Date.parse(perIterSnapshots[0].timestamp)
      : Date.now();

    // Walk the final message history and emit events. Since every snapshot
    // contains the FULL history up to that iteration, we use the last snapshot's
    // messages as the authoritative source.
    const messages = lastSnapshot.messages as Array<{
      role: string;
      content: string;
      tool_call_id?: string;
    }>;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // Rough timestamp interpolation: spread messages across the
      // per-iteration timestamps we collected
      const iterIdx = Math.min(
        perIterSnapshots.length - 1,
        Math.floor((i / messages.length) * perIterSnapshots.length),
      );
      const tsSource = perIterSnapshots[iterIdx]?.timestamp;
      const timestamp = tsSource
        ? new Date(tsSource).toISOString()
        : new Date(startMs + i * 1000).toISOString();

      if (msg.role === "tool") {
        events.push({
          id: nextId++,
          timestamp,
          type: "tool_result",
          role: "environment",
          toolResult: {
            output: msg.content,
            isError: msg.content?.includes("<exception>") || false,
            toolCallEventId: msg.tool_call_id
              ? Number(msg.tool_call_id) || undefined
              : undefined,
          },
        });
      } else if (msg.role === "assistant") {
        events.push({
          id: nextId++,
          timestamp,
          type: "message",
          role: "assistant",
          content: msg.content,
        });
      } else if (msg.role === "user" || msg.role === "system") {
        events.push({
          id: nextId++,
          timestamp,
          type: msg.role === "system" ? "system" : "message",
          role: msg.role as any,
          content: msg.content,
        });
      }
    }

    // Emit a trailing summary event with per-iteration tool_calls metadata
    // so the timeline knows which tools fired at which iteration.
    for (const snap of perIterSnapshots) {
      if (Array.isArray(snap.tool_calls)) {
        for (const tc of snap.tool_calls) {
          events.push({
            id: nextId++,
            timestamp: snap.timestamp
              ? new Date(snap.timestamp).toISOString()
              : new Date(startMs).toISOString(),
            type: "tool_call",
            role: "assistant",
            toolCall: {
              name: tc.name,
              arguments: tc.arguments ?? "",
            },
            tokens: snap.input_tokens
              ? { input: snap.input_tokens, output: snap.output_tokens ?? 0 }
              : undefined,
          });
        }
      }
    }

    events.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb || a.id - b.id;
    });

    const endMs = perIterSnapshots[perIterSnapshots.length - 1]?.timestamp
      ? Date.parse(perIterSnapshots[perIterSnapshots.length - 1].timestamp)
      : startMs;

    const traj: Trajectory = {
      version: "1.0",
      source: "vett",
      session: {
        id: `vett-trace/${instanceId}`,
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        status: "unknown",
        metadata: {
          instanceId,
          source: "vett-trace",
          sourceFile: filename,
          iterations: perIterSnapshots.length,
          vettRichTrace: true, // marker used by the dedupe pass below
        },
      },
      events,
    };
    fillEventDurations(events);
    traj.summary = computeSummary(events);
    return traj;
  }

  private buildTrajectory(
    inst: VettInstanceResult,
    run: VettRunResult,
    filename: string,
  ): Trajectory {
    const events: TrajectoryEvent[] = [];
    let nextId = 1;
    const startMs = inst.started_at ? Date.parse(inst.started_at) : Date.now();
    const endMs = inst.completed_at ? Date.parse(inst.completed_at) : startMs;
    const totalIters = Math.max(1, inst.total_iterations ?? 1);
    const msPerIter = Math.max(1, (endMs - startMs) / totalIters);
    let cursor = startMs;

    const at = (offset = 0) => new Date(cursor + offset).toISOString();

    // Session start banner
    events.push({
      id: nextId++,
      timestamp: at(),
      type: "system",
      role: "system",
      content: `Vett run: ${run.suite_name ?? "?"} / ${run.profile_name ?? "?"} / ${run.model ?? "?"}`,
    });

    for (const step of inst.steps ?? []) {
      events.push({
        id: nextId++,
        timestamp: at(),
        type: "system",
        role: "system",
        content: `Step "${step.step_name ?? "?"}" — ${step.iterations ?? 0} iterations, ` +
          `${step.input_tokens ?? 0} in / ${step.output_tokens ?? 0} out tokens`,
        stage: step.step_name,
        tokens: {
          input: step.input_tokens ?? 0,
          output: step.output_tokens ?? 0,
        },
        durationMs: Math.round((step.duration_seconds ?? 0) * 1000),
      });

      for (const tc of step.tool_calls ?? []) {
        const callId = nextId++;
        events.push({
          id: callId,
          timestamp: at(),
          type: "tool_call",
          role: "assistant",
          toolCall: { name: tc.tool_name, arguments: "" },
          stage: step.step_name,
        });
        events.push({
          id: nextId++,
          timestamp: at(tc.duration_ms ?? 0),
          type: "tool_result",
          role: "environment",
          toolResult: {
            output: tc.success === false ? "(tool reported failure)" : "(success)",
            isError: tc.success === false,
            toolCallEventId: callId,
          },
          durationMs: tc.duration_ms,
          stage: step.step_name,
        });
        cursor += tc.duration_ms ?? msPerIter;
      }
    }

    if (inst.patch) {
      events.push({
        id: nextId++,
        timestamp: new Date(endMs).toISOString(),
        type: "message",
        role: "assistant",
        content: "```diff\n" + inst.patch + "\n```",
      });
    }

    events.push({
      id: nextId++,
      timestamp: new Date(endMs).toISOString(),
      type: inst.failure_reason ? "error" : "system",
      role: "system",
      content: inst.failure_reason
        ? `ERROR: ${inst.failure_reason}`
        : `Verification: ${inst.passed ? "PASSED" : "FAILED"}`,
    });

    fillEventDurations(events);

    const traj: Trajectory = {
      version: "1.0",
      source: "vett",
      session: {
        id: `${run.profile_name ?? "vett"}/${inst.instance_id ?? "?"}`,
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        model: run.model,
        status: inst.failure_reason ? "error" : inst.passed ? "succeeded" : "failed",
        metadata: {
          instanceId: inst.instance_id,
          suiteName: inst.suite_name ?? run.suite_name,
          profileName: run.profile_name,
          source: "vett",
          sourceFile: filename,
        },
      },
      events,
    };

    if (inst.confidence_scores && inst.confidence_scores.length > 0) {
      const top = inst.confidence_scores[0];
      traj.analysis = {
        analyzedBy: top.source,
        analyzedAt: new Date(endMs).toISOString(),
        verdict: inst.passed ? "correct" : top.score < 0.5 ? "incorrect" : "inconclusive",
        confidence: top.score,
        summary: top.summary ?? `Confidence ${top.score.toFixed(2)} from ${top.source}`,
        explanation: inst.confidence_scores
          .map(score => `${score.source}: ${score.score.toFixed(2)}${score.summary ? ` — ${score.summary}` : ""}`)
          .join("\n"),
        patchCorrectness: inst.passed ? "correct" : inst.patch ? "incorrect" : "no_patch",
      };
    }

    traj.summary = computeSummary(events);
    return traj;
  }

  // ────────────────────────────────────────────────────────────────────
  // CS3 LiveSink JSONL: per-event envelope, one Trajectory per instance.
  // ────────────────────────────────────────────────────────────────────

  /**
   * Parse the new (2026-04-25+) CS3 LiveSink event-stream JSONL.
   *
   * File can be either:
   *   - <output>/events.jsonl              — multi-instance, mixed by time
   *   - <output>/instances/<id>/events.jsonl — single instance, time-ordered
   *
   * Each line is one envelope:
   *   { seq: number, ts: ISO, type: string, instance_id: string|null, data: {...} }
   *
   * We group by instance_id and emit one Trajectory per instance. Run-level
   * events (instance_id == null, e.g. run_start/run_end) are dropped — they're
   * better surfaced in the Live page or a separate run-summary view.
   *
   * Mapping vett event types → TrajectoryEvent:
   *   instance_start            → system message ("Instance X started")
   *   iteration_start           → (skip — too noisy; iter is on tool_call_end)
   *   iteration_end             → (skip)
   *   llm_response              → assistant message (with token usage)
   *   llm_error                 → error event
   *   tool_call_start           → tool_call event (correlation key: data.call_id)
   *   tool_call_end             → tool_result event (linked back via call_id)
   *   session_recovery          → system message (cwd/env reset)
   *   session_recovery_failed   → error event
   *   error                     → error event (middleware exception)
   *   instance_end              → system message with end_reason
   *   patch_capture_failed      → error event (post-instance)
   *   post_hook_failed          → error event (post-instance)
   */
  /**
   * VETT's tool_call_start envelope doesn't include the arguments — only
   * the tool name and call_id. So Diff / File Edits / etc. views see
   * `arguments=""` and render "unknown file" with no patch.
   *
   * For file_editor calls specifically, the result_preview text from the
   * matching tool_call_end almost always names the file:
   *   - "File created successfully at: /testbed/foo.py"
   *   - "Here's the result of running `cat -n` on /testbed/foo.py:"
   *   - "The file /testbed/foo.py has been edited..."
   *   - "Last edit to /testbed/foo.py undone successfully."
   *
   * Extract the path here and synthesise minimal {command, path} JSON so
   * downstream views can at least show which file was touched. The actual
   * `file_text` / `old_str` / `new_str` are still missing — that requires
   * a VETT sidecar update to include arguments in tool_call_start.data.
   */
  private deriveFileEditorArgsFromResult(result: string): string {
    if (!result) return "";
    const patterns: Array<{ command: string; re: RegExp }> = [
      { command: "create", re: /File created successfully at:\s*(\S+)/ },
      { command: "view",   re: /Here's the result of running `cat -n` on\s+(\S+):/ },
      { command: "view",   re: /Here's the files and directories up to .* deep in\s+(\S+),/ },
      { command: "str_replace", re: /The file\s+(\S+)\s+has been edited\./ },
      { command: "insert", re: /The file\s+(\S+)\s+has been edited\./ },
      { command: "undo_edit", re: /Last edit to\s+(\S+)\s+undone successfully\./ },
    ];
    for (const { command, re } of patterns) {
      const m = result.match(re);
      if (m && m[1]) {
        return JSON.stringify({ command, path: m[1], _derivedFromResult: true });
      }
    }
    return "";
  }

  private parseLiveSinkJsonl(contents: string, filename: string): Trajectory[] {
    type Envelope = {
      seq?: number;
      ts?: string;
      type?: string;
      instance_id?: string | null;
      data?: Record<string, unknown>;
    };

    const envelopes: Envelope[] = [];
    for (const raw of contents.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        envelopes.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    if (envelopes.length === 0) return [];

    // Group by instance_id. Drop run-level events (instance_id falsy).
    const byInstance = new Map<string, Envelope[]>();
    for (const e of envelopes) {
      const id = e.instance_id;
      if (!id) continue;
      if (!byInstance.has(id)) byInstance.set(id, []);
      byInstance.get(id)!.push(e);
    }

    const trajectories: Trajectory[] = [];
    for (const [instanceId, instEvents] of byInstance) {
      // Sort by seq (preferred — monotonic within a run) then by ts.
      instEvents.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

      const events: TrajectoryEvent[] = [];
      let nextId = 1;
      // Map vett call_id (string) → TrajectoryEvent.id (number) so tool_result
      // events can link back via toolCall.eventId.
      const callIdToEventId = new Map<string, number>();
      let endReason: string | null = null;
      // Track whether we've already emitted the session's system prompt
      // as a system message. We extract it from the first llm_request
      // event (vett-chat era) and emit it once.
      let systemPromptEmitted = false;
      // thread_id → member name. Built from dispatch_start events so
      // sub-agent events get prefixed with a human-friendly lane name
      // (e.g. "researcher / Assistant") instead of the opaque "task-1".
      const threadToMember = new Map<string, string>();

      for (const env of instEvents) {
        const ts = env.ts ?? new Date().toISOString();
        const data = env.data ?? {};
        const type = env.type ?? "";

        // Capture thread_id → member mapping eagerly so events that
        // arrive before/around dispatch_start in the same JSONL still
        // get a reasonable lane label.
        if (type === "dispatch_start") {
          const tid = String(data.task_id ?? "");
          const member = String(data.member ?? "");
          const task = String(data.task ?? "");
          // Tag the agent with both member and task_id so parallel
          // dispatches to the same member ("researcher" twice) get
          // their own lanes. Without the task_id suffix both runs
          // collapsed into one "researcher" lane and you couldn't
          // tell which assistant call belonged to which researcher.
          const laneTag = tid && member ? `${member} (${tid})` : (member || tid);
          if (tid && laneTag) threadToMember.set(tid, laneTag);
          // Emit a synthetic user_message into the sub-agent's lane so
          // the gantt's per-agent group header reads
          // "researcher (task-1) — Generate a random number..."
          // instead of falling back to the first tool call.
          if (laneTag && task) {
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "message",
              role: "user",
              content: task,
              agent: laneTag,
            });
          }
        }

        // Tag the event with which agent produced it. Leader events
        // ("main" or no thread_id) get no tag and flow into the default
        // Assistant / Tool Calls / User / System lanes. Sub-agent events
        // get `agent = <member> (<task_id>)` so each parallel dispatch
        // gets its own lane (see gantt.ts line ~1022).
        const threadId = data.thread_id;
        const agent = (typeof threadId === "string" && threadId !== "main")
          ? (threadToMember.get(threadId) ?? threadId)
          : undefined;

        // Track which events get pushed during this iteration so we
        // can stamp `agent` on all of them in one place. Cheaper than
        // editing every events.push site in the giant switch below.
        const beforeLen = events.length;

        switch (type) {
          case "instance_start":
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "system",
              role: "system",
              content: `Instance ${instanceId} started`,
            });
            break;

          case "llm_request": {
            // vett (post-2026-04) emits the full outbound request before
            // each LLM call, including the system prompt as message[0].
            // We extract the system prompt once per session so the gantt
            // detail panel can show it as part of the conversation
            // context. Subsequent llm_requests carry the same prompt
            // (it's stable within a session) so we skip re-emission.
            if (systemPromptEmitted) break;
            const messages = data.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }> | undefined;
            if (!messages || messages.length === 0) break;
            const first = messages[0];
            if (first.role !== "system") break;
            const texts = (first.content ?? [])
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text as string);
            const promptText = texts.join("\n").trim();
            if (!promptText) break;
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "system",
              role: "system",
              content: promptText,
            });
            systemPromptEmitted = true;
            break;
          }

          case "user_message": {
            // The vett-chat extension synthesizes user_message events
            // when the user types into the chat (vett itself doesn't
            // echo user input back over stdout — it consumes it from
            // stdin). Without this case the gantt's User lane stayed
            // empty even though the conversation has user turns.
            const text = String(data.text ?? "");
            if (!text) break;
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "message",
              role: "user",
              content: text,
            });
            break;
          }

          case "llm_response": {
            const inputTok = Number(data.input_tokens ?? 0);
            const outputTok = Number(data.output_tokens ?? 0);
            const iter = Number(data.iteration ?? 0);
            // VETT only emits llm_response when the response LANDS — there
            // is no llm_request_start envelope, so the call's actual time
            // span is invisible without back-filling. We compute the call
            // duration as the gap between the previous event's end and
            // this response's timestamp, and backdate the message's own
            // timestamp to the call start. Net effect: the AI Call bar in
            // the Gantt now spans the real LLM time (~20s/call) instead
            // of collapsing to a zero-width tick.
            const responseTs = new Date(ts).getTime();
            let startTsIso = ts;
            let llmDurationMs: number | undefined;
            if (events.length > 0 && Number.isFinite(responseTs)) {
              const prev = events[events.length - 1];
              const prevTs = new Date(prev.timestamp).getTime();
              const prevEnd = prevTs + (prev.durationMs ?? 0);
              if (Number.isFinite(prevEnd) && prevEnd < responseTs) {
                startTsIso = new Date(prevEnd).toISOString();
                llmDurationMs = responseTs - prevEnd;
              }
            }
            // vett (post-2026-04) emits the full assistant message in
            // `data.content`. Pull the actual text out so the gantt's
            // detail panel reads the real reply, not "(LLM response,
            // iter N)" placeholder. Function-call blocks get a compact
            // summary appended so a tool-only iteration isn't blank.
            let extracted = `(LLM response, iter ${iter})`;
            const msg = data.content as { content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }> } | undefined;
            if (msg?.content && msg.content.length > 0) {
              const parts: string[] = [];
              for (const c of msg.content) {
                if (c.type === "text" && typeof c.text === "string" && c.text.length > 0) {
                  parts.push(c.text);
                } else if (c.type === "function_call") {
                  const argStr = typeof c.arguments === "string"
                    ? c.arguments
                    : JSON.stringify(c.arguments ?? {});
                  parts.push(`→ ${String(c.name ?? "?")}(${argStr})`);
                }
              }
              if (parts.length > 0) extracted = parts.join("\n");
            }
            events.push({
              id: nextId++,
              timestamp: startTsIso,
              type: "message",
              role: "assistant",
              content: extracted,
              tokens: { input: inputTok, output: outputTok },
              turnIndex: iter,
              durationMs: llmDurationMs,
            });
            break;
          }

          case "llm_error":
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "error",
              role: "system",
              content: `LLM error: ${String(data.message ?? "")}`,
            });
            break;

          case "tool_call_start": {
            const callId = String(data.call_id ?? "");
            const eventId = nextId++;
            if (callId) callIdToEventId.set(callId, eventId);
            events.push({
              id: eventId,
              timestamp: ts,
              type: "tool_call",
              role: "assistant",
              toolCall: {
                name: String(data.tool_name ?? "unknown"),
                arguments: "",
              },
            });
            break;
          }

          case "tool_call_end": {
            const callId = String(data.call_id ?? "");
            const linkedId = callId ? callIdToEventId.get(callId) : undefined;
            const success = data.success !== false;
            const resultText = String(data.result_preview ?? "");
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "tool_result",
              role: "environment",
              toolResult: {
                output: resultText,
                isError: !success,
                toolCallEventId: linkedId,
              },
              durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
            });
            // VETT's tool_call_start envelope doesn't include the arguments,
            // so the corresponding tool_call event landed with arguments="".
            // For file_editor calls, derive a sensible {command, path}
            // back-fill from the result text so views (Diff, File Edits)
            // can show "/testbed/foo.py" instead of "unknown file".
            if (linkedId !== undefined) {
              const callEvent = events.find((e) => e.id === linkedId);
              if (callEvent?.toolCall?.name === "file_editor" && !callEvent.toolCall.arguments) {
                const derived = this.deriveFileEditorArgsFromResult(resultText);
                if (derived) callEvent.toolCall.arguments = derived;
              } else if (callEvent?.toolCall?.name === "terminal" && !callEvent.toolCall.arguments) {
                // Terminal calls don't appear in the diff view but the
                // tool-call panels look better with SOMETHING here. We
                // still don't have the original command, but flag it so
                // downstream code can render "(arguments not captured)".
                callEvent.toolCall.arguments = JSON.stringify({ _captured: false });
              }
            }
            break;
          }

          case "session_recovery":
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "system",
              role: "system",
              content: `Session recovered (iter ${data.iteration ?? "?"}, reason: ${data.reason ?? "?"})`,
            });
            break;

          case "session_recovery_failed":
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "error",
              role: "system",
              content: `Session recovery FAILED (iter ${data.iteration ?? "?"}): ${data.error ?? ""}`,
            });
            break;

          case "error":
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "error",
              role: "system",
              content: `Middleware error: ${data.message ?? ""}`,
            });
            break;

          case "patch_capture_failed":
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "error",
              role: "system",
              content: `Patch capture failed: ${data.error ?? ""}`,
            });
            break;

          case "post_hook_failed":
            events.push({
              id: nextId++,
              timestamp: ts,
              type: "error",
              role: "system",
              content: `Post-process hook failed: ${data.error ?? ""}`,
            });
            break;

          case "instance_end":
            endReason = String(data.end_reason ?? "unknown");
            events.push({
              id: nextId++,
              timestamp: ts,
              type: endReason === "finish_tool" ? "system" : "error",
              role: "system",
              content: `Instance ended: ${endReason}`,
            });
            break;

          // iteration_start / iteration_end intentionally dropped: too noisy,
          // and iteration count is already on llm_response/tool_call events.
        }

        if (agent) {
          for (let i = beforeLen; i < events.length; i++) {
            events[i].agent = agent;
          }
        }
      }

      if (events.length === 0) continue;

      const startTime = events[0].timestamp;
      const endTime = events[events.length - 1].timestamp;
      const status: Trajectory["session"]["status"] =
        endReason === "finish_tool" ? "succeeded"
        : endReason === null         ? "running"
        : endReason === "error"      ? "error"
        : "failed";

      fillEventDurations(events);

      const traj: Trajectory = {
        version: "1.0",
        source: "vett",
        session: {
          id: `vett-live/${instanceId}`,
          startTime,
          endTime,
          status,
          metadata: {
            instanceId,
            source: "vett-livesink",
            sourceFile: filename,
            endReason,
          },
        },
        events,
      };
      traj.summary = computeSummary(events);
      trajectories.push(traj);
    }

    return trajectories;
  }
}
