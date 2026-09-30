import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';

/**
 * Pure-ish helpers for the Whisper-compatible STT round-trip. The
 * transport itself touches the network so it isn't fully pure, but
 * the request shape + response parsing are extracted into testable
 * helpers (vitest covers them with a fake server).
 *
 * The endpoint shape we target is the OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint that whisper.cpp's HTTP server,
 * Faster-Whisper-Server, and the official OpenAI API all expose:
 *   POST <endpoint>
 *   Content-Type: multipart/form-data
 *   Fields: file (audio bytes), model (string), response_format (json|text)
 *   Response: { text: "..." } for json, or raw "..." for text
 *
 * If the user's STT server uses a different protocol, they'll have to
 * point a small proxy at it; we don't try to detect dialects.
 */

export interface WhisperResponse {
  ok: boolean;
  text: string;
  message?: string;
  status?: number;
}

/**
 * Wire format the server expects.
 *
 * - `openai`: multipart fields `file` + `model` + `response_format=json`.
 *   Targets whisper.cpp's HTTP server, Faster-Whisper-Server, and the
 *   OpenAI API.
 * - `simple`: single multipart field `audio`, no model/response_format.
 *   Matches the lightweight FastAPI wrappers some self-hosted STT
 *   servers expose at `/transcribe` (a single `audio: UploadFile` route).
 */
export type WhisperApiStyle = 'openai' | 'simple';

/**
 * POST an audio file to a Whisper-compatible HTTP endpoint and return
 * the transcribed text. Uses Node's built-in `http`/`https` so we
 * don't pull a fetch polyfill into the bundle. Streams the file from
 * disk via `fs.createReadStream` so a multi-minute recording doesn't
 * end up in a Buffer-of-doom.
 *
 * `endpoint` should be the full URL (e.g. `http://localhost:9000/v1/audio/transcriptions`).
 * Falls back gracefully on every error path — the controller surfaces
 * `message` to the user and resets the UI.
 */
export async function transcribeAudio(
  audioPath: string,
  endpoint: string,
  opts?: { model?: string; apiKey?: string; timeoutMs?: number; style?: WhisperApiStyle },
): Promise<WhisperResponse> {
  if (!endpoint) {
    return { ok: false, text: '', message: 'No Whisper endpoint configured. Set `vett-chat.whisperEndpoint`.' };
  }
  if (!fs.existsSync(audioPath)) {
    return { ok: false, text: '', message: `Audio file not found at ${audioPath}.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, text: '', message: `Invalid Whisper endpoint URL: ${endpoint}` };
  }

  const boundary = '----vett-stt-' + Math.random().toString(36).slice(2);
  const headerParts: Buffer[] = [];
  const style: WhisperApiStyle = opts?.style ?? 'openai';
  // OpenAI-compat servers want `file` + `model` + `response_format`.
  // Simple FastAPI servers want a single `audio` field. The audio
  // bytes themselves are streamed below, after these header parts.
  const fileFieldName = style === 'simple' ? 'audio' : 'file';

  if (style !== 'simple') {
    const model = opts?.model ?? 'whisper-1';
    headerParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${model}\r\n`,
    ));
    // Pin response_format=json so the parser has a stable shape.
    headerParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `json\r\n`,
    ));
  }

  // File part header — body streams in below.
  const filename = path.basename(audioPath);
  headerParts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`,
  ));

  const headerBuf = Buffer.concat(headerParts);
  const trailer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileSize = fs.statSync(audioPath).size;
  const contentLength = headerBuf.length + fileSize + trailer.length;

  const headers: Record<string, string> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(contentLength),
  };
  if (opts?.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  return new Promise<WhisperResponse>((resolve) => {
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        timeout: opts?.timeoutMs ?? 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(parseWhisperResponse(res.statusCode ?? 0, body));
        });
      },
    );

    req.on('error', (err) => {
      resolve({ ok: false, text: '', message: `Whisper request failed: ${err.message}` });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, text: '', message: 'Whisper request timed out.' });
    });

    req.write(headerBuf);
    const fileStream = fs.createReadStream(audioPath);
    fileStream.on('end', () => {
      req.end(trailer);
    });
    fileStream.on('error', (err) => {
      req.destroy();
      resolve({ ok: false, text: '', message: `Failed to read audio file: ${err.message}` });
    });
    fileStream.pipe(req, { end: false });
  });
}

/**
 * Parse a Whisper-compatible HTTP response. Spec is `{text: "..."}` on
 * 2xx; anything else returns the body as the error message. Also
 * tolerates servers that return raw text on 2xx (some whisper.cpp
 * builds with `response_format=text` ignored) — we feel that out by
 * trying JSON first and falling back to the raw body.
 *
 * Pure — exported for vitest.
 */
export function parseWhisperResponse(status: number, body: string): WhisperResponse {
  if (status < 200 || status >= 300) {
    // Server sent an error — surface the message verbatim, capped so
    // the toast doesn't blow up.
    const cleaned = (body || `HTTP ${status}`).slice(0, 400);
    return { ok: false, text: '', status, message: cleaned };
  }
  // Try JSON first.
  try {
    const obj = JSON.parse(body);
    if (typeof obj === 'object' && obj !== null && typeof obj.text === 'string') {
      return { ok: true, text: obj.text.trim(), status };
    }
  } catch { /* fall through */ }
  // Fallback: treat the body as raw transcript text.
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { ok: false, text: '', status, message: 'Whisper returned an empty response.' };
  }
  return { ok: true, text: trimmed, status };
}
