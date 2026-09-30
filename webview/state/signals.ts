import { signal, computed } from '@preact/signals';
import vscode from '../vscode';
import type { ChatMessage, ToolCall, IterationInfo, VettEvent, ConnectionErrorKind, ProfileSummary, Dispatch, ChatMode, VettImageAttachment, Mention, MentionFile, MentionSymbol, ProblemsCount, GitStatusSummary, SessionOverrides, WorktreeStatus, PendingPermission, PermissionKind } from '../../src/shared/types';
import { computeCost, getPricing, type ModelPricing } from '../utils/pricing';
import { filterBeforeTimestamp, rewindMessagesToIndex, rewindMessagesToTurn } from '../utils/rewind';

// Maximum messages/tool calls to keep in memory. Older entries are
// trimmed to prevent unbounded growth in long sessions.
const MAX_MESSAGES = 500;
const MAX_TOOL_CALLS = 200;

// --- Connection state ---
export const connected = signal(false);
export const connectionError = signal<string | null>(null);
export const connectionErrorKind = signal<ConnectionErrorKind | null>(null);
export const connectionErrorDetails = signal<string | null>(null);
export const cwd = signal('');
export const profile = signal('coding');

// --- Profile catalog ---
// Populated from `vett profiles --json` on extension start. The current
// profile's endpoint/model/etc. is derived from this list — there is no
// extension-level setting for them. To change LLM config, edit the
// profile YAML.
export const profiles = signal<ProfileSummary[]>([]);

/** The full ProfileSummary for the currently-selected profile, or null
 * if the catalog hasn't loaded yet or the named profile no longer exists. */
export const currentProfile = computed<ProfileSummary | null>(() =>
  profiles.value.find((p) => p.name === profile.value) ?? null,
);

// --- Welcome / first-run state ---
// True when the user hasn't completed onboarding yet. Set on init from
// globalState; flipped to false when the user dismisses the welcome view.
export const showWelcome = signal(false);

// --- View mode ---
/**
 * Three view modes for the chat panel:
 *   - 'live'  → curated chat (user/assistant messages, dispatch cards,
 *               collapsed tool cards). Default for normal use.
 *   - 'logs'  → chronological event timeline with compact tool result
 *               previews. Useful for "what is the agent doing?".
 *   - 'raw'   → same timeline but with FULL data (untruncated tool
 *               results, full args). For deep debugging.
 *
 * `verboseMode` is kept as a derived alias for backward-compat with
 * components that already check it; it's true whenever we're in
 * logs OR raw view (i.e. NOT in live mode).
 */
export type ViewMode = 'live' | 'logs' | 'raw' | 'gantt';
export const viewMode = signal<ViewMode>('live');
export const verboseMode = computed(() => viewMode.value !== 'live');

/** Every event that arrived from vett, in arrival order. Maintained
 * in parallel with the curated state (messages/toolCalls/dispatches)
 * so toggling between curated and verbose is instant. Bounded same as
 * MAX_TOOL_CALLS so a runaway session can't blow up memory. */
const MAX_RAW_EVENTS = 2000;
export const rawEvents = signal<{ ts: string; event: VettEvent }[]>([]);

function pushRaw(event: VettEvent): void {
  const entry = { ts: event.timestamp ?? new Date().toISOString(), event };
  const next = [...rawEvents.value, entry];
  rawEvents.value = next.length > MAX_RAW_EVENTS ? next.slice(next.length - MAX_RAW_EVENTS) : next;
}

// --- Session log path ---
// Set by ChatViewProvider via the 'init' message and (separately) via a
// dedicated 'sessionLogPath' message that fires once per session start.
// Surface this in the UI so users can click → reveal the file in their
// OS file manager → drag into AI Timeline.
export const sessionLogPath = signal<string | null>(null);

// --- Chat state ---
export const messages = signal<ChatMessage[]>([]);
export const messageText = signal('');
export const isSending = signal(false);
export const waitingForInput = signal(false);

// --- Agent state ---
export const toolCalls = signal<ToolCall[]>([]);
/** Sub-agent dispatches: each entry captures one member task that the
 * leader spawned via assign_task. Rendered inline as collapsible cards
 * so the user can see what the member did without leaving the panel. */
export const dispatches = signal<Dispatch[]>([]);
export const currentIteration = signal<IterationInfo | null>(null);
export const totalInputTokens = signal(0);
/** Size of the prompt sent on the most-recent MAIN-THREAD llm_response —
 *  i.e., what's currently sitting in the model's context window for the
 *  leader / single-agent. Drives the StatusBar gauge ("how full is my
 *  context right now?"). Sub-agent (member) llm_responses run in their
 *  own context windows and don't contribute here. Cumulative session
 *  totals (totalInputTokens / totalOutputTokens) still sum everything
 *  for cost calculation. */
export const lastMainTurnInputTokens = signal(0);
export const totalOutputTokens = signal(0);

/** Tokens spent inside the CURRENT turn (between the user message and
 *  the next assistant_text). Reset on every assistant_text so we can
 *  attach "input N / output M" to that message in the chat view.
 *  Without this, the chat only shows cumulative totals — useful in the
 *  status bar, useless for "how expensive was that one answer?". */
export const turnInputTokens = signal(0);
export const turnOutputTokens = signal(0);

/** Cumulative dollar cost across the session, computed from the active
 *  profile's model + a per-call pricing table. Local /
 *  self-hosted models contribute 0 (UI shows "$0 / local"). */
export const totalCostUsd = signal(0);

/** Density mode for tool-call cards in the Live view. Bound to the
 *  `vett-chat.toolCardDensity` setting via the host's init message and
 *  refreshed if the user changes the setting. Defaults to "default"
 *  (header card with truncated IN/OUT) so a fresh install matches the
 *  doc.
 *
 *   compact  — one line per call: "● Bash · List home dir ✓ 120ms"
 *   default  — header + IN/OUT preview blocks (truncated), expandable
 *   verbose  — full args + full result inline, no truncation
 */
export type ToolCardDensity = 'compact' | 'default' | 'verbose';
export const toolCardDensity = signal<ToolCardDensity>('default');

/** Active chat mode for this panel. Mirrors the per-panel mode tracked
 *  by ChatPanelProvider. Toggling this value sends a `setChatMode`
 *  message to the host, which respawns the vett subprocess with the
 *  appropriate `--mode` flag (mode is baked at session start so a
 *  respawn is required to take effect). */
export const chatMode = signal<ChatMode>('execute');

/** Per-session profile overrides — temperature / top-p / max iterations
 *  / timeout / system-prompt-append. Bound to the Settings UI form;
 *  applied to vett as CLI flags at subprocess spawn. Empty object =
 *  use profile defaults. Mirrors host-side `ChatPanelProvider.sessionOverrides`. */
export const sessionOverrides = signal<SessionOverrides>({});

/** Settings drawer visibility. The drawer overlays the chat content
 *  rather than living in a separate panel — keeps it close to the chat
 *  it's tweaking, avoids a second webview registration. */
export const settingsOpen = signal(false);

/** Mirror of the workspace `vett-chat.useWorktree` setting — drives the
 *  Settings drawer's Workspace section toggle. Updated on init + on
 *  `useWorktreeSettingChanged` from the host (config-watcher). The
 *  current panel keeps its captured mode regardless of this value;
 *  changing it only affects newly-spawned panels. */
export const useWorktreeSetting = signal<boolean>(false);

/** Total context window size for the active LLM, in tokens. Drives
 *  the StatusBar's token gauge — `total / contextWindowTokens` is the
 *  fill ratio. Mirrors the `vett-chat.contextWindowTokens` setting;
 *  set on init, refreshed on `settingsChanged`. Default matches the
 *  package.json default (131072 / 128k) so the gauge is sane before
 *  the first init message arrives. */
export const contextWindowTokens = signal<number>(131072);

/** Sub-agent dispatch-card rendering style. `log` (default) = the
 *  current one-line-per-event compact log. `structured` = render
 *  sub-agent tool calls as the same `ToolCallCard` the main chat
 *  uses + assistant_text as message bubbles, with iteration /
 *  llm_request / llm_response noise hidden. Mirrors the
 *  `vett-chat.dispatchViewStyle` setting; updated on init +
 *  `settingsChanged`. */
export type DispatchViewStyle = 'log' | 'structured';
export const dispatchViewStyle = signal<DispatchViewStyle>('log');
/** Mode the CURRENT panel was spawned with. `'worktree'` → the chat is
 *  running inside `~/.vett/worktrees/...` and the Settings UI should
 *  show a "next chat" hint when the toggle disagrees. `'direct'` → the
 *  chat is editing the workspace directly. */
export const panelWorktreeMode = signal<'worktree' | 'direct'>('direct');

/** Worktree state for this panel — tells the chat header chip what to
 *  render and the dropdown which actions to enable. `disabled` mode
 *  means the chat is operating directly in the user's workspace
 *  (vett-chat.useWorktree = false, or the panel hit a fallback). */
export const worktreeStatus = signal<WorktreeStatus>({
  enabled: false,
  mode: 'disabled',
  path: '',
  workspaceRoot: '',
});

/** Worktree dropdown menu visibility. Click the chip to toggle. */
export const worktreeMenuOpen = signal(false);

/** Pending image attachments staged for the next user message — built
 *  up via paste, drag-drop, and the screenshot hotkey, drained when
 *  the user hits Send. Each entry is { data: <base64>, media_type }
 *  matching the wire format the host forwards to vett. The webview
 *  also keeps a parallel `pendingImagePreviews` of data: URIs for
 *  the input-area thumbnail row. */
export const pendingImages = signal<VettImageAttachment[]>([]);
export const pendingImagePreviews = signal<string[]>([]);

/** Mentions the user has picked from the @-menu but not yet sent.
 *  Keyed by the verbatim token (e.g. `@src/foo.ts`) so the host's
 *  expander can substitute exact matches in the message text at send
 *  time. Pruned automatically: tokens that no longer appear in the
 *  textarea (because the user backspaced them) get garbage-collected
 *  on every input change in ChatView. */
export const pendingMentions = signal<Mention[]>([]);

/** Latest mention-menu context shipped from the host in response to
 *  `requestMentionContext`. Empty until the user opens the @-menu.
 *  Phase 2 added `symbols` (workspace symbol search), `problems`
 *  (diagnostics count), and `git` (status summary) so the menu can
 *  surface `@symbol-name` / `@problems` / `@git` / `@diff` rows
 *  alongside files and selection. */
export const mentionFiles = signal<MentionFile[]>([]);
export const mentionSymbols = signal<MentionSymbol[]>([]);
export const mentionSelectionPreview = signal<string | null>(null);
export const mentionProblemsCount = signal<ProblemsCount | null>(null);
export const mentionGit = signal<GitStatusSummary>({ available: false });

/** True when the agent loop is paused at an iteration boundary
 *  (between LLM responses). Set by the `paused` event, cleared by
 *  `resumed` or by the loop emitting any forward-progress event. The
 *  chat header shows a "PAUSED" tag and the input shows a "Resume"
 *  button while this is true. */
export const agentPaused = signal(false);

/** Currently-pending ask_user_question tool call. When set, the chat
 *  view shows a question card with the question + (optional) choices.
 *  Cleared once the user answers (either by clicking a choice or
 *  typing an answer in the inline reply box). */
export interface PendingQuestion {
  questionId: string;
  question: string;
  choices: string[];
}
export const pendingQuestion = signal<PendingQuestion | null>(null);

/** Pending permission asks emitted by vett's permission gate before
 *  it dispatches risky tool calls. Multiple can be in flight if the
 *  agent emits parallel tool calls — we render them as a stack of
 *  cards in arrival order. Each card resolves on the user's Allow /
 *  Allow Always / Deny / Deny Always click and is removed from the
 *  list. Cleared on resetChatState too. */
export const pendingPermissions = signal<PendingPermission[]>([]);

/** Pending per-call plan-mode action requests. Each entry is one
 *  blocked tool call awaiting user approval. The chat UI renders a
 *  card for each (Approve & Switch / Reject). On Approve, the gate
 *  unlocks for the rest of the session AND vett emits
 *  chat_mode_changed:execute so the header chip flips Plan → Exec
 *  without a respawn. After unlock, no further requests should arrive
 *  (the gate short-circuits) but if one does we still render it.
 *  Cleared on resetChatState + rewind. */
export interface PendingPlanAction {
  requestId: string;
  toolName: string;
  preview: string;
  arguments: Record<string, unknown>;
}
export const pendingPlanActions = signal<PendingPlanAction[]>([]);

/** Voice-input UI state (idle / recording / transcribing). Driven by
 *  `voiceInputStatus` host messages — the host owns the recording
 *  lifecycle, the webview just renders the right button label + style.
 *  `idle` is the default; first `toggleVoiceInput` flips it to
 *  `recording` and back through `transcribing`. */
export type VoiceInputState = 'idle' | 'recording' | 'transcribing';
export const voiceInputState = signal<VoiceInputState>('idle');

// --- Computed ---
/** True when the agent is ready to receive a message *immediately*
 * (idle, or explicitly waiting for input). When false, a Send action
 * still works but the message gets queued and flushed at the next
 * `assistant_text` / `user_input_needed` boundary. */
export const canSendImmediately = computed(() =>
  !isSending.value || waitingForInput.value
);
/** Kept as an always-true alias so the input box never reads as
 * disabled. The queue handles the busy case. Existing call sites that
 * read `canSend.value` see the same shape; behavior changes downstream
 * via `addUserMessage` enqueuing instead of blocking. */
export const canSend = computed(() => true);

// --- Helpers ---
function appendMessage(msg: ChatMessage): void {
  const updated = [...messages.value, msg];
  messages.value = updated.length > MAX_MESSAGES
    ? updated.slice(updated.length - MAX_MESSAGES)
    : updated;
}

function appendToolCall(tc: ToolCall): void {
  const updated = [...toolCalls.value, tc];
  toolCalls.value = updated.length > MAX_TOOL_CALLS
    ? updated.slice(updated.length - MAX_TOOL_CALLS)
    : updated;
}

// --- Event handler ---
export function handleVettEvent(event: VettEvent): void {
  // Always capture into rawEvents first so the verbose view sees
  // EVERY event, including ones we'd otherwise drop in curated view
  // (iteration_start/end, llm_response, stderr, dispatch markers).
  pushRaw(event);

  // Sub-agent thread routing. Vett tags events that came from a member's
  // run with `thread_id = <member name>`. We append those events to the
  // matching Dispatch's `events` list so the inline card can render
  // them, and skip the rest of the main-thread handling for them.
  // Events with thread_id="main" or no thread_id flow through unchanged.
  const threadId = (event.data as { thread_id?: string } | undefined)?.thread_id;
  if (threadId && threadId !== 'main') {
    appendToDispatch(threadId, event);
    return;
  }

  switch (event.type) {
    case 'dispatch_start': {
      const d = event.data ?? {};
      const member = String(d.member ?? '');
      const task = String(d.task ?? '');
      // task_id uniquely identifies one dispatch instance; multiple
      // parallel calls (even to the same member) each get their own
      // card. Falls back to member name for older logs that pre-date
      // task_id plumbing.
      const taskId = String(d.task_id ?? d.member ?? '');
      const isContinuation = Boolean(d.continuation);

      // Continuations get their OWN dispatch card pushed into the feed
      // at the moment continue_task fired — same threadId so member
      // events still route correctly via appendToDispatch (which now
      // picks the latest matching dispatch), but a separate startedAt
      // so the card sorts in chronologically next to its triggering
      // continue_task tool call. Without this, continuation work was
      // invisibly tucked back inside the original assign_task card,
      // far above the user's follow-up message.
      dispatches.value = [
        ...dispatches.value,
        {
          threadId: taskId,
          memberName: member,
          task: isContinuation ? `(continuation) ${task}` : task,
          startedAt: event.timestamp ?? new Date().toISOString(),
          // Seed with the dispatch_start event itself so the expanded
          // card shows "↳ dispatch start" as the first line — matches
          // what Logs view shows.
          events: [event],
          active: true,
          expanded: false,
        },
      ];
      break;
    }

    case 'dispatch_end': {
      const d = event.data ?? {};
      const member = String(d.member ?? '');
      const taskId = String(d.task_id ?? d.member ?? '');
      const completedAt = event.timestamp ?? new Date().toISOString();
      // ⛔ COULD-NOT-MEASURE IS NOT MEASURED-ZERO.
      //
      // The harness publishes `iterations: null` alongside
      // `counters_measured: false` when a dispatch was cancelled before the
      // agent loop could report a count. Coercing that with `?? 0` recreated,
      // in this UI, the exact defect the harness change removed: an unmeasured
      // dispatch rendered "0 iters", byte-identical to a member that ran and
      // genuinely did nothing.
      //
      // Worse, it also broke the card's own fallback. DispatchCard does
      // `dispatch.iterations ?? liveIterations`, and 0 is NOT nullish — so a
      // laundered zero SUPPRESSED the live iteration_start count that would
      // otherwise have shown the real progress.
      //
      // Leave it undefined so "unknown" stays distinguishable from "zero".
      const iterations = d.iterations == null ? undefined : Number(d.iterations);
      const stopReason = String(d.stop_reason ?? '');
      // Close the LATEST active dispatch with this taskId. With
      // continuations, the same taskId has multiple dispatch entries
      // — the active one at the time dispatch_end arrives is always
      // the most recently started segment.
      for (let i = dispatches.value.length - 1; i >= 0; i--) {
        const disp = dispatches.value[i];
        const match = disp.threadId === taskId || (disp.memberName === member);
        if (!match || !disp.active) continue;
        dispatches.value = [
          ...dispatches.value.slice(0, i),
          {
            ...disp,
            // Append the dispatch_end event too so the expanded card has
            // a closing "↰ dispatch end" line.
            events: [...disp.events, event],
            active: false,
            completedAt,
            iterations,
            stopReason,
          },
          ...dispatches.value.slice(i + 1),
        ];
        break;
      }
      break;
    }

    case 'ready':
      connected.value = true;
      connectionError.value = null;
      if (event.data?.cwd && typeof event.data.cwd === 'string') {
        cwd.value = event.data.cwd;
      }
      break;

    case 'user_input_needed':
      isSending.value = false;
      waitingForInput.value = true;
      // If the user typed messages while the agent was busy, fire the
      // next one through right now. The webview message handler (App.tsx)
      // observes the queue draining via the messages signal and posts
      // the sendMessage to the host.
      flushPendingQueue();
      break;

    case 'assistant_text': {
      // Snapshot per-turn token tally onto this message before resetting,
      // so the chat view can render "input N / output M / $X.XX" under
      // the assistant bubble. Without this snapshot the per-turn counts
      // would all show whatever was in flight at render time, not the
      // count that produced this specific reply.
      const tIn = turnInputTokens.value;
      const tOut = turnOutputTokens.value;
      const pricing = getActivePricing();
      const tCost = computeCost(pricing, tIn, tOut);
      appendMessage({
        role: 'assistant',
        text: event.text ?? '',
        timestamp: event.timestamp ?? new Date().toISOString(),
        turnInputTokens: tIn,
        turnOutputTokens: tOut,
        turnCostUsd: tCost,
      });
      // Reset per-turn counters now that they've been attached. The
      // next iteration_start fires before the next assistant_text, so
      // we don't lose anything.
      turnInputTokens.value = 0;
      turnOutputTokens.value = 0;
      isSending.value = false;
      waitingForInput.value = true;
      flushPendingQueue();
      break;
    }

    case 'tool_call_start': {
      const d = event.data ?? {};
      appendToolCall({
        callId: String(d.call_id ?? ''),
        toolName: String(d.tool_name ?? ''),
        arguments: d.arguments as Record<string, unknown> | undefined,
        expanded: false,
        startedAt: event.timestamp ?? new Date().toISOString(),
      });
      isSending.value = true;
      waitingForInput.value = false;
      break;
    }

    case 'tool_call_end': {
      const d = event.data ?? {};
      const id = String(d.call_id ?? '');
      // Vett emits `result_preview` — already truncated to 200 chars +
      // a "…[+N]" tail on the C# side (see AgentLoop.Preview). We accept
      // `result` as a fallback in case a future protocol bump sends the
      // full string under a different name.
      const preview =
        typeof d.result_preview === 'string' ? d.result_preview :
        typeof d.result === 'string' ? d.result :
        undefined;
      // Vett also emits the FULL result alongside the truncated preview
      // (AgentLoop.cs tool_call_end). Capture it so the expanded card
      // shows the complete output — without this the OUT block stayed
      // truncated to ~200 chars even when expanded, which made
      // accept_dispatch / review_dispatch results unreadable in the UI.
      const fullResult = typeof d.result === 'string' ? d.result : undefined;
      const { display, truncated, fullLength } = parsePreview(preview);
      toolCalls.value = toolCalls.value.map((tc) =>
        tc.callId === id
          ? {
              ...tc,
              result: display,
              resultFull: fullResult,
              resultTruncated: truncated,
              resultLength: fullLength,
              success: Boolean(d.success),
              durationMs: Number(d.duration_ms ?? 0),
            }
          : tc,
      );
      break;
    }

    case 'iteration_start': {
      const d = event.data ?? {};
      currentIteration.value = {
        iteration: Number(d.iteration ?? 0),
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
      break;
    }

    case 'iteration_end': {
      const d = event.data ?? {};
      if (currentIteration.value) {
        currentIteration.value = {
          ...currentIteration.value,
          durationMs: Number(d.duration_ms ?? 0),
        };
      }
      break;
    }

    case 'llm_response': {
      const d = event.data ?? {};
      const inT = Number(d.input_tokens ?? 0);
      const outT = Number(d.output_tokens ?? 0);
      totalInputTokens.value += inT;
      totalOutputTokens.value += outT;
      // Track the most-recent MAIN-THREAD prompt size separately so the
      // StatusBar gauge reflects current context fill (not a cumulative
      // sum that overshoots the model's window when sub-agents run).
      // Single-agent profiles emit events without a thread_id; team
      // leader emits with thread_id='main'; members emit thread_id=
      // <member-name>. Treat undefined / 'main' as leader/main; others
      // (members) don't update the gauge denominator.
      const threadId = (d as { thread_id?: unknown }).thread_id;
      if (threadId === undefined || threadId === 'main') {
        lastMainTurnInputTokens.value = inT;
      }
      // Per-turn tally — drained on the next assistant_text and
      // attached to that message so the user can see what the answer
      // actually cost.
      turnInputTokens.value += inT;
      turnOutputTokens.value += outT;
      // Cumulative session cost — the StatusBar reads this so it can
      // show a $-figure next to the token gauge for cloud models.
      const pricing = getActivePricing();
      totalCostUsd.value += computeCost(pricing, inT, outT);
      break;
    }

    case 'done': {
      isSending.value = false;
      waitingForInput.value = false;
      connected.value = false;
      const d = event.data ?? {};
      appendMessage({
        role: 'assistant',
        text: `--- Session ended (${d.stop_reason ?? 'unknown'}) | ${d.iterations ?? 'unmeasured'} iterations ---`,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'compacted': {
      // Vett's MilestoneCheckpoint middleware just compressed the
      // conversation history (either auto-triggered by the token
      // threshold or because the user typed /compact). Show an
      // inline marker so the user knows compression happened.
      const d = event.data ?? {};
      const reason = d.reason === 'user_requested' ? 'manual' : 'auto';
      const before = typeof d.before === 'number' ? d.before : 0;
      const after = typeof d.after === 'number' ? d.after : 0;
      const removed = Math.max(0, before - after);
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          text: `[Compacted ${removed} earlier message${removed === 1 ? '' : 's'} (${reason}). Conversation continues.]`,
          timestamp: event.timestamp ?? new Date().toISOString(),
        },
      ];
      break;
    }

    case 'paused': {
      // Loop reached an iteration boundary with PauseRequest set.
      // Show the paused state until a `resumed` event arrives (or the
      // loop emits a fresh assistant_text / iteration_start, which
      // implicitly means we're moving again).
      agentPaused.value = true;
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          text: '[Paused at iteration boundary. Click Resume in the input area, or type a message to continue.]',
          timestamp: event.timestamp ?? new Date().toISOString(),
        },
      ];
      isSending.value = false;
      waitingForInput.value = true;
      break;
    }

    case 'resumed': {
      agentPaused.value = false;
      const withMessage = (event.data?.with_message as boolean | undefined) ?? false;
      if (!withMessage) {
        messages.value = [
          ...messages.value,
          {
            role: 'assistant',
            text: '[Resumed.]',
            timestamp: event.timestamp ?? new Date().toISOString(),
          },
        ];
      }
      // If the resume was triggered by a user message, that message is
      // already in the chat (added by the input handler) — no extra
      // marker needed.
      break;
    }

    case 'user_question': {
      // Agent fired the ask_user_question tool. Surface the question
      // as an inline card with the choices as buttons. Clearing the
      // pending state is the user's job (clicking a choice or typing
      // an answer).
      const d = event.data ?? {};
      const qid = String(d.question_id ?? '');
      const q = String(d.question ?? '');
      const choicesRaw = d.choices;
      const choices: string[] = Array.isArray(choicesRaw)
        ? choicesRaw.map(String)
        : [];
      if (qid && q) {
        pendingQuestion.value = { questionId: qid, question: q, choices };
      }
      break;
    }

    case 'plan_mode_action_request': {
      // The plan-mode unlock gate is asking the user to approve a
      // blocked write tool call. Render a card with Approve & Switch /
      // Reject. Approve unlocks the gate + flips chat mode; Reject
      // returns an error to the agent.
      const d = event.data ?? {};
      const requestId = String(d.request_id ?? '');
      const toolName = String(d.tool_name ?? '');
      const preview = String(d.preview ?? '');
      const argsObj = (d.arguments && typeof d.arguments === 'object')
        ? (d.arguments as Record<string, unknown>)
        : {};
      if (requestId && toolName) {
        pendingPlanActions.value = [
          ...pendingPlanActions.value,
          { requestId, toolName, preview, arguments: argsObj },
        ];
      }
      break;
    }
    case 'chat_mode_changed': {
      // vett emits this when the plan-mode gate unlocks (or any other
      // path that flips mode server-side). Reflect it in the header
      // toggle so the user sees the mode change. Reason field tells us
      // WHY (e.g. "plan_mode_unlocked") for future telemetry; for now
      // we just mirror the mode value.
      const d = event.data ?? {};
      const m = String(d.mode ?? '');
      if (m === 'execute' || m === 'plan') {
        chatMode.value = m;
      }
      break;
    }

    case 'permission_request': {
      // Permission gate is asking the user before dispatching a risky
      // tool call. Render a card with Allow / Always Allow / Deny /
      // Always Deny — the user's click resolves the request via
      // permissionResponse and clears it from this list.
      const d = event.data ?? {};
      const requestId = String(d.request_id ?? '');
      const toolName = String(d.tool_name ?? '');
      const kindRaw = String(d.kind ?? 'Other');
      const kind: PermissionKind = (
        ['Read', 'Edit', 'TerminalSafe', 'TerminalUnsafe', 'Mcp', 'Other'] as PermissionKind[]
      ).includes(kindRaw as PermissionKind) ? (kindRaw as PermissionKind) : 'Other';
      const preview = String(d.preview ?? '');
      const argsObj = (d.arguments && typeof d.arguments === 'object')
        ? (d.arguments as Record<string, unknown>)
        : {};
      if (requestId && toolName) {
        pendingPermissions.value = [
          ...pendingPermissions.value,
          { requestId, toolName, kind, preview, arguments: argsObj },
        ];
      }
      break;
    }

    case 'auto_check': {
      // Lint/test feedback from the auto-check loop. Render an inline
      // marker so the user can see what the agent saw — even if the
      // check passed quietly, we want a small acknowledgment. Failure
      // copies are louder.
      const d = event.data ?? {};
      const kind = String(d.kind ?? '');
      const status = String(d.status ?? '');
      const exit = d.exit_code;
      const dur = d.duration_ms;
      let text = '';
      if (status === 'pass') text = `[auto-${kind} ✓ passed in ${dur}ms]`;
      else if (status === 'fail') text = `[auto-${kind} ✗ failed (exit ${exit}) — output piped back to agent for self-correction]`;
      else if (status === 'error') text = `[auto-${kind} couldn't run: ${d.message ?? 'unknown error'}]`;
      if (text) {
        messages.value = [
          ...messages.value,
          {
            role: 'assistant',
            text,
            timestamp: event.timestamp ?? new Date().toISOString(),
          },
        ];
      }
      break;
    }

    case 'cancelled': {
      // Vett aborted the in-flight LLM call + tool calls and is now
      // waiting for the next user message.
      // Mark in-flight tool cards as cancelled and add a visible
      // "interrupted" note so the user sees that the turn ended.
      toolCalls.value = toolCalls.value.map((tc) =>
        tc.success === undefined ? { ...tc, success: false, result: '(cancelled)' } : tc,
      );
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          text: '[Request interrupted by user]',
          timestamp: event.timestamp ?? new Date().toISOString(),
        },
      ];
      isSending.value = false;
      waitingForInput.value = true;
      break;
    }

    case 'error': {
      const d = event.data ?? {};
      const msg = typeof d.message === 'string' ? d.message : 'Unknown error';
      connectionError.value = msg;
      // Heuristic: if the message smells like an LLM endpoint problem,
      // surface it as that kind so the banner can suggest fixing the
      // endpoint setting rather than reinstalling vett.
      if (!connectionErrorKind.value && isLikelyLlmEndpointError(msg)) {
        connectionErrorKind.value = 'llm_endpoint';
        connectionErrorDetails.value = msg;
      } else if (!connectionErrorKind.value) {
        connectionErrorKind.value = 'agent_error';
        connectionErrorDetails.value = msg;
      }
      break;
    }

    case 'stderr':
      break;
  }
}

// --- Actions ---
/**
 * Submit a user message. If the agent is idle this fires the message
 * straight at the subprocess; if the agent is busy the message is
 * appended to the chat with `queued: true` and gets flushed at the next
 * `assistant_text`/`user_input_needed` boundary. Returns the text that
 * was actually sent immediately, or null if the message was queued —
 * the caller uses this to decide whether to also `vscode.postMessage`.
 *
 * `images` (optional): wire-format image attachments to send alongside
 * the text. Currently only sent for the IMMEDIATE path — queued
 * messages don't currently capture images (rare edge case: paste +
 * type while agent is busy). If we hit that we'll extend the queued
 * shape, but for v1 the dropped-images case just shows in the chat
 * without delivery.
 *
 * `previews` (optional): data: URIs paired with `images`, attached to
 * the appended ChatMessage so the chat view shows thumbnails inline.
 */
export function addUserMessage(text: string, images?: VettImageAttachment[], previews?: string[]): string | null {
  const queued = !canSendImmediately.value;
  const ts = new Date().toISOString();
  appendMessage({
    role: 'user',
    text,
    timestamp: ts,
    queued,
    images: previews && previews.length > 0 ? previews : undefined,
  });
  // Also push a synthetic `user_message` event into rawEvents so the
  // Logs / Raw / Gantt views see the user side of the conversation.
  // Vett never echoes user_message back over stdout (the message is
  // SENT to vett's stdin), so without this synthesis the chronological
  // event timeline would be missing every user turn.
  pushRaw({
    type: 'user_message',
    text,
    timestamp: ts,
    data: { text, queued, image_count: images?.length ?? 0 },
  });
  messageText.value = '';
  // Drain pending image staging now that they've been attached to the
  // outgoing message — the input bar's thumbnail strip clears.
  if (images && images.length > 0) {
    pendingImages.value = [];
    pendingImagePreviews.value = [];
  }
  // Drain mentions too — the host expanded them into the outgoing
  // message text, so the staged list isn't useful anymore.
  if (pendingMentions.value.length > 0) {
    pendingMentions.value = [];
  }
  if (queued) return null;
  isSending.value = true;
  waitingForInput.value = false;
  return text;
}

/**
 * Pop the oldest queued user message, flip its `queued` flag, and post
 * the corresponding `sendMessage` to the host. Called from the vett
 * event handler when the agent transitions back to a ready state.
 * Idempotent — does nothing when no queued message exists.
 */
export function flushPendingQueue(): void {
  const idx = messages.value.findIndex((m) => m.queued);
  if (idx === -1) return;
  const next = messages.value[idx];
  const updated = messages.value.slice();
  updated[idx] = { ...next, queued: false };
  messages.value = updated;
  isSending.value = true;
  waitingForInput.value = false;
  vscode.postMessage({ type: 'sendMessage', data: { text: next.text } });
}

/**
 * Seed the chat panel with prior messages from a resumed session.
 * Distinct from the agent's seeded conversation context (vett's
 * `--resume` handles that) — this is purely the UI replay so the
 * user can see what was said before. Appends rather than replaces so
 * a partially-loaded chat doesn't lose any in-flight content.
 */
export function seedHistory(seedMessages: ChatMessage[]): void {
  for (const m of seedMessages) {
    appendMessage(m);
  }
}

/**
 * Replay raw JSONL envelopes from a resumed session through the same
 * pipeline that handles live events. Without this, only user/assistant
 * text was being seeded — Raw, Logs, and Gantt views were empty after
 * a resume, and dispatch cards for sub-agent calls didn't appear in
 * Live. Caller is the host's resume path; it reads the JSONL and posts
 * the parsed envelopes to the webview as a single batch.
 *
 * `user_message` is handled here because handleVettEvent doesn't deal
 * with it (live vett doesn't echo user input back; the live-path
 * synthesis lives in `addUserMessage`). For resume we have it on disk
 * and need to populate both messages + rawEvents from it.
 */
export function replaySeedEnvelopes(envelopes: VettEvent[]): void {
  // Idempotency: if we've already populated state (either from a
  // previous seed or from live events), don't wipe and replay. The
  // host posts seedFromLog on every onWebviewReady, and live events
  // can arrive *before* seedFromLog because the host starts vett
  // right after posting the seed. Wiping populated state mid-session
  // erased newer assistant_text/tool_call events — Live went blank
  // even though Logs showed everything (rawEvents got rebuilt from
  // the JSONL but messages/dispatches were stale).
  if (rawEvents.value.length > 0 || messages.value.length > 0) {
    return;
  }
  messages.value = [];
  toolCalls.value = [];
  dispatches.value = [];
  rawEvents.value = [];
  currentIteration.value = null;
  totalInputTokens.value = 0;
  lastMainTurnInputTokens.value = 0;
  totalOutputTokens.value = 0;

  for (const ev of envelopes) {
    // Skip transient UI-prompt events on replay. These are
    // request/response pairs (plan-mode action approval, permission
    // gate, exit_plan_mode, ask_user_question) where the request side
    // is logged but the response is not — replaying just the request
    // re-surfaces a card the user already answered, which is confusing
    // and wrong. The fresh vett subprocess has no outstanding prompts
    // anyway. Skip the requests and the live event stream from the new
    // subprocess will surface anything genuinely pending.
    if (
      ev.type === 'plan_mode_action_request' ||
      ev.type === 'permission_request' ||
      ev.type === 'exit_plan_mode_request' ||
      ev.type === 'user_question'
    ) {
      // Still drop the raw envelope into rawEvents so the Logs/Raw
      // views show the historical request — just don't push to the
      // active-prompts signal.
      pushRaw(ev);
      continue;
    }
    if (ev.type === 'user_message') {
      const text = ev.text ?? (ev.data?.text as string | undefined) ?? '';
      if (!text) continue;
      const ts = ev.timestamp ?? new Date().toISOString();
      appendMessage({ role: 'user', text, timestamp: ts });
      pushRaw({ type: 'user_message', text, timestamp: ts, data: { text } });
      continue;
    }
    handleVettEvent(ev);
  }
  // After replay, leave the chat ready for input regardless of what the
  // last event was — a stale "sending…" state from a mid-stream log is
  // worse than starting clean.
  isSending.value = false;
  waitingForInput.value = true;
}

/**
 * Optimistic cancel: flip local UI state back to "ready for input" the
 * moment the user clicks Cancel, before the subprocess has acknowledged.
 * Whatever vett emits next (assistant_text, error, done) will reconcile
 * the real state — but the user shouldn't have to wait to feel like the
 * cancel landed.
 *
 * The corresponding `cancel` message is posted by the caller; this
 * function just owns the local-state flip so the action is co-located
 * with the rest of the chat-state mutations.
 */
export function cancelTurn(): void {
  isSending.value = false;
  waitingForInput.value = true;
  // Mark any in-flight (no success field) tool calls as cancelled so the
  // chat history reflects what happened instead of leaving them as
  // perpetually-running spinners.
  toolCalls.value = toolCalls.value.map((tc) =>
    tc.success === undefined
      ? { ...tc, success: false, result: '(cancelled)' }
      : tc,
  );
}

/** Append a sub-agent thread event to the right Dispatch's events list.
 * For continuations the same threadId can appear multiple times (one
 * dispatch entry per assign + each continue_task) — events always go
 * to the LATEST matching entry, which is the currently-running segment.
 * Best-effort: if no matching dispatch is open, the event is dropped. */
function appendToDispatch(threadId: string, event: VettEvent): void {
  for (let i = dispatches.value.length - 1; i >= 0; i--) {
    if (dispatches.value[i].threadId !== threadId) continue;
    const disp = dispatches.value[i];
    dispatches.value = [
      ...dispatches.value.slice(0, i),
      { ...disp, events: [...disp.events, event] },
      ...dispatches.value.slice(i + 1),
    ];
    return;
  }
}

/**
 * Conversation rewind — slice the visible chat history (messages +
 * tool calls + dispatches) to everything strictly before the chosen
 * cutoff. Powers two surfaces:
 *   - The "Restore conversation" / "Restore both" QuickPick option in
 *     the worktree-chip / `/restore` flow (called via `rewindToTurn`).
 *   - The inline "↶" button next to each user message (called via
 *     `rewindToMessageIndex`).
 *
 * Doesn't touch the agent's *internal* conversation context — vett's
 * subprocess is unaware of the rewind. Cancelling the in-flight turn
 * + respawning the subprocess (or just letting the next user message
 * trigger fresh context) is the user's call. The slice is purely the
 * UI-visible history; combined with the files-side restore (file
 * checkout against the shadow-git), it produces a coherent
 * "checkpoint to here" outcome from the user's perspective.
 *
 * No-op when the cutoff doesn't match anything in state.
 */
export function rewindToTurn(userTurn: number): void {
  const { sliced, cutoffTs } = rewindMessagesToTurn(messages.value, userTurn);
  if (cutoffTs === null) return;
  applyRewind(sliced, cutoffTs);
}

export function rewindToMessageIndex(index: number): void {
  const { sliced, cutoffTs } = rewindMessagesToIndex(messages.value, index);
  if (cutoffTs === null) return;
  applyRewind(sliced, cutoffTs);
}

function applyRewind(slicedMessages: ChatMessage[], cutoffTs: number): void {
  messages.value = slicedMessages;
  toolCalls.value = filterBeforeTimestamp(toolCalls.value, cutoffTs);
  dispatches.value = filterBeforeTimestamp(dispatches.value, cutoffTs);
  // Drain pending state that no longer makes sense post-rewind. Open
  // questions / permission requests / staged images all belong to the
  // discarded future; clearing them keeps the UI consistent.
  pendingQuestion.value = null;
  pendingPermissions.value = [];
  pendingPlanActions.value = [];
  pendingImages.value = [];
  pendingImagePreviews.value = [];
  pendingMentions.value = [];
}

export function resetChatState(): void {
  messages.value = [];
  toolCalls.value = [];
  dispatches.value = [];
  rawEvents.value = [];
  currentIteration.value = null;
  totalInputTokens.value = 0;
  lastMainTurnInputTokens.value = 0;
  totalOutputTokens.value = 0;
  turnInputTokens.value = 0;
  turnOutputTokens.value = 0;
  totalCostUsd.value = 0;
  pendingImages.value = [];
  pendingImagePreviews.value = [];
  pendingMentions.value = [];
  mentionFiles.value = [];
  mentionSymbols.value = [];
  mentionSelectionPreview.value = null;
  mentionProblemsCount.value = null;
  mentionGit.value = { available: false };
  agentPaused.value = false;
  pendingQuestion.value = null;
  pendingPermissions.value = [];
  pendingPlanActions.value = [];
  isSending.value = false;
  waitingForInput.value = false;
  connectionError.value = null;
  connectionErrorKind.value = null;
  connectionErrorDetails.value = null;
  messageText.value = '';
  sessionLogPath.value = null;
}

/** Look up the active profile's model in the pricing table. Returns
 *  null when no profile is loaded yet, when the model is local, or
 *  when the model isn't in the table. Cached only by the underlying
 *  pricing-table function — cheap to call repeatedly. */
function getActivePricing(): ModelPricing | null {
  return getPricing(currentProfile.value?.model);
}

/** Heuristic — does this error message look like the LLM endpoint
 * misbehaving (refused, timeout, auth) vs an in-agent bug? Used to pick
 * the right banner copy when vett emits a generic 'error' event. */
function isLikelyLlmEndpointError(msg: string): boolean {
  return /\b(connection refused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|unreachable|getaddrinfo|name resolution|401|403|429|502|503|504|unauthor[is]z|api[_ -]?key|invalid model|model.*not.*found)\b/i.test(msg);
}

/** Decode vett's `result_preview` format. Vett's `Preview()` returns
 * either the full string (if ≤200 chars) or `<head>…[+N]` where N is the
 * number of bytes elided. We parse N back out so the UI can label
 * truncated results with the original size. */
function parsePreview(preview: string | undefined): {
  display: string | undefined;
  truncated: boolean;
  fullLength: number | undefined;
} {
  if (preview === undefined) {
    return { display: undefined, truncated: false, fullLength: undefined };
  }
  const match = /…\[\+(\d+)\]$/.exec(preview);
  if (!match) {
    return { display: preview, truncated: false, fullLength: preview.length };
  }
  const elided = Number(match[1]);
  const head = preview.slice(0, match.index);
  return {
    display: preview,
    truncated: true,
    fullLength: head.length + elided,
  };
}
