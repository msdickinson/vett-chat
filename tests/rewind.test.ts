import { describe, it, expect } from 'vitest';
import {
  filterBeforeTimestamp,
  findNthUserMessageIndex,
  rewindMessagesToIndex,
  rewindMessagesToTurn,
} from '../webview/utils/rewind';
import type { ChatMessage } from '../src/shared/types';

/**
 * Pure-helper coverage for the conversation-rewind module. Powers
 * both the /restore checkpoint mode picker and the inline "↶" button
 * on user messages. The helpers are vscode-import-free so vitest can
 * pin the slice contract without spinning up Preact + the webview's
 * full state graph.
 */

function userMsg(text: string, ts: string): ChatMessage {
  return { role: 'user', text, timestamp: ts };
}
function assistantMsg(text: string, ts: string): ChatMessage {
  return { role: 'assistant', text, timestamp: ts };
}

describe('rewind helpers', () => {
  describe('findNthUserMessageIndex', () => {
    const messages: ChatMessage[] = [
      userMsg('first', '2026-05-05T10:00:00Z'),
      assistantMsg('reply 1', '2026-05-05T10:00:30Z'),
      userMsg('second', '2026-05-05T10:01:00Z'),
      assistantMsg('reply 2', '2026-05-05T10:01:30Z'),
      userMsg('third', '2026-05-05T10:02:00Z'),
    ];

    it('finds the 1st user message at index 0', () => {
      expect(findNthUserMessageIndex(messages, 1)).toBe(0);
    });

    it('finds the 2nd user message at index 2 (skips the assistant in between)', () => {
      expect(findNthUserMessageIndex(messages, 2)).toBe(2);
    });

    it('finds the 3rd user message at index 4', () => {
      expect(findNthUserMessageIndex(messages, 3)).toBe(4);
    });

    it('returns -1 when the requested turn doesn\'t exist', () => {
      expect(findNthUserMessageIndex(messages, 4)).toBe(-1);
      expect(findNthUserMessageIndex(messages, 99)).toBe(-1);
    });

    it('returns -1 for non-positive turn numbers', () => {
      expect(findNthUserMessageIndex(messages, 0)).toBe(-1);
      expect(findNthUserMessageIndex(messages, -1)).toBe(-1);
    });

    it('returns -1 on an empty list', () => {
      expect(findNthUserMessageIndex([], 1)).toBe(-1);
    });
  });

  describe('rewindMessagesToTurn', () => {
    const messages: ChatMessage[] = [
      userMsg('first', '2026-05-05T10:00:00Z'),
      assistantMsg('reply 1', '2026-05-05T10:00:30Z'),
      userMsg('second', '2026-05-05T10:01:00Z'),
      assistantMsg('reply 2', '2026-05-05T10:01:30Z'),
      userMsg('third', '2026-05-05T10:02:00Z'),
    ];

    it('keeps everything before the 2nd user message — drops 3 items', () => {
      const { sliced, cutoffTs } = rewindMessagesToTurn(messages, 2);
      expect(sliced).toEqual([messages[0], messages[1]]);
      expect(cutoffTs).toBe(Date.parse('2026-05-05T10:01:00Z'));
    });

    it('rewinding to turn 1 leaves an empty array (the slice is BEFORE turn 1)', () => {
      const { sliced, cutoffTs } = rewindMessagesToTurn(messages, 1);
      expect(sliced).toEqual([]);
      expect(cutoffTs).toBe(Date.parse('2026-05-05T10:00:00Z'));
    });

    it('a missing turn leaves messages untouched and returns null cutoffTs', () => {
      const { sliced, cutoffTs } = rewindMessagesToTurn(messages, 99);
      expect(sliced).toBe(messages);
      expect(cutoffTs).toBeNull();
    });

    it('handles an empty messages list', () => {
      const { sliced, cutoffTs } = rewindMessagesToTurn([], 1);
      expect(sliced).toEqual([]);
      expect(cutoffTs).toBeNull();
    });
  });

  describe('rewindMessagesToIndex', () => {
    const messages: ChatMessage[] = [
      userMsg('a', '2026-05-05T10:00:00Z'),
      assistantMsg('b', '2026-05-05T10:00:30Z'),
      userMsg('c', '2026-05-05T10:01:00Z'),
    ];

    it('slices to the chosen index — returns items before it', () => {
      const { sliced, cutoffTs } = rewindMessagesToIndex(messages, 2);
      expect(sliced).toEqual([messages[0], messages[1]]);
      expect(cutoffTs).toBe(Date.parse('2026-05-05T10:01:00Z'));
    });

    it('out-of-range index leaves the list unchanged', () => {
      const out = rewindMessagesToIndex(messages, 99);
      expect(out.sliced).toBe(messages);
      expect(out.cutoffTs).toBeNull();
    });

    it('negative index leaves the list unchanged', () => {
      const out = rewindMessagesToIndex(messages, -1);
      expect(out.sliced).toBe(messages);
      expect(out.cutoffTs).toBeNull();
    });

    it('an unparseable timestamp at the cutoff returns cutoffTs=null but still slices', () => {
      const bad: ChatMessage[] = [
        userMsg('a', '2026-05-05T10:00:00Z'),
        userMsg('garbage', 'not-a-timestamp'),
      ];
      const out = rewindMessagesToIndex(bad, 1);
      expect(out.sliced).toEqual([bad[0]]);
      expect(out.cutoffTs).toBeNull();
    });
  });

  describe('filterBeforeTimestamp', () => {
    const items = [
      { startedAt: '2026-05-05T10:00:00Z', id: 'a' },
      { startedAt: '2026-05-05T10:00:30Z', id: 'b' },
      { startedAt: '2026-05-05T10:01:00Z', id: 'c' },
      { startedAt: '2026-05-05T10:02:00Z', id: 'd' },
    ];

    it('keeps items strictly before the cutoff', () => {
      const out = filterBeforeTimestamp(items, Date.parse('2026-05-05T10:01:00Z'));
      expect(out.map((i) => i.id)).toEqual(['a', 'b']);
    });

    it('items missing a startedAt are kept (defensive against pre-timestamp data)', () => {
      const mixed = [...items, { id: 'no-ts' } as { id: string; startedAt?: string }];
      const out = filterBeforeTimestamp(mixed, Date.parse('2026-05-05T10:01:00Z'));
      expect(out.find((i) => i.id === 'no-ts')).toBeDefined();
    });

    it('items with unparseable startedAt are kept', () => {
      const mixed = [...items, { id: 'bogus', startedAt: 'not-a-date' }];
      const out = filterBeforeTimestamp(mixed, Date.parse('2026-05-05T10:01:00Z'));
      expect(out.find((i) => i.id === 'bogus')).toBeDefined();
    });

    it('cutoff in the past returns an empty list', () => {
      const out = filterBeforeTimestamp(items, Date.parse('2026-05-05T09:00:00Z'));
      expect(out).toEqual([]);
    });

    it('cutoff in the future returns the full list', () => {
      const out = filterBeforeTimestamp(items, Date.parse('2026-05-05T20:00:00Z'));
      expect(out).toHaveLength(items.length);
    });
  });
});
