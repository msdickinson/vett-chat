import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseSessionEnvelopes,
  parseSessionMessages,
  peekFirstUserMessage,
} from '../src/process/sessionLogParser';

/**
 * Pin the resume-path JSONL parsers. These are best-effort by contract:
 * a malformed line in any session log must NEVER throw, because the
 * resume picker reads dozens of files in a single pass and one corrupt
 * file would otherwise wipe the whole list.
 *
 * Idempotency: calling the parsers twice on the same path must produce
 * structurally-identical results. Resume can re-trigger when the user
 * picks the same chat from a sidebar + new tab in close succession.
 */

function makeLog(tmpHome: string, lines: string[]): string {
  const file = path.join(tmpHome, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('sessionLogParser', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-parser-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('peekFirstUserMessage', () => {
    it('returns empty string when file does not exist', () => {
      expect(peekFirstUserMessage(path.join(tmp, 'no-such.jsonl'))).toBe('');
    });

    it('returns empty string for an empty file', () => {
      const file = makeLog(tmp, []);
      expect(peekFirstUserMessage(file)).toBe('');
    });

    it('returns empty string when no user_message envelope present', () => {
      const file = makeLog(tmp, [
        JSON.stringify({ seq: 1, type: 'session_start' }),
        JSON.stringify({ seq: 2, type: 'assistant_text', text: 'hi from agent' }),
      ]);
      expect(peekFirstUserMessage(file)).toBe('');
    });

    it('returns the first user_message text (vett-direct shape)', () => {
      const file = makeLog(tmp, [
        JSON.stringify({ seq: 1, type: 'session_start' }),
        JSON.stringify({ seq: 2, type: 'user_message', text: 'first thing I asked' }),
        JSON.stringify({ seq: 3, type: 'user_message', text: 'second thing — should be ignored' }),
      ]);
      expect(peekFirstUserMessage(file)).toBe('first thing I asked');
    });

    it('returns the first user_message text (extension-wrapped shape)', () => {
      const file = makeLog(tmp, [
        JSON.stringify({ seq: 1, type: 'user_message', data: { text: 'wrapped form' } }),
      ]);
      expect(peekFirstUserMessage(file)).toBe('wrapped form');
    });

    it('does NOT throw on malformed JSON lines — skips and keeps scanning', () => {
      // The audit pin: a single corrupt line must not break the picker.
      // The function should walk past it and find the well-formed lines.
      const file = makeLog(tmp, [
        '{this is not json',
        'still not json',
        JSON.stringify({ seq: 7, type: 'user_message', text: 'survived corruption' }),
      ]);
      expect(() => peekFirstUserMessage(file)).not.toThrow();
      expect(peekFirstUserMessage(file)).toBe('survived corruption');
    });

    it('does NOT throw on a fully-corrupt file', () => {
      const file = makeLog(tmp, ['garbage', 'more garbage']);
      expect(() => peekFirstUserMessage(file)).not.toThrow();
      expect(peekFirstUserMessage(file)).toBe('');
    });

    it('truncates the result to 120 chars', () => {
      const long = 'x'.repeat(200);
      const file = makeLog(tmp, [
        JSON.stringify({ type: 'user_message', text: long }),
      ]);
      expect(peekFirstUserMessage(file).length).toBe(120);
    });

    it('skips blank lines and continues scanning', () => {
      const file = makeLog(tmp, [
        '',
        '   ',
        JSON.stringify({ type: 'user_message', text: 'after blanks' }),
      ]);
      expect(peekFirstUserMessage(file)).toBe('after blanks');
    });

    it('is idempotent — same result on repeated calls', () => {
      const file = makeLog(tmp, [
        JSON.stringify({ type: 'user_message', text: 'stable' }),
      ]);
      const a = peekFirstUserMessage(file);
      const b = peekFirstUserMessage(file);
      const c = peekFirstUserMessage(file);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
  });

  describe('parseSessionMessages — resume idempotency', () => {
    it('returns [] for missing file (no throw)', () => {
      expect(parseSessionMessages(path.join(tmp, 'nope.jsonl'))).toEqual([]);
    });

    it('skips malformed lines without throwing', () => {
      const file = makeLog(tmp, [
        '{not json',
        JSON.stringify({ seq: 2, type: 'user_message', text: 'ok' }),
        'also not json',
        JSON.stringify({ seq: 3, type: 'assistant_text', text: 'reply' }),
      ]);
      expect(() => parseSessionMessages(file)).not.toThrow();
      const msgs = parseSessionMessages(file);
      expect(msgs.map((m) => m.text)).toEqual(['ok', 'reply']);
    });

    it('returns structurally-identical results across repeated calls', () => {
      // Idempotency contract: resume can fire twice in quick succession
      // (sidebar pick + new-tab open). Both reads must agree.
      const file = makeLog(tmp, [
        JSON.stringify({ seq: 1, type: 'user_message', text: 'q1', ts: '2026-05-05T10:00:00Z' }),
        JSON.stringify({ seq: 2, type: 'assistant_text', text: 'a1', ts: '2026-05-05T10:00:01Z' }),
        JSON.stringify({ seq: 3, type: 'user_message', text: 'q2', ts: '2026-05-05T10:00:02Z' }),
      ]);
      const first = parseSessionMessages(file);
      const second = parseSessionMessages(file);
      expect(second).toEqual(first);
      expect(first).toHaveLength(3);
      expect(first.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    });

    it('orders by seq even when log lines are written out-of-order', () => {
      const file = makeLog(tmp, [
        JSON.stringify({ seq: 3, type: 'user_message', text: 'third' }),
        JSON.stringify({ seq: 1, type: 'user_message', text: 'first' }),
        JSON.stringify({ seq: 2, type: 'user_message', text: 'second' }),
      ]);
      expect(parseSessionMessages(file).map((m) => m.text)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('parseSessionEnvelopes — resume idempotency', () => {
    it('returns [] for missing file', () => {
      expect(parseSessionEnvelopes(path.join(tmp, 'nope.jsonl'))).toEqual([]);
    });

    it('skips malformed lines without throwing', () => {
      const file = makeLog(tmp, [
        'broken {',
        JSON.stringify({ seq: 1, type: 'tool_call_start', data: { data: { toolName: 'bash' } } }),
      ]);
      expect(() => parseSessionEnvelopes(file)).not.toThrow();
      expect(parseSessionEnvelopes(file)).toHaveLength(1);
    });

    it('repeated calls produce structurally-identical results', () => {
      const file = makeLog(tmp, [
        JSON.stringify({ seq: 1, type: 'ready', ts: '2026-05-05T10:00:00Z' }),
        JSON.stringify({ seq: 2, type: 'user_message', data: { text: 'q' }, ts: '2026-05-05T10:00:01Z' }),
      ]);
      const a = parseSessionEnvelopes(file);
      const b = parseSessionEnvelopes(file);
      expect(b).toEqual(a);
      expect(a).toHaveLength(2);
    });
  });
});
