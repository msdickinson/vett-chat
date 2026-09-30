# Extension-host integration test

```
npm run test:integration
```

## What this covers that `npm test` cannot

`npm test` (vitest) runs in plain node with the `vscode` module
mocked. **We wrote that mock**, so it agrees with us by construction. It is
structurally unable to observe:

- `activate()` throwing — a bad import, a missing `dist/` file
- a command declared in `contributes.commands` that nothing registers.
  It appears in the Command Palette and fails with *"command not found"*
  only when a human clicks it.
- a contributed view id that does not resolve
- a contributed setting with no readable default

This runs the extension in a **real VS Code extension host** and checks all
of the above. First green run: 2026-08-26, 8/8, activation 52–947 ms.

## Proving the harness itself works

A green result from a ruler you wrote is not evidence until you have seen it
go red. This one was verified two-sided on 2026-08-26 by adding a
`vett-chat.deliberatelyUnregistered` entry to `contributes.commands` and
re-running:

```
FAIL  all 20 declared commands are registered
      MISSING: vett-chat.deliberatelyUnregistered
7/8 checks passed        (exit 1)
```

Do that again if you ever change what the harness asserts.

## The VS Code binary

Resolution order is `$VSCODE_BIN`, then the platform's usual install path.

⛔ **Never point `VSCODE_BIN` at `code` or `code.cmd`.** That shim spawns the
real Electron process and **returns immediately with exit 0**. Measured
2026-08-26: the run looked green, no host had started, and no `result.json`
existed. Use the Electron binary directly (`Code.exe` on Windows). This is
also why `run.js` treats *the presence of `result.json`* — not the exit code
— as proof the runner executed.

## Known environment failure

If VS Code has a pending update, its Inno Setup installer holds the
`vscode-updating` mutex and the binary refuses to start:

```
Error: Code is currently being updated. Please wait for the update to
complete before launching.
```

That is an environment problem, not a test failure. Close VS Code, let the
update finish, and re-run. Encountered on this machine 2026-08-26 — the
first green run used a portable VS Code extracted to a scratch directory to
avoid touching the developer's own installation.

Nothing here writes to your real VS Code profile: `run.js` creates a
throwaway `--user-data-dir`, `--extensions-dir`, and workspace under the
system temp directory and removes them on success.
