import type { ChatMessage as Msg, ToolCall as Tc, Dispatch as Disp } from '../../src/shared/types';

/**
 * Curated-view feed builder. ChatView walks three independent signal
 * arrays (messages, toolCalls, dispatches); without interleaving them
 * the UI reads as three pooled blocks instead of an actual conversation.
 *
 * Sort key: the start timestamp on each item. Items missing a parseable
 * timestamp sink to the bottom (Number.MAX_SAFE_INTEGER sentinel) so an
 * incomplete record never disrupts the live ordering of timestamped
 * neighbors. Stable on tie via fixed kind ordering — message before
 * toolCall before dispatch — matching the natural "user spoke, then
 * tools fired, then sub-agent spawned" sequence within one iteration.
 *
 * Pure module: no preact / signal / vscode imports so vitest can pin
 * the contract without a webview shim.
 */

export type FeedItem =
  | { kind: 'message'; msg: Msg; ts: number; idx: number }
  | { kind: 'toolCall'; tc: Tc; ts: number; idx: number }
  | { kind: 'dispatch'; disp: Disp; ts: number; idx: number };

export function buildFeed(msgs: Msg[], tcs: Tc[], disps: Disp[]): FeedItem[] {
  const feed: FeedItem[] = [];
  msgs.forEach((m, i) => feed.push({ kind: 'message', msg: m, ts: parseTs(m.timestamp), idx: i }));
  tcs.forEach((t, i) => feed.push({ kind: 'toolCall', tc: t, ts: parseTs(t.startedAt), idx: i }));
  disps.forEach((d, i) => feed.push({ kind: 'dispatch', disp: d, ts: parseTs(d.startedAt), idx: i }));
  feed.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const order = { message: 0, toolCall: 1, dispatch: 2 };
    return order[a.kind] - order[b.kind];
  });
  return feed;
}

/**
 * Parse an ISO timestamp into a millisecond epoch. Missing or malformed
 * input returns Number.MAX_SAFE_INTEGER so those items sort to the
 * bottom of the feed instead of the top — pinning this in
 * feed.test.ts because flipping the sentinel would silently scramble
 * the chat ordering for every session that has any item without a ts.
 */
export function parseTs(iso: string | undefined): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}
