import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProfileService } from './profileService';
import { ProfileSummary } from '../shared/types';
import { parseSessionMessages } from './sessionLogParser';

/**
 * Generates a short title for a chat session by asking the active
 * profile's LLM to summarize the first user/assistant pair. Stores the
 * result alongside the JSONL log as `<jsonl-path>.title` so future
 * launcher refreshes can read it without recomputing.
 *
 * Lazy + idempotent:
 *   - Skips sessions that already have a sidecar title file.
 *   - Skips sessions that have fewer than 2 messages (nothing to title).
 *   - Caches "in-flight" paths in memory so the file watcher doesn't
 *     fire 10 generations in parallel for the same session.
 *
 * Best-effort — every failure mode (no profile, no endpoint, network
 * error, malformed response) silently falls back to leaving the title
 * file absent. The launcher already shows the first user message as
 * a fallback title in that case.
 */
export class TitleService {
  private inFlight = new Set<string>();

  constructor(private readonly profileService: ProfileService) {}

  /** For a list of session paths, kick off title generation for any
   * that don't yet have a sidecar. Fire-and-forget. */
  async generateMissing(paths: string[]): Promise<void> {
    for (const p of paths) {
      const sidecarPath = sidecarFor(p);
      if (fs.existsSync(sidecarPath)) continue;
      if (this.inFlight.has(p)) continue;
      this.inFlight.add(p);
      // Fire off — don't await each one. A given launcher refresh kicks
      // off all generations in parallel; results land via the file
      // watcher.
      this.generateOne(p).finally(() => this.inFlight.delete(p));
    }
  }

  /** Read the sidecar title file if present, or return undefined. */
  static readTitle(jsonlPath: string): string | undefined {
    const sidecarPath = sidecarFor(jsonlPath);
    if (!fs.existsSync(sidecarPath)) return undefined;
    try {
      return fs.readFileSync(sidecarPath, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async generateOne(jsonlPath: string): Promise<void> {
    const messages = parseSessionMessages(jsonlPath);
    if (messages.length < 2) return;
    // Title generation is an opportunistic background nicety: if the
    // profile list is unavailable we simply don't generate a title this
    // pass, exactly as when the active profile has no endpoint. There is
    // no user-visible surface here to route an error to, and a toast per
    // un-titled session log would be noise.
    const listed = await this.profileService.list();
    if (!listed.ok) return;
    const profile = activeProfile(listed.profiles);
    if (!profile?.endpoint || !profile?.model) return;

    // Limit context: take the first user + first assistant only. Cheap
    // and keeps the title focused on the original ask rather than later
    // tangents.
    const firstUser = messages.find((m) => m.role === 'user');
    const firstAssistant = messages.find((m) => m.role === 'assistant');
    if (!firstUser || !firstAssistant) return;

    const body = {
      model: profile.model,
      messages: [
        {
          role: 'system',
          content:
            'You write concise titles for code-assistant chat sessions. ' +
            'Return ONLY the title, no quotes, no punctuation at the end. ' +
            'Maximum 8 words. Capitalize the first word. Do not start ' +
            'with "Chat" or "Session".',
        },
        {
          role: 'user',
          content: `User: ${truncate(firstUser.text, 600)}\n\nAssistant: ${truncate(firstAssistant.text, 400)}\n\nTitle:`,
        },
      ],
      max_tokens: 32,
      temperature: 0.3,
      stream: false,
    };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const apiKey = profile.provider !== 'local' ? readApiKey(profile) : '';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
      const resp = await fetch(joinUrl(profile.endpoint, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return;
      const json = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const raw = json.choices?.[0]?.message?.content?.trim();
      const title = clean(raw ?? '');
      if (!title) return;
      try {
        fs.writeFileSync(sidecarFor(jsonlPath), title, 'utf8');
      } catch {
        // disk full / permission — give up silently
      }
    } catch {
      // network error / abort — give up silently
    }
  }
}

function sidecarFor(jsonlPath: string): string {
  return jsonlPath + '.title';
}

function activeProfile(profiles: ProfileSummary[]): ProfileSummary | null {
  // The picker writes to global config; we read the same. The default
  // is `coding`, which the bundled profile catalog includes.
  const name = process.env.VETT_CHAT_TITLE_PROFILE || 'coding';
  return profiles.find((p) => p.name === name) ?? profiles[0] ?? null;
}

function readApiKey(profile: ProfileSummary): string {
  // ProfileSummary doesn't carry the api_key_env name; the picker
  // doesn't need it. For now we default to common provider env vars
  // — if none is set, the request goes out without auth and the
  // provider rejects it (we ignore the error).
  const candidates = ['VETT_LLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  for (const key of candidates) {
    const v = process.env[key];
    if (v) return v;
  }
  return '';
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** Strip surrounding quotes / trailing punctuation that LLMs love to
 * tack on, then cap length at a hard maximum. */
function clean(s: string): string {
  let t = s.trim();
  // First non-empty line only — some models add a "Title:" rationale.
  const newline = t.indexOf('\n');
  if (newline !== -1) t = t.slice(0, newline).trim();
  t = t.replace(/^["'`“”]+|["'`“”]+$/g, '');
  t = t.replace(/[.!?]+$/g, '');
  return t.slice(0, 80);
}

/** Resolve the chat-sessions directory honoring the user's config. */
export function defaultSessionsDir(): string {
  return path.join(os.homedir(), '.vett', 'chat-sessions');
}
