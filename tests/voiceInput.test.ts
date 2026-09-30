import { describe, it, expect } from 'vitest';
import { buildDshowListDevicesArgs, buildFfmpegArgs, parseDshowAudioDevices } from '../src/voice/voicePlatform';
import { parseWhisperResponse } from '../src/voice/whisperClient';

/**
 * Pure-helper coverage for the voice-input module. Real ffmpeg
 * invocations + real network I/O are not covered here — those need a
 * desktop-with-mic environment that vitest can't fake. The helpers
 * we DO cover (cross-platform argument shaping, response parsing)
 * are the ones most likely to silently misbehave.
 */
describe('buildFfmpegArgs', () => {
  it('uses dshow + audio= prefix on Windows', () => {
    const args = buildFfmpegArgs('win32', '');
    expect(args).not.toBeNull();
    expect(args).toContain('-f');
    expect(args).toContain('dshow');
    expect(args!.find((a) => a.startsWith('audio='))).toBe('audio=default');
  });

  it('honors a custom Windows device name verbatim', () => {
    const args = buildFfmpegArgs('win32', 'Microphone (Realtek High Definition)');
    expect(args!.find((a) => a.startsWith('audio='))).toBe('audio=Microphone (Realtek High Definition)');
  });

  it('uses avfoundation + index on macOS', () => {
    const args = buildFfmpegArgs('darwin', '');
    expect(args).toContain('-f');
    expect(args).toContain('avfoundation');
    expect(args).toContain(':0');
  });

  it('honors a custom macOS device index', () => {
    const args = buildFfmpegArgs('darwin', ':3');
    expect(args).toContain(':3');
    expect(args).not.toContain(':0');
  });

  it('uses pulse + default on Linux', () => {
    const args = buildFfmpegArgs('linux', '');
    expect(args).toContain('-f');
    expect(args).toContain('pulse');
    expect(args).toContain('default');
  });

  it('returns null for unsupported platforms', () => {
    expect(buildFfmpegArgs('aix', '')).toBeNull();
    expect(buildFfmpegArgs('freebsd', '')).toBeNull();
  });

  it('always pins 16kHz mono WAV output across platforms', () => {
    for (const p of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      const args = buildFfmpegArgs(p, '');
      expect(args).toContain('-ac');
      expect(args).toContain('1');
      expect(args).toContain('-ar');
      expect(args).toContain('16000');
      // -y forces overwrite of the temp file path, important when the
      // controller reuses /tmp paths under heavy use.
      expect(args).toContain('-y');
    }
  });
});

describe('buildDshowListDevicesArgs', () => {
  it('emits the canonical -list_devices invocation with hidden banner', () => {
    const args = buildDshowListDevicesArgs();
    expect(args).toEqual(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  });
});

describe('parseDshowAudioDevices', () => {
  it('extracts audio device names from typical ffmpeg stderr output', () => {
    const stderr = `[in#0 @ 000001c434ec1f40] "Microphone (HD Pro Webcam C920)" (audio)
[in#0 @ 000001c434ec1f40] "CABLE Output (VB-Audio Virtual Cable)" (audio)`;
    expect(parseDshowAudioDevices(stderr)).toEqual([
      'Microphone (HD Pro Webcam C920)',
      'CABLE Output (VB-Audio Virtual Cable)',
    ]);
  });

  it('preserves device order — first is the system default capture', () => {
    const stderr = `[dshow @ 0x1] "First Mic" (audio)
[dshow @ 0x2] "Second Mic" (audio)`;
    expect(parseDshowAudioDevices(stderr)[0]).toBe('First Mic');
  });

  it('skips video devices', () => {
    const stderr = `[dshow @ 0x1] "Logitech Webcam" (video)
[dshow @ 0x2] "Microphone (Realtek)" (audio)`;
    expect(parseDshowAudioDevices(stderr)).toEqual(['Microphone (Realtek)']);
  });

  it('skips Alternative name CLSID rows', () => {
    const stderr = `[dshow @ 0x1] "Microphone (Realtek)" (audio)
    Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{...}"`;
    const out = parseDshowAudioDevices(stderr);
    expect(out).toEqual(['Microphone (Realtek)']);
  });

  it('handles CRLF line endings', () => {
    const stderr = '[dshow @ 0x1] "Mic A" (audio)\r\n[dshow @ 0x2] "Mic B" (audio)\r\n';
    expect(parseDshowAudioDevices(stderr)).toEqual(['Mic A', 'Mic B']);
  });

  it('returns empty list when no audio devices are present', () => {
    expect(parseDshowAudioDevices('[dshow @ 0x1] "Webcam" (video)')).toEqual([]);
    expect(parseDshowAudioDevices('')).toEqual([]);
  });
});

describe('parseWhisperResponse', () => {
  it('extracts text from a JSON 200 response', () => {
    const out = parseWhisperResponse(200, JSON.stringify({ text: 'hello world' }));
    expect(out.ok).toBe(true);
    expect(out.text).toBe('hello world');
    expect(out.status).toBe(200);
  });

  it('trims whitespace from JSON text', () => {
    const out = parseWhisperResponse(200, JSON.stringify({ text: '   trimmed   \n' }));
    expect(out.text).toBe('trimmed');
  });

  it('falls back to raw body on 200 with non-JSON content', () => {
    const out = parseWhisperResponse(200, 'plain transcript text here\n');
    expect(out.ok).toBe(true);
    expect(out.text).toBe('plain transcript text here');
  });

  it('treats empty 200 body as an error', () => {
    const out = parseWhisperResponse(200, '   ');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/empty/i);
  });

  it('reports server errors with the raw body as message (capped)', () => {
    const longBody = 'oops '.repeat(200); // 1000 chars
    const out = parseWhisperResponse(500, longBody);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(500);
    expect(out.message?.length).toBeLessThanOrEqual(400);
  });

  it('uses an HTTP-status fallback message when body is empty on error', () => {
    const out = parseWhisperResponse(503, '');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('HTTP 503');
  });

  it('handles JSON without a text field gracefully (falls through to raw)', () => {
    const out = parseWhisperResponse(200, '{"unexpected":"shape"}');
    // The whole body becomes the transcript — not ideal, but better
    // than dropping the response on the floor.
    expect(out.ok).toBe(true);
    expect(out.text).toContain('unexpected');
  });
});
