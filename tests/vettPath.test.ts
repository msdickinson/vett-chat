import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveVettPath } from '../src/process/vettPath';

// Use posix joining for the Linux test fixtures so paths are
// reproducible regardless of which OS the tests run on.
const pjoin = path.posix.join;

describe('resolveVettPath', () => {
  // ── Configured path takes priority ─────────────────────────────────
  it('returns the configured path when it exists', () => {
    const r = resolveVettPath('/custom/path/vett', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '',
      exists: (p) => p === '/custom/path/vett',
    });
    expect(r.path).toBe('/custom/path/vett');
    expect(r.searched[0]).toBe('/custom/path/vett');
  });

  it('falls through when configured path is set but doesn\'t exist', () => {
    const r = resolveVettPath('/missing/vett', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '',
      exists: () => false,
    });
    expect(r.path).toBe(null);
    expect(r.searched).toContain('/missing/vett');
  });

  // ── ~/.dotnet/tools ────────────────────────────────────────────────
  it('finds the C# dotnet-tool install at ~/.dotnet/tools/vett', () => {
    const r = resolveVettPath('', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '',
      exists: (p) => p === pjoin('/home/user', '.dotnet', 'tools', 'vett'),
    });
    expect(r.path).toBe(pjoin('/home/user', '.dotnet', 'tools', 'vett'));
  });

  it('uses .exe on Windows', () => {
    const r = resolveVettPath('', {
      homeDir: 'C:\\Users\\user',
      platform: 'win32',
      pathEnv: '',
      exists: (p) => p.endsWith('vett.exe') && p.includes('.dotnet'),
    });
    expect(r.path).toContain('vett.exe');
  });

  // ── ~/go/bin (legacy) ──────────────────────────────────────────────
  it('falls back to legacy ~/go/bin/vett when dotnet-tools location empty', () => {
    const goBin = pjoin('/home/user', 'go', 'bin', 'vett');
    const r = resolveVettPath('', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '',
      exists: (p) => p === goBin,
    });
    expect(r.path).toBe(goBin);
  });

  // ── PATH lookup ────────────────────────────────────────────────────
  it('finds vett on PATH when the well-known dirs are empty', () => {
    const r = resolveVettPath('', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '/usr/bin:/usr/local/bin',
      exists: (p) => p === '/usr/local/bin/vett',
    });
    expect(r.path).toBe('vett'); // bare name; spawn() will resolve
    expect(r.searched).toContain('vett (via PATH)');
  });

  it('PATH lookup uses ; on win32', () => {
    const r = resolveVettPath('', {
      homeDir: 'C:\\Users\\user',
      platform: 'win32',
      pathEnv: 'C:\\Windows;C:\\Program Files\\vett',
      exists: (p) => p === 'C:\\Program Files\\vett\\vett.exe',
    });
    expect(r.path).toBe('vett.exe');
  });

  // ── Order matters ──────────────────────────────────────────────────
  it('prefers ~/.dotnet/tools over ~/go/bin when both exist', () => {
    const dotnet = pjoin('/home/user', '.dotnet', 'tools', 'vett');
    const go = pjoin('/home/user', 'go', 'bin', 'vett');
    const r = resolveVettPath('', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '',
      exists: (p) => p === dotnet || p === go,
    });
    expect(r.path).toBe(dotnet);
  });

  it('prefers configured path over everything', () => {
    const dotnet = pjoin('/home/user', '.dotnet', 'tools', 'vett');
    const r = resolveVettPath('/explicit/vett', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '/usr/bin',
      exists: (p) => p === '/explicit/vett' || p === dotnet || p === '/usr/bin/vett',
    });
    expect(r.path).toBe('/explicit/vett');
  });

  // ── Total miss ─────────────────────────────────────────────────────
  it('returns null path with full searched list when nothing matches', () => {
    const r = resolveVettPath('', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '/usr/bin:/usr/local/bin',
      exists: () => false,
    });
    expect(r.path).toBe(null);
    // Searched should include both well-known dirs + the PATH marker
    expect(r.searched.some(s => s.includes('.dotnet/tools'))).toBe(true);
    expect(r.searched.some(s => s.includes('go/bin'))).toBe(true);
    expect(r.searched.some(s => s.includes('via PATH'))).toBe(true);
  });

  // ── Defensive ──────────────────────────────────────────────────────
  it('handles empty PATH gracefully', () => {
    const r = resolveVettPath('', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '',
      exists: () => false,
    });
    expect(r.path).toBe(null);
  });

  it('skips fs.existsSync errors during PATH walk', () => {
    const r = resolveVettPath('', {
      homeDir: '/home/user',
      platform: 'linux',
      pathEnv: '/usr/bin:/non-existent',
      exists: (p) => {
        if (p.startsWith('/non-existent')) throw new Error('EACCES');
        return p === '/usr/bin/vett';
      },
    });
    expect(r.path).toBe('vett');
  });
});
