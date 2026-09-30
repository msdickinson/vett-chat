import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointStore } from '../src/worktree/checkpointStore';

describe('CheckpointStore', () => {
  let tmp: string;
  let workTree: string;
  let homeDir: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-cp-test-'));
    homeDir = path.join(tmp, 'home');
    workTree = path.join(tmp, 'wt');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(workTree, { recursive: true });
    fs.writeFileSync(path.join(workTree, 'a.txt'), 'one\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('init creates a shadow .git outside the worktree', async () => {
    const store = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store.init();
    const expected = path.join(homeDir, '.vett', 'checkpoints', 'wshash-panel-1', '.git');
    expect(fs.existsSync(expected)).toBe(true);
    // CRUCIALLY: the worktree itself stays clean — no .git was added there.
    expect(fs.existsSync(path.join(workTree, '.git'))).toBe(false);
  });

  it('snapshot commits a turn and assigns sequential turn numbers', async () => {
    const store = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store.init();
    // Diverge from session-start before each snapshot — snapshot is
    // intentionally a no-op when nothing changed since HEAD.
    fs.writeFileSync(path.join(workTree, 'a.txt'), 'turn-1-state\n');
    const t1 = await store.snapshot('first ask');
    expect(t1).not.toBeNull();
    expect(t1!.turn).toBe(1);
    expect(t1!.message).toContain('Turn 1: first ask');

    fs.writeFileSync(path.join(workTree, 'b.txt'), 'two\n');
    const t2 = await store.snapshot('second ask');
    expect(t2!.turn).toBe(2);
  });

  it('snapshot is a no-op when nothing changed since the previous one', async () => {
    const store = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store.init();
    fs.writeFileSync(path.join(workTree, 'a.txt'), 'changed\n');
    const t1 = await store.snapshot('first');
    expect(t1).not.toBeNull();
    // Nothing changed between first and second — second must no-op.
    const t2 = await store.snapshot('still nothing changed');
    expect(t2).toBeNull();
    // Turn counter must not advance for a no-op snapshot.
    fs.writeFileSync(path.join(workTree, 'c.txt'), 'three\n');
    const t3 = await store.snapshot('real change');
    expect(t3!.turn).toBe(2);
  });

  it('list returns most-recent-first', async () => {
    const store = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store.init();
    fs.writeFileSync(path.join(workTree, 'a.txt'), 'first\n');
    await store.snapshot('first');
    fs.writeFileSync(path.join(workTree, 'b.txt'), 'b\n');
    await store.snapshot('second');
    fs.writeFileSync(path.join(workTree, 'c.txt'), 'c\n');
    await store.snapshot('third');

    const entries = await store.list();
    // session-start commit + 3 turn commits = 4 total, most recent first
    expect(entries.length).toBe(4);
    expect(entries[0].turn).toBe(3);
    expect(entries[1].turn).toBe(2);
    expect(entries[2].turn).toBe(1);
    // session-start has turn=0 (no "Turn N:" prefix in the subject).
    expect(entries[3].turn).toBe(0);
  });

  it('restoreFiles rolls the worktree back to an earlier turn', async () => {
    const store = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store.init();

    fs.writeFileSync(path.join(workTree, 'a.txt'), 'turn-1\n');
    const t1 = await store.snapshot('first ask');
    expect(t1).not.toBeNull();

    fs.writeFileSync(path.join(workTree, 'a.txt'), 'turn-2\n');
    await store.snapshot('second ask');

    expect(fs.readFileSync(path.join(workTree, 'a.txt'), 'utf8')).toBe('turn-2\n');

    await store.restoreFiles(t1!.sha);

    expect(fs.readFileSync(path.join(workTree, 'a.txt'), 'utf8')).toBe('turn-1\n');
  });

  it('init is idempotent and reads next turn from existing log on resume', async () => {
    const store1 = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store1.init();
    fs.writeFileSync(path.join(workTree, 'a.txt'), 'first\n');
    await store1.snapshot('first');
    fs.writeFileSync(path.join(workTree, 'b.txt'), 'b\n');
    await store1.snapshot('second');

    // Brand-new instance pointed at the same shadow-git → should
    // pick up next-turn = 3, not start at 1.
    const store2 = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store2.init();
    fs.writeFileSync(path.join(workTree, 'c.txt'), 'c\n');
    const t = await store2.snapshot('third');
    expect(t!.turn).toBe(3);
  });

  it('dispose removes the shadow-git directory', async () => {
    const store = new CheckpointStore(workTree, 'wshash', 'panel-1', homeDir);
    await store.init();
    fs.writeFileSync(path.join(workTree, 'a.txt'), 'changed\n');
    await store.snapshot('first');
    const root = path.join(homeDir, '.vett', 'checkpoints', 'wshash-panel-1');
    expect(fs.existsSync(root)).toBe(true);
    await store.dispose();
    expect(fs.existsSync(root)).toBe(false);
  });
});
