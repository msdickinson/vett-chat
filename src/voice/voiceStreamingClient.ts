import WebSocket from 'ws';
import { ChildProcess, spawn } from 'child_process';
import { URL } from 'url';

/**
 * Live STT client. Connects to the server's `/ws/transcribe` WebSocket,
 * pipes ffmpeg's raw PCM (s16le 16kHz mono) into the socket as it's
 * captured from the mic, and emits text deltas back through callbacks.
 *
 * Wire format:
 *   Client → server: binary frames of 16-bit signed mono 16kHz PCM.
 *   Server → client: JSON text frames
 *     { type: 'partial', text: '...' }   — every ~1s while audio comes in
 *     { type: 'final',   text: '...' }   — one-shot before close
 *     { type: 'error',   message: '...' } — recoverable errors (logged)
 *
 * The "full transcript so far" lives on the server — every partial is
 * a fresh transcription of everything captured. The client just
 * replaces its current text with each partial it receives, and locks
 * in the final on close.
 */

export interface StreamingOptions {
  endpoint: string;
  ffmpegPath: string;
  ffmpegArgs: string[];
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(err: Error): void;
}

export class VoiceStreamingSession {
  private ws: WebSocket | null = null;
  private proc: ChildProcess | null = null;
  private done = false;
  private opts: StreamingOptions;

  constructor(opts: StreamingOptions) {
    this.opts = opts;
  }

  /**
   * Open the WebSocket + spawn ffmpeg. Returns when the WS handshake
   * completes (so the caller can set the UI state to "recording").
   * Throws if either step fails.
   */
  async start(): Promise<void> {
    const wsUrl = deriveWsUrl(this.opts.endpoint);
    this.ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onOpen = () => {
        ws.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(new Error(`WebSocket connect failed: ${err.message}`));
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    // Wire up ongoing message + close handlers AFTER the handshake so
    // the open/error race above stays clean.
    this.ws!.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    this.ws!.on('error', (err) => {
      // Don't swallow — the controller surfaces it as a user-facing toast.
      this.opts.onError(new Error(`WebSocket error: ${err.message}`));
    });
    this.ws!.on('close', () => {
      // Server-side disconnect (or our own stop()) — if we never got a
      // final, settle with empty so the UI can return to idle.
      if (!this.done) {
        this.done = true;
        this.opts.onFinal('');
      }
    });

    // Spawn ffmpeg with PCM-to-stdout output. The args list must
    // already be set up for raw 16-bit mono 16kHz output (see
    // buildFfmpegStreamingPcmArgs). We pipe stdout directly into the
    // WebSocket as binary frames.
    try {
      this.proc = spawn(this.opts.ffmpegPath, this.opts.ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.cleanup();
      throw new Error(`Failed to spawn ffmpeg: ${(err as Error).message}`);
    }

    let stderrTail = '';
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      // Ship PCM bytes upstream. ws's send accepts Buffer directly.
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(chunk); } catch { /* will surface via 'error' */ }
      }
    });
    this.proc.on('error', (err) => {
      this.opts.onError(new Error(`ffmpeg error: ${err.message}`));
      this.cleanup();
    });
    this.proc.on('exit', (code, signal) => {
      // If ffmpeg dies unexpectedly, surface enough of stderr to
      // diagnose. SIGINT / SIGTERM / our own stop() are expected.
      if (code !== 0 && code !== null && signal !== 'SIGINT' && signal !== 'SIGTERM' && !this.done) {
        const tail = stderrTail.split('\n').slice(-3).join(' / ').slice(0, 400);
        this.opts.onError(new Error(`ffmpeg exited (code ${code}): ${tail || 'no stderr'}`));
      }
      // Tell the server we're done sending audio. The server's final
      // pass + close will trigger our `final` callback above.
      try { this.ws?.close(); } catch { /* */ }
    });
  }

  /**
   * Stop ffmpeg cleanly so its WAV/PCM tail is flushed, then wait for
   * the server's `final` message (or the WebSocket close) before
   * returning. Caller awaits this so the UI can move from "Recording"
   * to "Transcribing" to idle.
   */
  async stop(): Promise<void> {
    // Send 'q' (ffmpeg's clean-shutdown command) on stdin. Same idea
    // as the manual-mode controller's stopAndTranscribe.
    try {
      this.proc?.stdin?.write('q\n');
      this.proc?.stdin?.end();
    } catch { /* already closed */ }

    // Wait for ffmpeg to exit (up to 5s) so we don't drop trailing
    // audio. The exit handler above will close the WebSocket.
    if (this.proc) {
      await waitForExit(this.proc, 5_000);
      this.proc = null;
    }

    // Now wait for the server to send its final transcript and close
    // the socket. Capped so a non-responsive server doesn't hang
    // forever — caller can show "transcribing" for that window.
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), 10_000);
        this.ws!.once('close', () => { clearTimeout(t); resolve(); });
      });
    }
    this.cleanup();
  }

  /** Hard-stop. Used on errors or user-initiated cancellation. */
  cancel(): void {
    if (!this.done) {
      this.done = true;
      // No final callback — caller already knows the session is over.
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* */ }
      this.proc = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* */ }
      this.ws = null;
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    let text: string;
    try {
      text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
    } catch (err) {
      console.error('[vett-chat:streaming] message decode error', err);
      return;
    }
    console.log('[vett-chat:streaming] ws message in:', text.slice(0, 200));
    let msg: { type?: string; text?: string; message?: string };
    try {
      msg = JSON.parse(text);
    } catch (err) {
      console.error('[vett-chat:streaming] JSON parse failed:', text);
      return;
    }
    if (msg.type === 'partial' && typeof msg.text === 'string') {
      console.log('[vett-chat:streaming] partial →', msg.text);
      this.opts.onPartial(msg.text);
    } else if (msg.type === 'final' && typeof msg.text === 'string') {
      console.log('[vett-chat:streaming] final →', msg.text);
      this.done = true;
      this.opts.onFinal(msg.text);
    } else if (msg.type === 'error' && typeof msg.message === 'string') {
      this.opts.onError(new Error(`server: ${msg.message}`));
    } else {
      console.warn('[vett-chat:streaming] unknown ws message shape:', msg);
    }
  }
}

/**
 * Convert a configured Whisper endpoint into the WebSocket URL for the
 * streaming server. Strips a trailing `/transcribe` or
 * `/v1/audio/transcriptions` (whichever shape the user has set) and
 * appends `/ws/transcribe`. Swaps `http` for `ws`, `https` for `wss`.
 *
 * Pure — exported for unit testing.
 */
export function deriveWsUrl(endpoint: string): string {
  const u = new URL(endpoint);
  let path = u.pathname.replace(/\/+$/, '');
  if (path.endsWith('/transcribe')) {
    path = path.slice(0, -'/transcribe'.length);
  } else if (path.endsWith('/v1/audio/transcriptions')) {
    path = path.slice(0, -'/v1/audio/transcriptions'.length);
  }
  if (path === '') path = '';
  u.pathname = path + '/ws/transcribe';
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    const t = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* */ }
      resolve();
    }, timeoutMs);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}
