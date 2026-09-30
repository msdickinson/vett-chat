import type { ChatMessage } from '../../src/shared/types';

/**
 * Pure helpers for conversation-rewind. Extracted from the signals
 * module so vitest can pin the slice contract without spinning up
 * Preact + the full webview state graph.
 *
 * The rewind model: pick a turn (1-based user-message index) or a
 * specific message index → keep everything strictly before it →
 * discard everything from that point onward, across messages,
 * tool-calls, and dispatches. Tool calls + dispatches are filtered by
 * timestamp against the cutoff so cards from removed turns don't
 * dangle in the feed.
 */

/**
 * Find the index in `messages` of the Nth user message (1-based).
 * Returns -1 if there are fewer than `userTurn` user messages.
 *
 * Used by the /restore + worktree-chip flow: a checkpoint records a
 * turn number, we map turn → message index to pick the cutoff.
 */
export function findNthUserMessageIndex(messages: ChatMessage[], userTurn: number): number {
  if (userTurn < 1) return -1;
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      count++;
      if (count === userTurn) return i;
    }
  }
  return -1;
}

/**
 * Slice the messages list to everything before the Nth user message.
 * Returns the new slice + the cutoff timestamp (parsed) so callers
 * can apply the same cutoff to tool-calls / dispatches. `cutoffTs` is
 * null when the requested turn doesn't exist (caller should leave
 * state untouched).
 *
 * `userTurn` is 1-based (the canonical "Turn 1, Turn 2, …" the
 * checkpoint store uses). `userTurn === 0` and negative values map
 * to a no-op — there's no "rewind to before turn 0," that would
 * trim the entire conversation, which is what `/new` is for.
 */
export function rewindMessagesToTurn(
  messages: ChatMessage[],
  userTurn: number,
): { sliced: ChatMessage[]; cutoffTs: number | null } {
  const idx = findNthUserMessageIndex(messages, userTurn);
  if (idx < 0) return { sliced: messages, cutoffTs: null };
  return rewindMessagesToIndex(messages, idx);
}

/**
 * Slice the messages list to everything strictly before `index`.
 * Powers the inline "↶ Restore to before this message" button — the
 * webview has the message + its index in hand, no turn-counting
 * needed. Out-of-range indices return the input unchanged.
 */
export function rewindMessagesToIndex(
  messages: ChatMessage[],
  index: number,
): { sliced: ChatMessage[]; cutoffTs: number | null } {
  if (index < 0 || index >= messages.length) {
    return { sliced: messages, cutoffTs: null };
  }
  const cutoff = Date.parse(messages[index].timestamp);
  return {
    sliced: messages.slice(0, index),
    cutoffTs: Number.isFinite(cutoff) ? cutoff : null,
  };
}

/**
 * Filter a list of timestamped items (tool calls / dispatches) to
 * those started strictly before `cutoffMs`. Items missing or with
 * unparseable `startedAt` values are KEPT — they were either created
 * before timestamps were tracked or for some other reason can't be
 * placed on the timeline; the safe default is to leave them so the
 * user doesn't lose evidence of past activity.
 */
export function filterBeforeTimestamp<T extends { startedAt?: string }>(
  items: T[],
  cutoffMs: number,
): T[] {
  return items.filter((it) => {
    if (!it.startedAt) return true;
    const t = Date.parse(it.startedAt);
    if (!Number.isFinite(t)) return true;
    return t < cutoffMs;
  });
}
