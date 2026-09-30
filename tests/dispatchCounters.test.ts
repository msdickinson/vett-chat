import { describe, it, expect, beforeEach } from 'vitest';
import { handleVettEvent, resetChatState, dispatches } from '../webview/state/signals';
import type { VettEvent } from '../src/shared/types';

/**
 * COULD-NOT-MEASURE IS NOT MEASURED-ZERO — across the repo boundary.
 *
 * On 2026-08-28 the vett harness (`Coordinator.ContinueMember`) stopped
 * publishing `iterations: 0` on the cancel path and started publishing
 * `iterations: null` plus `counters_measured: false`, so a dispatch that
 * was killed before its agent loop could report a count is no longer
 * indistinguishable from a member that ran and genuinely did nothing.
 *
 * That fix was defeated one repo over. This UI did
 * `Number(d.iterations ?? 0)`, which laundered the harness's null straight
 * back into a 0 — recreating the exact defect in the surface a human
 * actually reads. Worse, DispatchCard falls back with
 * `dispatch.iterations ?? liveIterations`, and 0 is NOT nullish, so the
 * laundered zero also SUPPRESSED the live iteration_start count.
 *
 * These tests are the tripwire for that. They are deliberately written as
 * three cases, not one: an "unmeasured stays unknown" assertion on its own
 * would also pass if the handler simply dropped every count on the floor.
 * The zero and non-zero cases are the negative controls that prove the
 * handler still carries a REAL count through.
 */

function start(taskId: string, member = 'implementer'): VettEvent {
  return {
    type: 'dispatch_start',
    timestamp: '2026-08-28T00:00:00.000Z',
    data: { thread_id: 'main', member, task: 't', task_id: taskId },
  };
}

function end(taskId: string, data: Record<string, unknown>): VettEvent {
  return {
    type: 'dispatch_end',
    timestamp: '2026-08-28T00:00:05.000Z',
    data: { thread_id: 'main', member: 'implementer', task_id: taskId, ...data },
  };
}

function only() {
  expect(dispatches.value).toHaveLength(1);
  return dispatches.value[0];
}

describe('dispatch_end iteration counters', () => {
  beforeEach(() => {
    resetChatState();
  });

  it('an UNMEASURED count stays unknown — it is not laundered into 0', () => {
    handleVettEvent(start('task-a'));
    handleVettEvent(
      end('task-a', {
        iterations: null,
        stop_reason: 'cancelled',
        counters_measured: false,
      }),
    );

    const d = only();
    expect(d.active).toBe(false);
    expect(d.stopReason).toBe('cancelled');
    // The assertion that matters. `toBeUndefined` and not `toBeFalsy`:
    // 0 is falsy, and 0 is precisely the wrong answer here.
    expect(d.iterations).toBeUndefined();
    // And it must stay NULLISH, because DispatchCard's live-count fallback
    // is `dispatch.iterations ?? liveIterations`. A laundered 0 would pass
    // the line above only if it were undefined anyway, but this pins the
    // property the fallback actually depends on.
    expect(d.iterations ?? 'fellback').toBe('fellback');
  });

  it('a genuine ZERO is still reported as zero — the two are distinguishable', () => {
    handleVettEvent(start('task-b'));
    handleVettEvent(
      end('task-b', {
        iterations: 0,
        stop_reason: 'declared_done',
        counters_measured: true,
      }),
    );

    const d = only();
    expect(d.iterations).toBe(0);
    // The whole point of the change: these two runs no longer render alike.
    expect(d.iterations).not.toBeUndefined();
  });

  it('a real count is carried through unchanged', () => {
    handleVettEvent(start('task-c'));
    handleVettEvent(
      end('task-c', {
        iterations: 4,
        stop_reason: 'declared_done',
        counters_measured: true,
      }),
    );

    expect(only().iterations).toBe(4);
  });

  it('a MISSING iterations key is unknown too, not zero', () => {
    // Older vett builds and hand-written logs omit the key entirely.
    // `undefined == null` is true, so the same branch must catch it.
    handleVettEvent(start('task-d'));
    handleVettEvent(end('task-d', { stop_reason: 'wall_clock_timeout' }));

    expect(only().iterations).toBeUndefined();
  });
});
