import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatPanelProvider } from './ChatPanelProvider';
import { profileDetail } from './profileDetail';
import { ProfileService } from '../process/profileService';
import { listSessions, deleteSession } from '../process/sessionIndex';
import { TitleService } from '../process/titleService';
import { LauncherToHost, HostToLauncher } from '../shared/types';
import { customizeTeamShape } from './customizeTeam';

const SETTINGS_QUERY = '@ext:dickinsonbros.vett-chat';

/**
 * Sidebar webview provider. As of v0.4 the sidebar is a *launcher* — a
 * list of past chat sessions, a search input, and a "+ New Chat"
 * button. Chats themselves live in editor-area panels (see
 * ChatPanelProvider). Keeping the launcher zero-state means the
 * sidebar is fast to open and never holds a vett subprocess.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vett-chat.chatView';

  private webviewView?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private context: vscode.ExtensionContext;
  private profileService: ProfileService;
  private titleService: TitleService;
  private watcher?: fs.FSWatcher;
  private refreshDebounce?: NodeJS.Timeout;

  constructor(
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    profileService: ProfileService,
  ) {
    this.extensionUri = extensionUri;
    this.context = context;
    this.profileService = profileService;
    this.titleService = new TitleService(profileService);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => this.handleMessage(raw));
    // Re-pull the sessions list whenever the launcher becomes visible
    // again — backstop for cases where the file watcher missed an
    // event.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refreshLauncher();
    });
    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
      this.stopWatching();
    });
    this.startWatching();
  }

  /**
   * fs.watch the chat-sessions directory so the launcher gets live
   * updates when chat panels write events to their JSONL logs. We
   * debounce because each user_message + assistant_text + tool_call_*
   * triggers a write, and we don't need to re-read every session 30
   * times per turn.
   */
  private startWatching(): void {
    this.stopWatching();
    const dir = sessionsDir();
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, { persistent: false }, () => {
        if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
        this.refreshDebounce = setTimeout(() => this.refreshLauncher(), 250);
      });
    } catch {
      // fs.watch can fail on network shares. Falls back to the
      // visibility-change refresh; nothing to surface to the user.
    }
  }

  private stopWatching(): void {
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
      this.refreshDebounce = undefined;
    }
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* best effort */ }
      this.watcher = undefined;
    }
  }

  /** Push the current sessions list to the launcher. Triggered by the
   * launcher's `launcherReady` ping and after delete / new-chat ops. */
  refreshLauncher(): void {
    if (!this.webviewView) return;
    const indexed = listSessions();
    const sessions = indexed.map((s) => ({
      path: s.path,
      fileName: s.fileName,
      title: s.title,
      mtimeMs: s.mtimeMs,
      turns: s.turns,
    }));
    const profile = vscode.workspace.getConfiguration('vett-chat').get<string>('profile', 'coding');
    const openSessions = ChatPanelProvider.liveSessions();
    const msg: HostToLauncher = { type: 'sessions', data: { sessions, profile, openSessions } };
    this.webviewView.webview.postMessage(msg);
    // Kick off title generation for any sessions that don't yet have
    // an AI-summary sidecar. Results land asynchronously and trigger
    // another launcher refresh via the file watcher.
    void this.titleService.generateMissing(indexed.map((s) => s.path));
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
    const msg = raw as LauncherToHost;
    switch (msg.type) {
      case 'launcherReady':
        this.refreshLauncher();
        break;
      case 'newChat': {
        // If an idle empty panel already exists (no vett process started
        // yet), reveal it instead of stacking a new one. Otherwise
        // repeated "+ New Chat" clicks pile up panels in a split editor
        // group — each running its own session — which is what the
        // "click live and logs spins up more" report turned out to be.
        const idle = ChatPanelProvider.findIdle();
        if (idle) {
          idle.reveal();
        } else {
          ChatPanelProvider.openNew(this.context, this.profileService);
        }
        break;
      }
      case 'newChatCustom':
        // NEVER reuses an idle panel, unlike 'newChat' above. The team shape
        // is baked into the subprocess argv at spawn, so handing the user an
        // already-started panel would show the shape they picked while
        // running the one they didn't.
        await this.startNewSessionCustom();
        break;
      case 'openSession':
        if (msg.data?.path) {
          // If a panel for this exact session log is already open,
          // focus it instead of spawning a duplicate. Otherwise the
          // user ends up with two tabs ("Vett Chat" and "Vett Chat
          // (resume)") for the same JSONL — both replay the same
          // content, producing the "see its here twice now" report.
          const existing = ChatPanelProvider.liveSessions().find(
            (s) => s.sessionLogPath === msg.data.path,
          );
          if (existing) {
            ChatPanelProvider.revealById(existing.id);
          } else {
            ChatPanelProvider.openNew(this.context, this.profileService, {
              resumePath: msg.data.path,
              title: `Vett Chat (resume)`,
            });
          }
        }
        break;
      case 'deleteSession':
        if (msg.data?.path) {
          // Use VS Code's modal — webview window.confirm() is a no-op
          // (host blocks it) so the launcher × button used to silently
          // do nothing.
          const choice = await vscode.window.showWarningMessage(
            'Delete this chat session log?',
            { modal: true, detail: msg.data.path },
            'Delete',
          );
          if (choice === 'Delete') {
            deleteSession(msg.data.path);
            this.refreshLauncher();
          }
        }
        break;
      case 'pickProfile':
        await vscode.commands.executeCommand('vett-chat.pickProfile');
        // After picking, refresh so the new profile shows in the chip.
        this.refreshLauncher();
        break;
      case 'revealOpenSession':
        if (msg.data?.id) ChatPanelProvider.revealById(msg.data.id);
        break;
    }
  }

  /** Open the extension settings, used by the legacy command. */
  openSettings(): void {
    vscode.commands.executeCommand('workbench.action.openSettings', SETTINGS_QUERY);
  }

  /**
   * Legacy command (kept so existing keybindings / docs work). The
   * sidebar no longer holds a chat, so "new session" now means "open a
   * new chat in an editor tab".
   */
  startNewSession(): void {
    ChatPanelProvider.openNew(this.context, this.profileService);
  }

  /**
   * "New Chat (Custom)" - the Customize step, then a panel shaped by it.
   *
   * Backing out of the picker starts nothing at all. An empty panel left
   * behind by a cancelled configure would be indistinguishable from a
   * profile-default chat, which is the one thing this flow exists to make
   * visible.
   */
  async startNewSessionCustom(): Promise<void> {
    const current = vscode.workspace
      .getConfiguration('vett-chat')
      .get<string>('profile', 'coding');
    const chosen = await customizeTeamShape(this.profileService, current);
    if (!chosen) return;
    ChatPanelProvider.openNew(this.context, this.profileService, {
      profile: chosen.profile,
      overrides: chosen.overrides,
    });
  }

  /**
   * Legacy command. With chat-in-sidebar gone, "stop agent" maps to the
   * focused panel's stop action — but the launcher doesn't track which
   * panel has focus. Best we can do is forward to the active editor
   * panel via VS Code's command pipeline. Falls back to a no-op
   * notification so users don't think the command vanished silently.
   */
  stopAgent(): void {
    vscode.window.showInformationMessage(
      'Stop the agent from inside the chat panel (the Cancel button next to Send).',
    );
  }

  /** Re-show the welcome screen. With launcher-as-sidebar there's no
   * welcome view to bring back; route to the picker instead so the
   * user has a single discoverable affordance. */
  async showWelcome(): Promise<void> {
    await vscode.commands.executeCommand('vett-chat.openInEditor');
  }

  /** Profile picker — preserved as a public entry point so the
   * existing `vett-chat.pickProfile` command keeps working. */
  async showProfilePicker(): Promise<void> {
    const listed = await this.profileService.list(true);
    // "We couldn't ask vett" and "vett says there are none" need
    // different messages: the old code showed the install-vett advice for
    // both, which sent users to reinstall a working binary when the real
    // problem was a timeout or a bad cwd.
    if (!listed.ok) {
      vscode.window.showErrorMessage(`Vett Chat: couldn't list profiles — ${listed.error}`);
      return;
    }
    const profiles = listed.profiles;
    if (profiles.length === 0) {
      vscode.window.showWarningMessage(
        'No vett profiles found. Install vett or run `vett install defaults` in your workspace.',
      );
      return;
    }
    const config = vscode.workspace.getConfiguration('vett-chat');
    const current = config.get<string>('profile', 'coding');
    const items: vscode.QuickPickItem[] = profiles.map((p) => ({
      label: p.name,
      description: p.name === current ? '(current)' : undefined,
      detail: profileDetail(p),
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Pick a vett profile for chat sessions',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || picked.label === current) return;
    await config.update('profile', picked.label, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`vett-chat profile set to '${picked.label}'.`);
    this.refreshLauncher();
  }

  /**
   * Legacy: resume in sidebar. With sidebar-as-launcher there's no
   * sidebar chat. Route to the new-tab resume flow instead so old
   * keybindings keep doing something useful.
   */
  resumeInSidebar(resumePath: string): void {
    ChatPanelProvider.openNew(this.context, this.profileService, {
      resumePath,
      title: `Vett Chat (resume)`,
    });
  }

  dispose(): void {
    this.stopWatching();
    this.webviewView = undefined;
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'launcher.js'),
    );
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>Vett Chat</title>
  <style>
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    #root { height: 100vh; display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Resolve the chat-sessions directory honoring the user's config. */
function sessionsDir(): string {
  const config = vscode.workspace.getConfiguration('vett-chat');
  const customDir = config.get<string>('chatSessionLogDir', '');
  return customDir.trim() || path.join(os.homedir(), '.vett', 'chat-sessions');
}

function makeNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

