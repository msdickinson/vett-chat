import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/**
 * Shadow-git store for per-turn checkpoints.
 *
 * Lives at `~/.vett/checkpoints/<workspaceHash>-<panelId>/.git/`,
 * completely separate from the user's `.git`. We commit the entire
 * worktree state to a single linear branch (`vett-checkpoints`) before
 * every user message — gives the user "undo back to before I asked
 * X" without polluting their real history.
 *
 * v1 ships file-only restore (`git checkout <sha> -- .` against the
 * worktree). Conversation-only restore + combined restore are wired
 * up at the host layer (chat history rewind) but not yet exposed in
 * the UI — those are scoped for the next session.
 *
 * The shadow-git operates against the worktree path via git's
 * `--git-dir` + `--work-tree` flags, NOT by symlinking or creating a
 * `.git` file in the worktree. That keeps the shadow invisible to
 * the agent — it sees the worktree's own `.git` (in git-worktree
 * mode) or the cp-fallback's `.git` and not ours.
 */
export interface CheckpointEntry {
  /** 7-char short SHA; sufficient for restore lookups in the small
   *  number of commits a single chat session produces. */
  sha: string;
  /** Human-readable message — typically `Turn N: <first 80 chars of
   *  user message>`. Same shape used by `git log --oneline`. */
  message: string;
  /** ISO 8601 from git's commit metadata. */
  timestamp: string;
  /** Turn number (1-indexed) within this chat session. */
  turn: number;
}

export class CheckpointStore {
  private readonly gitDir: string;
  private readonly workTree: string;
  private initialized = false;
  private nextTurn = 1;

  /** Construct with explicit paths — no IO. Call `init()` before any
   *  snapshot / list / restore to materialize the on-disk repo. */
  constructor(workTreePath: string, workspaceHash: string, panelId: string, homeDir?: string) {
    const home = homeDir ?? os.homedir();
    this.gitDir = path.join(home, '.vett', 'checkpoints', `${workspaceHash}-${panelId}`, '.git');
    this.workTree = workTreePath;
  }

  /** Idempotent: if the shadow git already exists, just sets
   *  `initialized = true` and reads the next turn number from the
   *  existing log. Otherwise creates an empty bare-ish repo and seeds
   *  it with an initial commit so subsequent rollbacks have a "before
   *  the chat started" anchor. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.promises.mkdir(path.dirname(this.gitDir), { recursive: true });
    if (!fs.existsSync(this.gitDir)) {
      // Multi-step init. If `git init` succeeds but a `git config`
      // call fails midway, leaving the repo half-configured would
      // make every future snapshot's `git commit` fail (no identity).
      // The existsSync check above would skip re-running config on
      // the next call, stranding the user. Trap and recover by
      // wiping the partial repo so the next call starts clean.
      try {
        await this.git(['init', '--initial-branch=vett-checkpoints']);
        await this.git(['config', 'user.email', 'vett-checkpoints@localhost']);
        await this.git(['config', 'user.name', 'vett-checkpoints']);
        // Pin line-ending behavior off — the shadow git stores files
        // byte-for-byte. Without this, restoring a file on Windows
        // would convert LF→CRLF via git's autocrlf smudge filter, even
        // when the on-disk file used LF. Same reasoning for safecrlf.
        await this.git(['config', 'core.autocrlf', 'false']);
        await this.git(['config', 'core.safecrlf', 'false']);
      } catch (err) {
        // Roll back the half-built repo so the next attempt isn't
        // hosed by the partial state.
        try { await fs.promises.rm(this.gitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        // eslint-disable-next-line no-console
        console.warn(`[vett-chat] checkpoint init failed mid-config, rolled back: ${(err as Error).message}`);
        return; // initialized stays false; next call retries from scratch.
      }
      // Initial commit captures "the worktree before the chat ran any
      // turn." Allow-empty handles the case where the worktree is
      // genuinely empty (cp-fallback skipped everything).
      try {
        await this.git(['add', '-A']);
        await this.git(['commit', '--allow-empty', '-m', 'session start']);
      } catch (err) {
        // First commit failures are non-fatal — we still have the
        // configured repo so future snapshots will work once the
        // worktree has content the user wants captured.
        // eslint-disable-next-line no-console
        console.warn(`[vett-chat] checkpoint initial commit failed: ${(err as Error).message}`);
      }
    }
    // Bring nextTurn up to date on resume — count existing
    // turn-shaped commits.
    try {
      const list = await this.list();
      const lastTurn = list.reduce((max, e) => Math.max(max, e.turn), 0);
      this.nextTurn = lastTurn + 1;
    } catch {
      this.nextTurn = 1;
    }
    this.initialized = true;
  }

  /** Snapshot the current worktree state as a new commit. Returns the
   *  short SHA, or null when nothing changed since the last snapshot
   *  (in which case we don't waste a commit). Errors soft-fail —
   *  checkpointing is best-effort and must never break the chat path. */
  async snapshot(userMessage: string): Promise<CheckpointEntry | null> {
    if (!this.initialized) {
      try { await this.init(); } catch { return null; }
    }
    const turn = this.nextTurn++;
    const summary = userMessage.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)';
    const subject = `Turn ${turn}: ${summary}`;
    try {
      // Status-first: most turns have nothing to snapshot (agent
      // hasn't written anything yet, or already committed at the
      // last turn). Skipping `git add -A` on no-op turns saves disk
      // I/O on a hot path that fires before every user message.
      // Note: `status --porcelain` shows untracked files too, so
      // adds are detected even though they aren't staged yet.
      const { stdout } = await this.git(['status', '--porcelain']);
      if (!stdout.trim()) {
        // Roll back the turn counter so the next real snapshot is N,
        // not N+1.
        this.nextTurn = turn;
        return null;
      }
      await this.git(['add', '-A']);
      await this.git(['commit', '-m', subject]);
      const { stdout: shaOut } = await this.git(['rev-parse', '--short=7', 'HEAD']);
      const { stdout: tsOut } = await this.git(['log', '-1', '--format=%cI']);
      return {
        sha: shaOut.trim(),
        message: subject,
        timestamp: tsOut.trim(),
        turn,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[vett-chat] checkpoint snapshot failed: ${(err as Error).message}`);
      this.nextTurn = turn;
      return null;
    }
  }

  /** Most-recent-first list of checkpoints in this session. Empty
   *  array on read failure (we never throw — the caller's UI can
   *  render "no checkpoints" instead of breaking). */
  async list(): Promise<CheckpointEntry[]> {
    if (!fs.existsSync(this.gitDir)) return [];
    try {
      // %h short sha, %cI ISO timestamp, %s subject. NUL between
      // fields and records so subjects with control chars don't break
      // parsing.
      const { stdout } = await this.git([
        'log', '--format=%h%x00%cI%x00%s%x00', 'vett-checkpoints',
      ]);
      const entries: CheckpointEntry[] = [];
      // Records are %s-terminated by %x00 + literal newline; split on
      // newline and parse each.
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [sha, ts, subject] = line.split('\x00');
        if (!sha) continue;
        const m = (subject ?? '').match(/^Turn (\d+):/);
        const turn = m ? parseInt(m[1], 10) : 0;
        entries.push({
          sha,
          message: subject ?? '',
          timestamp: ts ?? '',
          turn,
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  /** Roll the worktree back to the file state at `sha`. Doesn't
   *  affect chat history — that's a host-layer concern.
   *
   *  We use `git checkout <sha> -- .` which sets the index AND
   *  working tree to match `sha` for tracked files. Files that the
   *  agent ADDED after the checkpoint won't be removed by checkout;
   *  pass `cleanAdded: true` to follow up with `git clean -fd` and
   *  remove them too (a "true" rewind). False (the default) keeps
   *  added files in place — useful when the user wants to preserve
   *  scaffolding the agent created later. */
  async restoreFiles(sha: string, opts: { cleanAdded?: boolean } = {}): Promise<void> {
    if (!this.initialized) await this.init();
    // Verify the sha exists first so we surface a clear error rather
    // than `git checkout`'s opaque "fatal: invalid reference".
    try {
      await this.git(['cat-file', '-e', sha]);
    } catch {
      throw new Error(`Checkpoint ${sha} not found in shadow-git`);
    }
    await this.git(['checkout', sha, '--', '.']);
    if (opts.cleanAdded) {
      // Wipe untracked files + dirs introduced after the checkpoint.
      // -d covers directories; -f bypasses git's safety prompt
      // (we already asked the user via the chat-side modal).
      await this.git(['clean', '-fd']);
    }
  }

  /** Count the number of files added (untracked from the checkpoint's
   *  perspective) since `sha`. Used to decide whether the restore
   *  modal should bother offering the "also remove added files?"
   *  option. Returns 0 on git failure or if everything's tracked. */
  async countAddedSince(sha: string): Promise<number> {
    if (!this.initialized) await this.init();
    try {
      // List files present now but absent at sha. `diff --name-only
      // --diff-filter=A` against sha shows what's been added since.
      const { stdout } = await this.git([
        'diff', '--name-only', '--diff-filter=A', sha, 'HEAD',
      ]);
      const tracked = stdout.split('\n').filter((l) => l.trim().length > 0).length;
      // Plus untracked (files agent created but never committed via
      // a turn snapshot; status from the working tree side).
      const { stdout: untracked } = await this.git([
        'ls-files', '--others', '--exclude-standard',
      ]);
      const u = untracked.split('\n').filter((l) => l.trim().length > 0).length;
      return tracked + u;
    } catch {
      return 0;
    }
  }

  /** Tear down the shadow-git store entirely — used when the user
   *  discards the worktree, since the checkpoints reference paths
   *  that no longer exist. Best-effort. */
  async dispose(): Promise<void> {
    const root = path.dirname(this.gitDir);
    if (fs.existsSync(root)) {
      try {
        await fs.promises.rm(root, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[vett-chat] checkpoint dispose rm failed: ${(err as Error).message}`);
      }
    }
  }

  /** Run a git subcommand against the shadow-git's git-dir + the
   *  worktree's work-tree. Centralized so every invocation gets the
   *  same flags + timeouts + windowsHide treatment. */
  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const all = ['--git-dir', this.gitDir, '--work-tree', this.workTree, ...args];
    return execFileP('git', all, {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}
