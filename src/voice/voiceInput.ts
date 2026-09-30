import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { transcribeAudio, type WhisperApiStyle } from './whisperClient';
import { buildDshowListDevicesArgs, buildFfmpegArgs, buildFfmpegStreamingPcmArgs, parseDshowAudioDevices } from './voicePlatform';
import { VoiceStreamingSession } from './voiceStreamingClient';

/**
 * Voice input via push-to-talk → ffmpeg → Whisper-compatible HTTP →
 * `prefillInput` back into the chat textarea.
 *
 * Cross-platform mic capture is the hard part. We shell out to
 * `ffmpeg` because it ships everywhere people develop and the input
 * device names are platform-specific:
 *   - Windows: `-f dshow -i audio="<device-name>"`
 *   - macOS:   `-f avfoundation -i ":<device-index>"`
 *   - Linux:   `-f pulse -i default` (or `-f alsa -i default`)
 *
 * The default per-platform device name usually works. If not, the
 * user sets `vett-chat.voiceInputDevice` to their own device name and
 * we pass it through verbatim.
 *
 * State machine (per-controller-instance):
 *   idle → recording (user clicks button)
 *   recording → transcribing (user clicks again, OR auto-stop after timeout)
 *   transcribing → idle (Whisper returns; result drops into chat input)
 *
 * Only one recording at a time per controller. Concurrent calls when
 * already recording are interpreted as "stop recording."
 */
export class VoiceInputController {
  private state: 'idle' | 'recording' | 'transcribing' = 'idle';
  private proc: ChildProcess | null = null;
  private currentFile: string | null = null;
  private postStatus: ((s: 'idle' | 'recording' | 'transcribing', message?: string) => void) | null = null;
  private prefillInput: ((text: string, opts?: { replace?: boolean }) => void) | null = null;
  /** Cached result of `discoverWindowsDefaultDevice`. Probing ffmpeg's
   *  `-list_devices` output costs ~1s per call — once is plenty per
   *  session. Resets when the user changes `vett-chat.voiceInputDevice`. */
  private cachedWin32Device: string | null = null;
  /** Active streaming session, when `voiceMode` is `streaming`. Null
   *  in manual mode, where the file-based recording path runs instead. */
  private streamingSession: VoiceStreamingSession | null = null;

  /** Wire up the panel-side callbacks. The controller is per-panel
   *  so the toggle button on one chat doesn't bleed into another. */
  attach(opts: {
    postStatus: (s: 'idle' | 'recording' | 'transcribing', message?: string) => void;
    prefillInput: (text: string, opts?: { replace?: boolean }) => void;
  }): void {
    this.postStatus = opts.postStatus;
    this.prefillInput = opts.prefillInput;
  }

  detach(): void {
    this.cancel();
    this.postStatus = null;
    this.prefillInput = null;
  }

  /** Toggle recording. Idle → start. Recording → stop + transcribe.
   *  Transcribing → no-op (the previous run is still in flight). */
  async toggle(): Promise<void> {
    if (this.state === 'transcribing') {
      vscode.window.showInformationMessage('Vett: still transcribing the last recording — try again in a sec.');
      return;
    }
    if (this.state === 'recording') {
      // Streaming sessions own their own stop path; the manual file
      // path uses stopAndTranscribe.
      if (this.streamingSession) {
        await this.stopStreaming();
      } else {
        await this.stopAndTranscribe();
      }
      return;
    }
    await this.start();
  }

  private async start(): Promise<void> {
    const config = vscode.workspace.getConfiguration('vett-chat');
    const ffmpeg = config.get<string>('ffmpegPath', '').trim() || 'ffmpeg';
    let device = config.get<string>('voiceInputDevice', '').trim();
    // Windows DirectShow has no `default` keyword — it requires the
    // exact device name. Auto-pick the first audio device ffmpeg
    // enumerates so users don't have to hand-configure their mic.
    // Manual override (`voiceInputDevice` setting) wins when set.
    if (!device && process.platform === 'win32') {
      const auto = await this.resolveWindowsDefaultDevice(ffmpeg);
      if (!auto) {
        vscode.window.showErrorMessage(
          'Vett: no DirectShow audio device found. Plug in / unmute a mic, or set `vett-chat.voiceInputDevice` to its exact name.',
        );
        return;
      }
      device = auto;
    }

    const voiceMode = (config.get<string>('voiceMode', 'manual') || 'manual').toLowerCase();
    if (voiceMode === 'streaming') {
      await this.startStreaming(ffmpeg, device);
      return;
    }

    const args = buildFfmpegArgs(process.platform, device);
    if (!args) {
      vscode.window.showErrorMessage(
        `Vett: voice input doesn't have a default device for platform '${process.platform}'. ` +
        'Set `vett-chat.voiceInputDevice` to your mic name.',
      );
      return;
    }

    this.currentFile = path.join(os.tmpdir(), `vett-voice-${Date.now()}.wav`);
    args.push(this.currentFile);

    try {
      this.proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      vscode.window.showErrorMessage(`Vett: couldn't spawn ffmpeg — ${(err as Error).message}. Install ffmpeg or set vett-chat.ffmpegPath.`);
      this.currentFile = null;
      return;
    }

    this.proc.on('error', (err) => {
      vscode.window.showErrorMessage(`Vett: ffmpeg error — ${err.message}. Install ffmpeg, or set vett-chat.ffmpegPath.`);
      this.cancel();
    });

    let stderrTail = '';
    this.proc.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-2000);
    });

    this.proc.on('exit', (code, signal) => {
      // Process exited unexpectedly (not via our SIGINT). Keep the
      // tail around so debug messages can surface.
      if (this.state === 'recording' && code !== 0 && signal !== 'SIGINT') {
        const summary = stderrTail.split('\n').slice(-3).join(' / ').slice(0, 400);
        vscode.window.showErrorMessage(`Vett: ffmpeg exited (code ${code}) — ${summary || 'no stderr'}`);
        this.cancel();
      }
    });

    this.state = 'recording';
    this.postStatus?.('recording', 'Recording — click again to stop and transcribe.');
  }

  private async stopAndTranscribe(): Promise<void> {
    if (!this.proc || !this.currentFile) {
      this.cancel();
      return;
    }
    const file = this.currentFile;
    this.currentFile = null;

    this.state = 'transcribing';
    this.postStatus?.('transcribing', 'Transcribing…');

    // Send 'q' to ffmpeg's stdin for a clean shutdown — that flushes
    // the WAV header. SIGINT works on Linux/macOS; on Windows ffmpeg
    // ignores SIGINT by design.
    try {
      this.proc.stdin?.write('q\n');
      this.proc.stdin?.end();
    } catch { /* already closed */ }

    // Wait for ffmpeg to finish (up to 5s) so the file is closed.
    await waitForExit(this.proc, 5000);
    this.proc = null;

    if (!fs.existsSync(file) || fs.statSync(file).size < 1024) {
      vscode.window.showWarningMessage('Vett: recording was too short or empty — nothing to transcribe.');
      cleanupFile(file);
      this.cancel();
      return;
    }

    const config = vscode.workspace.getConfiguration('vett-chat');
    const endpoint = config.get<string>('whisperEndpoint', '').trim();
    const model = config.get<string>('whisperModel', '').trim() || 'whisper-1';
    if (!endpoint) {
      vscode.window.showErrorMessage('Vett: voice input needs `vett-chat.whisperEndpoint` set (e.g. http://localhost:9000/v1/audio/transcriptions).');
      cleanupFile(file);
      this.cancel();
      return;
    }

    // Bearer auth for Whisper. Settings string wins; otherwise fall
    // back to OPENAI_API_KEY (the package.json description for
    // whisperEndpoint promises this works for OpenAI's hosted API).
    // Empty string is fine — local servers (whisper.cpp, faster-whisper)
    // typically don't require auth.
    const apiKey =
      (config.get<string>('whisperApiKey', '') || '').trim() ||
      (process.env.OPENAI_API_KEY ?? '').trim();

    const styleSetting = (config.get<string>('whisperApiStyle', 'openai') || 'openai').trim().toLowerCase();
    const style: WhisperApiStyle = styleSetting === 'simple' ? 'simple' : 'openai';
    let result;
    try {
      result = await transcribeAudio(file, endpoint, { model, apiKey: apiKey || undefined, style });
    } catch (err) {
      vscode.window.showErrorMessage(`Vett: transcription crashed — ${(err as Error).message}`);
      cleanupFile(file);
      this.cancel();
      return;
    }
    cleanupFile(file);

    if (!result.ok || result.text.length === 0) {
      vscode.window.showErrorMessage(`Vett: transcription failed — ${result.message ?? 'empty response'}`);
      this.cancel();
      return;
    }

    this.prefillInput?.(result.text);
    this.cancel();
  }

  /**
   * Streaming-mode start. Open a WebSocket to `<endpoint>/ws/transcribe`,
   * spawn ffmpeg with raw-PCM-to-stdout, pipe audio bytes upstream as
   * the user speaks. Partial transcripts replace the chat input live;
   * `final` (or close) locks in the result.
   */
  private async startStreaming(ffmpeg: string, device: string): Promise<void> {
    const args = buildFfmpegStreamingPcmArgs(process.platform, device);
    if (!args) {
      vscode.window.showErrorMessage(
        `Vett: voice input doesn't have a default device for platform '${process.platform}'. ` +
        'Set `vett-chat.voiceInputDevice` to your mic name.',
      );
      return;
    }

    const config = vscode.workspace.getConfiguration('vett-chat');
    const endpoint = config.get<string>('whisperEndpoint', '').trim();
    if (!endpoint) {
      vscode.window.showErrorMessage('Vett: streaming voice needs `vett-chat.whisperEndpoint` set (e.g. http://localhost:9000/transcribe).');
      return;
    }

    const session = new VoiceStreamingSession({
      endpoint,
      ffmpegPath: ffmpeg,
      ffmpegArgs: args,
      onPartial: (text) => {
        // Each partial is a fresh transcription of the full audio
        // buffer collected on the server, so we REPLACE the input
        // text (not append). The user typing alongside live voice
        // would be clobbered — documented trade-off until we add
        // prefix tracking.
        this.prefillInput?.(text, { replace: true });
      },
      onFinal: (text) => {
        // The final pass uses higher beam search server-side; lock
        // the input field to it and return to idle.
        if (text.length > 0) {
          this.prefillInput?.(text, { replace: true });
        }
        this.streamingSession = null;
        this.state = 'idle';
        this.postStatus?.('idle');
      },
      onError: (err) => {
        vscode.window.showErrorMessage(`Vett: streaming voice — ${err.message}`);
        // Don't auto-cancel on every error; transient WS hiccups
        // shouldn't kill an active session. The session's own close
        // handler will reset state if the connection truly drops.
      },
    });

    try {
      await session.start();
    } catch (err) {
      vscode.window.showErrorMessage(`Vett: streaming voice failed to start — ${(err as Error).message}`);
      session.cancel();
      return;
    }

    this.streamingSession = session;
    this.state = 'recording';
    this.postStatus?.('recording', 'Recording — click again to stop.');
  }

  /** Streaming-mode stop. ffmpeg flushes its tail, the server runs a
   *  high-beam final pass, the result locks into the input field. */
  private async stopStreaming(): Promise<void> {
    const session = this.streamingSession;
    if (!session) {
      this.cancel();
      return;
    }
    this.state = 'transcribing';
    this.postStatus?.('transcribing', 'Transcribing…');
    try {
      await session.stop();
    } catch (err) {
      vscode.window.showErrorMessage(`Vett: streaming stop — ${(err as Error).message}`);
    }
    // onFinal callback (or the close handler) takes care of clearing
    // streamingSession + state. If somehow neither fires within the
    // session's internal timeouts, force the reset here.
    if (this.streamingSession === session) {
      this.streamingSession = null;
      this.state = 'idle';
      this.postStatus?.('idle');
    }
  }

  /**
   * Auto-discover the system's first DirectShow audio device by running
   * `ffmpeg -list_devices true -f dshow -i dummy` and parsing the
   * stderr listing. Cached after the first successful probe so we
   * don't pay the ~1s spawn on every recording.
   *
   * Returns null when ffmpeg can't be spawned, the listing parse turns
   * up no audio devices, or the probe takes longer than 5s. Caller is
   * expected to surface a user-facing error in that case.
   */
  private async resolveWindowsDefaultDevice(ffmpeg: string): Promise<string | null> {
    if (this.cachedWin32Device) return this.cachedWin32Device;
    const stderr = await new Promise<string>((resolve) => {
      let probe: ChildProcess;
      try {
        probe = spawn(ffmpeg, buildDshowListDevicesArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch {
        resolve('');
        return;
      }
      let buf = '';
      probe.stderr?.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
      const t = setTimeout(() => { try { probe.kill('SIGKILL'); } catch { /* */ } resolve(buf); }, 5000);
      probe.on('error', () => { clearTimeout(t); resolve(buf); });
      probe.on('exit', () => { clearTimeout(t); resolve(buf); });
    });
    const devices = parseDshowAudioDevices(stderr);
    if (devices.length === 0) return null;
    this.cachedWin32Device = devices[0];
    return this.cachedWin32Device;
  }

  /** Reset to idle. Kills any in-flight ffmpeg + clears state.
   *  Called both on completion and on error paths. */
  cancel(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = null;
    }
    if (this.currentFile) {
      cleanupFile(this.currentFile);
      this.currentFile = null;
    }
    if (this.streamingSession) {
      try { this.streamingSession.cancel(); } catch { /* */ }
      this.streamingSession = null;
    }
    this.state = 'idle';
    this.postStatus?.('idle');
  }
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    const t = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* */ }
      resolve();
    }, timeoutMs);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

function cleanupFile(p: string): void {
  try { fs.unlinkSync(p); } catch { /* best-effort */ }
}
