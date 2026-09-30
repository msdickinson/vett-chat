import { ChildProcess, spawn } from 'child_process';
import { createInterface, Interface } from 'readline';
import * as vscode from 'vscode';
import { buildTeamArgs } from './teamArgs';
import { VettRequest, VettEvent, VettImageAttachment, ChatMode, SessionOverrides, TeamSummary } from '../shared/types';
import { SessionLogger } from './sessionLogger';
import { resolveVettPath } from './vettPath';

export type VettEventCallback = (event: VettEvent) => void;

export interface VettBinaryNotFoundError {
  type: 'binary_not_found';
  configured: string;
  searched: string[];
  message: string;
}

/**
 * The customized team shape cannot run, so no subprocess was started.
 *
 * ⭐ A SEPARATE TYPE, NOT A GENERIC FAILURE. This is a user-fixable
 * configuration mistake — a role that does not exist, a seat count past the
 * cap — and it must not surface through the same path as "the binary is
 * missing" or "the subprocess died". Those read as a broken install; this one
 * needs the Customize panel reopened on the offending field.
 */
export interface VettInvalidTeamOverrideError {
  type: 'invalid_team_override';
  message: string;
  errors: string[];
}

export type VettStartError = VettBinaryNotFoundError | VettInvalidTeamOverrideError;

/**
 * Manages a `vett chat --stdio` subprocess. Sends JSON requests on
 * stdin and reads JSON events from stdout, line by line.
 */
/** Keep the last N stderr lines so a non-zero exit can carry context
 * forward to the user without needing to resurrect the subprocess. */
const STDERR_TAIL_LINES = 20;

export class VettProcess {
  private proc: ChildProcess | null = null;
  private stdoutRl: Interface | null = null;
  private stderrRl: Interface | null = null;
  private onEvent: VettEventCallback;
  private onExit: (code: number | null) => void;
  private logger: SessionLogger | null = null;
  private recentStderr: string[] = [];

  constructor(onEvent: VettEventCallback, onExit: (code: number | null) => void) {
    this.onEvent = onEvent;
    this.onExit = onExit;
  }

  /** Most recent stderr lines (up to STDERR_TAIL_LINES), joined by `\n`.
   * Used by ChatViewProvider to enrich subprocess-exit errors with the
   * last thing vett actually printed. */
  stderrTail(): string {
    return this.recentStderr.join('\n');
  }

  /**
   * Start the vett chat subprocess. Returns null on success, or a
   * structured error if the binary couldn't be located so the
   * webview can render an actionable banner instead of a silent fail.
   *
   * Opts:
   * - `resumePath`: if set, passed to vett as `--resume <path>` so the
   *    agent's conversation history is seeded from that JSONL log. The
   *    extension's session log is also opened in append mode against
   *    the same file, so a single conversation = a single JSONL.
   * - `sessionId`: stable id used as the JSONL filename when starting
   *    a fresh session. Defaults to a generated id.
   */
  start(
    cwd: string,
    opts: {
      resumePath?: string;
      sessionId?: string;
      mode?: ChatMode;
      overrides?: SessionOverrides;
      extraEnv?: Record<string, string>;
      /**
       * The chosen profile's published roster, when known. Supplied by the
       * caller because only it has the profile list; used to reject an
       * impossible team shape BEFORE spawn. Absent = could not check, which
       * forwards the flags and lets the binary decide — see buildTeamArgs.
       */
      profileTeam?: TeamSummary;
    } = {},
  ): VettStartError | null {
    const config = vscode.workspace.getConfiguration('vett-chat');
    const configured = config.get<string>('vettPath', '');
    const resolved = resolveVettPath(configured);
    if (!resolved.path) {
      return {
        type: 'binary_not_found',
        configured,
        searched: resolved.searched,
        message:
          'VETT binary not found.\n\n' +
          `Searched:\n  ${resolved.searched.join('\n  ')}\n\n` +
          'Install: from a clone of vett, run `dotnet pack src/Vett/Vett.csproj` ' +
          'then `dotnet tool install --global --add-source ./bin/nupkg VettBench`. ' +
          'Or set `vett-chat.vettPath` in VS Code settings to point at a `vett` ' +
          'binary you already have.',
      };
    }
    const vettPath = resolved.path;
    const profile = config.get<string>('profile', 'coding');

    // Open a JSONL session log. When resuming, append to the existing
    // file so a single conversation = a single JSONL across restarts.
    // Otherwise create a fresh log (with the panel's stable id baked in
    // to the filename so future resumes can find it).
    const customLogDir = config.get<string>('chatSessionLogDir', '');
    this.logger = new SessionLogger(undefined, customLogDir, opts);
    this.logger.start();

    // The profile is the single source of truth for endpoint / model /
    // API key. The extension is a thin shell — it picks the profile and
    // forwards `--cwd`, `--resume`, and per-session overrides.
    const args = ['chat', '--stdio', '--profile', profile, '--cwd', cwd];

    // ⛔ REFUSE BEFORE SPAWN, NOT AFTER. An invalid roster is a parse error
    // from the subprocess otherwise — surfaced after the user has configured a
    // whole run, and reported as a crashed binary rather than a bad field.
    const shaped = buildTeamArgs(opts.overrides, {
      name: profile,
      team: opts.profileTeam,
    });
    if (shaped.errors.length > 0) {
      return {
        type: 'invalid_team_override',
        message:
          'This team shape cannot run:\n\n  ' +
          shaped.errors.join('\n  ') +
          '\n\nAdjust it in Customize, or start with the profile defaults.',
        errors: shaped.errors,
      };
    }
    const teamArgs = shaped.args;
    if (opts.resumePath) {
      args.push('--resume', opts.resumePath);
    }
    // Plan vs execute mode is baked at session start (system prompt
    // + tool list change). Mid-session toggles require respawn — the
    // ChatPanelProvider handles that on `setChatMode` messages.
    if (opts.mode === 'plan') {
      args.push('--mode', 'plan');
    }

    // Per-session overrides from the Settings UI. Each flag mirrors a
    // profile field; vett applies them after profile load + after
    // VETT.md/AGENTS.md instructions, so they layer on top cleanly.
    // Like --mode, these are baked at session start — applying new
    // overrides mid-session requires a respawn (ChatPanelProvider's
    // applySettings handler triggers that).
    const o = opts.overrides;
    if (o) {
      // Team SHAPE for this run. Validated against the profile's published
      // roster in buildTeamArgs; a non-empty `errors` there means the caller
      // already refused to reach this point, so anything arriving here is
      // known-representable.
      args.push(...teamArgs);
      if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) {
        args.push('--temperature', String(o.temperature));
      }
      if (typeof o.topP === 'number' && Number.isFinite(o.topP)) {
        args.push('--top-p', String(o.topP));
      }
      if (typeof o.maxIterations === 'number' && Number.isFinite(o.maxIterations) && o.maxIterations > 0) {
        args.push('--max-iterations', String(Math.floor(o.maxIterations)));
      }
      if (typeof o.timeoutMinutes === 'number' && Number.isFinite(o.timeoutMinutes) && o.timeoutMinutes > 0) {
        args.push('--timeout-minutes', String(Math.floor(o.timeoutMinutes)));
      }
      if (typeof o.systemPromptAppend === 'string' && o.systemPromptAppend.trim().length > 0) {
        args.push('--system-prompt-append', o.systemPromptAppend.trim());
      }
      // Per-kind permission overrides (#5 close-out). Each flag is
      // optional; if the form leaves a kind unselected, the profile
      // YAML's value (or its built-in default) wins. Validates the
      // value against the auto/ask/deny set to defend against typed
      // garbage if someone wires a custom front-end.
      const validPermValues = ['auto', 'ask', 'deny'] as const;
      const permFlag = (key: keyof SessionOverrides, flag: string) => {
        const v = o[key];
        if (typeof v === 'string' && (validPermValues as readonly string[]).includes(v)) {
          args.push(flag, v);
        }
      };
      permFlag('permissionRead', '--permission-read');
      permFlag('permissionEdit', '--permission-edit');
      permFlag('permissionTerminalSafe', '--permission-terminal-safe');
      permFlag('permissionTerminalUnsafe', '--permission-terminal-unsafe');
      permFlag('permissionMcp', '--permission-mcp');
      permFlag('permissionOther', '--permission-other');
    }

    // Merge process.env with extraEnv. process.env wins so a user who
    // explicitly exported (e.g.) OPENAI_API_KEY in their shell isn't
    // silently overridden by a saved-but-stale SecretStorage value.
    // extraEnv only fills the gaps. Secret keys arrive here via
    // ChatPanelProvider.preloadCloudSecrets().
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env };
    if (opts.extraEnv) {
      for (const [k, v] of Object.entries(opts.extraEnv)) {
        if (!mergedEnv[k]) mergedEnv[k] = v;
      }
    }

    this.proc = spawn(vettPath, args, {
      cwd,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Read stdout line by line for JSON events.
    if (this.proc.stdout) {
      this.stdoutRl = createInterface({ input: this.proc.stdout });
      this.stdoutRl.on('line', (line: string) => {
        if (!line.trim()) { return; }
        try {
          const event: VettEvent = JSON.parse(line);
          this.logger?.log(event);
          this.onEvent(event);
        } catch {
          // Not JSON — ignore (could be debug output)
        }
      });
    }

    // Capture stderr for error reporting + keep a tail so exit handlers
    // can include the last few lines as exit context.
    this.recentStderr = [];
    if (this.proc.stderr) {
      this.stderrRl = createInterface({ input: this.proc.stderr });
      this.stderrRl.on('line', (line: string) => {
        this.recentStderr.push(line);
        if (this.recentStderr.length > STDERR_TAIL_LINES) {
          this.recentStderr.shift();
        }
        const ev: VettEvent = { type: 'stderr', text: line };
        this.logger?.log(ev);
        this.onEvent(ev);
      });
    }

    this.proc.on('exit', (code) => {
      this.logger?.close(`exit code ${code ?? 'null'}`);
      this.cleanup();
      this.onExit(code);
    });

    this.proc.on('error', (err) => {
      const ev: VettEvent = { type: 'error', data: { message: err.message } };
      this.logger?.log(ev);
      this.onEvent(ev);
      this.logger?.close(`spawn error: ${err.message}`);
      this.cleanup();
      this.onExit(1);
    });

    return null;
  }

  /** Path of the active session log file, if any. Surfaced to the webview
   * for "open in AI Timeline" actions. */
  get sessionLogPath(): string | null { return this.logger?.logPath ?? null; }

  /** Send a JSON request to the subprocess. */
  send(req: VettRequest): void {
    if (!this.proc?.stdin?.writable) { return; }
    try {
      const data = JSON.stringify(req) + '\n';
      this.proc.stdin.write(data, (err) => {
        if (err) {
          this.onEvent({ type: 'error', data: { message: `stdin write failed: ${err.message}` } });
        }
      });
    } catch (err) {
      this.onEvent({ type: 'error', data: { message: `send failed: ${(err as Error).message}` } });
    }
  }

  /** Send a user message, optionally with attached images. Also writes
   * a synthetic `user_message` event to the session log so the JSONL is
   * a complete transcript — needed for resume.
   *
   * Image payloads are NOT logged in full (base64 of an image can be
   * megabytes) — we record a `[N images attached]` marker instead.
   * Resume reconstructs the conversation from the LOG, so resumed
   * sessions won't replay images to the agent. That's deliberate
   * for v1: resuming with image context would require the host to
   * re-decode them and the LLM to re-process expensive vision tokens
   * on every resume. Defer to future work. */
  sendMessage(text: string, images?: VettImageAttachment[]): void {
    const imgCount = images?.length ?? 0;
    if (imgCount > 0) {
      this.logger?.log({
        type: 'user_message',
        text,
        data: { text, image_count: imgCount, images_omitted_from_log: true },
      });
    } else {
      this.logger?.log({ type: 'user_message', text });
    }
    this.send({ type: 'user_message', text, ...(imgCount > 0 ? { images } : {}) });
  }

  /** Cancel the current operation. */
  cancel(): void {
    this.send({ type: 'cancel' });
  }

  /** Stop and kill the subprocess AND everything it spawned.
   *
   *  This is the ONLY teardown path — `cleanup()` runs on the natural
   *  exit/error events where the OS has already reaped the tree, so it
   *  deliberately does not kill anything. Every caller that tears a
   *  session down (panel dispose, respawn, extension deactivate) must
   *  come through here. */
  stop(): void {
    if (this.proc) {
      killProcessTree(this.proc);
    }
    this.cleanup();
  }

  /** Check if the subprocess is running. */
  get isRunning(): boolean {
    return this.proc !== null;
  }

  /** Clean up readline interfaces and process reference. */
  private cleanup(): void {
    this.stdoutRl?.close();
    this.stderrRl?.close();
    this.stdoutRl = null;
    this.stderrRl = null;
    this.proc = null;
  }

  // resolveVettPathWithSearched and existsOnPath were extracted to
  // ./vettPath.ts so they can be unit-tested without the vscode shim.
}

/**
 * Terminate `proc` and every process it spawned.
 *
 * MEASURED SYMPTOM (Windows): closing a chat tab left the `dotnet build`
 * the agent had started still running. It kept file handles open on
 * `bin/` and `obj/`, so the user's next build failed on locked outputs
 * until they hunted the stray process down by hand.
 *
 * The cause is that `ChildProcess.kill()` on Windows terminates the
 * DIRECT child only — vett itself. Windows has no process groups and no
 * signal propagation, so every grandchild vett spawned (dotnet, git,
 * npm, a test runner) is simply re-parented and survives. `taskkill /T`
 * walks the parent-child tree Windows itself records and `/F` force-
 * terminates each node, which is the only tree-kill primitive available
 * without adding a dependency.
 *
 * The POSIX path is left EXACTLY as it was — a plain `kill()` on the
 * direct child. Tree-killing there means spawning detached to get a
 * process group and then `process.kill(-pid)`, which changes stdio and
 * signal behaviour for the stdin/stdout protocol this class depends on.
 * No orphaning has been observed on POSIX; this fix is scoped to the
 * platform where it was reproduced.
 *
 * The pid is validated as a positive integer before it is used. It is
 * passed as an argv element to a directly-spawned `taskkill` — never
 * interpolated into a shell string — so there is no command line for a
 * malformed value to escape into.
 */
function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;

  // `pid` is undefined when spawn never produced a process (bad binary
  // path), and Number.isInteger guards the pathological rest. Anything
  // that isn't a real pid falls through to the plain kill, which is a
  // no-op on a process that never existed.
  const usable = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  if (process.platform !== 'win32' || !usable) {
    try { proc.kill(); } catch { /* already gone */ }
    return;
  }

  try {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    // taskkill exits NON-ZERO ("process not found") whenever the tree is
    // already gone — which is the common case when the user hits Stop a
    // beat after vett finished on its own. There is no user action that
    // would follow from that, so it is deliberately not surfaced and not
    // logged. We only listen for `error`, which means taskkill itself
    // could not be launched (stripped PATH, locked-down image); in that
    // case fall back to the single-process kill so vett at least dies.
    killer.on('error', () => {
      try { proc.kill(); } catch { /* already gone */ }
    });
  } catch {
    // Synchronous spawn failure — same fallback.
    try { proc.kill(); } catch { /* already gone */ }
  }
}
