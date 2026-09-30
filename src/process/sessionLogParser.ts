import * as fs from 'fs';
import { ChatMessage, VettEvent } from '../shared/types';

/**
 * Walk a chat session JSONL log (the format the SessionLogger writes —
 * `{seq, ts, type, instance_id, data}` envelopes) and return the
 * user / assistant message pairs in chronological order.
 *
 * Used by the resume path: when a panel is opened with a resumePath,
 * the host reads the JSONL and posts the result as a `seedHistory`
 * message so the chat UI shows what was said before. Vett's
 * `--resume <path>` separately seeds the agent's conversation context;
 * this is the visual side of the same data.
 *
 * Best-effort — malformed lines are skipped, never throws.
 */
export function parseSessionMessages(path: string): ChatMessage[] {
  if (!fs.existsSync(path)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const rows: { seq: number; msg: ChatMessage }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    const type = env.type;
    if (type !== 'user_message' && type !== 'assistant_text') continue;
    const text = extractText(env);
    if (!text) continue;
    const ts = typeof env.ts === 'string' ? env.ts : new Date().toISOString();
    const seq = typeof env.seq === 'number' ? env.seq : Number.MAX_SAFE_INTEGER;
    rows.push({
      seq,
      msg: {
        role: type === 'user_message' ? 'user' : 'assistant',
        text,
        timestamp: ts,
      },
    });
  }
  // Stable order — `seq` is the canonical ordering, but file-write
  // order is also expected to match so this is a no-op in practice.
  rows.sort((a, b) => a.seq - b.seq);
  return rows.map((r) => r.msg);
}

/**
 * Walk the same JSONL log and return every envelope mapped to the
 * VettEvent shape the webview already understands. Used to seed the
 * Raw / Logs / Gantt views and the inline dispatch cards on resume —
 * `parseSessionMessages` only covers the visible chat bubbles.
 *
 * Best-effort: malformed lines and event-less envelopes are skipped.
 */
export function parseSessionEnvelopes(path: string): VettEvent[] {
  if (!fs.existsSync(path)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const events: { seq: number; ev: VettEvent }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    const type = typeof env.type === 'string' ? env.type : '';
    if (!type) continue;
    const seq = typeof env.seq === 'number' ? env.seq : Number.MAX_SAFE_INTEGER;
    const timestamp = typeof env.ts === 'string' ? env.ts : undefined;

    // The session logger wraps the original VettEvent verbatim under
    // `data`, so a logged envelope looks like:
    //   { seq, ts, type, instance_id, data: { type, data: {...}, text? } }
    // That means the event's real data is at env.data.data and its text
    // at env.data.text — not env.data and env.text. Without unwrapping,
    // the resumed webview saw events with bogus payloads (tool calls
    // with no name, dispatches with no member, messages with no text).
    let inner: Record<string, unknown> | undefined;
    if (env.data && typeof env.data === 'object') {
      inner = env.data as Record<string, unknown>;
    }
    const realData = inner?.data && typeof inner.data === 'object'
      ? (inner.data as Record<string, unknown>)
      : inner;
    const realText = typeof inner?.text === 'string'
      ? inner.text
      : (typeof env.text === 'string' ? env.text : undefined);

    events.push({ seq, ev: { type, timestamp, data: realData, text: realText } });
  }
  events.sort((a, b) => a.seq - b.seq);
  return events.map((r) => r.ev);
}

/**
 * Read just enough of a JSONL session log to grab the first user message
 * for the resume picker's detail line. Returns "" when the file is
 * missing, unreadable, malformed, or contains no `user_message` envelope.
 *
 * Hardened: never throws — the picker must stay alive even when one log
 * file is corrupt. Each line is JSON-parsed independently so a single
 * bad line doesn't poison the rest of the scan.
 *
 * Result is sliced to 120 chars so the picker `detail` row stays compact.
 */
export function peekFirstUserMessage(filePath: string): string {
  let data: string;
  try {
    data = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    if (env.type === 'user_message') {
      const text = extractText(env);
      if (text) return text.slice(0, 120);
    }
  }
  return '';
}

function extractText(env: Record<string, unknown>): string {
  // Two layouts seen in our logs:
  //   1. { type: 'user_message', text: '...' }              (vett-direct)
  //   2. { type: 'user_message', data: { text: '...' } }    (extension-wrapped)
  // Try both.
  if (typeof env.text === 'string' && env.text.length > 0) return env.text;
  if (env.data && typeof env.data === 'object') {
    const d = env.data as Record<string, unknown>;
    if (typeof d.text === 'string' && d.text.length > 0) return d.text;
  }
  return '';
}
