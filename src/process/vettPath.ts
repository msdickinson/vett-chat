import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface VettPathResolution {
  /** The resolved binary path, or null if nothing was found AND PATH
   * lookup also missed. Caller can use `null` to render an actionable
   * "not found" error to the user. */
  path: string | null;
  /** Every location that was checked, in order. Useful for the error
   * message when nothing matched. */
  searched: string[];
}

export interface ResolveOptions {
  /** Override `os.homedir()` — used by tests. */
  homeDir?: string;
  /** Override `process.platform` — used by tests. */
  platform?: NodeJS.Platform;
  /** Override `process.env.PATH` — used by tests. */
  pathEnv?: string;
  /** Override fs.existsSync — used by tests. */
  exists?: (p: string) => boolean;
}

/**
 * Locate the vett binary. Search order:
 *
 *   1. `configured` — explicit `vett-chat.vettPath` setting from the user
 *   2. `~/.dotnet/tools/vett[.exe]` — where `dotnet tool install --global` puts the C# build
 *   3. `~/go/bin/vett[.exe]` — legacy Go install location, kept for v0.x users
 *   4. PATH — bare name; spawn() will resolve at run time
 *
 * Returns `path: null` when nothing matches AND PATH lookup also fails.
 * In that case `searched` describes everything we tried — surface it to
 * the user verbatim so they know exactly where to fix the install.
 *
 * Pure function: all I/O dependencies (homedir, platform, PATH, fs) are
 * injectable. Real callers pass nothing; tests pass mocks.
 */
export function resolveVettPath(configured: string, opts: ResolveOptions = {}): VettPathResolution {
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  const exists = opts.exists ?? fs.existsSync;
  // Use the platform-appropriate path module so tests can simulate
  // Linux/macOS layouts on a Windows host (and vice versa).
  const join = platform === 'win32' ? path.win32.join : path.posix.join;

  const exe = platform === 'win32' ? 'vett.exe' : 'vett';
  const searched: string[] = [];

  if (configured) {
    searched.push(configured);
    if (exists(configured)) { return { path: configured, searched }; }
  }

  const dotnetTools = join(homeDir, '.dotnet', 'tools', exe);
  searched.push(dotnetTools);
  if (exists(dotnetTools)) { return { path: dotnetTools, searched }; }

  const goBin = join(homeDir, 'go', 'bin', exe);
  searched.push(goBin);
  if (exists(goBin)) { return { path: goBin, searched }; }

  searched.push(`${exe} (via PATH)`);
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    try {
      if (exists(join(dir, exe))) { return { path: exe, searched }; }
    } catch { /* directory doesn't exist or perm denied — keep looking */ }
  }

  return { path: null, searched };
}
