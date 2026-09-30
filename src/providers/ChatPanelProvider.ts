import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { VettProcess } from '../process/vettProcess';
import { ProfileService } from '../process/profileService';
import { mergeSettingsOverrides } from '../process/teamArgs';
import { parseSessionEnvelopes } from '../process/sessionLogParser';
import { VettEvent, HostToWebview, WebviewToHost, ChatMode, Mention, MentionFile, MentionSymbol, ProblemsCount, GitStatusSummary, SessionOverrides, WorktreeStatus, TeamSummary } from '../shared/types';
import { WorktreeManager, WorktreeNotSupportedError, type WorktreeInfo, type WorktreeChange } from '../worktree/worktreeManager';
import { CheckpointStore, type CheckpointEntry } from '../worktree/checkpointStore';
import { VoiceInputController } from '../voice/voiceInput';

const execFileP = promisify(execFile);

const SETTINGS_QUERY = '@ext:dickinsonbros.vett-chat';

/**
 * Each instance of this class owns one VS Code editor-area
 * WebviewPanel running the chat UI plus the vett subprocess powering
 * that one chat. Multiple instances live in parallel — that's what
 * makes the extension multi-session.
 *
 * The webview bundle is the same one used by ChatViewProvider (sidebar);
 * each panel just loads its own copy, so panels' signal state is
 * naturally isolated by JS context. No webview-side refactor needed.
 */
export class ChatPanelProvider {
  /** Tracks every live panel keyed by id, so future calls can reveal an
   * existing one (e.g. clicking a tab in the sidebar launcher) instead
   * of opening a duplicate. */
  private static readonly all = new Map<string, ChatPanelProvider>();

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly profileService: ProfileService;
  private vettProcess?: VettProcess;
  /** Set while a `startVettSession` call is between its first await and
   *  the assignment of `this.vettProcess`. Non-undefined means "a spawn
   *  is already on its way" — see startVettSession() for the orphaned-
   *  process race this closes. */
  private startInFlight?: Promise<void>;
  /** True once the panel has been disposed. Checked by an in-flight
   *  start so a tab closed mid-spawn doesn't leave a vett process that
   *  nothing holds a reference to. */
  private disposed = false;
  private pendingFirstMessage?: string;
  /** Programmatic-prefill text staged at panel construction. Replayed
   *  to the webview the moment it sends `ready`, so a hand-off-to-chat
   *  caller (Cmd+I "Iterate", future code-lens "Explain", etc) can
   *  populate the textarea without a clipboard round-trip. */
  private pendingPrefillText?: string;
  /** Images attached to the first-message-pending payload — held so
   *  handleVettEvent('ready') can deliver text + images together. */
  private pendingFirstImages?: import('../shared/types').VettImageAttachment[];
  private readonly resumePath?: string;
  /** True once the panel has ever spawned a vett subprocess. Stays
   *  true after the subprocess exits (cleanly or crashed) — used by
   *  findIdle() to distinguish "untouched empty panel" from
   *  "previously-active panel whose vett is no longer running." */
  private hasEverStartedVett = false;
  /** Disposer for the panel's onDidChangeConfiguration listener.
   *  Held on the instance (NOT pushed to context.subscriptions) so it
   *  dies with the panel — otherwise closed panels keep their
   *  listeners alive for the extension's lifetime, leaking the
   *  panel's `this` capture. Set on first webview-ready; disposed in
   *  panel dispose(). Subsequent ready events reuse it. */
  private configWatcherDispose?: vscode.Disposable;
  /** Active chat mode for this panel. `execute` (default) gives the
   *  agent full tool access; `plan` removes write tools and adds a
   *  "produce a plan, don't modify state" system-prompt addendum.
   *  Mode is baked at subprocess-start, so toggling triggers a
   *  respawn (see handleMessage 'setChatMode'). */
  private chatMode: ChatMode = 'execute';

  /** Per-session profile overrides set via the Settings UI. Layered
   *  on top of the profile YAML at subprocess-spawn time as CLI flags.
   *  Empty object = "no overrides, use profile values verbatim."
   *  Lives only in memory; closing the panel forgets them. */
  private sessionOverrides: SessionOverrides = {};

  /** Profile chosen for THIS panel in the Customize flow.
   *
   *  undefined = follow the workspace `vett-chat.profile` setting, which is
   *  what every panel did before this existed. Set means this panel alone
   *  runs the chosen profile: the pick must not write the workspace setting,
   *  or a one-off custom run would silently repoint every future chat. */
  private sessionProfile: string | undefined;

  /** The profile this panel actually spawns with.
   *
   *  Every profile read goes through here - the header chip, the init
   *  payload, the roster lookup, and the argv - so the name shown can never
   *  drift from the one running. */
  private activeProfile(): string {
    return (
      this.sessionProfile ??
      vscode.workspace.getConfiguration('vett-chat').get<string>('profile', 'coding')
    );
  }

  /** Active worktree for this panel. When set, vett's cwd is the
   *  worktree path instead of the user's workspace — agent edits land
   *  there, the user reviews, then either Apply (copy back) or
   *  Discard. Resolved lazily on first session start. */
  private worktreeInfo: WorktreeInfo | null = null;
  /** Active "use worktree?" decision for this panel. Captured from the
   *  workspace setting at construction; mutable so the Settings drawer
   *  toggle can flip it mid-session and respawn vett with the new
   *  cwd. Note that worktree mode being ON doesn't migrate prior edits
   *  — direct→worktree leaves earlier workspace edits in place;
   *  worktree→direct strands prior worktree edits at the worktree path
   *  until the user applies/discards. */
  private useWorktree: boolean;

  /** Per-turn shadow-git for rollback. Materializes lazily when the
   *  first user message arrives — same panel id → same checkpoint
   *  store on resume, so rollbacks survive panel close. */
  private checkpointStore: CheckpointStore | null = null;

  /** Voice-input controller — owns ffmpeg recording + Whisper round-
   *  trip per panel. Idle until first toggle. */
  private readonly voiceInput = new VoiceInputController();

  /** Stable id used as the JSONL session id, panel key, and (eventually)
   * the surface the launcher uses to switch between panels. Generated
   * once per panel; never changes. */
  readonly id: string;

  private constructor(
    id: string,
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    profileService: ProfileService,
    resumePath?: string,
  ) {
    this.id = id;
    this.panel = panel;
    this.context = context;
    this.profileService = profileService;
    this.resumePath = resumePath;
    // Capture the worktree setting at construction time. Per-panel and
    // sticky for the panel's lifetime; flipping the global setting
    // mid-session would require a respawn AND a worktree migration of
    // the in-progress edits, which is too dangerous for a setting toggle.
    this.useWorktree = vscode.workspace.getConfiguration('vett-chat').get<boolean>('useWorktree', false);

    this.panel.webview.html = this.getHtmlContent(panel.webview, context.extensionUri);
    this.panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw));
    this.panel.onDidDispose(() => this.dispose());

    // Voice-input controller writes back to the chat input via
    // prefillInput and reports its state via voiceInputStatus. Both
    // are HostToWebview messages on this panel only — concurrent chat
    // panels each own their own recording session.
    this.voiceInput.attach({
      postStatus: (state, message) => {
        this.panel.webview.postMessage({
          type: 'voiceInputStatus',
          data: { state, message },
        });
      },
      prefillInput: (text, opts) => {
        // Streaming voice partials want to REPLACE the input field
        // (each partial is a fresh transcription of the full audio
        // buffer, so appending would duplicate). Manual mode appends
        // so the user can pre-type "fix this:" then hit voice.
        const replace = opts?.replace === true;
        this.panel.webview.postMessage({
          type: 'prefillInput',
          data: { text, append: !replace },
        });
      },
    });
  }

  /**
   * Open a new chat panel. If resumePath is set, vett seeds the agent's
   * conversation history from that JSONL file before accepting input.
   */
  static openNew(
    context: vscode.ExtensionContext,
    profileService: ProfileService,
    opts: {
      resumePath?: string;
      title?: string;
      prefillText?: string;
      /**
       * Team shape chosen in the Customize flow, applied to this panel's FIRST
       * session. Seeded here rather than posted afterwards because the shape is
       * baked at spawn — arriving even one message late would silently start
       * the run with profile defaults while the panel showed the custom shape.
       */
      overrides?: SessionOverrides;
      /** Profile for this panel only - see ChatPanelProvider.sessionProfile. */
      profile?: string;
    } = {},
  ): ChatPanelProvider {
    const id = generateId();
    const panel = vscode.window.createWebviewPanel(
      'vett-chat.chatPanel',
      opts.title ?? (opts.resumePath ? `Vett Chat (resume)` : 'Vett Chat'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    const instance = new ChatPanelProvider(id, panel, context, profileService, opts.resumePath);
    if (opts.prefillText) {
      instance.pendingPrefillText = opts.prefillText;
    }
    if (opts.overrides) {
      instance.sessionOverrides = opts.overrides;
    }
    if (opts.profile) {
      instance.sessionProfile = opts.profile;
    }
    ChatPanelProvider.all.set(id, instance);
    ChatPanelProvider.onChange?.();
    return instance;
  }

  /**
   * Re-attach to a panel that VS Code restored after a window reload.
   * Treats the saved sessionLogPath as a resume path so the chat picks
   * up where it left off — same UX as if the user had clicked the
   * session in the launcher to resume it. Brand-new panels with no
   * saved state get a fresh blank session.
   */
  static attach(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    profileService: ProfileService,
    state: unknown,
  ): ChatPanelProvider | undefined {
    const s = (state as { id?: string; sessionLogPath?: string } | undefined) ?? {};
    const id = s.id || generateId();
    const resumePath = s.sessionLogPath;

    // Dedupe at reload time. VS Code persists every webview panel that
    // was open and re-deserializes them all on next launch, so debug
    // sessions that ended with multiple chats come back as multiple
    // stacked panels — the persistent "every time i click logs it
    // adds the UX again" symptom.
    //
    // Three dedupe paths:
    //   1. Same resumePath — already showing this exact session log.
    //   2. Same id collision — same panel attached twice.
    //   3. Both this and an existing panel are FRESH (no resumePath,
    //      no live vett process) — only one empty chat is ever useful;
    //      the rest are leftover debug residue. Without this, fresh
    //      panels accumulate forever across reloads.
    if (resumePath) {
      for (const existing of ChatPanelProvider.all.values()) {
        if (existing.resumePath === resumePath || existing.vettProcess?.sessionLogPath === resumePath) {
          panel.dispose();
          return undefined;
        }
      }
    } else {
      for (const existing of ChatPanelProvider.all.values()) {
        if (!existing.resumePath && !existing.hasEverStartedVett) {
          panel.dispose();
          return undefined;
        }
      }
    }
    if (ChatPanelProvider.all.has(id)) {
      panel.dispose();
      return undefined;
    }

    // Re-set the localResourceRoots — VS Code may not preserve them
    // across reload depending on how the panel was registered.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    };
    const instance = new ChatPanelProvider(id, panel, context, profileService, resumePath);
    ChatPanelProvider.all.set(id, instance);
    ChatPanelProvider.onChange?.();
    return instance;
  }

  /** Bring an existing panel to the foreground. */
  reveal(): void {
    this.panel.reveal();
  }

  /** Snapshot of every currently-open panel, used by the launcher to
   * show an "Open chats" group above the past-chats list. The session
   * log path is included so resuming a closed panel can re-attach to
   * its conversation. */
  static liveSessions(): { id: string; title: string; sessionLogPath?: string }[] {
    return Array.from(ChatPanelProvider.all.values()).map((p) => ({
      id: p.id,
      title: p.panel.title,
      sessionLogPath: p.vettProcess?.sessionLogPath ?? undefined,
    }));
  }

  /** Reveal a panel by id (clicked in the launcher). */
  static revealById(id: string): boolean {
    const p = ChatPanelProvider.all.get(id);
    if (!p) return false;
    p.reveal();
    return true;
  }

  /** Find an open chat panel that has NEVER started vett — the user
   * hasn't typed a first message, so it's safe to reuse for a new
   * conversation. Used by the launcher's "+ New Chat" to avoid
   * stacking empty panels.
   *
   * Crucially does NOT match panels whose vett process exited or
   * crashed: those panels are showing error cards / stale state and
   * "+ New Chat" needs to actually create a fresh worktree, not
   * reveal a broken panel.
   */
  static findIdle(): ChatPanelProvider | undefined {
    for (const p of ChatPanelProvider.all.values()) {
      if (!p.hasEverStartedVett && !p.resumePath) return p;
    }
    return undefined;
  }

  /** Close every panel except the one provided (or every panel if
   * none provided). Used by the "Vett Chat: Close All Other Tabs"
   * command for cleaning up after a debugging spree where many
   * panels accumulated. */
  static closeAll(except?: ChatPanelProvider): number {
    let n = 0;
    for (const p of [...ChatPanelProvider.all.values()]) {
      if (p === except) continue;
      p.panel.dispose();
      n++;
    }
    return n;
  }

  /**
   * Stop every live panel's vett subprocess. Wired to the extension's
   * `deactivate()`.
   *
   * `dispose()` is the per-panel teardown, and it only runs off
   * `panel.onDidDispose` — which VS Code fires when the USER closes a
   * tab. It does NOT fire on extension deactivation (window closed,
   * window reloaded, extension disabled or updated): the panels just go
   * away with the host. The measured consequence was that every open
   * chat's vett subprocess — and, before the tree-kill fix in
   * vettProcess.stop(), everything vett had spawned — outlived VS Code
   * entirely.
   *
   * Deliberately does NOT dispose the panels themselves. During
   * deactivation the webview host is already tearing down, and
   * `panel.dispose()` would re-enter `dispose()` → `onChange` → a
   * launcher post into a webview that is going away. The subprocesses
   * are the only thing that outlives the host, so they are the only
   * thing chased here.
   */
  static shutdownAll(): void {
    for (const p of ChatPanelProvider.all.values()) {
      try {
        p.vettProcess?.stop();
        p.vettProcess = undefined;
      } catch {
        // One panel failing to stop must not skip the remaining panels —
        // this is the last chance to reach any of them.
      }
    }
  }

  /** Notify when panels open/close so the launcher can refresh. */
  static onChange?: () => void;

  private async handleMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
    const msg = raw as WebviewToHost;
    switch (msg.type) {
      case 'ready':
        await this.onWebviewReady();
        break;
      case 'sendMessage':
        if (msg.data?.text || (msg.data?.images && msg.data.images.length > 0)) {
          // Expand any @-mentions in the text BEFORE forwarding to vett.
          // The webview ships the original text + a list of mentions it
          // staged from the @-menu; we read each mention's source on
          // disk (or from the editor) here so the agent always sees
          // current content, not stale snapshots from when the menu
          // opened. Failures are non-fatal — the bare token survives
          // in the prompt and the agent can still reason about it.
          const expanded = msg.data.mentions && msg.data.mentions.length > 0
            ? await this.expandMentions(msg.data.text ?? '', msg.data.mentions)
            : (msg.data.text ?? '');

          // Snapshot the worktree state BEFORE the agent sees the
          // message — gives the user a "rewind to before I asked X"
          // restore point. Best-effort; failures don't block send.
          // The label uses the ORIGINAL user text so the checkpoint
          // list stays readable (not littered with @-mention context
          // blocks).
          await this.snapshotCheckpoint(msg.data.text ?? '(images only)');

          if (this.vettProcess?.isRunning) {
            this.vettProcess.sendMessage(expanded, msg.data.images);
          } else {
            // First-message-with-images path: stash the images alongside
            // the text so handleVettEvent('ready') can fire them through
            // together. Without holding the images, the first send after
            // spawn would lose its attachments.
            this.pendingFirstMessage = expanded;
            this.pendingFirstImages = msg.data.images;
            await this.startVettSession();
          }
        }
        break;
      case 'requestMentionContext': {
        const ctx = await this.buildMentionContext(msg.data.query);
        this.post({ type: 'mentionContext', data: ctx });
        break;
      }
      case 'captureScreenshot': {
        // Defer to the global command — registered once in extension.ts
        // so all panels share the same platform-aware implementation.
        await vscode.commands.executeCommand('vett-chat.captureScreenshot');
        break;
      }
      case 'applySettings': {
        // New batch of per-session overrides from the Settings UI.
        //
        // The drawer sends the full effective set on every Apply, so a
        // missing field means "go back to profile default" — and that is
        // taken verbatim, for the eleven fields the drawer renders.
        //
        // ⛔ THE TEAM SHAPE IS CARRIED ACROSS, NOT TAKEN FROM THE FORM.
        // The drawer has no roster, width or per-seat-context inputs, so it
        // cannot say "leave those alone" — its silence about them is
        // ignorance, not intent. Taking the payload verbatim for those five
        // keys would let a temperature tweak delete the team the user set at
        // start, and the next respawn would quietly run profile defaults
        // while the panel still read as customized.
        this.sessionOverrides = mergeSettingsOverrides(
          this.sessionOverrides,
          msg.data?.overrides ?? {},
        );
        // Echo a fresh init so the webview signal stays in sync. (Init
        // is the one path that already carries sessionOverrides.) The
        // chat history is preserved — App.tsx's init handler doesn't
        // wipe messages.
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const config = vscode.workspace.getConfiguration('vett-chat');
        const profile = this.activeProfile();
        this.post({
          type: 'init',
          data: {
            cwd, profile,
            connected: this.vettProcess?.isRunning ?? false,
            sessionLogPath: this.vettProcess?.sessionLogPath ?? undefined,
            welcomeSeen: true,
            chatMode: this.chatMode,
            sessionOverrides: this.sessionOverrides,
            worktree: this.buildWorktreeStatus(cwd),
            useWorktreeSetting: config.get<boolean>("useWorktree", false),
            contextWindowTokens: config.get<number>("contextWindowTokens", 131072),
            dispatchViewStyle: config.get<"log" | "structured">("dispatchViewStyle", "log"),
            panelMode: this.useWorktree ? 'worktree' : 'direct',
          },
        });
        // Overrides are baked at subprocess spawn (CLI flags). Respawn
        // only if a session is already running; otherwise the next
        // user-message-driven start picks them up automatically.
        if (this.vettProcess?.isRunning) {
          await this.startVettSession();
        }
        break;
      }
      case 'planModeActionResponse': {
        // User clicked Approve / Reject on the per-call plan-mode card.
        // Forward to vett over stdin — the gate is blocking inside its
        // wrap, awaiting this response by request_id. On approve the
        // gate unlocks for the rest of the session and emits
        // chat_mode_changed:execute server-side, which the webview
        // catches and reflects in the header toggle. No respawn — the
        // agent keeps its full conversation context.
        if (msg.data?.requestId && typeof msg.data.approve === 'boolean') {
          this.vettProcess?.send({
            type: 'plan_mode_action_response',
            request_id: msg.data.requestId,
            approve: msg.data.approve,
          });
        }
        break;
      }
      case 'setChatMode': {
        const next = msg.data.mode;
        if (next !== 'execute' && next !== 'plan') break;
        if (this.chatMode === next) break;
        this.chatMode = next;
        // Echo back so the webview signal stays authoritative even if
        // the local optimistic update was reverted somewhere. Sent
        // before the respawn so the UI shows the new state immediately
        // rather than after the subprocess startup latency.
        this.post({ type: 'chatModeChanged', data: { mode: next } });
        // Mode is baked at subprocess start (system prompt + tool list
        // change). Respawn only if a session is already live; otherwise
        // the next user message picks up the new mode automatically.
        // We DON'T resetChat here — message history is the user's, not
        // the agent's, and clearing it on a mode toggle is hostile.
        if (this.vettProcess?.isRunning) {
          await this.startVettSession();
        }
        break;
      }
      case 'cancel':
        this.vettProcess?.cancel();
        break;
      case 'pause':
        this.vettProcess?.send({ type: 'pause' });
        break;
      case 'resume':
        this.vettProcess?.send({ type: 'resume' });
        break;
      case 'user_question_answer':
        // Forward through to vett's stdin. Vett's UserQuestionService
        // matches the question_id against the pending tool call and
        // releases the awaiting AskUserQuestion ToolFn.
        if (msg.data?.question_id !== undefined && msg.data?.text !== undefined) {
          this.vettProcess?.send({
            type: 'user_question_answer',
            text: msg.data.text,
            question_id: msg.data.question_id,
          });
        }
        break;
      case 'worktreeOpenInWindow': {
        if (!this.worktreeInfo) {
          vscode.window.showInformationMessage('No worktree active for this chat.');
          break;
        }
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(this.worktreeInfo.path),
          { forceNewWindow: true },
        );
        break;
      }
      case 'worktreeApply': {
        await this.applyWorktreeChanges();
        break;
      }
      case 'worktreeDiscard': {
        await this.discardWorktree();
        break;
      }
      case 'restoreCheckpoint': {
        await this.runRestoreCheckpointFlow();
        break;
      }
      case 'toggleVoiceInput': {
        // Per-panel ffmpeg → Whisper → prefillInput round-trip.
        // First click starts recording, second stops + transcribes.
        await this.voiceInput.toggle();
        break;
      }
      case 'setUseWorktreeSetting': {
        // Drawer toggle. Persist to workspace settings.json (or user
        // settings if no workspace target available). Then apply the
        // change to the CURRENT panel: if the new value differs from
        // the panel's captured useWorktree, flip it and respawn vett
        // so the next request uses the right cwd. Chat history is
        // preserved (matches setChatMode + applySettings).
        const next = !!msg.data?.value;
        // Pre-validate when turning ON: worktree mode requires `.git`.
        // Without this check the toggle would persist as `true` and
        // every panel would surface the "no git" toast — confusing.
        // Refuse the flip + revert the checkbox visually.
        if (next) {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!wsRoot || !(await WorktreeManager.isGitRepo(wsRoot))) {
            vscode.window.showWarningMessage(
              'Vett Chat: worktree isolation requires a git repo. Run `git init` in this workspace first.',
            );
            this.post({ type: 'useWorktreeSettingChanged', data: { value: false } });
            break;
          }
        }
        const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
        try {
          await vscode.workspace.getConfiguration('vett-chat').update('useWorktree', next, target);
        } catch (err) {
          vscode.window.showErrorMessage(`Vett Chat: couldn't update useWorktree setting — ${(err as Error).message}`);
          break;
        }
        if (this.useWorktree !== next) {
          this.useWorktree = next;
          // Drop the cached worktreeInfo when going direct so a future
          // flip back to worktree starts fresh; keep it when going
          // worktree so a re-toggle reuses the existing worktree path
          // (panel id is stable, so resume is cheap).
          if (!next) this.worktreeInfo = null;
          if (this.vettProcess?.isRunning) {
            await this.startVettSession();
          }
        }
        break;
      }
      case 'rewindConversationToIndex': {
        // Inline ↶ button on a user message. The webview already knows
        // the index — we round-trip through the host so any future
        // confirm / log / permission step can hook in cleanly. For
        // v1 we just echo the rewind back as a HostToWebview message
        // so the webview slices its own state. Files are untouched.
        if (typeof msg.data?.index === 'number') {
          this.panel.webview.postMessage({
            type: 'rewindConversation',
            data: { mode: 'index', index: msg.data.index },
          });
        }
        break;
      }
      case 'worktreeReviewChanges': {
        await this.runReviewChangesFlow();
        break;
      }
      case 'permissionResponse': {
        // Forward through to vett. The agent loop's PermissionGate is
        // awaiting on this request_id via PermissionService — when our
        // message lands, the gate's CheckAsync returns and the tool
        // either runs (auto) or returns a synthesized error (deny).
        // `remember_for_kind` flips the per-session rule so
        // subsequent same-kind calls don't re-prompt.
        if (msg.data?.requestId && msg.data.decision) {
          this.vettProcess?.send({
            type: 'permission_response',
            request_id: msg.data.requestId,
            decision: msg.data.decision,
            remember_for_kind: msg.data.rememberForKind === true,
          });
        }
        break;
      }
      case 'newSession':
        // Explicit New Session — wipe chat history alongside the
        // subprocess respawn. The other startVettSession callers
        // (applySettings, setChatMode, first-message spawn, resume)
        // deliberately preserve history.
        await this.startVettSession(true);
        break;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', SETTINGS_QUERY);
        break;
      case 'openFolder':
        vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;
      case 'pickProfile': {
        // Reuse the same picker as the sidebar — invoked via the global
        // command so the picker behavior stays in one place.
        await vscode.commands.executeCommand('vett-chat.pickProfile');
        break;
      }
      case 'runOnboarding': {
        // Unified onboarding entrypoint — local-detect + cloud setup
        // are both reachable from the same QuickPick. Implemented as
        // a global command in extension.ts so the sidebar launcher
        // could fire the same flow if it ever gets a similar surface.
        await vscode.commands.executeCommand('vett-chat.runOnboardingWizard');
        break;
      }
      case 'slashCommand': {
        // Slash commands the webview itself can't handle (those that
        // require host-side state changes). The webview handles
        // /model, /help, /profile, /stats locally; /new, /clear,
        // /compact bounce here.
        const c = msg.data?.command;
        if (c === 'new') {
          ChatPanelProvider.openNew(this.context, this.profileService);
        } else if (c === 'clear') {
          this.post({ type: 'resetChat' });
        } else if (c === 'compact') {
          // Forward to vett — agent loop handles at next iteration
          // boundary and emits a `compacted` event back to the UI.
          this.vettProcess?.send({ type: 'compact' });
        } else if (c === 'init') {
          // Bootstrap a starter VETT.md. Defers to the same command
          // exposed in the Command Palette (vett-chat.initProjectRules)
          // so the slash and the palette behave identically.
          vscode.commands.executeCommand('vett-chat.initProjectRules');
        }
        break;
      }
      case 'dismissWelcome':
        // Panels don't show the welcome view; ignore.
        break;
      case 'revealSessionLog': {
        const p = this.vettProcess?.sessionLogPath;
        if (p) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
        else vscode.window.showInformationMessage('Session log not available yet — start a chat first.');
        break;
      }
    }
  }

  private async onWebviewReady(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const config = vscode.workspace.getConfiguration('vett-chat');
    const profile = this.activeProfile();
    const toolCardDensity = config.get<'compact' | 'default' | 'verbose'>('toolCardDensity', 'default');

    // `init.profiles` is optional on the wire and the webview only
    // assigns it when present, so "we couldn't ask vett" is sent as
    // UNDEFINED (unknown — leave the last-known list alone) while an
    // empty array keeps its literal meaning of "vett knows about none".
    // Sending `[]` on failure used to blank the welcome view's profile
    // list as if the user had no profiles installed.
    const listed = await this.profileService.list();
    const profiles = listed.ok ? listed.profiles : undefined;
    if (!listed.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[vett-chat] profile list unavailable: ${listed.error}`);
    }

    // If the panel was restored after a window reload AND worktree
    // mode is on, look up the existing worktree (panel id is stable,
    // so the worktree path is too) so the header chip shows the
    // right state before the user types their first message.
    if (this.useWorktree && !this.worktreeInfo && cwd) {
      try {
        this.worktreeInfo = await WorktreeManager.find(cwd, this.id);
      } catch {
        // Resume-time lookup is best-effort. A real spawn will retry
        // via ensure() and either reuse or create.
      }
    }

    // Panels are post-onboarding; never show the welcome view.
    this.post({
      type: 'init',
      data: {
        cwd, profile,
        connected: this.vettProcess?.isRunning ?? false,
        sessionLogPath: this.vettProcess?.sessionLogPath ?? undefined,
        welcomeSeen: true,
        profiles,
        toolCardDensity,
        chatMode: this.chatMode,
        sessionOverrides: this.sessionOverrides,
        worktree: this.buildWorktreeStatus(cwd),
        useWorktreeSetting: config.get<boolean>("useWorktree", false),
            contextWindowTokens: config.get<number>("contextWindowTokens", 131072),
            dispatchViewStyle: config.get<"log" | "structured">("dispatchViewStyle", "log"),
        panelMode: this.useWorktree ? 'worktree' : 'direct',
      },
    });

    // Push setting changes live so users don't need to reload the
    // window after toggling density. Disposed in panel dispose() so
    // the closure on `this` doesn't pin the panel after close.
    if (!this.configWatcherDispose) {
      this.configWatcherDispose = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vett-chat.toolCardDensity')) {
          const next = vscode.workspace.getConfiguration('vett-chat').get<'compact' | 'default' | 'verbose'>('toolCardDensity', 'default');
          this.post({ type: 'settingsChanged', data: { toolCardDensity: next } });
        }
        if (e.affectsConfiguration('vett-chat.useWorktree')) {
          // Broadcast the new value so the Settings drawer's checkbox
          // stays in sync, including when the change came from VS Code's
          // own settings UI or a hand-edit to settings.json.
          const next = vscode.workspace.getConfiguration('vett-chat').get<boolean>('useWorktree', false);
          this.post({ type: 'useWorktreeSettingChanged', data: { value: next } });
        }
        if (e.affectsConfiguration('vett-chat.contextWindowTokens')) {
          const next = vscode.workspace.getConfiguration('vett-chat').get<number>('contextWindowTokens', 131072);
          this.post({ type: 'settingsChanged', data: { contextWindowTokens: next } });
        }
        if (e.affectsConfiguration('vett-chat.dispatchViewStyle')) {
          const next = vscode.workspace.getConfiguration('vett-chat').get<'log' | 'structured'>('dispatchViewStyle', 'log');
          this.post({ type: 'settingsChanged', data: { dispatchViewStyle: next } });
        }
      });
    }

    // For resumed sessions, replay every JSONL envelope through the
    // same handler that processes live events. This populates not just
    // the visible chat bubbles (user/assistant text) but also the Raw
    // and Logs views, the Gantt timeline, and any inline dispatch
    // cards for sub-agent calls — which previously came back blank
    // because seedHistory only carried user/assistant messages.
    // Vett's --resume separately seeds the agent's conversation context.
    if (this.resumePath) {
      const envelopes = parseSessionEnvelopes(this.resumePath);
      if (envelopes.length > 0) {
        this.post({ type: 'seedFromLog', data: { envelopes } });
      }
    }

    // Replay any prefill text staged at openNew() time. Set by the
    // inline-edit "Iterate in chat" path + future hand-off-to-chat
    // surfaces. Replaces the textarea wholesale (not append) since
    // a fresh panel's input is always empty.
    //
    // Deliberately BEFORE the auto-start below, which is now awaited:
    // worktree creation can take a noticeable moment on a big repo, and
    // the prefill has no dependency on the subprocess. Leaving it after
    // the await would make the handed-off text appear seconds late in an
    // apparently-empty input box.
    if (this.pendingPrefillText) {
      this.post({
        type: 'prefillInput',
        data: { text: this.pendingPrefillText, append: false },
      });
      this.pendingPrefillText = undefined;
    }

    // Auto-start the subprocess on panel open so the user doesn't have
    // to type a first message before the resume kicks in. For new
    // (non-resumed) panels we eagerly start ONLY when worktree mode
    // is on — so the worktree creation + chip render happens
    // immediately after opening the panel from either the sidebar
    // launcher or the in-panel "+ New" button. Without this, sidebar
    // "+ New Chat" panels would defer worktree setup until the first
    // user message and read as "broken" while the user waited.
    // Direct-mode panels keep the lazy-spawn behavior so opening
    // multiple new chats doesn't fork N vett processes the user
    // never actually used.
    //
    // Awaited (like every other call site) so this eager start is a
    // participant in the re-entrancy guard rather than a floating promise
    // racing the user's first message.
    if (!this.vettProcess && (this.resumePath || this.useWorktree)) {
      await this.startVettSession();
    }
  }

  /** Preload saved cloud-provider keys from VS Code's SecretStorage so
   *  vettProcess.start can inject them into the spawned subprocess's
   *  env vars. Reads each known provider's key under
   *  `vett-chat.<envvar-lowercase>`; missing entries are skipped silently.
   *  process.env still wins downstream — a user who explicitly exported
   *  a key in their shell is never overridden. */
  private async preloadCloudSecrets(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const known = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
    for (const envName of known) {
      try {
        const saved = await this.context.secrets.get(`vett-chat.${envName.toLowerCase()}`);
        if (saved) out[envName] = saved;
      } catch {
        // SecretStorage failures are best-effort; vett will surface a
        // missing-key error if the profile actually needs the value.
      }
    }
    return out;
  }

  /** Spawn (or respawn) the vett subprocess for this panel.
   *
   *  `clearHistory` controls the chat-bubble side: an explicit New Session
   *  wants the messages wiped; a settings/mode-toggle respawn does NOT —
   *  the user expects the conversation they're looking at to survive a
   *  config tweak. Default false so callers must opt in to data loss.
   *
   *  RE-ENTRANCY GUARD. `doStartVettSession` awaits twice before it
   *  assigns `this.vettProcess` (worktree ensure, SecretStorage read), and
   *  every caller reaches it from an async message handler. Two triggers
   *  arriving inside that window — a double-click on New Session, a
   *  settings Apply landing on top of the first-message spawn — both ran
   *  to completion: the second assignment overwrote the first's
   *  `vettProcess` reference while that process was already spawned and
   *  live, so nothing could ever stop it. The same interleaving also let
   *  one call's `this.useWorktree = false` downgrade (from a failed
   *  `ensure`) be read by the other call's cwd resolution, silently
   *  dropping a session out of worktree isolation into the user's real
   *  tree.
   *
   *  While a start is in flight, further requests get that same promise
   *  instead of a second spawn. The consequence to be aware of: a config
   *  or mode change requested DURING a start is coalesced into it rather
   *  than queued behind it. That is benign for the mutable state these
   *  callers set (`chatMode`, `sessionOverrides`, `useWorktree` are read
   *  late, after the awaits, so an in-flight start usually picks the new
   *  values up anyway) and it is strictly better than the orphaned
   *  process it replaces. */
  private startVettSession(clearHistory = false): Promise<void> {
    // Done here rather than inside the guarded body for two reasons.
    // First, it must not be skipped when a start is already in flight —
    // the user asked for a clean slate and should get one. Second, it was
    // gated on `this.vettProcess?.isRunning`, so clicking New Session on a
    // panel whose vett had exited (crashed, or never started) left the old
    // conversation on screen under a brand-new session — the visible
    // history and the agent's actual context silently disagreed.
    if (clearHistory) {
      this.post({ type: 'resetChat' });
    }
    if (this.startInFlight) return this.startInFlight;
    const inFlight = this.doStartVettSession().finally(() => {
      // Identity check: only clear the slot if it still holds THIS run.
      if (this.startInFlight === inFlight) this.startInFlight = undefined;
    });
    this.startInFlight = inFlight;
    return inFlight;
  }

  private async doStartVettSession(): Promise<void> {
    this.vettProcess?.stop();
    // Mark the panel as "no longer fresh" before any await — even if
    // spawn/worktree setup fails, the panel has user-visible activity
    // (error cards, partial state) and shouldn't be reused by findIdle.
    this.hasEverStartedVett = true;

    // Workspace fallback: when no folder is open, use the user's home
    // directory as cwd. This unblocks pure-chat profiles (tools: [])
    // that don't need filesystem access at all — the user can still
    // converse without first opening a folder. Tool-using profiles
    // pointed at a tools-less environment will see operations fail
    // naturally when they try to read/write files; that's a softer
    // failure mode than the hard "open a folder first" block was.
    // We also disable worktree mode in this case since there's no git
    // repo at $HOME to base a worktree on.
    const explicitWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceRoot = explicitWorkspaceRoot ?? os.homedir();
    if (!explicitWorkspaceRoot) {
      this.useWorktree = false;
    }

    // Resolve the cwd we'll spawn vett against. With the worktree
    // setting on (default), every session runs in
    // ~/.vett/worktrees/<hash>-<panel>/ and the user's workspace stays
    // clean. The worktree is created lazily on first start AND reused
    // on resume — same panel id always maps to the same worktree path.
    let cwd = workspaceRoot;
    if (this.useWorktree && !this.worktreeInfo) {
      try {
        this.worktreeInfo = await WorktreeManager.ensure(workspaceRoot, this.id);
      } catch (err) {
        if (err instanceof WorktreeNotSupportedError) {
          // No `.git` (or `git worktree add` failed). Auto-downgrade
          // this panel to direct mode — keep the workspace setting
          // intact so other workspaces can still opt in. Toast tells
          // the user what happened so the missing worktree chip
          // doesn't look like a silent failure.
          vscode.window.showWarningMessage(`Vett Chat: ${err.message}`);
          this.useWorktree = false;
        } else {
          // Anything else is unexpected — log and continue in direct
          // mode rather than blocking the chat.
          vscode.window.showWarningMessage(
            `Vett Chat: worktree creation failed (${(err as Error).message}). Running directly in workspace.`,
          );
          this.useWorktree = false;
        }
      }
    }
    // Only route through the worktree when worktree mode is active for
    // this panel. A leftover worktreeInfo from a prior worktree-mode
    // session (e.g. user toggled to direct mode) shouldn't keep
    // hijacking the cwd.
    if (this.useWorktree && this.worktreeInfo) {
      cwd = this.worktreeInfo.path;
    }

    const config = vscode.workspace.getConfiguration('vett-chat');
    const profile = this.activeProfile();

    // Held in a local as well as on `this` so the callbacks can check
    // WHICH process they belong to. A respawn's `stop()` makes the old
    // process's exit event fire asynchronously, often after the new one
    // is already installed — without the identity check the dead
    // session's exit posts a "vett exited unexpectedly" banner over a
    // healthy new session, and reads `stderrTail()` off the wrong object.
    const proc: VettProcess = new VettProcess(
      (event: VettEvent) => this.handleVettEvent(event),
      (code: number | null) => {
        if (this.vettProcess !== proc) return;
        // The process is gone, so anything still queued for its `ready`
        // event will never be delivered by it. handleVettEvent only
        // clears pendingFirstMessage when it actually sends, so leaving
        // it set here means the NEXT session this panel starts fires the
        // stale message at its own `ready` — the user sees a message they
        // typed into a dead session reappear, and the agent acts on it.
        this.pendingFirstMessage = undefined;
        this.pendingFirstImages = undefined;
        if (code === 0 || code === null) {
          this.post({ type: 'connectionStatus', data: { connected: false } });
          return;
        }
        const tail = proc.stderrTail();
        this.post({
          type: 'connectionStatus',
          data: {
            connected: false,
            kind: 'subprocess_exit',
            error: `vett exited unexpectedly (code ${code})`,
            details: tail || 'No stderr output captured.',
          },
        });
      },
    );
    this.vettProcess = proc;
    const extraEnv = await this.preloadCloudSecrets();

    // The chosen profile's published roster, so an impossible team shape is
    // refused BEFORE spawn instead of arriving as a subprocess parse error.
    //
    // ⛔ BEST-EFFORT, AND THAT IS THE POINT. If the listing fails, or the
    // installed vett is older than 2026-08-28 and publishes no roster, this
    // stays undefined — which buildTeamArgs reads as "could not check" and
    // forwards, letting the binary be the one that decides. Substituting an
    // empty roster here would be far worse: it would read as "this profile
    // defines no roles", and reject every shape the user asked for.
    let profileTeam: TeamSummary | undefined;
    try {
      const listed = await this.profileService.list();
      if (listed.ok) profileTeam = listed.profiles.find((p) => p.name === profile)?.team;
    } catch {
      /* could not check — forward and let vett decide */
    }
    // Last checkpoint before the actual spawn. `dispose()` stops
    // `this.vettProcess`, but a start that was mid-await when the user
    // closed the tab would sail past that stop and spawn afterwards —
    // producing exactly the orphan the tree-kill in stop() exists to
    // prevent, only with nothing left holding a reference to kill.
    if (this.disposed) {
      this.vettProcess = undefined;
      return;
    }
    const startErr = proc.start(cwd, {
      resumePath: this.resumePath,
      sessionId: this.id,
      mode: this.chatMode,
      overrides: this.sessionOverrides,
      extraEnv,
      profileTeam,
    });
    if (startErr) {
      // Two very different failures share this path. Reporting a bad team
      // shape as "binary not found" would send the user to reinstall a
      // working binary over a field they can fix in five seconds.
      const badShape = startErr.type === 'invalid_team_override';
      this.post({
        type: 'connectionStatus',
        data: {
          connected: false,
          kind: badShape ? 'invalid_team_override' : 'binary_not_found',
          error: badShape ? 'This team shape cannot run' : 'VETT binary not found',
          details: startErr.message,
        },
      });
      this.vettProcess = undefined;
      // Same reasoning as the exit handler above: no subprocess was ever
      // spawned, so nothing will consume the queued first message. This
      // path never cleared it, which is how a message typed at a panel
      // with a missing vett binary got replayed into whatever session the
      // user managed to start afterwards.
      this.pendingFirstMessage = undefined;
      this.pendingFirstImages = undefined;
      return;
    }

    this.post({
      type: 'init',
      data: {
        cwd, profile, connected: true,
        sessionLogPath: this.vettProcess.sessionLogPath ?? undefined,
        welcomeSeen: true,
        chatMode: this.chatMode,
        sessionOverrides: this.sessionOverrides,
        worktree: this.buildWorktreeStatus(workspaceRoot),
        useWorktreeSetting: vscode.workspace.getConfiguration('vett-chat').get<boolean>('useWorktree', false),
        contextWindowTokens: vscode.workspace.getConfiguration('vett-chat').get<number>('contextWindowTokens', 131072),
        dispatchViewStyle: vscode.workspace.getConfiguration('vett-chat').get<'log' | 'structured'>('dispatchViewStyle', 'log'),
        panelMode: this.useWorktree ? 'worktree' : 'direct',
      },
    });
    if (this.vettProcess.sessionLogPath) {
      this.post({ type: 'sessionLogPath', data: { path: this.vettProcess.sessionLogPath } });
    }
    // Tell the webview to persist enough state for VS Code to restore
    // this panel after a window reload. The serializer reads it back
    // and re-attaches as a resumed session.
    this.post({
      type: 'persistState',
      data: { id: this.id, sessionLogPath: this.vettProcess.sessionLogPath ?? undefined },
    });
  }

  private handleVettEvent(event: VettEvent): void {
    if (event.type === 'ready' && this.pendingFirstMessage !== undefined) {
      const msg = this.pendingFirstMessage;
      const imgs = this.pendingFirstImages;
      this.pendingFirstMessage = undefined;
      this.pendingFirstImages = undefined;
      this.vettProcess?.sendMessage(msg, imgs);
    }
    // Mirror server-initiated mode changes (today: the plan-mode
    // unlock gate emits chat_mode_changed:execute on first approve)
    // into the host's per-panel state. Without this, this.chatMode
    // stays stale at 'plan' even after the unlock, and a subsequent
    // user click on the Plan toggle short-circuits in setChatMode
    // (`if (this.chatMode === next) break;`) instead of respawning.
    // Net effect was: Plan mode flipped on in the UI but vett kept
    // running with the unlocked gate, so writes dispatched silently.
    if (event.type === 'chat_mode_changed') {
      const m = event.data && typeof event.data === 'object'
        ? (event.data as { mode?: unknown }).mode
        : undefined;
      if (m === 'execute' || m === 'plan') {
        this.chatMode = m as ChatMode;
      }
    }
    this.post({ type: 'vettEvent', data: event });
  }

  private post(msg: HostToWebview): void {
    this.panel.webview.postMessage(msg);
  }

  /**
   * Build the per-keystroke @-menu context: matching files, matching
   * workspace symbols, current editor selection preview, diagnostics
   * counts, and git status summary. All five queries fire in parallel —
   * the slowest dominates (typically the workspace symbol provider on
   * first keystroke as the language server warms up).
   *
   * Every individual query is best-effort: failures fall back to empty
   * so a misconfigured language server, missing git, or hung file
   * search never blocks the menu from rendering. The webview's menu
   * filters defensively too.
   */
  private async buildMentionContext(query: string): Promise<{
    files: MentionFile[];
    symbols: MentionSymbol[];
    selectionPreview: string | null;
    problemsCount: ProblemsCount | null;
    git: GitStatusSummary;
  }> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const [files, symbols, gitSummary] = await Promise.all([
      this.findMentionFiles(query),
      this.findMentionSymbols(query),
      this.gitStatusSummary(cwd),
    ]);
    return {
      files,
      symbols,
      selectionPreview: this.previewActiveSelection(),
      problemsCount: this.workspaceProblemsCount(),
      git: gitSummary,
    };
  }

  private async findMentionFiles(query: string): Promise<MentionFile[]> {
    const q = query.trim().toLowerCase();
    // Build a glob that fuzzy-matches the query — `**/*<q>*` catches
    // both basename and path matches without requiring the user to
    // know the directory. Empty query → all files (capped at 50).
    const pattern = q ? `**/*${q}*` : '**/*';
    // Honor VS Code's default exclude list by passing `null` (uses
    // both `files.exclude` AND `search.exclude` via VS Code's
    // built-in FileSearchProvider integration).
    try {
      const uris = await vscode.workspace.findFiles(pattern, undefined, 50);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      // Compare case-insensitively on Windows so a workspace path with
      // mixed case history (`C:\Users\Dev\proj` vs the actual file
      // URI's `c:\users\dev\proj`) still strips the prefix correctly.
      const isWin = process.platform === 'win32';
      const cwdNorm = isWin ? cwd.toLowerCase() : cwd;
      const out: MentionFile[] = [];
      for (const u of uris) {
        const fsPath = u.fsPath;
        const fsCmp = isWin ? fsPath.toLowerCase() : fsPath;
        const rel = cwd && fsCmp.startsWith(cwdNorm) ? fsPath.slice(cwd.length + 1) : fsPath;
        const norm = rel.replace(/\\/g, '/');
        const lastSlash = norm.lastIndexOf('/');
        const basename = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
        out.push({ path: norm, basename });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Query VS Code's workspace symbol provider for symbols matching
   *  the user's @-menu query. Capped to ~10 results to keep the menu
   *  usable on big repos. Each language server provides its own
   *  symbols; if no servers are available the call resolves to [].
   *
   *  Empty query returns no symbols (most providers refuse a wildcard
   *  search, and a flood of unrelated symbols would crowd out files
   *  in the menu). The user has to type at least one character. */
  private async findMentionSymbols(query: string): Promise<MentionSymbol[]> {
    const q = query.trim();
    if (q.length === 0) return [];
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', q,
      );
      if (!symbols || symbols.length === 0) return [];
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const isWin = process.platform === 'win32';
      const cwdCmp = isWin ? cwd.toLowerCase() : cwd;
      const out: MentionSymbol[] = [];
      for (const s of symbols.slice(0, 10)) {
        const fsPath = s.location.uri.fsPath;
        const fsCmp = isWin ? fsPath.toLowerCase() : fsPath;
        const rel = cwd && fsCmp.startsWith(cwdCmp) ? fsPath.slice(cwd.length + 1) : fsPath;
        const norm = rel.replace(/\\/g, '/');
        out.push({
          name: s.name,
          kind: vscode.SymbolKind[s.kind] ?? 'Symbol',
          path: norm,
          startLine: s.location.range.start.line,
          endLine: s.location.range.end.line,
          containerName: s.containerName || undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Tally workspace diagnostics so the @-menu can show
   *  "@problems · 4 errors, 12 warnings". Returns null when there's
   *  nothing to report (the menu hides the row in that case). */
  private workspaceProblemsCount(): ProblemsCount | null {
    try {
      const all = vscode.languages.getDiagnostics();
      let errors = 0, warnings = 0, info = 0;
      for (const [, list] of all) {
        for (const d of list) {
          if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
          else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
          else if (d.severity === vscode.DiagnosticSeverity.Information) info++;
        }
      }
      if (errors === 0 && warnings === 0 && info === 0) return null;
      return { errors, warnings, info };
    } catch {
      return null;
    }
  }

  /** Light git probe so the @-menu can decide whether to surface
   *  `@git` / `@diff`. Runs `git rev-parse --abbrev-ref HEAD` (cheap)
   *  + a one-liner dirty-files count via `git status --porcelain`.
   *
   *  Failures collapse to `available: false` — no surfacing of the
   *  menu rows, no errors back to the user. */
  private async gitStatusSummary(cwd: string): Promise<GitStatusSummary> {
    if (!cwd) return { available: false };
    try {
      const { stdout: branchOut } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd, timeout: 1500, windowsHide: true,
      });
      const branch = branchOut.trim();
      let dirtyFiles = 0;
      try {
        const { stdout: statusOut } = await execFileP('git', ['status', '--porcelain'], {
          cwd, timeout: 1500, windowsHide: true, maxBuffer: 1024 * 1024,
        });
        dirtyFiles = statusOut.split('\n').filter((l: string) => l.trim().length > 0).length;
      } catch { /* ignore — branch alone is enough to mark git available */ }
      return { available: true, branch: branch === 'HEAD' ? undefined : branch, dirtyFiles };
    } catch {
      return { available: false };
    }
  }

  private previewActiveSelection(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const sel = editor.selection;
    if (sel.isEmpty) return null;
    const text = editor.document.getText(sel);
    if (!text.trim()) return null;
    // Preview only — full text is fetched at expansion time so the
    // agent always sees what's currently selected, not a snapshot.
    const firstLine = text.split('\n')[0].trim();
    return firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine;
  }

  /**
   * Substitute `@token` runs in the user's message with the actual
   * content (file contents, current selection text), wrapped in fenced
   * code blocks at the message footer for readability. Originals stay
   * inline so the agent sees both the reference AND the content.
   *
   * Failure modes: missing files / no selection produce a `[note: ...]`
   * line in the footer rather than throwing, so a stale token doesn't
   * break the send.
   */
  private async expandMentions(text: string, mentions: Mention[]): Promise<string> {
    if (mentions.length === 0) return text;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const blocks: string[] = [];
    const seen = new Set<string>();
    // Cumulative byte budget across all expanded mentions. Per-source
    // caps already bound each block (32KB file, 120 lines symbol,
    // 32KB diff, 200 lines problems), but a user with 10 mentions of
    // 32KB each would still ship 320KB of body. Stop appending once
    // the budget is hit and surface a single trailing note so the
    // agent knows context was capped.
    const MENTION_TOTAL_CAP = 256 * 1024;
    let totalBytes = 0;
    let capped = false;
    const tryPush = (block: string): boolean => {
      if (capped) return false;
      const size = Buffer.byteLength(block, 'utf8');
      if (totalBytes + size > MENTION_TOTAL_CAP) {
        capped = true;
        return false;
      }
      totalBytes += size;
      blocks.push(block);
      return true;
    };
    for (const m of mentions) {
      // De-dupe by token: if the user typed the same mention twice we
      // still expand once.
      if (seen.has(m.token)) continue;
      seen.add(m.token);
      // Belt-and-braces — only expand mentions actually present in
      // the text.
      if (!text.includes(m.token)) continue;
      if (capped) break;
      try {
        if (m.kind === 'selection') {
          const ed = vscode.window.activeTextEditor;
          if (!ed || ed.selection.isEmpty) {
            tryPush(`<context source="@selection">\n[note: no active editor selection at send time]\n</context>`);
            continue;
          }
          const selText = ed.document.getText(ed.selection);
          const lang = languageHint(ed.document.languageId);
          const fileRel = workspaceRelative(ed.document.uri.fsPath, cwd);
          tryPush(
            `<context source="@selection" file="${escapeAttr(fileRel)}" lines="${ed.selection.start.line + 1}-${ed.selection.end.line + 1}">\n` +
            `\`\`\`${lang}\n${selText}\n\`\`\`\n` +
            `</context>`,
          );
          continue;
        }
        if (m.kind === 'file' && m.path) {
          const abs = path.isAbsolute(m.path) ? m.path : path.join(cwd, m.path);
          const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
          // Hard cap at ~32KB so a giant file doesn't blow the prompt.
          // The agent can read the rest with file_editor view if it
          // wants more context.
          const FILE_CAP = 32 * 1024;
          let content = Buffer.from(buf).toString('utf8');
          let truncated = false;
          if (content.length > FILE_CAP) {
            content = content.slice(0, FILE_CAP);
            truncated = true;
          }
          const lang = languageHint(extOf(m.path));
          tryPush(
            `<context source="@file" path="${escapeAttr(m.path)}"${truncated ? ' truncated="true"' : ''}>\n` +
            `\`\`\`${lang}\n${content}\n\`\`\`\n` +
            (truncated ? `[note: file truncated at ${FILE_CAP} bytes — agent can read more via file_editor view]\n` : '') +
            `</context>`,
          );
          continue;
        }
        if (m.kind === 'symbol' && m.path && m.symbolName) {
          // Re-read the file slice live at send time so the agent sees
          // the current version. The pick-time line range is the
          // primary anchor; if the file shifted we still get a
          // reasonable window of code around it.
          const abs = path.isAbsolute(m.path) ? m.path : path.join(cwd, m.path);
          const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
          const allLines = Buffer.from(buf).toString('utf8').split('\n');
          const startLine = Math.max(0, m.startLine ?? 0);
          // Cap symbol slice at ~120 lines — a 500-line class would
          // crowd everything else; the agent can read more via
          // file_editor view if it wants the whole thing.
          const SYMBOL_LINE_CAP = 120;
          const requestedEnd = Math.max(startLine, m.endLine ?? startLine);
          const endLine = Math.min(allLines.length - 1, Math.min(requestedEnd, startLine + SYMBOL_LINE_CAP));
          const truncated = requestedEnd > endLine;
          const slice = allLines.slice(startLine, endLine + 1).join('\n');
          const lang = languageHint(extOf(m.path));
          tryPush(
            `<context source="@symbol" name="${escapeAttr(m.symbolName)}" path="${escapeAttr(m.path)}" lines="${startLine + 1}-${endLine + 1}"${truncated ? ' truncated="true"' : ''}>\n` +
            `\`\`\`${lang}\n${slice}\n\`\`\`\n` +
            (truncated ? `[note: symbol body truncated at ${SYMBOL_LINE_CAP} lines — agent can read more via file_editor view]\n` : '') +
            `</context>`,
          );
          continue;
        }
        if (m.kind === 'problems') {
          const t = renderProblems();
          tryPush(`<context source="@problems">\n${t}\n</context>`);
          continue;
        }
        if (m.kind === 'git') {
          const t = await gitContextBlock(cwd);
          tryPush(`<context source="@git">\n${t}\n</context>`);
          continue;
        }
        if (m.kind === 'diff') {
          const t = await gitDiffBlock(cwd);
          tryPush(`<context source="@diff">\n${t}\n</context>`);
          continue;
        }
      } catch (err) {
        tryPush(`<context source="${escapeAttr(m.token)}">\n[note: failed to read — ${(err as Error).message}]\n</context>`);
      }
    }
    if (capped) {
      blocks.push(`<context source="@vett-chat">\n[note: mention expansion stopped at ${MENTION_TOTAL_CAP} bytes total. Some mentions were not included.]\n</context>`);
    }
    if (blocks.length === 0) return text;
    return text + '\n\n' + blocks.join('\n\n');
  }

  /** Build the WorktreeStatus payload sent to the webview's chat
   *  header. When worktree mode is off, returns a `disabled` status
   *  pinned to the user's workspace so the chip can still render
   *  something sensible ("main tree"). */
  private buildWorktreeStatus(workspaceRoot: string): WorktreeStatus {
    if (!this.worktreeInfo) {
      return {
        enabled: false,
        mode: 'disabled',
        path: workspaceRoot,
        workspaceRoot,
      };
    }
    // Short id = last 6 chars of the panel id — enough to disambiguate
    // visually without overflowing the chip.
    const shortId = `wt-${this.id.slice(-6)}`;
    return {
      enabled: true,
      mode: this.worktreeInfo.mode,
      path: this.worktreeInfo.path,
      workspaceRoot: this.worktreeInfo.workspaceRoot,
      branch: this.worktreeInfo.branch,
      shortId,
    };
  }

  /** Run WorktreeManager.apply, surface the result + any warnings,
   *  and re-emit the worktree status so the chip refreshes. */
  private async applyWorktreeChanges(): Promise<void> {
    if (!this.worktreeInfo) {
      vscode.window.showInformationMessage('No worktree active for this chat.');
      return;
    }
    // Warn if the user has uncommitted changes in their workspace —
    // applying could clobber them. We compute the INTERSECTION of
    // worktree-changed paths and workspace-dirty paths so the modal
    // tells the user exactly which files will be overwritten, not just
    // a raw count. The per-file Review picker (F7) is the safer flow
    // when there ARE conflicts; we point users at it from the modal.
    const dirty = await WorktreeManager.workspaceDirtyPaths(this.worktreeInfo.workspaceRoot);
    if (!dirty.ok) {
      // FAIL CLOSED. This branch is "the dirty check could not be
      // performed" — not a git repo, or `git status` errored/timed out.
      // It used to be indistinguishable from "the workspace is clean"
      // (both arrived as `null`), so the guard fell straight through and
      // applied, silently overwriting whatever uncommitted edits the user
      // had. A guard that cannot measure must not pass: the user gets an
      // explicit choice, and the default — Esc, or dismissing the modal —
      // is to abort.
      const choice = await vscode.window.showWarningMessage(
        "Vett Chat can't tell whether your workspace has uncommitted edits, so it can't warn you which files this apply would overwrite.",
        {
          modal: true,
          detail:
            `${dirty.error}\n\n` +
            'Applying now could overwrite your own in-flight edits with the agent\'s versions, ' +
            'with no way to tell afterwards which files were yours. ' +
            '"Review changes per file…" shows each file\'s diff before anything is copied.',
        },
        'Review Per File', 'Apply Without the Check',
      );
      if (choice === 'Review Per File') {
        await this.runReviewChangesFlow();
        return;
      }
      if (choice !== 'Apply Without the Check') return;
    } else if (dirty.paths.size > 0) {
      const dirtyPaths = dirty.paths;
      const listed = await WorktreeManager.listChanges(this.worktreeInfo);
      if (!listed.ok) {
        // We know the workspace is dirty but can't enumerate the agent's
        // changes, so the conflict set is unknowable. Same rule as above:
        // don't apply on a guard that couldn't run. (Apply itself re-runs
        // the same `git status`, so it would fail immediately anyway —
        // this just reports the real reason instead of a copy error.)
        vscode.window.showErrorMessage(
          `Vett Chat: can't apply — the agent's changes couldn't be listed, so conflicts with your ${dirtyPaths.size} uncommitted change(s) can't be checked. ${listed.error}`,
        );
        return;
      }
      const agentChanges = listed.changes;
      const conflicts = agentChanges.filter((c) => dirtyPaths.has(c.path));
      if (conflicts.length > 0) {
        const PREVIEW = 5;
        const head = conflicts.slice(0, PREVIEW).map((c) => `  • ${c.path}`).join('\n');
        const tail = conflicts.length > PREVIEW
          ? `\n  …and ${conflicts.length - PREVIEW} more`
          : '';
        const choice = await vscode.window.showWarningMessage(
          `Apply will overwrite ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} you have uncommitted edits on.`,
          { modal: true, detail: `Conflicts:\n${head}${tail}\n\nUse "Review changes per file…" to accept selectively.` },
          'Overwrite Anyway', 'Review Per File',
        );
        if (choice === 'Review Per File') {
          await this.runReviewChangesFlow();
          return;
        }
        if (choice !== 'Overwrite Anyway') return;
      } else {
        // Dirty workspace, but no overlap with agent changes — the
        // user's edits are on different files. Still warn so they
        // know `git status` will look busier after apply, but no
        // data-loss risk.
        const choice = await vscode.window.showInformationMessage(
          `Your workspace has ${dirtyPaths.size} uncommitted change${dirtyPaths.size === 1 ? '' : 's'}, but none overlap with the agent's edits. Apply ${agentChanges.length} change${agentChanges.length === 1 ? '' : 's'}?`,
          { modal: true },
          'Apply',
        );
        if (choice !== 'Apply') return;
      }
    }
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Vett Chat: applying worktree changes…' },
        async () => WorktreeManager.apply(this.worktreeInfo!),
      );
      const summary = `Applied ${result.filesChanged} change${result.filesChanged === 1 ? '' : 's'}` +
        (result.filesDeleted > 0 ? ` and ${result.filesDeleted} deletion${result.filesDeleted === 1 ? '' : 's'}` : '') +
        '.';
      if (result.warnings.length > 0) {
        vscode.window.showWarningMessage(`${summary} ${result.warnings.length} warning(s) — see Output panel.`);
      } else {
        vscode.window.showInformationMessage(summary + ' Review with your normal git workflow.');
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Apply failed: ${(err as Error).message}`);
    }
  }

  /** Tear down the worktree (dir + branch in git mode) and re-emit
   *  the disabled status so the chip flips back. The chat continues —
   *  next session start picks up against the user's workspace directly
   *  (because useWorktree was the panel-construction-time decision and
   *  worktreeInfo is now null). */
  private async discardWorktree(): Promise<void> {
    if (!this.worktreeInfo) {
      vscode.window.showInformationMessage('No worktree active for this chat.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'Discard the worktree? All agent edits in it will be lost. The user workspace is untouched.',
      { modal: true },
      'Discard', 'Cancel',
    );
    if (choice !== 'Discard') return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Vett Chat: discarding worktree…' },
        async () => WorktreeManager.discard(this.worktreeInfo!),
      );
      // Tear down the shadow-git too — its checkpoints reference paths
      // that no longer exist.
      if (this.checkpointStore) {
        try { await this.checkpointStore.dispose(); } catch { /* best-effort */ }
        this.checkpointStore = null;
      }
      const ws = this.worktreeInfo.workspaceRoot;
      this.worktreeInfo = null;
      this.post({ type: 'worktreeStatus', data: { worktree: this.buildWorktreeStatus(ws) } });
      vscode.window.showInformationMessage('Worktree discarded. Future messages run directly in your workspace.');
    } catch (err) {
      vscode.window.showErrorMessage(`Discard failed: ${(err as Error).message}`);
    }
  }

  /** Per-file review of agent changes in the worktree. Opens an
   *  interactive QuickPick: each row is a changed file with action
   *  icons (View Diff / Accept / Reject). View Diff opens VS Code's
   *  native side-by-side diff (workspace ↔ worktree). Accept copies
   *  that one file into the user's workspace. Reject reverts the
   *  worktree's copy to its baseline. The picker stays open through
   *  multiple actions; closing it returns control to chat.
   *
   *  This is the per-file companion to the all-or-nothing
   *  "Apply changes to main tree…" action in the worktree dropdown.
   *  Pairs with #4 worktree isolation since the diff is exactly the
   *  "agent's worktree → user's main tree" axis the worktree creates. */
  private async runReviewChangesFlow(): Promise<void> {
    if (!this.worktreeInfo) {
      vscode.window.showInformationMessage('No worktree active for this chat. Enable `vett-chat.useWorktree` and start a new chat.');
      return;
    }
    const info = this.worktreeInfo;

    // Custom QuickPick so we can stay open across multiple actions
    // (item buttons fire without dismissing). showQuickPick's simple
    // form would dismiss after every button click — wrong UX for
    // "review N files in a row."
    // Eagerly register the vett-empty: content provider here so its
    // disposable joins context.subscriptions exactly once per
    // extension lifetime. Subsequent calls are no-ops.
    ensureEmptyContentProviderRegistered(this.context);

    const picker = vscode.window.createQuickPick<ChangePickItem>();
    picker.title = 'Review agent changes (worktree → main tree)';
    picker.placeholder = 'Click a row to open the diff. Use the icons to Accept / Reject per file.';
    picker.canSelectMany = false;
    picker.matchOnDescription = true;

    const refresh = async () => {
      const listed = await WorktreeManager.listChanges(info);
      if (!listed.ok) {
        // Explicit error state. This picker showing an empty list used to
        // read as "the agent changed nothing", and the natural follow-up
        // to that is Discard — which would have thrown the agent's work
        // away over a git call that failed. Say what actually happened,
        // and say it in the picker the user is looking at rather than
        // only in a toast that can be missed behind the modal.
        picker.items = [];
        picker.placeholder = `Couldn't list changes — this is an ERROR, not an empty worktree. ${listed.error}`;
        picker.title = 'Review agent changes — FAILED to read worktree status';
        vscode.window.showErrorMessage(`Vett Chat: couldn't list worktree changes. ${listed.error}`);
        return;
      }
      const changes = listed.changes;
      picker.title = 'Review agent changes (worktree → main tree)';
      if (changes.length === 0) {
        picker.items = [];
        picker.placeholder = 'No changes to review — worktree matches its baseline.';
        return;
      }
      picker.placeholder = `${changes.length} file${changes.length === 1 ? '' : 's'} changed. Click for diff; icons to Accept / Reject.`;
      picker.items = changes.map((c) => buildChangeItem(c));
    };

    picker.onDidTriggerItemButton(async (e) => {
      // Re-validate the worktree on every button click. If the user
      // discarded the worktree (chip dropdown) while the picker was
      // open, the captured `info` now points at a deleted directory
      // and downstream operations would surface a confusing error.
      // Bail with a clear message instead.
      if (!this.worktreeInfo) {
        vscode.window.showInformationMessage('Worktree was discarded — review picker no longer applies.');
        picker.hide();
        return;
      }
      const item = e.item;
      const button = e.button as ChangeButton;
      try {
        if (button.action === 'diff') {
          await openDiffForChange(info, item.change);
        } else if (button.action === 'edit') {
          // Open the diff + flush any dirty state on the worktree side
          // back to disk so a subsequent Accept copies what the user
          // sees (not the pre-edit version). VS Code's diff viewer
          // makes the right pane editable by default — the file URI
          // points at the worktree path, so saves land in the right
          // place. After save we fall through; the user clicks Accept
          // when they're done iterating.
          await openDiffForChange(info, item.change);
          vscode.window.showInformationMessage(
            `Editing the worktree's copy of ${item.change.path} (right pane). Click Accept when done — unsaved edits are auto-saved before the copy.`,
          );
        } else if (button.action === 'accept') {
          // Defensive save: if the worktree-side document is dirty,
          // flush it to disk before copying to the workspace. Without
          // this, "edit then click Accept" would copy the pre-edit
          // version. saveAll(false) only saves dirty docs; cheap.
          await flushDirtyWorktreeDocs(info);
          await WorktreeManager.acceptFile(info, item.change);
          vscode.window.showInformationMessage(`Accepted ${describeChange(item.change)}.`);
          await refresh();
        } else if (button.action === 'reject') {
          await WorktreeManager.rejectFile(info, item.change);
          vscode.window.showInformationMessage(`Reverted ${item.change.path} in worktree.`);
          await refresh();
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Action failed: ${(err as Error).message}`);
      }
    });

    // Click on a row (without an icon) opens the diff — natural shortcut.
    picker.onDidAccept(async () => {
      const sel = picker.selectedItems[0];
      if (sel) {
        try { await openDiffForChange(info, sel.change); }
        catch (err) { vscode.window.showErrorMessage(`Couldn't open diff: ${(err as Error).message}`); }
      }
    });

    picker.onDidHide(() => picker.dispose());
    await refresh();
    picker.show();
  }

  /** Take a per-turn checkpoint of the current worktree state. Init
   *  the shadow-git lazily on first call. Best-effort throughout —
   *  failures log but never throw into the chat path. */
  private async snapshotCheckpoint(userText: string): Promise<void> {
    // Without a worktree there's no stable target for the checkpoint
    // (we'd have to commit the user's actual workspace which is
    // exactly what the worktree feature is meant to avoid). Skip in
    // that mode; document as a tradeoff for users who turn worktree
    // off.
    if (!this.worktreeInfo) return;
    if (!this.checkpointStore) {
      this.checkpointStore = new CheckpointStore(
        this.worktreeInfo.path,
        this.worktreeInfo.workspaceHash,
        this.id,
      );
    }
    try {
      await this.checkpointStore.snapshot(userText);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[vett-chat] checkpoint snapshot failed: ${(err as Error).message}`);
    }
  }

  /** Open a QuickPick of recent checkpoints, restore files when the
   *  user picks one, surface a result toast. Conversation-only and
   *  combined restore are deferred to next session — they require
   *  webview-side message-history surgery on top of the checkpoint
   *  metadata. */
  private async runRestoreCheckpointFlow(): Promise<void> {
    if (!this.worktreeInfo) {
      vscode.window.showInformationMessage('Checkpoints require worktree mode. Enable `vett-chat.useWorktree` and start a new chat.');
      return;
    }
    if (!this.checkpointStore) {
      this.checkpointStore = new CheckpointStore(
        this.worktreeInfo.path,
        this.worktreeInfo.workspaceHash,
        this.id,
      );
      await this.checkpointStore.init();
    }
    let entries: CheckpointEntry[];
    try {
      entries = await this.checkpointStore.list();
    } catch (err) {
      vscode.window.showErrorMessage(`Couldn't list checkpoints: ${(err as Error).message}`);
      return;
    }
    if (entries.length === 0) {
      vscode.window.showInformationMessage('No checkpoints yet — checkpoints are taken before each user message.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: e.turn > 0 ? `Turn ${e.turn} — ${e.message.replace(/^Turn \d+: /, '')}` : e.message,
        description: e.sha,
        detail: new Date(e.timestamp).toLocaleString(),
        sha: e.sha,
        turn: e.turn,
      })),
      { placeHolder: 'Restore to which checkpoint?' },
    );
    if (!picked) return;
    const sha = (picked as { sha: string }).sha;
    const turn = (picked as { turn: number }).turn;

    // Second picker: what to roll back. Files only is the original
    // session-8 behavior; conversation + combined are session-15
    // additions that close out the #3 partial.
    const modePick = await vscode.window.showQuickPick(
      [
        { label: '$(files) Files only', description: 'Roll back the worktree files; keep the chat history intact', value: 'files' as const },
        { label: '$(comment-discussion) Conversation only', description: 'Trim chat history to before this turn; leave files unchanged', value: 'conversation' as const },
        { label: '$(history) Files + conversation', description: 'Roll back both — full restore to this checkpoint', value: 'both' as const },
      ],
      { placeHolder: `Restore mode for Turn ${turn} (${sha})?` },
    );
    if (!modePick) return;
    const mode = (modePick as { value: 'files' | 'conversation' | 'both' }).value;

    const wantsFiles = mode === 'files' || mode === 'both';
    const wantsConv = mode === 'conversation' || mode === 'both';

    // For files-restore, ask whether to ALSO remove files added
    // since the checkpoint. Default-no preserves the historical
    // behavior (added files survive); users who want a true rewind
    // can opt in. Skip the prompt when there's nothing to clean.
    let cleanAdded = false;
    if (wantsFiles) {
      const addedCount = await this.checkpointStore!.countAddedSince(sha);
      if (addedCount > 0) {
        const cleanChoice = await vscode.window.showWarningMessage(
          `${addedCount} file${addedCount === 1 ? '' : 's'} added after Turn ${turn} would survive a files-only restore. Remove them too?`,
          { modal: true, detail: 'Recommended for a clean rewind. "Keep" leaves the new files in place — useful if the agent created scaffolding you want to preserve.' },
          'Remove Added Files', 'Keep',
        );
        if (cleanChoice === undefined) return; // Cancel = bail entirely
        cleanAdded = cleanChoice === 'Remove Added Files';
      }
    }

    const confirmTitle = wantsFiles && wantsConv
      ? `Restore files AND conversation to ${sha}?`
      : wantsFiles
        ? `Restore worktree files to ${sha}? Agent edits since this checkpoint will be lost.`
        : `Trim chat history to before Turn ${turn}? Files unchanged.`;
    const confirm = await vscode.window.showWarningMessage(
      confirmTitle,
      { modal: true },
      'Restore', 'Cancel',
    );
    if (confirm !== 'Restore') return;

    try {
      if (wantsFiles) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Vett Chat: restoring files to ${sha}…` },
          async () => this.checkpointStore!.restoreFiles(sha, { cleanAdded }),
        );
      }
      if (wantsConv && turn > 0) {
        // Webview owns the message-list state — fire the rewind there.
        // For turn === 0 (the synthetic "session start" entry) there's
        // nothing to trim; skip silently.
        this.panel.webview.postMessage({
          type: 'rewindConversation',
          data: { mode: 'turn', userTurn: turn },
        });
      }

      const summary = wantsFiles && wantsConv
        ? `Restored files + conversation to Turn ${turn} (${sha}).`
        : wantsFiles
          ? `Worktree restored to ${sha}. Chat history is unchanged — the agent's view of "what's on disk" updates on its next read.`
          : `Chat history trimmed to before Turn ${turn}. Files unchanged.`;
      vscode.window.showInformationMessage(summary);
    } catch (err) {
      vscode.window.showErrorMessage(`Restore failed: ${(err as Error).message}`);
    }
  }

  private dispose(): void {
    // Set BEFORE the stop so an in-flight startVettSession that hasn't
    // reached its spawn yet aborts instead of leaving a live process
    // behind a disposed panel.
    this.disposed = true;
    this.vettProcess?.stop();
    this.vettProcess = undefined;
    this.voiceInput.detach();
    this.configWatcherDispose?.dispose();
    this.configWatcherDispose = undefined;
    ChatPanelProvider.all.delete(this.id);
    ChatPanelProvider.onChange?.();
  }

  private getHtmlContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>Vett Chat</title>
  <style>
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    #root { height: 100vh; display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function generateId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `chat-${ts}-${rand}`;
}

/** Map a VS Code languageId or file extension to a markdown code-fence
 *  language label. Best-effort; unknown types fall back to empty so the
 *  fence still renders. */
function languageHint(idOrExt: string): string {
  const m = idOrExt.toLowerCase();
  switch (m) {
    case 'typescript': case 'ts': case 'tsx': return 'typescript';
    case 'javascript': case 'js': case 'jsx': return 'javascript';
    case 'csharp': case 'cs': return 'csharp';
    case 'python': case 'py': return 'python';
    case 'go': return 'go';
    case 'rust': case 'rs': return 'rust';
    case 'ruby': case 'rb': return 'ruby';
    case 'java': return 'java';
    case 'kotlin': case 'kt': return 'kotlin';
    case 'swift': return 'swift';
    case 'shellscript': case 'sh': case 'bash': return 'bash';
    case 'powershell': case 'ps1': return 'powershell';
    case 'json': return 'json';
    case 'yaml': case 'yml': return 'yaml';
    case 'toml': return 'toml';
    case 'xml': return 'xml';
    case 'html': return 'html';
    case 'css': return 'css';
    case 'sql': return 'sql';
    case 'markdown': case 'md': return 'markdown';
    case 'dockerfile': return 'dockerfile';
    default: return m;
  }
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return path.slice(dot + 1);
}

function workspaceRelative(absPath: string, cwd: string): string {
  if (!cwd || !absPath.startsWith(cwd)) return absPath.replace(/\\/g, '/');
  return absPath.slice(cwd.length + 1).replace(/\\/g, '/');
}

function makeNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** Render the workspace's current diagnostics (errors + warnings) as a
 *  flat-text block grouped by file. Capped at 200 lines so a workspace
 *  with hundreds of warnings doesn't blow the prompt — the agent can
 *  always run `tsc` / `eslint` directly to see the rest. */
function renderProblems(): string {
  const PROBLEMS_LINE_CAP = 200;
  const all = vscode.languages.getDiagnostics();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const lines: string[] = [];
  let totalErrors = 0, totalWarnings = 0, totalInfo = 0;
  for (const [, list] of all) {
    for (const d of list) {
      if (d.severity === vscode.DiagnosticSeverity.Error) totalErrors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) totalWarnings++;
      else if (d.severity === vscode.DiagnosticSeverity.Information) totalInfo++;
    }
  }
  if (totalErrors === 0 && totalWarnings === 0 && totalInfo === 0) {
    return 'No diagnostics in the current workspace.';
  }
  lines.push(`Workspace diagnostics: ${totalErrors} error(s), ${totalWarnings} warning(s), ${totalInfo} info`);
  lines.push('');
  let truncated = false;
  const isWin = process.platform === 'win32';
  const cwdCmp = isWin ? cwd.toLowerCase() : cwd;
  outer: for (const [uri, list] of all) {
    if (list.length === 0) continue;
    const fsPath = uri.fsPath;
    const fsCmp = isWin ? fsPath.toLowerCase() : fsPath;
    const rel = cwd && fsCmp.startsWith(cwdCmp) ? fsPath.slice(cwd.length + 1) : fsPath;
    lines.push(rel.replace(/\\/g, '/'));
    for (const d of list) {
      const sev =
        d.severity === vscode.DiagnosticSeverity.Error ? 'error' :
        d.severity === vscode.DiagnosticSeverity.Warning ? 'warn' :
        d.severity === vscode.DiagnosticSeverity.Information ? 'info' :
        'hint';
      const ln = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const src = d.source ? ` [${d.source}]` : '';
      lines.push(`  ${sev} ${ln}:${col}${src}: ${d.message.split('\n')[0]}`);
      if (lines.length > PROBLEMS_LINE_CAP) { truncated = true; break outer; }
    }
  }
  if (truncated) lines.push(`[truncated — capped at ${PROBLEMS_LINE_CAP} lines]`);
  return lines.join('\n');
}

/** `git status --short` + `git log --oneline -10` from the workspace
 *  root, joined into a single fenced text block. Either subcommand
 *  failing collapses to a single `[note: ...]` line; we never throw. */
async function gitContextBlock(cwd: string): Promise<string> {
  if (!cwd) return '[note: no workspace open]';
  const parts: string[] = [];
  try {
    const { stdout } = await execFileP('git', ['status', '--short', '--branch'], {
      cwd, timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    parts.push('## git status\n```\n' + (stdout.trim() || '(clean)') + '\n```');
  } catch (err) {
    parts.push('[note: git status failed — ' + (err as Error).message + ']');
  }
  try {
    const { stdout } = await execFileP('git', ['log', '--oneline', '-10'], {
      cwd, timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    parts.push('## git log (last 10)\n```\n' + (stdout.trim() || '(no commits)') + '\n```');
  } catch (err) {
    parts.push('[note: git log failed — ' + (err as Error).message + ']');
  }
  return parts.join('\n\n');
}

/** `git diff` (uncommitted, including unstaged tracked files) from the
 *  workspace root. Capped at ~32KB so a massive diff doesn't blow the
 *  prompt; agent can run `git diff <path>` itself for narrower scope. */
async function gitDiffBlock(cwd: string): Promise<string> {
  if (!cwd) return '[note: no workspace open]';
  const DIFF_CAP = 32 * 1024;
  try {
    const { stdout } = await execFileP('git', ['diff'], {
      cwd, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return '(no uncommitted changes)';
    let body = trimmed;
    let truncated = false;
    if (body.length > DIFF_CAP) {
      body = body.slice(0, DIFF_CAP);
      truncated = true;
    }
    return '```diff\n' + body + '\n```' + (truncated ? `\n[note: diff truncated at ${DIFF_CAP} bytes — agent can read more via terminal git diff]` : '');
  } catch (err) {
    return '[note: git diff failed — ' + (err as Error).message + ']';
  }
}

/** Flush any unsaved edits on documents inside the active worktree
 *  back to disk before an Accept copies them to the main tree.
 *
 *  Without this step, "edit the right pane → click Accept" silently
 *  copies the pre-edit version because the worktree file on disk
 *  hasn't received the user's typing yet. We walk every open dirty
 *  document, check if its fsPath sits inside the worktree root, and
 *  call save() on each match. Cheap (most chats have ≤ 1-2 dirty
 *  docs); fail-soft (a save error is logged but doesn't block the
 *  Accept — the user gets a clear error from the underlying copy
 *  call instead of a cryptic "save failed"). */
async function flushDirtyWorktreeDocs(info: WorktreeInfo): Promise<void> {
  // Normalize wtRoot so the containment check survives:
  //   - Trailing separator: prevents `/foo/bar` matching `/foo/bar2/x`.
  //   - Case folding on Windows: NTFS is case-insensitive, but
  //     fsPath strings can carry mixed case from history.
  // Use path.resolve to collapse any trailing slashes / `..` artifacts
  // before re-appending a single separator.
  const isWin = process.platform === 'win32';
  const fold = (p: string) => (isWin ? p.toLowerCase() : p);
  const wtRoot = fold(path.resolve(info.path)) + path.sep;
  const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file');
  for (const doc of dirty) {
    const docPath = fold(path.resolve(doc.uri.fsPath));
    if (!docPath.startsWith(wtRoot)) continue;
    try {
      await doc.save();
    } catch (err) {
      console.warn(`[vett-chat] couldn't save ${doc.uri.fsPath} before Accept:`, err);
    }
  }
}

/** Escape a string for inclusion as the value of an XML/HTML attribute
 *  inside the `<context>` envelope blocks. Only single + double quotes
 *  + ampersand need handling; the rest are safe inside attribute
 *  values. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Per-file review-changes flow helpers -----------------------------

/** Action discriminator on the QuickPick item buttons. */
interface ChangeButton extends vscode.QuickInputButton {
  action: 'diff' | 'edit' | 'accept' | 'reject';
}

/** QuickPickItem extended with the change it represents so the
 *  trigger / accept handlers can act on it without round-tripping
 *  through the label string. */
interface ChangePickItem extends vscode.QuickPickItem {
  change: WorktreeChange;
}

/** Build a labeled QuickPick item with the three action icons on
 *  the right. VS Code's `theme-icon` semantic — using built-in codicons
 *  so we inherit the user's theme without bundling assets. */
function buildChangeItem(change: WorktreeChange): ChangePickItem {
  const statusBadge =
    change.status === 'modified' ? '$(diff-modified)' :
    change.status === 'added' ? '$(diff-added)' :
    '$(diff-removed)';
  const buttons: ChangeButton[] = [
    { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Open diff', action: 'diff' },
    { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit (open diff with the worktree side editable; save then click Accept)', action: 'edit' },
    { iconPath: new vscode.ThemeIcon('check'), tooltip: 'Accept (copy worktree → main tree, including any unsaved edits to the worktree)', action: 'accept' },
    { iconPath: new vscode.ThemeIcon('discard'), tooltip: 'Reject (revert worktree to baseline)', action: 'reject' },
  ];
  return {
    label: `${statusBadge} ${change.path}`,
    description: change.status,
    change,
    buttons,
  };
}

/** Open VS Code's native side-by-side diff for one change. Convention:
 *  left = "what's currently on the user's main tree" (or empty for an
 *  agent-added file), right = "what the agent has in the worktree" (or
 *  empty for a deletion). User reads left → right as "current → proposed."
 *
 *  For added / deleted files where one side has no file on disk, we
 *  pass a `vett-empty:` URI that resolves to empty content via a
 *  registered TextDocumentContentProvider — VS Code's diff viewer
 *  handles this cleanly with a "(empty)" marker. */
async function openDiffForChange(info: WorktreeInfo, change: WorktreeChange): Promise<void> {
  const wsPath = path.join(info.workspaceRoot, change.path);
  const wtPath = path.join(info.path, change.path);
  // Defensive — runReviewChangesFlow always registers first, but a
  // future caller might invoke this from a fresh code path. Pass
  // undefined; the disposable will leak to extension lifetime in
  // that edge case but the documented happy path stays clean.
  ensureEmptyContentProviderRegistered(undefined);

  const left = change.status === 'added'
    ? vscode.Uri.parse(`vett-empty:/${encodeURIComponent(change.path)}?side=main`)
    : vscode.Uri.file(wsPath);
  const right = change.status === 'deleted'
    ? vscode.Uri.parse(`vett-empty:/${encodeURIComponent(change.path)}?side=worktree`)
    : vscode.Uri.file(wtPath);

  const title = `${change.path} (main ↔ worktree)`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

/** "Accepted foo.ts" / "Accepted deletion of foo.ts". */
function describeChange(change: WorktreeChange): string {
  switch (change.status) {
    case 'deleted': return `deletion of ${change.path}`;
    case 'added': return `addition of ${change.path}`;
    default: return change.path;
  }
}

/** Lazy one-shot registration of the `vett-empty:` content provider.
 *  Returns empty string for any URI on the scheme — used for the
 *  "missing-on-this-side" pane in added / deleted file diffs. The
 *  Disposable is captured so the extension's deactivate() path can
 *  clean it up rather than relying on window reload. */
let emptyContentProviderDisposable: vscode.Disposable | undefined;
function ensureEmptyContentProviderRegistered(context: vscode.ExtensionContext | undefined): void {
  if (emptyContentProviderDisposable) return;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: () => '',
  };
  emptyContentProviderDisposable = vscode.workspace.registerTextDocumentContentProvider('vett-empty', provider);
  if (context) context.subscriptions.push(emptyContentProviderDisposable);
}
