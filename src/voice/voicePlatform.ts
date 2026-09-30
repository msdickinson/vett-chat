/**
 * Cross-platform mic-capture argument shaping for ffmpeg. Extracted
 * into a vscode-free module so vitest can pin the per-platform
 * argument contract without a vscode shim.
 */

/**
 * Returns the ffmpeg argument list (without the trailing output path)
 * for the host platform, or null if the platform isn't supported with
 * default settings. When `device` is provided it overrides the
 * per-platform default.
 *
 * Output format constraints we share across platforms: 16kHz mono
 * WAV — matches what whisper.cpp / faster-whisper expect natively
 * and minimizes payload size. `-y` forces overwrite of the output
 * path so a stale temp file doesn't block the recording.
 */
export function buildFfmpegArgs(platform: NodeJS.Platform, device: string): string[] | null {
  const common = ['-y', '-ac', '1', '-ar', '16000', '-f', 'wav'];
  if (platform === 'win32') {
    const dev = device || 'default';
    // dshow needs `audio=` prefix on the device name. Quote-free —
    // ffmpeg parses the bare arg without shell interpretation.
    return ['-f', 'dshow', '-i', `audio=${dev}`, ...common];
  }
  if (platform === 'darwin') {
    // `:0` is the system default audio input device. Users override
    // with e.g. `:1` if they want a specific device.
    const dev = device || ':0';
    return ['-f', 'avfoundation', '-i', dev, ...common];
  }
  if (platform === 'linux') {
    const dev = device || 'default';
    return ['-f', 'pulse', '-i', dev, ...common];
  }
  return null;
}

/**
 * ffmpeg argument list for LIVE streaming — outputs raw 16-bit signed
 * mono PCM at 16kHz to stdout (`-`) instead of writing a file.
 *
 * The streaming controller pipes ffmpeg's stdout directly into the
 * WebSocket as it's captured, so the server sees audio bytes as the
 * user speaks. Same input-side flags as `buildFfmpegArgs`; output
 * format is raw PCM (`-f s16le`) so no WAV header gets injected
 * mid-stream.
 */
export function buildFfmpegStreamingPcmArgs(platform: NodeJS.Platform, device: string): string[] | null {
  const common = ['-ac', '1', '-ar', '16000', '-f', 's16le'];
  if (platform === 'win32') {
    const dev = device || 'default';
    return ['-f', 'dshow', '-i', `audio=${dev}`, ...common, '-'];
  }
  if (platform === 'darwin') {
    const dev = device || ':0';
    return ['-f', 'avfoundation', '-i', dev, ...common, '-'];
  }
  if (platform === 'linux') {
    const dev = device || 'default';
    return ['-f', 'pulse', '-i', dev, ...common, '-'];
  }
  return null;
}

/**
 * ffmpeg argument list for ENUMERATING DirectShow audio devices on
 * Windows. Output goes to stderr; pair with `parseDshowAudioDevices`
 * to extract the device names.
 *
 * `-list_devices true -f dshow -i dummy` is the canonical incantation;
 * ffmpeg prints one line per device + exits non-zero (because `dummy`
 * is not a real device — that's expected, the caller ignores the
 * exit code). The `-hide_banner` knocks out the version preamble so
 * the parser doesn't have to skip past it.
 */
export function buildDshowListDevicesArgs(): string[] {
  return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
}

/**
 * Parse the stderr output of `ffmpeg -list_devices true -f dshow -i dummy`
 * and return the list of audio device names in the order ffmpeg printed
 * them. ffmpeg's "first device" is typically the system default capture
 * device, so callers that want auto-pick can take the first element.
 *
 * Format ffmpeg emits (one per line, varies slightly by version):
 *   [in#0 @ 0x...] "Microphone (HD Pro Webcam C920)" (audio)
 *   [dshow @ 0x...]  "Microphone (Realtek)"
 *      Alternative name "@device_cm_..."
 *
 * We pick lines that contain `"<name>"` (audio) or are tagged with
 * "(audio)" — and skip the "Alternative name" rows.
 */
export function parseDshowAudioDevices(stderr: string): string[] {
  const out: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    // Skip the "Alternative name" rows ffmpeg emits per-device — those
    // are CLSID-style aliases that work but read as gibberish in the UI.
    if (line.startsWith('Alternative name')) continue;
    if (!line.includes('(audio)')) continue;
    const m = line.match(/"([^"]+)"\s*\(audio\)/);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}
