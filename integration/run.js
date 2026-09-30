#!/usr/bin/env node
/**
 * Launcher for the extension-host smoke test (integration/index.js).
 *
 * Deliberately has NO npm dependency. @vscode/test-electron would be the
 * conventional choice, but it downloads its own VS Code on first run, and
 * this repo is developed on a machine that already has one.
 *
 * ⛔ DO NOT point this at `code` / `code.cmd`. That shim spawns the real
 * Electron process and returns IMMEDIATELY with exit 0 — measured
 * 2026-08-26 — so the run looks green while no host ever started. Always
 * launch the Electron binary (`Code.exe` on Windows) directly, and treat
 * the result.json file, not the exit code, as proof the runner executed.
 *
 * Binary resolution order:
 *   1. $VSCODE_BIN                      (explicit override)
 *   2. the platform's usual install path
 * If neither exists, this exits 2 (config error, nothing ran) rather than
 * 1, matching vett's own convention.
 *
 * NOTE: if VS Code has a pending update, its installer holds an Inno Setup
 * mutex and the binary refuses to start with "Code is currently being
 * updated." That is an environment problem, not a test failure — the error
 * is surfaced verbatim. Close VS Code, let the update finish, and re-run.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RESULT = path.join(__dirname, 'result.json');

function resolveBin() {
  if (process.env.VSCODE_BIN) return process.env.VSCODE_BIN;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
      : ['/usr/share/code/code', '/usr/bin/code'];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

const bin = resolveBin();
if (!bin || !fs.existsSync(bin)) {
  console.error(
    'Could not find a VS Code binary.\n' +
    'Set VSCODE_BIN to the Electron binary (Code.exe on Windows, NOT code.cmd).',
  );
  process.exit(2);
}

// A scratch workspace + user-data-dir so the run never touches the
// developer's real profile, extensions, or open editors.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-chat-eh-'));
fs.rmSync(RESULT, { force: true });

console.log(`VS Code binary : ${bin}`);
console.log(`Extension      : ${ROOT}`);
console.log(`Scratch        : ${scratch}\n`);

const r = spawnSync(bin, [
  `--extensionDevelopmentPath=${ROOT}`,
  `--extensionTestsPath=${__dirname}`,
  `--user-data-dir=${path.join(scratch, 'udd')}`,
  `--extensions-dir=${path.join(scratch, 'ext')}`,
  '--disable-gpu',
  '--disable-workspace-trust',
  '--new-window',
  path.join(scratch, 'ws'),
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VETT_EH_OUT: RESULT },
  timeout: 5 * 60 * 1000,
});

// The positive conjunct. Without this, a launcher that silently no-ops
// is indistinguishable from a clean pass.
if (!fs.existsSync(RESULT)) {
  console.error('The host never wrote result.json — the test module did not run.\n');
  console.error('--- stdout ---\n' + (r.stdout || ''));
  console.error('--- stderr ---\n' + (r.stderr || ''));
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
let failed = 0;
for (const res of results) {
  if (!res.ok) failed++;
  console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${res.name}`);
  if (res.detail) console.log(`      ${res.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) {
  console.error('--- stderr ---\n' + (r.stderr || ''));
}
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
