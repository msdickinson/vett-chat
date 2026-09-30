import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/**
 * Worktree isolation for chat sessions.
 *
 * Each chat panel runs the agent inside its own working directory at
 * `~/.vett/worktrees/<workspaceHash>-<panelId>/` so the user's actual
 * workspace is never touched until they explicitly accept changes.
 *
 * Worktree mode requires a real git repo. We use `git worktree add`
 * on a hidden branch named `vett/wt-<panelId>` — branches are
 * namespaced under `vett/` so the user can spot them in `git branch`,
 * and worktrees are cheap on big repos because objects are shared
 * with the main `.git`. Workspaces without `.git` get a clear error
 * (`WorktreeNotSupportedError`); the caller falls back to direct
 * mode for the panel.
 *
 * The legacy `cp-fallback` (recursive copy of the workspace tree)
 * was removed because it bricked monorepos: each chat would copy
 * 10s of GB and freeze the panel for minutes. The 'cp-fallback' mode
 * value still exists in the type union to keep wire compat with
 * resumed worktrees from older builds — we never produce new ones.
 *
 * "Apply" copies the worktree's modified files into the user's
 * workspace as uncommitted modifications — the user reviews and
 * commits with their existing git tooling. We don't run a git merge,
 * because the worktree branch is rarely committed (the agent edits
 * but doesn't commit on its own).
 *
 * "Discard" removes the worktree directory and (in git mode) the
 * branch.
 */
export type WorktreeMode = 'git-worktree' | 'cp-fallback';

/**
 * Thrown by `WorktreeManager.ensure` when the workspace can't host a
 * worktree — either no `.git` directory, or `git worktree add` failed
 * for a reason we can't recover from. Callers (ChatPanelProvider)
 * catch this specifically to surface a clear toast and fall back to
 * direct mode for the panel without writing back to settings.
 */
export class WorktreeNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeNotSupportedError';
  }
}

export interface WorktreeInfo {
  mode: WorktreeMode;
  /** Absolute path of the worktree's working directory. This is what
   *  `vett chat --cwd` should point at. */
  path: string;
  /** For git-worktree mode: the branch the worktree sits on
   *  (`vett/wt-<panelId>`). For cp-fallback: the local-init branch
   *  (`main` or whatever `git init` defaulted to). */
  branch: string;
  /** User's actual workspace root, kept so apply / discard know where
   *  to write back. */
  workspaceRoot: string;
  panelId: string;
  workspaceHash: string;
}

export interface ApplyResult {
  filesChanged: number;
  filesDeleted: number;
  warnings: string[];
}

/** One row of "what the agent changed since the worktree was created."
 *  `status` mirrors git's porcelain codes collapsed to three states.
 *  `path` is workspace-relative (forward-slashed). */
export interface WorktreeChange {
  status: 'modified' | 'added' | 'deleted';
  path: string;
}

/**
 * Outcome of `listChanges`.
 *
 * HIGHEST-IMPACT defect this file has carried: `listChanges` used to
 * swallow a failed `git status` and return `[]`. Every consumer renders
 * an empty list as "no changes to review — worktree matches its
 * baseline", so a user whose git call timed out (or whose worktree
 * directory had gone missing) was told, in as many words, that the agent
 * had produced nothing — and the obvious next click is Discard. That
 * discards real work on the strength of an error message nobody saw.
 *
 * `{ok: true, changes: []}` is the only thing allowed to mean "genuinely
 * nothing changed". A failure has to be rendered as a failure.
 */
export type ListChangesResult =
  | { ok: true; changes: WorktreeChange[] }
  | { ok: false; error: string };

/**
 * Outcome of `workspaceDirtyPaths`.
 *
 * Same defect class as ListChangesResult, on the other side of the apply
 * flow. The old signature returned `null` both for "this isn't a git
 * repo" and for "git failed", and the apply guard read either as "no
 * conflicts" and proceeded — a guard that could not measure passed. The
 * `reason` distinguishes the two so the caller can say WHICH one it hit.
 */
export type DirtyPathsResult =
  | { ok: true; paths: Set<string> }
  | { ok: false; reason: 'not-a-git-repo' | 'git-failed'; error: string };

export class WorktreeManager {
  /** Lower-case + SHA256 first 8 hex chars. Stable per absolute
   *  workspace path; case-insensitive on Windows where paths are too. */
  static workspaceHash(workspaceRoot: string): string {
    return createHash('sha256').update(workspaceRoot.toLowerCase()).digest('hex').slice(0, 8);
  }

  /**
   * Panel ids are interpolated into a filesystem path and a git branch
   * name, and both of those reach destructive commands: `discard()` runs
   * `fs.rm(worktreePath, {recursive, force})` and `git branch -D
   * branchName(id)`. `path.join` RESOLVES `..`, so an id of
   * `../../../../Documents` walks straight out of ~/.vett/worktrees and
   * deletes whatever it lands on. A leading `-` would likewise reach git
   * as a flag rather than a branch name.
   *
   * Ids that the extension itself generates are always safe
   * (`chat-<ISO timestamp>-<base36>`, separators stripped). The reason to
   * check anyway is that resume does NOT use a generated id: it reads
   * `state.id` out of the webview state VS Code persisted
   * (ChatPanelProvider.restore), which is on-disk JSON that nothing
   * validates on the way back in. That is one edit away from an
   * unbounded delete, and this is the single choke point both destructive
   * paths pass through.
   */
  private static assertSafePanelId(panelId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(panelId) || panelId.includes('..')) {
      throw new Error(
        `Refusing to derive a worktree path or branch from panel id ${JSON.stringify(panelId)}. ` +
          'Expected only letters, digits, dot, dash and underscore, starting with a letter or ' +
          'digit. This id reaches `rm -rf` and `git branch -D`.',
      );
    }
  }

  /** Where worktrees live for a given (workspace, panel). Pure
   *  function — calling this doesn't create anything. */
  static worktreePath(workspaceRoot: string, panelId: string, homeDir?: string): string {
    WorktreeManager.assertSafePanelId(panelId);
    const home = homeDir ?? os.homedir();
    const hash = WorktreeManager.workspaceHash(workspaceRoot);
    return path.join(home, '.vett', 'worktrees', `${hash}-${panelId}`);
  }

  /** Branch name used for git-worktree mode. Namespaced so the user's
   *  `git branch` output shows them grouped together. */
  static branchName(panelId: string): string {
    WorktreeManager.assertSafePanelId(panelId);
    return `vett/wt-${panelId}`;
  }

  /** True if `workspaceRoot` has a `.git` directory or file. The file
   *  variant happens when the workspace is itself a worktree. */
  static async isGitRepo(workspaceRoot: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(path.join(workspaceRoot, '.git'));
      return stat.isDirectory() || stat.isFile();
    } catch {
      return false;
    }
  }

  /** Create-or-reuse the worktree for this (workspace, panel). On
   *  resume, returns the existing worktree if present. */
  static async ensure(workspaceRoot: string, panelId: string, homeDir?: string): Promise<WorktreeInfo> {
    const wtPath = WorktreeManager.worktreePath(workspaceRoot, panelId, homeDir);
    const hash = WorktreeManager.workspaceHash(workspaceRoot);
    const branch = WorktreeManager.branchName(panelId);

    // Resume path — if the directory already exists, figure out what
    // mode it's in by checking for a .git file/dir inside it.
    if (fs.existsSync(wtPath)) {
      const gitMarker = path.join(wtPath, '.git');
      const gitExists = fs.existsSync(gitMarker);
      const gitStat = gitExists ? await fs.promises.stat(gitMarker) : null;
      // git-worktree: .git is a file (a gitfile pointer to main repo's
      // .git/worktrees/<id>/). cp-fallback: .git is a directory (we
      // ran `git init` ourselves at create time).
      const mode: WorktreeMode = gitStat?.isFile() ? 'git-worktree' : 'cp-fallback';
      return {
        mode,
        path: wtPath,
        branch,
        workspaceRoot,
        panelId,
        workspaceHash: hash,
      };
    }

    // Fresh path. Worktree mode requires a real git repo — we used to
    // fall back to a recursive copy of the workspace, but that bricked
    // big monorepos (dozens of GB per chat). Refuse cleanly and let
    // the caller surface the toast + flip the panel into direct mode.
    if (!(await WorktreeManager.isGitRepo(workspaceRoot))) {
      throw new WorktreeNotSupportedError(
        'Worktree isolation requires a git repo. Run `git init` in your workspace, or turn off `vett-chat.useWorktree`.',
      );
    }

    await fs.promises.mkdir(path.dirname(wtPath), { recursive: true });

    // `git worktree add -B` re-creates the branch if it stale-exists
    // from a prior panel that was discarded without cleaning up. The
    // panel id is stable per chat so the same panel resuming gets
    // the same branch.
    try {
      await execFileP(
        'git',
        ['-C', workspaceRoot, 'worktree', 'add', '-B', branch, wtPath, 'HEAD'],
        { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (err) {
      // Common causes: shallow clone (git refuses), git not on PATH
      // despite `.git` existing, write permissions on the .git/worktrees
      // dir. Surface as the same not-supported error so the caller
      // falls back to direct mode with a clear message instead of
      // hanging or copying gigabytes.
      throw new WorktreeNotSupportedError(
        `git worktree add failed: ${(err as Error).message}. Falling back to direct mode.`,
      );
    }

    return {
      mode: 'git-worktree',
      path: wtPath,
      branch,
      workspaceRoot,
      panelId,
      workspaceHash: hash,
    };
  }

  /** Look up an existing worktree without creating one. Returns null
   *  if the directory doesn't exist. */
  static async find(workspaceRoot: string, panelId: string, homeDir?: string): Promise<WorktreeInfo | null> {
    const wtPath = WorktreeManager.worktreePath(workspaceRoot, panelId, homeDir);
    if (!fs.existsSync(wtPath)) return null;
    const gitMarker = path.join(wtPath, '.git');
    const gitExists = fs.existsSync(gitMarker);
    const gitStat = gitExists ? await fs.promises.stat(gitMarker) : null;
    return {
      mode: gitStat?.isFile() ? 'git-worktree' : 'cp-fallback',
      path: wtPath,
      branch: WorktreeManager.branchName(panelId),
      workspaceRoot,
      panelId,
      workspaceHash: WorktreeManager.workspaceHash(workspaceRoot),
    };
  }

  /** Copy modified/added files from the worktree into the user's
   *  workspace as uncommitted modifications. Deletions in the worktree
   *  delete in the workspace too. We use `git status --porcelain` from
   *  the worktree to enumerate changes — this works in both modes
   *  because cp-fallback created an initial commit. */
  static async apply(info: WorktreeInfo): Promise<ApplyResult> {
    const warnings: string[] = [];
    let filesChanged = 0;
    let filesDeleted = 0;

    // Enumerate changes vs the worktree's HEAD. In git-worktree mode
    // HEAD is the snapshot at panel start. In cp-fallback HEAD is the
    // initial commit we made.
    let porcelain: string;
    try {
      const { stdout } = await execFileP(
        'git',
        ['-C', info.path, 'status', '--porcelain', '-z', '-uall'],
        { timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      porcelain = stdout;
    } catch (err) {
      throw new Error(`Couldn't read worktree status: ${(err as Error).message}`);
    }

    // -z null-separated to handle weird filenames. Each entry is
    // `XY filename\0` (no trailing slash, no quoting). For renames,
    // it's `XY new\0old\0`.
    const entries = parsePorcelainZ(porcelain);

    for (const entry of entries) {
      const srcAbs = path.join(info.path, entry.path);
      const dstAbs = path.join(info.workspaceRoot, entry.path);

      if (entry.kind === 'deleted') {
        try {
          await fs.promises.rm(dstAbs, { force: true });
          filesDeleted++;
        } catch (err) {
          warnings.push(`Failed to delete ${entry.path}: ${(err as Error).message}`);
        }
        continue;
      }

      // Treat both modified and added as "copy from worktree to
      // workspace." Renames already produce two entries (old=deleted,
      // new=added) in porcelain -z output, so they're covered.
      try {
        await fs.promises.mkdir(path.dirname(dstAbs), { recursive: true });
        await fs.promises.copyFile(srcAbs, dstAbs);
        filesChanged++;
      } catch (err) {
        warnings.push(`Failed to copy ${entry.path}: ${(err as Error).message}`);
      }
    }

    return { filesChanged, filesDeleted, warnings };
  }

  /** Remove the worktree directory and its branch (git mode only).
   *  Best-effort — failures degrade to "leaves the dir behind" rather
   *  than throwing into the chat path. */
  static async discard(info: WorktreeInfo): Promise<void> {
    if (info.mode === 'git-worktree') {
      try {
        await execFileP(
          'git',
          ['-C', info.workspaceRoot, 'worktree', 'remove', '--force', info.path],
          { timeout: 30_000, windowsHide: true },
        );
      } catch {
        // Fall through to manual rm below.
      }
      try {
        await execFileP(
          'git',
          ['-C', info.workspaceRoot, 'branch', '-D', info.branch],
          { timeout: 15_000, windowsHide: true },
        );
      } catch {
        // Branch may already be gone — fine.
      }
    }
    // Belt-and-braces: rm the directory if it still exists. Handles
    // both cp-fallback mode and the "git worktree remove" failure path.
    // Throws on rm failure so the caller (chat panel) can surface a
    // toast — silently leaving the directory behind would let a future
    // `ensure()` resume against stale state without the user knowing.
    if (fs.existsSync(info.path)) {
      try {
        await fs.promises.rm(info.path, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[vett-chat] discard rm failed for ${info.path}: ${(err as Error).message}`);
        throw new Error(
          `Couldn't remove worktree directory at ${info.path}: ${(err as Error).message}. ` +
          'A file lock from VS Code or another process likely owns a path inside. ' +
          'Close any open editors on the worktree and try again, or remove it manually.',
        );
      }
    }
  }

  /** Enumerate the agent's changes against the worktree's HEAD without
   *  applying them. Used by the per-file review flow to populate the
   *  pick list. Each entry has a status (modified/added/deleted) and
   *  a workspace-relative path.
   *
   *  Returns a ListChangesResult, never a bare array: a `git status` that
   *  failed must not be indistinguishable from a clean worktree. See the
   *  type's doc comment for what that indistinguishability cost. */
  static async listChanges(info: WorktreeInfo): Promise<ListChangesResult> {
    let porcelain: string;
    try {
      const { stdout } = await execFileP(
        'git',
        ['-C', info.path, 'status', '--porcelain', '-z', '-uall'],
        { timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      porcelain = stdout;
    } catch (err) {
      return {
        ok: false,
        error: `Couldn't read worktree status at ${info.path}: ${(err as Error).message}`,
      };
    }
    const entries = parsePorcelainZ(porcelain);
    // Map "added" (with kind=='added') to 'added' status. parsePorcelainZ
    // already merges modified/added into a single 'modified'/'added' bucket.
    return {
      ok: true,
      changes: entries.map((e) => ({
        status: e.kind === 'deleted' ? 'deleted' : e.kind === 'added' ? 'added' : 'modified',
        path: e.path.replace(/\\/g, '/'),
      } satisfies WorktreeChange)),
    };
  }

  /** Copy a single file from the worktree to the user's workspace.
   *  When `change.status === 'deleted'`, the workspace file is removed
   *  too — accepting a deletion means accepting the agent's intent to
   *  delete that file. Returns whether the operation succeeded; errors
   *  surface as a thrown Error so the caller can show a toast. */
  static async acceptFile(info: WorktreeInfo, change: WorktreeChange): Promise<void> {
    const srcAbs = path.join(info.path, change.path);
    const dstAbs = path.join(info.workspaceRoot, change.path);
    if (change.status === 'deleted') {
      await fs.promises.rm(dstAbs, { force: true });
      return;
    }
    await fs.promises.mkdir(path.dirname(dstAbs), { recursive: true });
    await fs.promises.copyFile(srcAbs, dstAbs);
  }

  /** Revert a single file in the worktree to its HEAD state. Use this
   *  when the user reviewed an agent edit and wants to discard JUST
   *  that file's changes without losing the rest of the worktree.
   *
   *  Modified file → `git checkout HEAD -- <path>` puts the worktree's
   *  copy back to its baseline.
   *  Added (untracked) file → just rm it from the worktree.
   *  Deleted file → `git checkout HEAD -- <path>` re-creates it from
   *  the worktree's HEAD (the agent's deletion is reverted). */
  static async rejectFile(info: WorktreeInfo, change: WorktreeChange): Promise<void> {
    const wtFile = path.join(info.path, change.path);
    if (change.status === 'added') {
      // Untracked → no HEAD version exists. rm is the inverse op.
      // `recursive` is defence-in-depth: with `-uall` on the status call
      // every entry is a file, but a plain rm on a directory throws, and
      // that is precisely the failure the `-uall` fix removed. If a
      // caller ever loses the flag, this degrades to doing the right
      // thing rather than to a toast. Safe on files too.
      await fs.promises.rm(wtFile, { force: true, recursive: true });
      return;
    }
    // For modified + deleted, `git checkout HEAD -- <path>` works in
    // both git-worktree and cp-fallback modes (cp-fallback's local
    // .git has the initial commit as HEAD).
    await execFileP(
      'git',
      ['-C', info.path, 'checkout', 'HEAD', '--', change.path],
      { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
  }

  /** Quick "is the workspace dirty?" check used to warn before apply
   *  potentially overwrites the user's own in-flight edits. Returns
   *  the count of dirty files (or null if not a git repo / git failed). */
  static async workspaceDirtyCount(workspaceRoot: string): Promise<number | null> {
    if (!await WorktreeManager.isGitRepo(workspaceRoot)) return null;
    try {
      const { stdout } = await execFileP(
        'git', ['-C', workspaceRoot, 'status', '--porcelain', '-uall'],
        { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return stdout.split('\n').filter((l) => l.trim().length > 0).length;
    } catch {
      return null;
    }
  }

  /** Set of dirty workspace paths (workspace-relative, forward-slashed)
   *  for conflict detection on apply.
   *
   *  The old contract said callers should treat "can't determine" as
   *  "don't gate on it", and the apply guard did exactly that — which
   *  made an unmeasurable workspace look identical to a clean one and let
   *  the apply overwrite the user's uncommitted edits without a word.
   *  The contract is now inverted: a caller CANNOT accidentally read a
   *  failure as "clean", because a failure has no `paths` to read. */
  static async workspaceDirtyPaths(workspaceRoot: string): Promise<DirtyPathsResult> {
    if (!await WorktreeManager.isGitRepo(workspaceRoot)) {
      return {
        ok: false,
        reason: 'not-a-git-repo',
        error: `${workspaceRoot} is not a git repo, so its uncommitted changes can't be enumerated.`,
      };
    }
    try {
      const { stdout } = await execFileP(
        'git', ['-C', workspaceRoot, 'status', '--porcelain', '-z', '-uall'],
        { timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
      const set = new Set<string>();
      for (const entry of parsePorcelainZ(stdout)) {
        set.add(entry.path.replace(/\\/g, '/'));
      }
      return { ok: true, paths: set };
    } catch (err) {
      return {
        ok: false,
        reason: 'git-failed',
        error: `\`git status\` failed in ${workspaceRoot}: ${(err as Error).message}`,
      };
    }
  }
}

interface PorcelainEntry {
  kind: 'modified' | 'added' | 'deleted';
  path: string;
}

/** Parse `git status --porcelain -z` output. The `-z` form uses NUL
 *  separators between records and doesn't quote special chars. Format
 *  per record: 2-char status code + space + path. Renames emit a
 *  second NUL-terminated record carrying the old path which we treat
 *  as a deletion (the new path arrives as a separate add).
 *
 *  ⛔ EVERY CALLER MUST PASS `-uall`. Git's default is `-unormal`, which
 *  collapses an untracked directory to ONE entry ending in `/` — and it
 *  collapses to the TOPMOST new directory, so an agent adding
 *  `src/NewThing/{Foo,Bar}.cs` to a repo with no `src/` yields the single
 *  record `?? src/`. Every consumer here assumes a record is a FILE:
 *  `apply` copyFile()s it (throws EPERM on Windows / EISDIR on POSIX,
 *  which it swallows into `warnings` while filesChanged stays 0 — the
 *  user is told fewer files changed and their new code is silently
 *  absent), `listChanges` offers it as an undiffable row, `acceptFile`
 *  throws, and `workspaceDirtyPaths` returns a `dir/` string that can
 *  never match a per-file path, so conflict detection goes blind.
 *  Measured and regression-tested 2026-08-26. This parser cannot detect
 *  the situation reliably from the outside — a path ending in `/` is the
 *  only hint — so the invariant lives with the callers. */
function parsePorcelainZ(text: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  if (!text) return out;
  // Records are NUL-separated. Trailing NUL produces an empty last
  // entry — drop it.
  const records = text.split('\0').filter((r) => r.length > 0);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 3) continue;
    const code = rec.slice(0, 2);
    const p = rec.slice(3); // skip status + space
    // Rename / copy: 'R ' or 'C ' — followed by a NUL-separated `old`
    // record we need to consume. Produce a deletion for the old path
    // and a modification for the new path.
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = records[i + 1];
      if (oldPath) {
        out.push({ kind: 'deleted', path: oldPath });
        i++; // consumed
      }
      out.push({ kind: 'added', path: p });
      continue;
    }
    // Untracked: '??'
    if (code === '??') { out.push({ kind: 'added', path: p }); continue; }
    // Working-tree state wins for the on-disk decision: if the
    // working tree shows D, the file is gone regardless of the
    // index. Code[0] is index status, code[1] is working-tree status.
    // Cases like `MD` (modified in index, deleted in working tree)
    // used to fall through to "modified" and then `apply` would
    // copyFile from a non-existent source.
    if (code[1] === 'D' || code === 'DD' || code === 'D ') {
      out.push({ kind: 'deleted', path: p });
      continue;
    }
    out.push({ kind: 'modified', path: p });
  }
  return out;
}

