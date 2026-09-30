import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { WorktreeManager, WorktreeNotSupportedError } from '../src/worktree/worktreeManager';

const execFileP = promisify(execFile);

/**
 * These tests shell out to real `git`. They're fast (a worktree add on
 * a tiny repo is sub-second) and deterministic, but they require git
 * on PATH — which is the same requirement vett-chat itself imposes.
 */
describe('WorktreeManager', () => {
  let tmp: string;
  let homeDir: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-wt-test-'));
    homeDir = path.join(tmp, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('workspaceHash', () => {
    it('is deterministic', () => {
      const a = WorktreeManager.workspaceHash('/some/path');
      const b = WorktreeManager.workspaceHash('/some/path');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{8}$/);
    });

    it('case-folds for Windows path stability', () => {
      const a = WorktreeManager.workspaceHash('C:\\Users\\Dev\\proj');
      const b = WorktreeManager.workspaceHash('c:\\users\\dev\\proj');
      expect(a).toBe(b);
    });
  });

  describe('worktreePath', () => {
    it('places worktrees under ~/.vett/worktrees/<hash>-<panel>/', () => {
      const p = WorktreeManager.worktreePath('/ws', 'panel-abc', homeDir);
      expect(p.startsWith(path.join(homeDir, '.vett', 'worktrees'))).toBe(true);
      expect(p.endsWith('-panel-abc')).toBe(true);
    });

    // The id the extension generates — chat-<ISO ts, separators stripped>-<base36>.
    // The guard below must not reject the real thing.
    it('accepts a generated panel id', () => {
      const real = 'chat-2026-08-26T08-14-50-123Z-k3f9qz';
      expect(() => WorktreeManager.worktreePath('/ws', real, homeDir)).not.toThrow();
      expect(() => WorktreeManager.branchName(real)).not.toThrow();
    });

    /**
     * A panel id reaches `fs.rm(recursive, force)` and `git branch -D` via
     * discard(). On resume the id is NOT generated — it is read from the
     * webview state VS Code persisted, which nothing validates. `path.join`
     * resolves `..`, so a traversing id escapes ~/.vett/worktrees entirely.
     *
     * The assertion is on containment, not on the throw alone: a guard that
     * threw for everything would satisfy `toThrow()` while breaking the
     * accepted-id test above, and this pins the actual property that matters.
     */
    it.each([
      ['..', 'bare parent'],
      ['../../../../Documents', 'traversal out of the worktrees dir'],
      ['a/../../b', 'traversal in the middle'],
      ['-D', 'reaches git as a flag, not a branch name'],
      ['a b', 'whitespace'],
      ['', 'empty'],
    ])('refuses panel id %j (%s)', (bad) => {
      expect(() => WorktreeManager.worktreePath('/ws', bad, homeDir)).toThrow(/Refusing/);
      expect(() => WorktreeManager.branchName(bad)).toThrow(/Refusing/);
    });

    it('a traversing id would otherwise have escaped the worktrees root', () => {
      // Demonstrates WHY the guard exists rather than asserting the guard
      // twice: this is what path.join does with the input, unguarded.
      const escaped = path.join(homeDir, '.vett', 'worktrees', 'deadbeef-../../../../Documents');
      expect(escaped.startsWith(path.join(homeDir, '.vett', 'worktrees'))).toBe(false);
    });
  });

  describe('ensure / git mode', () => {
    it('creates a git worktree on a real git repo', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      expect(info.mode).toBe('git-worktree');
      expect(info.path).toBe(WorktreeManager.worktreePath(ws, 'panel-1', homeDir));
      expect(info.branch).toBe('vett/wt-panel-1');
      // The worktree must exist on disk and contain the source file.
      expect(fs.existsSync(path.join(info.path, 'README.md'))).toBe(true);
      // .git inside the worktree must be a FILE pointer (not a dir),
      // confirming `git worktree add` ran rather than a copy.
      const gitMarker = fs.statSync(path.join(info.path, '.git'));
      expect(gitMarker.isFile()).toBe(true);
    });

    it('reuses an existing worktree on resume (same panel id)', async () => {
      const ws = await initRepo(tmp);
      const a = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      const b = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      expect(b.path).toBe(a.path);
      expect(b.mode).toBe('git-worktree');
    });

    it('different panel ids get different worktrees', async () => {
      const ws = await initRepo(tmp);
      const a = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      const b = await WorktreeManager.ensure(ws, 'panel-2', homeDir);
      expect(a.path).not.toBe(b.path);
      expect(a.branch).not.toBe(b.branch);
    });
  });

  describe('ensure / non-git workspaces', () => {
    it('throws WorktreeNotSupportedError when the workspace has no .git', async () => {
      // The cp-fallback path was removed: it bricked monorepos by
      // recursively copying 10s of GB. Worktree mode now refuses
      // cleanly so the caller (ChatPanelProvider) can flip the panel
      // to direct mode + surface a clear toast instead of hanging.
      const ws = path.join(tmp, 'nogit');
      fs.mkdirSync(ws);
      fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');

      await expect(WorktreeManager.ensure(ws, 'panel-1', homeDir))
        .rejects.toThrow(WorktreeNotSupportedError);
      // Nothing was created on disk.
      expect(fs.existsSync(WorktreeManager.worktreePath(ws, 'panel-1', homeDir))).toBe(false);
    });
  });

  describe('apply', () => {
    it('copies modified files from worktree back to workspace', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);

      // Simulate the agent editing in the worktree.
      fs.writeFileSync(path.join(info.path, 'README.md'), '# Agent edited');
      fs.writeFileSync(path.join(info.path, 'NEW.md'), 'brand new');

      const result = await WorktreeManager.apply(info);
      expect(result.filesChanged).toBe(2);
      expect(result.filesDeleted).toBe(0);
      // Files should now be in the user's workspace.
      expect(fs.readFileSync(path.join(ws, 'README.md'), 'utf8')).toBe('# Agent edited');
      expect(fs.readFileSync(path.join(ws, 'NEW.md'), 'utf8')).toBe('brand new');
    });

    it('deletes workspace files when the agent deleted them in the worktree', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);

      fs.unlinkSync(path.join(info.path, 'README.md'));
      const result = await WorktreeManager.apply(info);
      expect(result.filesDeleted).toBe(1);
      expect(fs.existsSync(path.join(ws, 'README.md'))).toBe(false);
    });

    // Regression, 2026-08-26. `git status --porcelain` defaults to
    // `-unormal`, which COLLAPSES an untracked directory to a single
    // `dir/` entry instead of listing the files inside it. Every
    // pre-existing addition test added its file at the repo ROOT, where
    // the entry is a plain file and nothing goes wrong — so the whole
    // suite was green while "agent writes a new class in a new folder",
    // one of the most common things an agent does, silently did not
    // apply: copyFile on a directory throws (EPERM on Windows, EISDIR on
    // POSIX), `apply` catches it into `warnings`, and filesChanged never
    // counts it. The user sees a smaller number and their new files are
    // simply absent. Fix is `-uall` on the status invocations.
    it('copies files the agent created inside a NEW directory', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);

      fs.mkdirSync(path.join(info.path, 'src', 'NewThing'), { recursive: true });
      fs.writeFileSync(path.join(info.path, 'src', 'NewThing', 'Foo.cs'), 'class Foo {}');
      fs.writeFileSync(path.join(info.path, 'src', 'NewThing', 'Bar.cs'), 'class Bar {}');

      const result = await WorktreeManager.apply(info);

      expect(result.warnings).toEqual([]);
      expect(result.filesChanged).toBe(2);
      expect(fs.readFileSync(path.join(ws, 'src', 'NewThing', 'Foo.cs'), 'utf8')).toBe('class Foo {}');
      expect(fs.readFileSync(path.join(ws, 'src', 'NewThing', 'Bar.cs'), 'utf8')).toBe('class Bar {}');
    });
  });

  describe('discard', () => {
    it('removes the worktree directory and the branch', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      expect(fs.existsSync(info.path)).toBe(true);

      await WorktreeManager.discard(info);

      expect(fs.existsSync(info.path)).toBe(false);
      // Branch is gone — `git branch --list` returns nothing.
      const { stdout } = await execFileP('git', ['-C', ws, 'branch', '--list', 'vett/wt-panel-1'], {
        windowsHide: true, timeout: 5_000,
      });
      expect(stdout.trim()).toBe('');
    });
  });

  describe('listChanges / acceptFile / rejectFile (per-file flow)', () => {
    it('listChanges enumerates modifications, additions, and deletions', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);

      // Simulate three kinds of agent edit.
      fs.writeFileSync(path.join(info.path, 'README.md'), '# Modified');
      fs.writeFileSync(path.join(info.path, 'NEW.md'), 'added');
      // Add a second file to delete
      await execFileP('git', ['-C', ws, 'commit', '--allow-empty', '-m', 'noop'], { windowsHide: true, timeout: 5_000 });
      fs.writeFileSync(path.join(ws, 'TO_DELETE.md'), 'doomed\n');
      await execFileP('git', ['-C', ws, 'add', '-A'], { windowsHide: true, timeout: 5_000 });
      await execFileP('git', ['-C', ws, 'commit', '-m', 'add doomed'], { windowsHide: true, timeout: 5_000 });
      // Recreate worktree so it sees the latest HEAD.
      await WorktreeManager.discard(info);
      const info2 = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      // Now agent edits + adds + deletes
      fs.writeFileSync(path.join(info2.path, 'README.md'), '# Modified by agent\n');
      fs.writeFileSync(path.join(info2.path, 'NEW.md'), 'added');
      fs.unlinkSync(path.join(info2.path, 'TO_DELETE.md'));

      const listed = await WorktreeManager.listChanges(info2);
      if (!listed.ok) throw new Error(listed.error);
      const byPath = Object.fromEntries(listed.changes.map((c) => [c.path, c.status]));
      expect(byPath['README.md']).toBe('modified');
      expect(byPath['NEW.md']).toBe('added');
      expect(byPath['TO_DELETE.md']).toBe('deleted');
    });

    /**
     * The highest-impact failure this module had: a failed `git status`
     * came back as `[]`, and every consumer renders `[]` as "no changes
     * to review — worktree matches its baseline". A user told that, with
     * real agent work sitting in the worktree, has every reason to hit
     * Discard.
     *
     * The falsifier has to be a git call that genuinely fails while the
     * WorktreeInfo still looks well-formed, so `info.path` points at a
     * directory that does not exist — `git -C` exits non-zero on it.
     * The assertion is two-sided on purpose: `ok` false is the point, but
     * `'changes' in result` must ALSO be false, because the whole defect
     * was an empty change list being reachable on the failure path.
     */
    it('listChanges reports failure instead of an empty list when git fails', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      const broken = { ...info, path: path.join(tmp, 'no-such-worktree-dir') };

      const listed = await WorktreeManager.listChanges(broken);

      expect(listed.ok).toBe(false);
      expect('changes' in listed).toBe(false);
      if (!listed.ok) expect(listed.error).toContain(broken.path);
    });

    /**
     * Same fail-closed rule on the apply-guard side: `workspaceDirtyPaths`
     * used to return `null` both for "not a git repo" and for "git
     * failed", and the apply guard read either as "workspace is clean"
     * and overwrote the user's uncommitted edits. A caller must be able
     * to tell WHICH it hit, and must not be able to read either as a
     * clean workspace.
     */
    it('workspaceDirtyPaths distinguishes not-a-repo from git failure', async () => {
      const notARepo = path.join(tmp, 'plain-dir');
      fs.mkdirSync(notARepo, { recursive: true });

      const result = await WorktreeManager.workspaceDirtyPaths(notARepo);

      expect(result.ok).toBe(false);
      expect('paths' in result).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not-a-git-repo');
    });

    // Same `-unormal` collapse as the apply regression above, seen from
    // the per-file review UI: the pick list showed one undiffable row
    // `src/NewThing/` instead of the two files, accepting it threw, and
    // rejecting it called `fs.rm` without `recursive` on a non-empty
    // directory.
    it('listChanges enumerates files inside a new directory, not the directory', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);

      fs.mkdirSync(path.join(info.path, 'src', 'NewThing'), { recursive: true });
      fs.writeFileSync(path.join(info.path, 'src', 'NewThing', 'Foo.cs'), 'class Foo {}');

      const listed = await WorktreeManager.listChanges(info);
      if (!listed.ok) throw new Error(listed.error);
      const paths = listed.changes.map((c) => c.path);
      expect(paths).toContain('src/NewThing/Foo.cs');
      expect(paths).not.toContain('src/NewThing/');

      // And the accept/reject pair must both work on that entry.
      const change = listed.changes.find((c) => c.path === 'src/NewThing/Foo.cs')!;
      await WorktreeManager.acceptFile(info, change);
      expect(fs.readFileSync(path.join(ws, 'src', 'NewThing', 'Foo.cs'), 'utf8')).toBe('class Foo {}');
      await WorktreeManager.rejectFile(info, change);
      expect(fs.existsSync(path.join(info.path, 'src', 'NewThing', 'Foo.cs'))).toBe(false);
    });

    it('acceptFile copies one modification through without affecting others', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);

      fs.writeFileSync(path.join(info.path, 'README.md'), '# Edited');
      fs.writeFileSync(path.join(info.path, 'OTHER.md'), 'other agent change');

      await WorktreeManager.acceptFile(info, { status: 'modified', path: 'README.md' });
      // README accepted → workspace updated.
      expect(fs.readFileSync(path.join(ws, 'README.md'), 'utf8')).toBe('# Edited');
      // OTHER stayed in worktree only — workspace unaffected.
      expect(fs.existsSync(path.join(ws, 'OTHER.md'))).toBe(false);
    });

    it('acceptFile of a deletion removes the workspace file', async () => {
      const ws = await initRepo(tmp);
      // Add a second tracked file we can delete.
      fs.writeFileSync(path.join(ws, 'TARGET.md'), 'doomed\n');
      await execFileP('git', ['-C', ws, 'add', '-A'], { windowsHide: true, timeout: 5_000 });
      await execFileP('git', ['-C', ws, 'commit', '-m', 'add target'], { windowsHide: true, timeout: 5_000 });
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);

      fs.unlinkSync(path.join(info.path, 'TARGET.md'));
      await WorktreeManager.acceptFile(info, { status: 'deleted', path: 'TARGET.md' });

      expect(fs.existsSync(path.join(ws, 'TARGET.md'))).toBe(false);
    });

    it('rejectFile reverts a modified worktree file to its baseline', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      const wtFile = path.join(info.path, 'README.md');
      const original = fs.readFileSync(wtFile, 'utf8');
      fs.writeFileSync(wtFile, '# Hijacked');

      await WorktreeManager.rejectFile(info, { status: 'modified', path: 'README.md' });

      expect(fs.readFileSync(wtFile, 'utf8')).toBe(original);
      // Workspace untouched throughout.
      expect(fs.readFileSync(path.join(ws, 'README.md'), 'utf8')).toBe(original);
    });

    it('rejectFile of an added (untracked) file removes it from the worktree', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      fs.writeFileSync(path.join(info.path, 'NEW.md'), 'agent created');

      await WorktreeManager.rejectFile(info, { status: 'added', path: 'NEW.md' });

      expect(fs.existsSync(path.join(info.path, 'NEW.md'))).toBe(false);
      // Untracked rejection didn't reach the user's workspace either.
      expect(fs.existsSync(path.join(ws, 'NEW.md'))).toBe(false);
    });

    it('rejectFile of a deletion restores the file in the worktree', async () => {
      const ws = await initRepo(tmp);
      const info = await WorktreeManager.ensure(ws, 'panel-1', homeDir);
      const original = fs.readFileSync(path.join(info.path, 'README.md'), 'utf8');
      fs.unlinkSync(path.join(info.path, 'README.md'));

      await WorktreeManager.rejectFile(info, { status: 'deleted', path: 'README.md' });

      expect(fs.existsSync(path.join(info.path, 'README.md'))).toBe(true);
      expect(fs.readFileSync(path.join(info.path, 'README.md'), 'utf8')).toBe(original);
    });
  });
});

/** Stand up a fresh git repo with one committed file, return its
 *  path. Used as the workspace root for tests above. */
async function initRepo(parent: string): Promise<string> {
  const ws = path.join(parent, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'README.md'), '# initial');
  await execFileP('git', ['-C', ws, 'init', '--initial-branch=main'], { windowsHide: true, timeout: 10_000 });
  await execFileP('git', ['-C', ws, 'config', 'user.email', 'test@localhost'], { windowsHide: true, timeout: 5_000 });
  await execFileP('git', ['-C', ws, 'config', 'user.name', 'test'], { windowsHide: true, timeout: 5_000 });
  await execFileP('git', ['-C', ws, 'add', '-A'], { windowsHide: true, timeout: 10_000 });
  await execFileP('git', ['-C', ws, 'commit', '-m', 'initial'], { windowsHide: true, timeout: 10_000 });
  return ws;
}
