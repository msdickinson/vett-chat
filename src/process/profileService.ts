import { execFile } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ProfileSummary } from '../shared/types';
import { resolveVettPath } from './vettPath';

const execFileAsync = promisify(execFile);

/**
 * Outcome of one `vett profiles --json` run.
 *
 * The two failure shapes that used to collapse into a bare `[]` are now
 * distinguishable by construction: `{ok: true, profiles: []}` means vett
 * ran and genuinely knows about no profiles, `{ok: false}` means we never
 * got an answer. Callers rendered "No vett profiles found. Install vett…"
 * for both, which sent users to reinstall a binary that was fine.
 */
export type ProfileListResult =
  | { ok: true; profiles: ProfileSummary[] }
  | { ok: false; error: string };

/**
 * Runs `vett profiles --json` and parses the result. Caches the parsed
 * list briefly so the welcome view + profile picker can both read from
 * the same snapshot without spawning the CLI twice in quick succession.
 *
 * The cache is keyed on the cwd the CLI was run from, because the answer
 * depends on it — see runVettProfiles().
 */
export class ProfileService {
  private cached: { cwd: string; result: ProfileListResult } | null = null;
  private cacheUntil = 0;
  private static readonly CACHE_MS = 30_000;

  /** List installed profiles. Uses the in-memory cache unless `force`.
   *  Returns a result, not an array — see ProfileListResult for why. */
  async list(force = false): Promise<ProfileListResult> {
    const cwd = ProfileService.resolveCwd();
    if (!force && this.cached !== null && this.cached.cwd === cwd && Date.now() < this.cacheUntil) {
      return this.cached.result;
    }
    const result = await this.runVettProfiles(cwd);
    this.cached = { cwd, result };
    this.cacheUntil = Date.now() + ProfileService.CACHE_MS;
    return result;
  }

  /** Drop the cache. Call after the user installs a new profile or
   * edits one — the next list() will re-run the CLI. */
  invalidate(): void {
    this.cached = null;
    this.cacheUntil = 0;
  }

  /**
   * The directory `vett profiles` must be run from.
   *
   * MEASURED: 13 profiles listed from the repo root, 12 from anywhere
   * else. Vett resolves profiles `<cwd>` > `~/.vett` > install-dir, so
   * the cwd is an INPUT to the answer, not an incidental detail — and
   * execFile with no `cwd` inherits the extension host's, which is
   * wherever VS Code happened to be launched from. The picker could
   * therefore offer a workspace-local profile that the chat session,
   * running from the workspace folder, resolved differently — or offer
   * one it could not load at all.
   *
   * This mirrors `ChatPanelProvider.startVettSession()`'s own cwd
   * resolution, INCLUDING the homedir fallback for "no folder open", so
   * the list and the subsequent load agree.
   *
   * Known gap, deliberately not chased: a panel in worktree mode spawns
   * vett with the worktree path as its cwd. The worktree is a checkout
   * of the same HEAD, so a committed `profiles/` directory is identical
   * there; an UNCOMMITTED workspace-local profile is the one case where
   * the two can still disagree.
   */
  private static resolveCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private async runVettProfiles(cwd: string): Promise<ProfileListResult> {
    const config = vscode.workspace.getConfiguration('vett-chat');
    const configured = config.get<string>('vettPath', '');
    const resolved = resolveVettPath(configured);
    if (!resolved.path) {
      return {
        ok: false,
        error:
          'VETT binary not found, so the profile list could not be read. Searched:\n  ' +
          resolved.searched.join('\n  ') +
          '\nInstall vett, or set `vett-chat.vettPath` in VS Code settings.',
      };
    }
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(resolved.path, ['profiles', '--json'], {
        // The cwd is load-bearing, not cosmetic — see resolveCwd().
        cwd,
        // Generous-but-bounded timeout: discovery should be near-instant
        // (it just reads YAML), but a hung subprocess shouldn't block the
        // webview from rendering.
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }));
    } catch (err) {
      // Older vett (pre-`--json`), a non-existent cwd, a timeout, a
      // non-zero exit. All of these mean "we do not know what profiles
      // exist" — which is NOT the same as "there are none", and the
      // caller has to be able to tell the difference.
      return {
        ok: false,
        error: `\`${resolved.path} profiles --json\` failed in ${cwd}: ${(err as Error).message}`,
      };
    }
    try {
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) {
        return { ok: false, error: '`vett profiles --json` returned something that is not a JSON array.' };
      }
      return { ok: true, profiles: parsed as ProfileSummary[] };
    } catch (err) {
      return { ok: false, error: `Couldn't parse \`vett profiles --json\` output: ${(err as Error).message}` };
    }
  }
}
