import { describe, it, expect } from 'vitest';
import { buildFeed, parseTs } from '../webview/utils/feed';
import type { ChatMessage, ToolCall, Dispatch } from '../src/shared/types';

/**
 * Pin the curated-feed contract: the Live chat view stitches three
 * independent signal arrays (messages, toolCalls, dispatches) into
 * one chronologically-sorted feed. Items missing a timestamp must
 * sink to the bottom — pin that fallback so a future rewrite that
 * accidentally treats missing as 0 (top) doesn't quietly scramble
 * every active session.
 */

function msg(ts: string | undefined, text = 'm'): ChatMessage {
  return { role: 'user', text, timestamp: ts ?? '' };
}

function tool(ts: string | undefined, callId = 'c1'): ToolCall {
  return { callId, toolName: 'bash', expanded: false, startedAt: ts };
}

function disp(ts: string | undefined, threadId = 't1'): Dispatch {
  return {
    threadId,
    // `taskTitle` and `iteration` were never fields on Dispatch — the real
    // names are `task` and `iterations`. An `as Dispatch` cast hid that, and
    // hid the three genuinely-required fields below, until tsconfig was
    // widened to typecheck tests/ on 2026-08-26.
    memberName: 'implementer',
    task: 'task',
    // Dispatch.startedAt is REQUIRED. The one production construction site
    // (webview/state/signals.ts, the dispatch_start case) fills it with
    // `event.timestamp ?? new Date().toISOString()`, so a dispatch can never
    // carry undefined — "missing timestamp" for a dispatch means the EMPTY
    // string, which parseTs maps to MAX_SAFE_INTEGER exactly as it maps
    // undefined. Same convention msg() above already uses. The sink-to-bottom
    // coverage is unchanged; it just no longer runs on an impossible object.
    startedAt: ts ?? '',
    events: [],
    active: false,
    expanded: false,
  };
}

describe('parseTs', () => {
  it('returns MAX_SAFE_INTEGER for undefined', () => {
    expect(parseTs(undefined)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns MAX_SAFE_INTEGER for empty string', () => {
    expect(parseTs('')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns MAX_SAFE_INTEGER for unparseable strings', () => {
    expect(parseTs('not-a-date')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseTs('2026-99-99T00:00:00Z')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('parses a valid ISO timestamp', () => {
    const ts = parseTs('2026-05-05T10:00:00.000Z');
    expect(ts).toBe(Date.parse('2026-05-05T10:00:00.000Z'));
    expect(Number.isFinite(ts)).toBe(true);
  });
});

describe('buildFeed timestamp ordering', () => {
  it('sorts items chronologically across all three kinds', () => {
    const m = msg('2026-05-05T10:00:02.000Z', 'm');
    const t = tool('2026-05-05T10:00:01.000Z');
    const d = disp('2026-05-05T10:00:03.000Z');

    const feed = buildFeed([m], [t], [d]);
    expect(feed.map((i) => i.kind)).toEqual(['toolCall', 'message', 'dispatch']);
  });

  it('sinks items with missing timestamps to the bottom', () => {
    // The audit pin: a tool call without startedAt must NOT bubble to
    // the top (which would happen if missing-ts mapped to 0). It sinks
    // below every timestamped neighbor.
    const tWithTs = tool('2026-05-05T10:00:01.000Z', 'tA');
    const tNoTs = tool(undefined, 'tNoTs');
    const m = msg('2026-05-05T10:00:02.000Z');

    const feed = buildFeed([m], [tWithTs, tNoTs], []);
    const lastItem = feed[feed.length - 1];
    expect(lastItem.kind).toBe('toolCall');
    expect((lastItem as { kind: 'toolCall'; tc: ToolCall }).tc.callId).toBe('tNoTs');
  });

  it('sinks malformed timestamps to the bottom too', () => {
    const tBad = tool('definitely-not-an-iso', 'tBad');
    const m = msg('2026-05-05T10:00:00.000Z');
    const feed = buildFeed([m], [tBad], []);
    expect(feed[feed.length - 1].kind).toBe('toolCall');
  });

  it('multiple items missing ts retain insertion order at the bottom', () => {
    // Tie-break on equal ts (both MAX_SAFE_INTEGER) uses the kind
    // ordering: message < toolCall < dispatch. So a msg-with-no-ts
    // appears before a tool-with-no-ts which appears before a
    // dispatch-with-no-ts, all sunk together at the end.
    const mNo = msg(undefined, 'mNo');
    const tNo = tool(undefined, 'tNo');
    const dNo = disp(undefined, 'dNo');
    const tail = buildFeed([mNo], [tNo], [dNo]);
    expect(tail.map((i) => i.kind)).toEqual(['message', 'toolCall', 'dispatch']);
  });

  it('empty inputs produce empty feed', () => {
    expect(buildFeed([], [], [])).toEqual([]);
  });

  it('preserves index from each source array', () => {
    // FeedItem.idx is used as a React key — must point back at the
    // ORIGINAL array index, not the feed index, so reordering doesn't
    // confuse the keying.
    const m0 = msg('2026-05-05T10:00:03.000Z', 'm0');
    const m1 = msg('2026-05-05T10:00:01.000Z', 'm1');
    const t0 = tool('2026-05-05T10:00:02.000Z', 't0');

    const feed = buildFeed([m0, m1], [t0], []);
    expect(feed[0]).toMatchObject({ kind: 'message', idx: 1 }); // m1 first chronologically
    expect(feed[1]).toMatchObject({ kind: 'toolCall', idx: 0 });
    expect(feed[2]).toMatchObject({ kind: 'message', idx: 0 });
  });

  it('on equal timestamps, message precedes toolCall precedes dispatch', () => {
    const sameTs = '2026-05-05T10:00:00.000Z';
    const m = msg(sameTs);
    const t = tool(sameTs);
    const d = disp(sameTs);
    // Provide them in reverse order to confirm the sort imposes the rule.
    const feed = buildFeed([m], [t], [d]);
    expect(feed.map((i) => i.kind)).toEqual(['message', 'toolCall', 'dispatch']);
  });
});
