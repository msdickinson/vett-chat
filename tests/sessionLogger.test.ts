import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionLogger } from '../src/process/sessionLogger';

describe('SessionLogger', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-chat-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes session_start as the first line and creates the dir', () => {
    const logger = new SessionLogger(tmpHome);
    logger.start();
    const p = logger.logPath!;
    expect(p).toContain(path.join('.vett', 'chat-sessions'));
    expect(fs.existsSync(p)).toBe(true);

    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const first = JSON.parse(lines[0]);
    expect(first.type).toBe('session_start');
    expect(first.seq).toBe(1);
    expect(first.instance_id).toMatch(/^chat-/);
    expect(first.data.cwd).toBeTruthy();

    logger.close('ok');
  });

  it('logs events with monotonic seq + envelope shape AI Timeline expects', () => {
    const logger = new SessionLogger(tmpHome);
    logger.start();
    logger.log({ type: 'ready' });
    // Payloads go in `data` — that is the shape vett actually writes (its own
    // session logs are `{ts, type, data}` lines) and the shape VettEvent
    // declares. These two lines previously used a top-level `content` field
    // and an `as never` cast for a top-level `name`/`args`; neither exists on
    // VettEvent, and both went unnoticed because tsconfig did not span tests/.
    logger.log({ type: 'llm_response', text: 'hello' });
    logger.log({ type: 'tool_call', data: { name: 'Bash', args: { command: 'ls' } } });
    logger.close('done');

    const lines = fs.readFileSync(logger.logPath!, 'utf8').trim().split('\n');
    // session_start, ready, llm_response, tool_call, session_end
    expect(lines.length).toBe(5);

    const envelopes = lines.map(l => JSON.parse(l));
    // seq is monotonic
    expect(envelopes.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // every line has the AI Timeline envelope shape
    for (const e of envelopes) {
      expect(typeof e.seq).toBe('number');
      expect(typeof e.ts).toBe('string');
      expect(typeof e.type).toBe('string');
      expect(typeof e.instance_id).toBe('string');
      expect(typeof e.data).toBe('object');
    }
    // session_end carries the close reason
    expect(envelopes[4].type).toBe('session_end');
    expect(envelopes[4].data.reason).toBe('done');
  });

  it('is silent when start() never ran (defensive)', () => {
    const logger = new SessionLogger(tmpHome);
    // Don't call start. log() and close() must not throw.
    expect(() => logger.log({ type: 'ready' })).not.toThrow();
    expect(() => logger.close('whatever')).not.toThrow();
    expect(logger.logPath).toBe(null);
  });

  it('close() is idempotent', () => {
    const logger = new SessionLogger(tmpHome);
    logger.start();
    logger.close('first');
    expect(() => logger.close('second')).not.toThrow();
  });

  it('uses different file paths for different sessions started back-to-back', () => {
    const a = new SessionLogger();
    const b = new SessionLogger();
    a.start(); b.start();
    expect(a.logPath).not.toBe(b.logPath);
    a.close('done'); b.close('done');
  });
});
