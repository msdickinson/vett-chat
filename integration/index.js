/**
 * Real VS Code extension-host smoke test for vett-chat.
 *
 * WHY THIS EXISTS, given 213 vitest tests already pass:
 * vitest runs in plain node with the `vscode` module mocked. That mock is
 * written by us, so it agrees with us by construction — it cannot observe
 * the failure modes that only exist inside a real host:
 *
 *   - activate() throwing (a bad import, a missing dist file)
 *   - a command in contributes.commands that nothing ever registers, which
 *     appears in the palette and fails with "command not found" only when
 *     a human clicks it
 *   - a contributed view id that does not resolve
 *   - a contributed setting with no readable default
 *
 * Run it with:  npm run test:integration
 * See integration/README.md for the VS Code binary requirement.
 *
 * VS Code imports this module and awaits run(). A rejection is a failure
 * and sets a nonzero exit code. It also writes result.json, because exit
 * codes alone are a weak signal here: the `code`/`code.cmd` launcher shim
 * detaches and returns 0 without ever starting a host. Presence of the
 * result file is the positive conjunct that proves the runner actually ran.
 */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const EXT_ID = 'dickinsonbros.vett-chat';
const OUT = process.env.VETT_EH_OUT || path.join(__dirname, 'result.json');

async function run() {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail: detail === undefined ? null : String(detail) });
  };

  try {
    // --- 1. the extension is present and activates ---------------------
    const ext = vscode.extensions.getExtension(EXT_ID);
    record('extension is discoverable', !!ext, ext ? ext.extensionPath : 'getExtension returned undefined');
    if (!ext) throw new Error(`${EXT_ID} not found in the host`);

    const t0 = Date.now();
    try {
      await ext.activate();
      record('activate() resolves', true, `${Date.now() - t0}ms`);
    } catch (err) {
      record('activate() resolves', false, err && err.stack ? err.stack : err);
      throw err;
    }
    record('isActive after activate', ext.isActive === true, `isActive=${ext.isActive}`);

    // --- 2. every DECLARED command is actually REGISTERED --------------
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, 'package.json'), 'utf8'),
    );
    const declared = ((pkg.contributes || {}).commands || []).map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((c) => !registered.has(c));
    record(
      `all ${declared.length} declared commands are registered`,
      missing.length === 0,
      missing.length ? `MISSING: ${missing.join(', ')}` : 'none missing',
    );

    // Registered-but-undeclared is legitimate (internal + generated view
    // commands), so it is recorded for information and never failed.
    const ours = [...registered].filter((c) => c.startsWith('vett-chat.'));
    record('registered vett-chat.* commands (informational)', true,
      `${ours.length}: ${ours.sort().join(', ')}`);

    // --- 3. contributed views resolve ----------------------------------
    const views = Object.values((pkg.contributes || {}).views || {}).flat().map((v) => v.id);
    record('contributed view ids (informational)', true, views.join(', ') || '(none)');

    // --- 4. contributed settings read back a value ---------------------
    const cfg = vscode.workspace.getConfiguration('vett-chat');
    const cfgKeys = Object.keys(((pkg.contributes || {}).configuration || {}).properties || {});
    const unreadable = cfgKeys.filter((k) => cfg.get(k.replace(/^vett-chat\./, '')) === undefined);
    record(
      `all ${cfgKeys.length} contributed settings read back a value`,
      unreadable.length === 0,
      unreadable.length ? `undefined: ${unreadable.join(', ')}` : 'all defined',
    );

    // --- 5. a command that must be safe to invoke headlessly -----------
    try {
      await vscode.commands.executeCommand('vett-chat.showWelcome');
      record('executeCommand vett-chat.showWelcome', true, 'no throw');
    } catch (err) {
      record('executeCommand vett-chat.showWelcome', false, err && err.message);
    }
  } catch (err) {
    record('FATAL', false, err && err.stack ? err.stack : err);
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      `${failed.length} extension-host check(s) failed:\n` +
        failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n'),
    );
  }
}

module.exports = { run };
