import * as vscode from 'vscode';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { ChatPanelProvider } from './providers/ChatPanelProvider';
import { ProfileService } from './process/profileService';
import { detectAll, type DetectionResult } from './onboarding/detect';
import * as fs from 'fs';
import * as path from 'path';
import { writeLocalProfile, writeCloudProfile, profilePath } from './onboarding/profileWriter';
import { CLOUD_PROVIDERS, testCloudKey, type CloudProviderInfo } from './onboarding/cloudOnboarding';
import { InlineEditController } from './inlineEdit/inlineEditController';
import { registerSmartActions } from './smartActions/smartActions';
import { peekFirstUserMessage } from './process/sessionLogParser';

let chatProvider: ChatViewProvider;
const profileService = new ProfileService();
const inlineEditController = new InlineEditController();

export function activate(context: vscode.ExtensionContext) {
  chatProvider = new ChatViewProvider(context.extensionUri, context, profileService);

  // ChatPanelProvider keeps a static map of open panels; the launcher
  // wants to refresh whenever that set changes (panel opened, panel
  // closed) so the "Open chats" group stays accurate without polling.
  ChatPanelProvider.onChange = () => chatProvider.refreshLauncher();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
    ),
  );

  // Webview-panel serializer: lets chat tabs survive a VS Code window
  // reload. VS Code calls deserializeWebviewPanel for each previously
  // open panel; we re-attach a ChatPanelProvider to it, treating the
  // saved sessionLogPath as a resume so the conversation picks up.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('vett-chat.chatPanel', {
      async deserializeWebviewPanel(panel, state) {
        ChatPanelProvider.attach(panel, context, profileService, state);
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.newSession', () => {
      chatProvider.startNewSession();
    }),
  );

  // The same thing, but stopping at the Customize step: pick a profile, set
  // how many of each role, how many may work at once, and how much memory the
  // leader gets - for this chat only, leaving the profile YAML untouched.
  //
  // THIS IS THE SURFACE THAT MAKES RUNTIME TEAM SHAPING REACHABLE. The flags
  // have existed since 2026-08-28, but the extension spawned `--profile X`
  // and nothing else, so from VS Code every run was profile defaults and no
  // dialog ever asked otherwise.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.newSessionCustom', async () => {
      await chatProvider.startNewSessionCustom();
    }),
  );

  // Project-instructions bootstrap: writes a starter VETT.md at the
  // workspace root if one doesn't already exist (won't overwrite),
  // then opens it for the user to fill in. Vett's hierarchical loader
  // picks up the file on next chat-spawn — no setting to flip.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.initProjectRules', async () => {
      await initProjectRules(context);
    }),
  );

  // Lets a user re-trigger the "no project rules found" nudge after
  // they dismissed it, e.g. they want to add a VETT.md after all.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.resetProjectRulesNudge', async () => {
      await context.workspaceState.update('vett-chat.projectRulesNudgeDismissed', undefined);
      vscode.window.showInformationMessage('Vett Chat: project-rules nudge reset for this workspace. Open a new chat to see it again.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.stopAgent', () => {
      chatProvider.stopAgent();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.showWelcome', () => {
      chatProvider.showWelcome();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.pickProfile', () => {
      chatProvider.showProfilePicker();
    }),
  );

  // New: open a chat as its own editor-area tab. Each invocation spawns
  // an independent panel + subprocess, so multiple chats run in
  // parallel — that's what makes the extension multi-session.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.openInEditor', () => {
      ChatPanelProvider.openNew(context, profileService);
    }),
  );

  // Open a fresh chat panel with the textarea pre-populated. Backs
  // the "Iterate in chat" path from inline-edit (#7) and future
  // hand-off-to-chat surfaces ("Explain with Vett" code-lens, etc).
  // The prefill replays the moment the webview emits 'ready', so the
  // user sees a populated input as soon as the panel opens.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.openInEditorWithPrefill', (text: string) => {
      ChatPanelProvider.openNew(context, profileService, { prefillText: text ?? '' });
    }),
  );

  // Escape hatch for users who ended up with many stacked chat panels
  // (debugging spree, accidental rapid +New clicks, etc). Closes every
  // chat panel — the user can then start clean from the launcher.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.closeAllPanels', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Close every Vett Chat tab?',
        { modal: true },
        'Close All',
      );
      if (choice !== 'Close All') return;
      const n = ChatPanelProvider.closeAll();
      vscode.window.showInformationMessage(`Closed ${n} chat panel${n === 1 ? '' : 's'}.`);
    }),
  );

  // New: resume a past chat. Prompts for which JSONL to resume from
  // (showing the most recent N from ~/.vett/chat-sessions/), then
  // opens a panel that seeds the agent from that conversation.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.resumeSession', async () => {
      const picked = await pickPastSession();
      if (!picked) return;
      ChatPanelProvider.openNew(context, profileService, {
        resumePath: picked.path,
        title: `Vett Chat (resume: ${picked.label})`,
      });
    }),
  );

  // Resume in the sidebar instead of a new editor tab. Kills the
  // current sidebar session, starts a new one with --resume.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.resumeInSidebar', async () => {
      const picked = await pickPastSession();
      if (!picked) return;
      // Make sure the sidebar view is visible before resuming, otherwise
      // the post-init message lands on a hidden webview.
      await vscode.commands.executeCommand('vett-chat.chatView.focus');
      chatProvider.resumeInSidebar(picked.path);
    }),
  );

  // Region-screenshot helper. Triggers the platform's snipping tool —
  // the snip lands on the OS clipboard and the user pastes into the
  // chat input where the existing paste handler picks it up. Cross-
  // platform routing chosen for "tools that exist on a fresh install":
  //   - Windows 10/11: ms-screenclip:// (Snipping Tool's URI scheme;
  //     installed by default).
  //   - macOS: `screencapture -i -c` (built-in; -c writes to clipboard).
  //   - Linux: `gnome-screenshot -a -c` is most common but distro-
  //     dependent — fall back to a notification with manual instructions.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.captureScreenshot', async () => {
      const { spawn } = await import('child_process');
      const platform = process.platform;
      try {
        if (platform === 'win32') {
          // Snipping Tool URI handler. Returns immediately; user does
          // the snip, image lands on clipboard, paste back into chat.
          spawn('cmd', ['/c', 'start', 'ms-screenclip:'], { detached: true, stdio: 'ignore' }).unref();
          vscode.window.showInformationMessage('Snip the region you want; then paste (Ctrl+V) into the chat input.');
        } else if (platform === 'darwin') {
          // -i = interactive region selection; -c = copy to clipboard
          // (don't write a file). Synchronous spawn so the user can
          // paste right away when it returns.
          spawn('screencapture', ['-i', '-c'], { stdio: 'ignore' }).on('close', () => {
            vscode.window.showInformationMessage('Snip captured to clipboard. Paste (Cmd+V) into the chat input to attach.');
          });
        } else {
          // Linux is fragmented — try gnome-screenshot first, then
          // fall back to instructions. Most desktop envs ship with
          // their own tool; the user can wire up a different one.
          const tool = spawn('gnome-screenshot', ['-a', '-c'], { stdio: 'ignore' });
          tool.on('error', () => {
            vscode.window.showWarningMessage(
              'No screenshot tool found. Install gnome-screenshot, or use your DE\'s snip hotkey, then paste into the chat.',
            );
          });
          tool.on('close', () => {
            vscode.window.showInformationMessage('Snip captured. Paste (Ctrl+V) into the chat input to attach.');
          });
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Couldn't launch screenshot tool: ${(e as Error).message}`);
      }
    }),
  );

  // Inline edit (Cmd+I / Ctrl+I): select code in the editor → hotkey →
  // type instruction → review proposal in side-by-side diff → Apply /
  // Cancel / Iterate. Backed by the C# `vett edit` subcommand which
  // does a single LLM call with no agent loop. Operates on the user's
  // real file (NOT a chat panel's worktree) — the hotkey lives in the
  // editor, the change should land where the cursor is.
  inlineEditController.register(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.inlineEdit', async () => {
      await inlineEditController.run();
    }),
  );

  // Smart actions (#8): "✨ Edit with Vett" CodeLens above functions /
  // methods / classes, plus a "Fix with Vett: <diag>" QuickFix code
  // action on every diagnostic. Both surfaces drive the same
  // InlineEditController.runOnRange() the Cmd+I path uses, so the
  // Diff → Apply / Cancel / Iterate flow is uniform across entry
  // points. Gated by `vett-chat.smartActionsEnabled` (default true).
  registerSmartActions(context, inlineEditController);

  // Onboarding: auto-detect local-model servers (Ollama / LM Studio /
  // vLLM) on the user's box, walk them through picking a model, and
  // write a working profile YAML to ~/.vett/profiles/. Designed so a
  // first-time user can go from "extension installed" to "first chat
  // works" without ever opening a YAML file. Cloud providers
  // (OpenAI/Anthropic/Google) are out of scope for this command —
  // they need an API key flow that's not implemented here.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.detectLocalModels', async () => {
      await runLocalModelOnboarding(profileService);
    }),
  );

  // Cloud provider setup: pick provider → paste key → live test → write
  // profile + stash key in SecretStorage. The actual key never lives in
  // the profile YAML — vett reads via env var, which the host injects
  // from SecretStorage at spawn time (ChatPanelProvider.preloadCloudSecrets).
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.setupCloudProvider', async () => {
      await runCloudProviderOnboarding(context, profileService);
    }),
  );

  // Unified onboarding entrypoint — what the WelcomeView button calls.
  // Branches into local-detect or cloud-setup based on user choice.
  context.subscriptions.push(
    vscode.commands.registerCommand('vett-chat.runOnboardingWizard', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Auto-detect local servers', description: 'Probe Ollama / LM Studio / vLLM on standard ports', value: 'local' as const },
          { label: 'Connect to OpenAI', description: 'Paste your OpenAI API key', value: 'openai' as const },
          { label: 'Connect to Anthropic', description: 'Paste your Anthropic (Claude) API key', value: 'anthropic' as const },
          { label: 'Connect to Google (Gemini)', description: 'Paste your Google AI Studio API key', value: 'google' as const },
        ],
        { placeHolder: 'How would you like to set up Vett Chat?' },
      );
      if (!pick) return;
      if (pick.value === 'local') {
        await runLocalModelOnboarding(profileService);
        return;
      }
      const provider = CLOUD_PROVIDERS.find((p) => p.id === pick.value);
      if (provider) {
        await runCloudProviderOnboarding(context, profileService, provider);
      }
    }),
  );

  // Ensure cleanup on deactivation.
  context.subscriptions.push({
    dispose: () => chatProvider?.dispose(),
  });
}

/** Probe → endpoint pick → model pick → write profile → switch active
 *  profile. All UI is VS Code native (QuickPick, withProgress, toasts);
 *  no extra webview surface. Errors surface as warning toasts and a
 *  short note about how to recover by editing the YAML by hand. */
async function runLocalModelOnboarding(profileService: ProfileService): Promise<void> {
  const detected = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Vett Chat: probing for local model servers…' },
    async () => detectAll(),
  );

  if (detected.length === 0) {
    vscode.window.showWarningMessage(
      'No local model servers detected on common ports (Ollama 11434, LM Studio 1234, vLLM 8000/8001). ' +
      'Start one and try again, or edit ~/.vett/profiles/ to point at a remote endpoint.',
    );
    return;
  }

  // Endpoint pick — one row per detected server. When only one was
  // found we still show the picker so the user can confirm + see what
  // we found before any disk write happens.
  const endpointPick = await vscode.window.showQuickPick(
    detected.map((d) => ({
      label: d.label,
      description: d.endpointForVett,
      detail: d.models.slice(0, 3).join(', ') + (d.models.length > 3 ? ', …' : ''),
      result: d,
    } satisfies vscode.QuickPickItem & { result: DetectionResult })),
    { placeHolder: 'Pick a local model server' },
  );
  if (!endpointPick) return;
  const chosen = (endpointPick as { result: DetectionResult }).result;

  // Model pick — flat list, sorted alphabetically. Default selection
  // bias: prefer something that smells like a coding model when present.
  const sortedModels = [...chosen.models].sort((a, b) => a.localeCompare(b));
  const codingHint = sortedModels.find((m) => /coder|coding|code/i.test(m));
  const modelPick = await vscode.window.showQuickPick(
    sortedModels.map((m) => ({
      label: m,
      description: m === codingHint ? '(coding-tuned, likely best fit)' : '',
    })),
    { placeHolder: 'Pick a model' },
  );
  if (!modelPick) return;

  // Write profile + flip the active setting so the next chat opens
  // against the new endpoint without any further user action.
  const profileName = `${chosen.kind}-detected`;
  if (!await confirmOverwriteProfile(profileName)) return;
  let written: string;
  try {
    written = writeLocalProfile({
      name: profileName,
      endpoint: chosen.endpointForVett,
      model: modelPick.label,
      source: chosen.label,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to write profile: ${(e as Error).message}`);
    return;
  }

  await vscode.workspace.getConfiguration('vett-chat').update(
    'profile', profileName, vscode.ConfigurationTarget.Global,
  );
  profileService.invalidate();

  const action = await vscode.window.showInformationMessage(
    `Created profile '${profileName}' (${modelPick.label} @ ${chosen.endpointForVett}). Active profile updated.`,
    'Open Profile YAML', 'Start a chat',
  );
  if (action === 'Open Profile YAML') {
    const doc = await vscode.workspace.openTextDocument(written);
    await vscode.window.showTextDocument(doc);
  } else if (action === 'Start a chat') {
    await vscode.commands.executeCommand('vett-chat.openInEditor');
  }
}

/** Cloud-provider onboarding: pick provider (or use the supplied one)
 *  → paste key → live-test → save key in SecretStorage → write a chat-
 *  tuned profile YAML → flip the active profile setting. Errors at each
 *  step surface as a warning toast and abort the flow without writing
 *  anything; the user can retry from a clean state. */
async function runCloudProviderOnboarding(
  context: vscode.ExtensionContext,
  profileService: ProfileService,
  preselected?: CloudProviderInfo,
): Promise<void> {
  let provider = preselected;
  if (!provider) {
    const pick = await vscode.window.showQuickPick(
      CLOUD_PROVIDERS.map((p) => ({ label: p.label, description: p.envVarName, detail: p.consoleUrl, value: p.id })),
      { placeHolder: 'Pick a cloud provider' },
    );
    if (!pick) return;
    provider = CLOUD_PROVIDERS.find((p) => p.id === pick.value);
    if (!provider) return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `${provider.label} API key`,
    prompt: `Paste your ${provider.label} API key. It'll be stored in VS Code's SecretStorage and injected into vett at spawn time as ${provider.envVarName} — never written to the profile YAML.`,
    placeHolder: 'Get one at ' + provider.consoleUrl,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim().length > 0 ? null : 'Key is required (or Esc to cancel)'),
  });
  if (!apiKey) return;

  const tested = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Vett Chat: testing ${provider.label} key…` },
    async () => testCloudKey(provider!, apiKey),
  );
  if (!tested.ok) {
    const action = await vscode.window.showErrorMessage(
      `Key didn't validate — ${tested.message}`,
      'Try Again', 'Cancel',
    );
    if (action === 'Try Again') {
      // Re-enter the flow with the same preselected provider so the
      // user doesn't need to re-pick. Tail call is fine; depth bounded
      // by user patience.
      return runCloudProviderOnboarding(context, profileService, provider);
    }
    return;
  }

  // Persist the key under SecretStorage. Single key per provider —
  // running the wizard twice for the same provider replaces the old key.
  try {
    await context.secrets.store(`vett-chat.${provider.envVarName.toLowerCase()}`, apiKey);
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to save key to SecretStorage: ${(e as Error).message}`);
    return;
  }

  // Write profile YAML. Single canonical name per provider — re-running
  // the wizard prompts before overwriting so a hand-edited profile
  // doesn't silently lose its tweaks.
  const profileName = `${provider.id}-onboarding`;
  if (!await confirmOverwriteProfile(profileName)) return;
  let written: string;
  try {
    written = writeCloudProfile({
      name: profileName,
      providerYaml: provider.providerYaml,
      providerLabel: provider.label,
      model: provider.defaultModel,
      endpoint: provider.baseEndpoint,
      envVarName: provider.envVarName,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to write profile: ${(e as Error).message}`);
    return;
  }

  await vscode.workspace.getConfiguration('vett-chat').update(
    'profile', profileName, vscode.ConfigurationTarget.Global,
  );
  profileService.invalidate();

  const action = await vscode.window.showInformationMessage(
    `Created profile '${profileName}' (${provider.label} · ${provider.defaultModel}). Active profile updated.`,
    'Open Profile YAML', 'Start a chat',
  );
  if (action === 'Open Profile YAML') {
    const doc = await vscode.workspace.openTextDocument(written);
    await vscode.window.showTextDocument(doc);
  } else if (action === 'Start a chat') {
    await vscode.commands.executeCommand('vett-chat.openInEditor');
  }
}

/**
 * QuickPick over recent JSONL session logs. Pulls metadata (first user
 * message, mtime) so the picker is browsable rather than just a list of
 * timestamped filenames.
 */
async function pickPastSession(): Promise<{ label: string; path: string } | undefined> {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const config = vscode.workspace.getConfiguration('vett-chat');
  const customDir = config.get<string>('chatSessionLogDir', '');
  const dir = customDir.trim() || path.join(os.homedir(), '.vett', 'chat-sessions');
  if (!fs.existsSync(dir)) {
    vscode.window.showInformationMessage(`No past chats found at ${dir}.`);
    return undefined;
  }
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 50);
  if (files.length === 0) {
    vscode.window.showInformationMessage(`No past chats found at ${dir}.`);
    return undefined;
  }
  // Plain QuickPickItems — custom fields like `path` aren't reliably
  // round-tripped through VS Code's picker (some hosts strip extras),
  // so we look the picked entry back up by label after selection.
  const items: vscode.QuickPickItem[] = files.map((f) => ({
    label: f.name,
    description: new Date(f.mtime).toLocaleString(),
    detail: peekFirstUserMessage(f.path) || '(no user messages logged)',
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a past chat to resume',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  const match = files.find((f) => f.name === picked.label);
  return match ? { label: match.name, path: match.path } : undefined;
}

/** Modal-prompt before overwriting an existing profile YAML.
 *  Returns true when it's safe to write — either the file doesn't
 *  exist, or the user explicitly approved overwriting. False when
 *  the user picked Cancel or the modal returned undefined. */
async function confirmOverwriteProfile(name: string): Promise<boolean> {
  const target = profilePath(name);
  if (!fs.existsSync(target)) return true;
  const choice = await vscode.window.showWarningMessage(
    `Profile '${name}' already exists at ${target}. Overwrite it?`,
    { modal: true, detail: 'Any hand edits to the existing YAML will be lost.' },
    'Overwrite',
  );
  return choice === 'Overwrite';
}

/**
 * Bootstrap a starter VETT.md at the workspace root. Won't overwrite
 * an existing file (any of AGENTS.md / VETT.md / .vett/AGENTS.md /
 * .vett/VETT.md counts as "vett already has rules"); if any exists we
 * just open whichever one we found instead of writing a new one.
 *
 * Drops a deliberately-skinny template so the user fills it in with
 * their own conventions instead of editing around boilerplate.
 */
async function initProjectRules(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('Vett Chat: open a folder first — VETT.md needs a workspace root to live at.');
    return;
  }
  const root = folders[0].uri.fsPath;
  const candidates = [
    path.join(root, 'AGENTS.md'),
    path.join(root, 'VETT.md'),
    path.join(root, '.vett', 'AGENTS.md'),
    path.join(root, '.vett', 'VETT.md'),
  ];
  const existing = candidates.find((p) => fs.existsSync(p));
  if (existing) {
    const doc = await vscode.workspace.openTextDocument(existing);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Vett Chat: opened existing project rules at ${path.basename(existing)}.`);
    return;
  }
  const target = path.join(root, 'VETT.md');
  const template = `# Vett Project Instructions

Notes vett should keep in mind for every chat in this workspace.
Vett's loader picks this up automatically — no setting to flip.

## Repo conventions

- (e.g. folder names lowercase-hyphenated; .NET projects under \`src/\`/\`tests/\`)
- (anything an outsider couldn't infer from the code in 30 seconds)

## Build / test commands

- (e.g. \`dotnet test MySolution.slnx -c Release\`)
- (e.g. \`npm test\` from \`web/\` for TS)

## Definition of done

- (what "task complete" actually requires — formatter clean, tests added, etc.)

## Rules / preferences

- (things you've corrected vett on more than once)
`;
  try {
    fs.writeFileSync(target, template, 'utf8');
  } catch (err) {
    vscode.window.showErrorMessage(`Vett Chat: couldn't write VETT.md — ${(err as Error).message}`);
    return;
  }
  // Clear the dismissal flag so future chats don't keep nudging if the
  // user manually dismissed before. (No-op if it wasn't dismissed.)
  await context.workspaceState.update('vett-chat.projectRulesNudgeDismissed', undefined);
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage('Vett Chat: created VETT.md at the workspace root. Edit it, then start a new chat to apply.');
}

export function deactivate() {
  // Kill every live vett subprocess FIRST. Nothing else in the extension
  // owns a child process, and `ChatPanelProvider.dispose()` — which does
  // the stop for a user-closed tab — never runs on this path, because
  // VS Code does not fire `panel.onDidDispose` when the whole host is
  // going down. Without this call, closing VS Code with N chats open
  // left N vett processes (plus whatever they had spawned) running.
  ChatPanelProvider.shutdownAll();
  chatProvider?.dispose();
}
