import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TitleService } from './titleService';

export interface SessionIndexEntry {
  /** Absolute path to the JSONL log. Used as the primary key. */
  path: string;
  /** Filename (no path), shown when no preview is available. */
  fileName: string;
  /** First user message (truncated to ~120 chars), used as the title.
   * Empty string if the session was opened but never received a user
   * message. */
  title: string;
  /** Last-modified time as a millisecond timestamp. Drives sort order
   * and the relative-time label ("1h", "3h", "1d"). */
  mtimeMs: number;
  /** Approximate user/assistant turn count, parsed by counting message
   * events in the file. Used for the secondary line in the launcher. */
  turns: number;
}

/**
 * Lists the local chat session JSONL logs and parses just enough of
 * each one to populate the launcher: title from first user message,
 * mtime, turn count.
 *
 * Returns sessions sorted newest-first.
 */
export function listSessions(): SessionIndexEntry[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const out: SessionIndexEntry[] = [];
  for (const name of files) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    // Prefer the AI-generated sidecar title when present, fall back to
    // the first user message otherwise. The launcher never sees the
    // ugly filename-as-title state if a title has been generated.
    const title = TitleService.readTitle(full) ?? peekTitle(full);
    out.push({
      path: full,
      fileName: name,
      title,
      mtimeMs: stat.mtimeMs,
      turns: countTurns(full),
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Delete a session log and its `.title` sidecar (if present).
 * Returns true on success. */
export function deleteSession(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
  } catch {
    return false;
  }
  // Best-effort sidecar cleanup. Without this the launcher used to
  // show the file as "deleted" but a stale .title lingered on disk
  // forever and could re-appear after a future scan that lists titles.
  try { fs.unlinkSync(filePath + '.title'); } catch { /* no sidecar */ }
  return true;
}

function sessionsDir(): string {
  const config = vscode.workspace.getConfiguration('vett-chat');
  const customDir = config.get<string>('chatSessionLogDir', '');
  return customDir.trim() || path.join(os.homedir(), '.vett', 'chat-sessions');
}

/**
 * Read just the first user_message in the JSONL and return its text
 * truncated to a reasonable title length. Falls back to the filename's
 * timestamp if the session has no user message yet.
 */
function peekTitle(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const env = JSON.parse(line);
        if (env.type === 'user_message') {
          const text = env.text ?? env.data?.text ?? '';
          if (text) return String(text).slice(0, 120).replace(/\s+/g, ' ').trim();
        }
      } catch {
        // skip bad lines
      }
    }
  } catch {
    // unreadable
  }
  return '';
}

/** Count user_message + assistant_text events. Used to show "3 turns"
 * etc. as a secondary label. Cheap because chat sessions are small. */
function countTurns(filePath: string): number {
  let n = 0;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const env = JSON.parse(line);
        if (env.type === 'user_message' || env.type === 'assistant_text') n++;
      } catch {
        // skip
      }
    }
  } catch {
    // unreadable
  }
  return n;
}
