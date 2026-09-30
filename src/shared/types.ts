// Message contracts between extension host and webview.
// Also matches the vett chat --stdio JSON protocol.

// --- vett subprocess protocol ---

/** One image attached to a user message. `data` is base64-encoded
 *  bytes (no data: prefix); `mediaType` is an IANA type like
 *  "image/png" / "image/jpeg" / "image/webp". VETT's Chat.User
 *  factory (ChatMessageHelpers.cs in the VETT repo) decodes
 *  these into MEAI DataContent blocks at consume time. */
export interface VettImageAttachment {
  data: string;
  media_type: string;
}

/** Request from extension to vett subprocess */
export interface VettRequest {
  type: 'user_message' | 'cancel' | 'ping' | 'compact' | 'pause' | 'resume' | 'user_question_answer' | 'permission_response' | 'plan_mode_action_response';
  text?: string;
  /** Optional image attachments — only meaningful with type:'user_message'.
   *  Requires a multimodal-capable model on the vett side
   *  (see webview/utils/multimodal.ts for the families recognised). */
  images?: VettImageAttachment[];
  id?: string;
  /** For type:'user_question_answer' — matches the question_id from the
   *  inbound `user_question` event so the agent loop's question service
   *  routes the answer to the right pending tool call. */
  question_id?: string;
  /** For type:'permission_response' — matches the request_id from the
   *  inbound `permission_request` event. Required for permission round-trip. */
  request_id?: string;
  /** For type:'permission_response' — `auto` (allow this call), `ask`
   *  (default — vett interprets unknown as ask), or `deny`. Vett's
   *  Permissions.Parse maps these to the PermissionRule enum. */
  decision?: 'auto' | 'ask' | 'deny';
  /** For type:'permission_response' — when true, vett flips the
   *  per-session rule for the request's kind to match the decision so
   *  subsequent same-kind calls don't re-prompt. */
  remember_for_kind?: boolean;
  /** For type:'plan_mode_action_response' — true to approve the
   *  blocked tool call (and unlock the gate for the rest of the
   *  session), false to reject (wrap returns an error to the agent;
   *  gate stays locked). */
  approve?: boolean;
}

/** Tool-call kinds the permission gate classifies. Mirrors
 *  `Vett.Tools.PermissionKind` in C#. The chat UI uses this to label
 *  the inline permission card and to drive the "always allow X" copy. */
export type PermissionKind = 'Read' | 'Edit' | 'TerminalSafe' | 'TerminalUnsafe' | 'Mcp' | 'Other';

/** A pending permission ask — built from the inbound
 *  `permission_request` event's data block. Stored on the chat panel's
 *  signals so the UI can render the inline card with Allow / Always
 *  Allow This Kind / Deny / Always Deny This Kind buttons. */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  kind: PermissionKind;
  /** Short human-readable preview built host-side by vett (first 200
   *  chars of a terminal command, "<op> <path>" for file_editor, etc).
   *  Already truncated; the webview just renders it verbatim. */
  preview: string;
  /** Full args object — surfaced when the user expands the card to see
   *  exactly what's about to run. JSON-stringified at render time. */
  arguments: Record<string, unknown>;
}

/** Event from vett subprocess to extension */
export interface VettEvent {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  text?: string;
}

// --- Extension host <-> Webview protocol ---

/**
 * Why the chat is in a disconnected state. Drives which copy + actions
 * the webview shows in the ErrorBanner.
 *
 * - `binary_not_found`: vett executable wasn't located on disk or PATH
 * - `workspace`: no folder open in the VS Code window
 * - `subprocess_exit`: vett spawned but exited non-zero (crash, bad args)
 * - `llm_endpoint`: vett ran but the LLM endpoint refused / timed out / 4xx'd
 * - `agent_error`: catch-all for other errors emitted from inside vett
 * - `invalid_team_override`: the customized team shape cannot run, so no
 *    subprocess was started. ⭐ SEPARATE FROM `subprocess_exit` ON PURPOSE:
 *    this is a fixable field in the Customize panel, not a broken install, and
 *    the banner that says "vett crashed" sends the user to debug the wrong
 *    thing entirely.
 */
export type ConnectionErrorKind =
  | 'binary_not_found'
  | 'invalid_team_override'
  | 'workspace'
  | 'subprocess_exit'
  | 'llm_endpoint'
  | 'agent_error';

/**
 * Sidebar launcher → host messages.
 */
export type LauncherToHost =
  | { type: 'launcherReady' }
  | { type: 'newChat' }
  /** Same as newChat, but stops at the Customize step first so the team
   *  shape can be set for this session only. A SEPARATE MESSAGE, not a flag
   *  on newChat: the plain path deliberately reveals an idle panel instead of
   *  spawning, and reusing an already-spawned panel would silently discard
   *  the shape the user just configured. */
  | { type: 'newChatCustom' }
  | { type: 'openSession'; data: { path: string } }
  | { type: 'deleteSession'; data: { path: string } }
  | { type: 'revealOpenSession'; data: { id: string } }
  | { type: 'pickProfile' };

/**
 * Host → sidebar launcher messages.
 */
export type HostToLauncher =
  | { type: 'sessions'; data: { sessions: LauncherSession[]; profile: string; openSessions: OpenSession[] } };

/** A chat panel that's currently open in the editor area. Listed above
 * past sessions in the launcher so the user can jump back to a tab
 * without hunting through editor tabs. */
export interface OpenSession {
  id: string;
  title: string;
  sessionLogPath?: string;
}

/**
 * Compact session record sent to the launcher webview. Omits the full
 * JSONL contents — the launcher only renders title + mtime + turn count.
 */
export interface LauncherSession {
  path: string;
  fileName: string;
  title: string;
  mtimeMs: number;
  turns: number;
}

/**
 * One row of `vett profiles --json` output. Used to populate the profile
 * picker and to render config status in the welcome view. Endpoint /
 * model live here because the profile YAML is the single source of truth
 * for LLM configuration — the extension never reads them from settings.
 */

/**
 * One role on a team profile's roster, and how many seats it currently holds.
 *
 * `name` is EXACTLY the token `--team` expects; the count is what the profile
 * declares as written, so a Customize panel opens on the profile's own shape
 * rather than on a guess and an untouched field round-trips to the same team.
 */
export interface TeamRole {
  name: string;
  count: number;
}

/**
 * A team profile's shape, as published by `vett profiles --json`.
 *
 * ⛔ OPTIONAL, AND EVERY READ MUST TOLERATE ABSENCE. It is emitted only by a
 * `vett` from 2026-08-28 or newer, and is legitimately absent for every SOLO
 * profile. Absent means "no roster to resize" or "this binary does not say",
 * never "a team with no members".
 */
export interface TeamSummary {
  leader: string;
  /**
   * ⛔ NULLABLE, AND NULL IS NOT 0. An explicit 0 means UNLIMITED and is a
   * legal deliberate choice; null means the profile never declared the key,
   * which `vett validate` reports as an error. Flattening null to 0 would
   * render a misconfigured profile as "unlimited".
   */
  maxConcurrentDispatches: number | null;
  members: TeamRole[];
}

export interface ProfileSummary {
  name: string;
  description: string;
  /** The TOP-LEVEL model only. For a team profile this is the leader's —
   *  see {@link ProfileSummary.models} before treating it as "the" model. */
  model: string;
  /** The TOP-LEVEL endpoint only, likewise — see {@link ProfileSummary.endpoints}. */
  endpoint: string;
  provider: string;
  maxIterations: number;
  tools: string[];
  sandboxType: string;

  /**
   * The team's roster, when this profile has one and the installed `vett`
   * publishes it. Drives the Customize panel: without it the panel cannot
   * offer role counts, because nothing else tells it the roles exist.
   * See {@link TeamSummary} — absent is a normal state, not an error.
   */
  team?: TeamSummary;

  /**
   * EVERY endpoint the profile references — top level, team leader, every
   * member, and any nested sub-team — deduped, top-level first.
   *
   * WHY THIS EXISTS. `endpoint` describes the top-level LLM block and nothing
   * else, so a TEAM profile was summarized by its leader alone. Measured across
   * the corpus on 2026-08-26: 12 of 49 profiles had a headline endpoint hiding
   * at least one other. That is not cosmetic — the two halves can disagree about
   * whether the profile runs at all. `dsv4-tier3` headlined a healthy
   * openrouter.ai while its members bound to a host vacated by a DHCP re-lease,
   * 251 lines further down the file. In a dropdown it read as perfectly fine.
   *
   * ⛔ OPTIONAL ON PURPOSE — DO NOT MAKE IT REQUIRED. These fields ship in a
   * newer `vett` than the one installed here (the 2026-08-25 build emits exactly
   * name/description/model/endpoint/provider/maxIterations/tools/sandboxType and
   * nothing else — verified by running it, not assumed). The extension is used
   * against whatever `vett` is on PATH, so every read must tolerate absence and
   * fall back to the headline pair.
   */
  endpoints?: string[];
  /** The same set, for models. Optional for the same reason as {@link endpoints}. */
  models?: string[];
  /**
   * True when the profile YAML could not be parsed at all. Distinguishes an
   * unreadable profile from one that parsed fine and declares nothing — those
   * were previously identical on the wire, so a broken profile appeared in the
   * picker looking merely under-configured. Optional: absent from older `vett`,
   * where the two states remain indistinguishable.
   */
  parseError?: boolean;
}

/** UI density preference for tool-call cards in the Live chat view.
 *  Mirrors the `vett-chat.toolCardDensity` setting; sent on init and on
 *  every settings change so the webview can re-render without a reload. */
export type ToolCardDensity = 'compact' | 'default' | 'verbose';

/**
 * One @-mention parsed out of a chat input. Phase 2 kinds:
 *   - file:      `@<relative-path>` — file is read from disk, content
 *                wrapped in a fenced code block at the message footer.
 *   - selection: `@selection` — current editor's selection is appended.
 *   - symbol:    `@<name>` — VS Code workspace symbol; host resolves to
 *                file + range and includes the surrounding code at send.
 *   - problems:  `@problems` — current workspace diagnostics, grouped
 *                by file. Empty when there are none.
 *   - git:       `@git` — `git status --short` + `git log --oneline -10`
 *                from the workspace root.
 *   - diff:      `@diff` — `git diff` (uncommitted) from the workspace.
 *
 * Each kind carries its own optional fields below; the host uses a
 * switch on `kind` to materialize the resolved block. URL mentions
 * (Phase 2 spec) deferred — needs HTML→text conversion that's a much
 * bigger lift than the others.
 */
export type MentionKind = 'file' | 'selection' | 'symbol' | 'problems' | 'git' | 'diff';

export interface Mention {
  /** Verbatim text the user typed including the leading `@`, e.g.
   *  `@src/foo.ts` or `@selection`. The host substitutes occurrences of
   *  this exact string in the user message text with the resolved
   *  context block before forwarding to vett. */
  token: string;
  kind: MentionKind;
  /** For `file` and `symbol` mentions: workspace-relative path of the
   *  file the resource lives in. */
  path?: string;
  /** For `symbol` mentions: the symbol's exact name, kept separately
   *  from `token` because symbol names can contain characters the
   *  @-token regex doesn't allow (parens, generics, spaces). */
  symbolName?: string;
  /** For `symbol` mentions: zero-indexed line range of the symbol's
   *  declaration / body, captured at pick time. The host re-reads from
   *  the file at expansion time using these line numbers, so the agent
   *  sees the live content even if the file changed since the pick. */
  startLine?: number;
  endLine?: number;
}

/** A single workspace file the host surfaces to the webview's @-menu.
 *  Path is workspace-relative; basename is precomputed so the menu can
 *  display "foo.ts" prominently with the dirname dimmer beside it. */
export interface MentionFile {
  path: string;
  basename: string;
}

/** A workspace symbol the host surfaces to the webview's @-menu in
 *  response to a query. Resolved via VS Code's
 *  `vscode.executeWorkspaceSymbolProvider` command — language servers
 *  power the actual matching. `path` is workspace-relative for
 *  display + send-time re-read; `kind` is a stringified VS Code
 *  SymbolKind (e.g. `'Function'`, `'Class'`). */
export interface MentionSymbol {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  containerName?: string;
}

/** Snapshot of the workspace's diagnostics counts — used to label the
 *  `@problems` row in the @-menu (empty + nothing matches → row hidden). */
export interface ProblemsCount {
  errors: number;
  warnings: number;
  info: number;
}

/** Light status of the workspace's git state — used to decide whether
 *  to surface `@git` / `@diff` rows in the @-menu and what summary text
 *  to render. `branch` is null when not in a git repo or detached HEAD;
 *  `dirty` is the count of modified-or-untracked files for the row's
 *  hint copy. */
export interface GitStatusSummary {
  available: boolean;
  branch?: string;
  dirtyFiles?: number;
}

/** Snapshot of the chat panel's worktree state, surfaced to the UI so
 *  the header chip can render the right copy ("📁 wt-3a8f" /
 *  "main tree" / "git worktree" / "copy mode"). When `enabled` is
 *  false, the chat is operating directly against the user's working
 *  tree — same as the pre-#4 behavior. */
export interface WorktreeStatus {
  enabled: boolean;
  mode: 'git-worktree' | 'cp-fallback' | 'disabled';
  /** Absolute path of the worktree (or the user's workspace root when
   *  disabled — the chat needs SOMETHING to label the chip with). */
  path: string;
  /** Workspace root the worktree was forked from. Same as `path` when
   *  disabled. */
  workspaceRoot: string;
  /** Branch the worktree sits on (git mode) or the local-init branch
   *  (cp-fallback). Empty when disabled. */
  branch?: string;
  /** Short id used for display: `wt-<panelId-suffix>`. Stable per
   *  panel; the user can recognize their own panel across reloads. */
  shortId?: string;
}

/** Messages from extension host to webview */
export type HostToWebview =
  | { type: 'init'; data: { cwd: string; profile: string; connected: boolean; sessionLogPath?: string; welcomeSeen?: boolean; profiles?: ProfileSummary[]; toolCardDensity?: ToolCardDensity; chatMode?: ChatMode; sessionOverrides?: SessionOverrides; worktree?: WorktreeStatus; useWorktreeSetting?: boolean; panelMode?: 'worktree' | 'direct'; contextWindowTokens?: number; dispatchViewStyle?: 'log' | 'structured' } }
  /** Workspace-level worktree setting changed (the user toggled it in
   *  the Settings drawer). The value reflects the new setting value;
   *  the current panel keeps its captured mode unchanged — this only
   *  affects new chats. */
  | { type: 'useWorktreeSettingChanged'; data: { value: boolean } }
  | { type: 'vettEvent'; data: VettEvent }
  | { type: 'connectionStatus'; data: { connected: boolean; error?: string; kind?: ConnectionErrorKind; details?: string } }
  | { type: 'sessionLogPath'; data: { path: string } }
  | { type: 'profilesRefreshed'; data: { profiles: ProfileSummary[] } }
  | { type: 'settingsChanged'; data: { toolCardDensity?: ToolCardDensity; contextWindowTokens?: number; dispatchViewStyle?: 'log' | 'structured' } }
  | { type: 'chatModeChanged'; data: { mode: ChatMode } }
  /** Response to `requestMentionContext`. `files` is up to ~50 paths
   *  matching the query; `symbols` is up to ~10 workspace symbols
   *  matching the query (Phase 2); `selectionPreview` is a one-line
   *  preview of the current editor selection (full text is fetched at
   *  send time so it's always fresh); `problemsCount` summarizes the
   *  workspace diagnostics for the `@problems` menu row; `git` carries
   *  enough state to decide whether to surface `@git` / `@diff`. */
  | { type: 'mentionContext'; data: {
      files: MentionFile[];
      symbols: MentionSymbol[];
      selectionPreview: string | null;
      problemsCount: ProblemsCount | null;
      git: GitStatusSummary;
    } }
  | { type: 'resetChat' }
  | { type: 'seedHistory'; data: { messages: ChatMessage[] } }
  | { type: 'seedFromLog'; data: { envelopes: VettEvent[] } }
  | { type: 'persistState'; data: { id: string; sessionLogPath?: string } }
  /** Worktree state changed (new session started, apply/discard
   *  finished, etc). Webview re-renders the header chip. */
  | { type: 'worktreeStatus'; data: { worktree: WorktreeStatus } }
  /** Slice the webview's message-list state to the chosen turn or
   *  message index. Sent by the host when the user picks
   *  "Restore conversation" / "Restore both" from the checkpoint
   *  flow OR confirms an inline "↶ Restore to before this message".
   *  `mode: 'turn'` is 1-based user-turn count (matches checkpoint
   *  metadata); `mode: 'index'` is a 0-based messages-array offset
   *  (used by the inline button). */
  | { type: 'rewindConversation'; data: { mode: 'turn'; userTurn: number } | { mode: 'index'; index: number } }
  /** Programmatic chat-input pre-fill. Used by:
   *  - voice input (Whisper transcript lands here),
   *  - inline-edit "Iterate in chat" v2 (replaces the clipboard handoff),
   *  - any future hand-off-to-chat surface (CodeLens "Explain", etc).
   *
   *  `append=true` concatenates onto the current input (with a leading
   *  space if non-empty); default `false` replaces the textarea
   *  contents wholesale. The webview also focuses the textarea so the
   *  user can keep typing or hit Enter. */
  | { type: 'prefillInput'; data: { text: string; append?: boolean } }
  /** Voice input lifecycle event. Drives the 🎤 button's visual
   *  state (idle / recording / transcribing) without the webview
   *  having to track its own copy of the host-side recording state. */
  | { type: 'voiceInputStatus'; data: { state: 'idle' | 'recording' | 'transcribing'; message?: string } };

/** Messages from webview to extension host */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'sendMessage'; data: { text: string; images?: VettImageAttachment[]; mentions?: Mention[] } }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'revealSessionLog' }
  | { type: 'openSettings' }
  | { type: 'openFolder' }
  | { type: 'dismissWelcome' }
  | { type: 'pickProfile' }
  | { type: 'runOnboarding' }
  | { type: 'refreshProfiles' }
  | { type: 'slashCommand'; data: { command: string; args?: string } }
  /** Switch the agent's mode (execute / plan) for the NEXT subprocess
   *  spawn. Mid-session switches require a respawn to take effect because
   *  the system prompt and tool list are baked at session start. The
   *  host applies the new mode the next time `startVettSession` runs. */
  | { type: 'setChatMode'; data: { mode: ChatMode } }
  /** Webview wants the current workspace files for the @-mention menu.
   *  Includes the partial query the user has typed after `@` so the
   *  host can prefilter (cheap, no need to ship 10K paths). Host
   *  responds with `mentionContext`. */
  | { type: 'requestMentionContext'; data: { query: string } }
  /** Webview triggers a region screenshot. Host runs the platform's
   *  screenshot tool (Win+Shift+S on Windows, screencapture -i on
   *  macOS, gnome-screenshot on Linux). User's snip lands on the
   *  clipboard and the existing paste handler picks it up — no need
   *  for an extra round-trip back to the webview. */
  | { type: 'captureScreenshot' }
  /** Apply a fresh batch of per-session overrides. Host stashes them
   *  on the panel and respawns vett if a session is already running so
   *  the new flags take effect immediately. Sending an empty object
   *  clears overrides back to profile defaults. */
  | { type: 'applySettings'; data: { overrides: SessionOverrides } }
  /** Toggle the workspace-level `vett-chat.useWorktree` setting. Host
   *  writes through `vscode.workspace.getConfiguration().update()`.
   *  Takes effect on NEW chats only — existing panels keep the
   *  worktree mode they captured at construction time. */
  | { type: 'setUseWorktreeSetting'; data: { value: boolean } }
  /** User clicked Approve / Reject on the per-call plan-mode card.
   *  Host forwards the decision to vett over stdin; the gate
   *  short-circuits the blocked tool call. On approve the gate
   *  unlocks for the rest of the session AND vett emits a
   *  chat_mode_changed:execute event so the UI flips Plan → Exec
   *  without a respawn (no context loss). */
  | { type: 'planModeActionResponse'; data: { requestId: string; approve: boolean } }
  /** Pause the agent loop at the next iteration boundary. Current
   *  in-flight tool call completes; loop emits `paused` and waits
   *  for `resume` or a new user message. */
  | { type: 'pause' }
  /** Resume from a paused state without sending a new user message. */
  | { type: 'resume' }
  /** Answer for a pending ask_user_question. question_id matches the
   *  inbound `user_question` event. */
  | { type: 'user_question_answer'; data: { question_id: string; text: string } }
  /** Open the worktree directory in a new VS Code window so the user
   *  can inspect agent changes side-by-side with their own. */
  | { type: 'worktreeOpenInWindow' }
  /** Copy the worktree's modified files into the user's workspace as
   *  uncommitted modifications. Host runs WorktreeManager.apply and
   *  toasts a result summary. */
  | { type: 'worktreeApply' }
  /** Remove the worktree directory + branch and re-open the chat
   *  against the user's workspace. Confirms first via showWarningMessage
   *  on the host side. */
  | { type: 'worktreeDiscard' }
  /** Open a QuickPick of recent checkpoints; user picks one + the
   *  restore mode (files / conversation / both). For files mode the
   *  host runs `git checkout` against the worktree; for conversation
   *  mode the host posts `rewindConversation` back so the webview
   *  slices its own message-list state; "both" does both. */
  | { type: 'restoreCheckpoint' }
  /** User clicked the inline "↶ Restore to before this message"
   *  button on a user message. Webview already has the message index
   *  in hand; this round-trips through the host only so a future
   *  permission / confirm / log step can hook in. */
  | { type: 'rewindConversationToIndex'; data: { index: number } }
  /** Open the per-file review picker — each changed file in the
   *  worktree shows up with View Diff / Accept / Reject icons. */
  | { type: 'worktreeReviewChanges' }
  /** User answered a pending permission_request from the inline
   *  card. `decision` is `auto` (allow) or `deny`. When
   *  `rememberForKind` is true, vett flips the per-session rule for
   *  the request's kind so subsequent same-kind calls don't ask. */
  | { type: 'permissionResponse'; data: { requestId: string; decision: 'auto' | 'deny'; rememberForKind: boolean } }
  /** Toggle voice input — first click starts recording, second click
   *  stops + transcribes + drops text into the input via
   *  `prefillInput`. Implemented host-side via ffmpeg + a Whisper-
   *  compatible HTTP endpoint configured by `vett-chat.whisperEndpoint`. */
  | { type: 'toggleVoiceInput' };

/**
 * Two-mode operation of the chat agent.
 * - `execute` (default): full tool access, agent can modify state.
 * - `plan`: read-only design phase. Vett removes write-capable tools
 *   (terminal, finish) and prepends a "produce a plan in markdown,
 *   don't modify state" system-prompt addendum. The chat header
 *   surfaces the toggle so the user can flip back and forth.
 */
export type ChatMode = 'execute' | 'plan';

/**
 * Per-session profile overrides set via the Settings UI. Each field is
 * optional — undefined means "use the profile's value." Stored on the
 * host (per-panel) and forwarded to `vett chat` as CLI flags at
 * subprocess spawn time. None of these persist to the profile YAML;
 * closing the chat panel forgets them. The "Save as new profile" path
 * (deferred from v1) would persist them.
 *
 * Mirrors the flag layer already on `vett chat`:
 *   --temperature / --top-p / --max-iterations / --timeout-minutes /
 *   --system-prompt-append
 */
export interface SessionOverrides {
  /**
   * Roster for this run: role name -> seats. Absent means "use the profile's
   * own team". A role mapped to 0 is REMOVED from the team.
   *
   * Names are validated against the profile's published roster before spawn
   * (see buildTeamArgs) because `--team` treats an unknown name as an error,
   * not as a smaller team — a GUI must not be able to compose that error.
   */
  team?: Record<string, number>;
  /**
   * How many members may work at once. ⛔ 0 IS A REAL VALUE meaning unlimited,
   * so `undefined` is the only "not set" sentinel — never 0.
   */
  teamWidth?: number;
  /** Leader's compaction trigger in tokens. */
  leaderContext?: number;
  /** Compaction trigger applied to every member; per-role values win. */
  workerContext?: number;
  /** Per-role compaction triggers: role name -> tokens. The leader is addressable here. */
  roleContext?: Record<string, number>;
  temperature?: number;
  topP?: number;
  maxIterations?: number;
  timeoutMinutes?: number;
  systemPromptAppend?: string;
  /** Per-kind permission rule overrides. Each value is one of
   *  `auto` / `ask` / `deny`; absence means "use the profile's value
   *  (or its built-in default if the profile has no permissions
   *  block)". Applied in-memory at subprocess-spawn time via the
   *  `--permission-<kind>` CLI flags. Persisting these to YAML lives
   *  with the wider "Save as new profile" path that's still deferred. */
  permissionRead?: 'auto' | 'ask' | 'deny';
  permissionEdit?: 'auto' | 'ask' | 'deny';
  permissionTerminalSafe?: 'auto' | 'ask' | 'deny';
  permissionTerminalUnsafe?: 'auto' | 'ask' | 'deny';
  permissionMcp?: 'auto' | 'ask' | 'deny';
  permissionOther?: 'auto' | 'ask' | 'deny';
}

// --- UI state types ---

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  /** True for user messages that the user typed while the agent was
   * mid-turn — the message is shown immediately for context but isn't
   * sent to the subprocess until the agent next reaches a ready state.
   * Cleared when the queue drains it. */
  queued?: boolean;
  /** Token counts spent producing THIS assistant message (sum of
   * llm_response.input_tokens between the user prompt and the
   * assistant_text). Undefined for user messages and for assistant
   * messages from older sessions / log replay. Drives the inline
   * "in N / out M / $X.XX" footer. */
  turnInputTokens?: number;
  turnOutputTokens?: number;
  /** Notional dollar cost for this turn — 0 for local models, computed
   * from the pricing table (webview/utils/pricing.ts) for cloud ones. */
  turnCostUsd?: number;
  /** Image attachments shown inline above the message text. Each entry
   * is a data: URI (or http(s):) the webview can drop straight into an
   * <img>. Populated only on user messages that include images via the
   * paste / drag-drop / screenshot UX. */
  images?: string[];
}

export interface ToolCall {
  callId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Captured output of the tool call. May be a truncated head+tail of
   * the real output — see `resultTruncated` and `resultLength`. */
  result?: string;
  /** Full untruncated result text, when vett included the `result` field
   * alongside `result_preview` on tool_call_end (it does for chat mode).
   * Shown in the expanded card view. Absent when only the preview was
   * sent (older host bundles) or when the full text exceeded the
   * webview's serialization limit. */
  resultFull?: string;
  /** Total length in characters of the *original* result, before any
   * head+tail truncation applied to fit in the webview. */
  resultLength?: number;
  /** True when `result` is a head+tail snippet rather than the full text.
   * The full output is preserved in the on-disk JSONL session log. */
  resultTruncated?: boolean;
  success?: boolean;
  durationMs?: number;
  expanded: boolean;
  /** ISO timestamp of when the tool_call_start event arrived. Used to
   * interleave tool cards with messages + dispatch cards in the
   * curated chat view. */
  startedAt?: string;
}

/**
 * A single sub-agent dispatch — the leader called assign_task and a
 * member ran one task. Captures everything the UI needs to show what
 * the sub-agent did without giving the user a separate panel.
 *
 * Surfaced as a collapsible inline card in the chat. v1; tabbed
 * thread-switching is a possible follow-up if a card-only flow proves
 * insufficient.
 */
export interface Dispatch {
  /** vett tags member events with thread_id = member name. */
  threadId: string;
  memberName: string;
  task: string;
  startedAt: string;
  completedAt?: string;
  iterations?: number;
  stopReason?: string;
  /** Events from the member's run, in arrival order. */
  events: VettEvent[];
  /** True while the member is still running. */
  active: boolean;
  expanded: boolean;
}

export interface IterationInfo {
  iteration: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
