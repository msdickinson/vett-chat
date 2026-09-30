import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VettEvent } from '../shared/types';

/**
 * Append every event from a chat session to a JSONL file using the same
 * envelope shape VETT itself writes for benchmark runs:
 *
 *   { seq, ts, type, instance_id, data }
 *
 * AI Timeline's VETT parser already understands this shape, so chat
 * sessions show up in the timeline view alongside benchmark runs. The
 * file is named so multi-session loads don't collide:
 *
 *   ~/.vett/chat-sessions/<startTime>-<random>.jsonl
 *
 * Best-effort — a write failure NEVER throws into the chat path. Worst
 * case the session file is short or missing; the chat keeps working.
 */
export class SessionLogger {
  private fd: number | null = null;
  private path: string | null = null;
  private seq = 0;
  private readonly sessionId: string;
  private readonly homeDir: string;
  private readonly customLogDir?: string;
  private readonly resumePath?: string;
  private readonly resumed: boolean;

  /**
   * @param homeDir Override the home directory used for the session log
   *   path. Used by tests to avoid polluting the real ~/.vett. Defaults
   *   to os.homedir().
   * @param customLogDir Absolute path that, when set, replaces the default
   *   `<homeDir>/.vett/chat-sessions/`. Surfaced as the
   *   `vett-chat.chatSessionLogDir` setting.
   * @param opts.sessionId Stable id for the chat. Used as the JSONL
   *   filename. Falls back to a generated id.
   * @param opts.resumePath When set, the log file is opened in append
   *   mode against this existing JSONL — a single conversation persists
   *   as a single file across restarts. The new run writes a
   *   `session_resumed` marker on open so consumers can split runs.
   */
  constructor(
    homeDir?: string,
    customLogDir?: string,
    opts: { sessionId?: string; resumePath?: string } = {},
  ) {
    if (opts.sessionId) {
      this.sessionId = opts.sessionId;
    } else {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = Math.random().toString(36).slice(2, 8);
      this.sessionId = `chat-${ts}-${rand}`;
    }
    this.homeDir = homeDir ?? os.homedir();
    this.customLogDir = customLogDir && customLogDir.trim() ? customLogDir.trim() : undefined;
    this.resumePath = opts.resumePath;
    this.resumed = Boolean(opts.resumePath);
  }

  /** Open the log file. Idempotent — second call is a no-op. */
  start(): void {
    if (this.fd != null) { return; }
    try {
      let logPath: string;
      if (this.resumePath) {
        // Resume: append to the existing file. The JSONL filename is
        // owned by the original run; we don't touch it.
        logPath = this.resumePath;
        const dir = path.dirname(logPath);
        fs.mkdirSync(dir, { recursive: true });
      } else {
        const dir = this.customLogDir ?? path.join(this.homeDir, '.vett', 'chat-sessions');
        fs.mkdirSync(dir, { recursive: true });
        logPath = path.join(dir, `${this.sessionId}.jsonl`);
      }
      this.path = logPath;
      this.fd = fs.openSync(this.path, 'a');

      if (this.resumed) {
        this.writeEnvelope('session_resumed', {
          instance_id: this.sessionId,
          cwd: process.cwd(),
          platform: process.platform,
        });
      } else {
        this.writeEnvelope('session_start', {
          instance_id: this.sessionId,
          cwd: process.cwd(),
          platform: process.platform,
        });
      }
    } catch {
      // Log failure should never break chat. Stay quiet.
      this.fd = null;
      this.path = null;
    }
  }

  /** Append an event in the AI Timeline events.jsonl envelope shape. */
  log(event: VettEvent): void {
    if (this.fd == null) { return; }
    const data = (event as unknown) as Record<string, unknown>;
    this.writeEnvelope(event.type, data);
  }

  /** Close the log file. Should be called on subprocess exit. */
  close(reason: string): void {
    if (this.fd == null) { return; }
    try {
      this.writeEnvelope('session_end', { instance_id: this.sessionId, reason });
      fs.closeSync(this.fd);
    } catch { /* swallow */ }
    this.fd = null;
  }

  /** Path of the active log file, or null if not started / failed to open. */
  get logPath(): string | null { return this.path; }

  private writeEnvelope(type: string, data: Record<string, unknown>): void {
    if (this.fd == null) { return; }
    const seq = ++this.seq;
    const ts = new Date().toISOString();
    // Force the instance_id field at the envelope level — AI Timeline
    // groups events by it. If `data` already carried one, prefer that
    // (e.g. a per-tool-call instance reference); otherwise use the
    // session id so every line is attributable to this chat.
    const instance_id = (data.instance_id as string | undefined) ?? this.sessionId;
    const envelope = JSON.stringify({ seq, ts, type, instance_id, data }) + '\n';
    try {
      fs.writeSync(this.fd, envelope);
    } catch {
      // If write fails (disk full, etc.), close + give up. Don't keep
      // throwing on every event.
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }
}
