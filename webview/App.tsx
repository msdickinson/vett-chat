import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import vscode from './vscode';
import type { HostToWebview } from '../src/shared/types';
import { ChatView } from './components/ChatView';
import {
  connected,
  connectionError,
  connectionErrorKind,
  connectionErrorDetails,
  cwd,
  profile,
  profiles,
  sessionLogPath,
  showWelcome,
  handleVettEvent,
  resetChatState,
  seedHistory,
  replaySeedEnvelopes,
  toolCardDensity,
  chatMode,
  sessionOverrides,
  mentionFiles,
  mentionSymbols,
  mentionSelectionPreview,
  mentionProblemsCount,
  mentionGit,
  worktreeStatus,
  useWorktreeSetting,
  panelWorktreeMode,
  contextWindowTokens,
  dispatchViewStyle,
  rewindToTurn,
  rewindToMessageIndex,
  messageText,
  voiceInputState,
} from './state/signals';

export function App() {
  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      try {
        dispatchHostMessage(msg);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        captured.value = [
          ...captured.value,
          `handler error processing ${msg?.type}: ${e.message}\n${e.stack ?? ''}`,
        ];
      }
    };

    function dispatchHostMessage(msg: HostToWebview) {
      switch (msg.type) {
        case 'init':
          cwd.value = msg.data.cwd;
          profile.value = msg.data.profile;
          connected.value = msg.data.connected;
          if (msg.data.profiles) {
            profiles.value = msg.data.profiles;
          }
          // welcomeSeen is only sent on the first init from onWebviewReady;
          // subsequent inits (from startNewSession) leave it undefined and
          // we don't want to re-show the welcome view.
          if (msg.data.welcomeSeen !== undefined) {
            showWelcome.value = !msg.data.welcomeSeen;
          }
          // Persist sessionLogPath if provided.
          if (msg.data.sessionLogPath) {
            sessionLogPath.value = msg.data.sessionLogPath;
          }
          // Density preference for tool-call cards. Optional in the
          // payload so older host bundles paired with a newer webview
          // gracefully fall back to whatever signal default is in use.
          if (msg.data.toolCardDensity) {
            toolCardDensity.value = msg.data.toolCardDensity;
          }
          // Per-panel chat mode (execute / plan). Optional for the
          // same reason as toolCardDensity — older host won't send it.
          if (msg.data.chatMode) {
            chatMode.value = msg.data.chatMode;
          }
          // Per-session overrides (temperature / top-p / etc.). The
          // Settings UI binds against this signal; init re-broadcasts
          // current values whenever applySettings runs so a stale form
          // can rehydrate.
          if (msg.data.sessionOverrides) {
            sessionOverrides.value = msg.data.sessionOverrides;
          }
          if (msg.data.worktree) {
            worktreeStatus.value = msg.data.worktree;
          }
          if (msg.data.useWorktreeSetting !== undefined) {
            useWorktreeSetting.value = msg.data.useWorktreeSetting;
          }
          if (typeof msg.data.contextWindowTokens === 'number' && msg.data.contextWindowTokens > 0) {
            contextWindowTokens.value = msg.data.contextWindowTokens;
          }
          if (msg.data.dispatchViewStyle === 'log' || msg.data.dispatchViewStyle === 'structured') {
            dispatchViewStyle.value = msg.data.dispatchViewStyle;
          }
          if (msg.data.panelMode) {
            panelWorktreeMode.value = msg.data.panelMode;
          }
          // Don't wipe message history just because a new subprocess
          // spawned — the chat log is the user's history and should
          // persist across subprocess restarts. The full reset is
          // reserved for explicit "newSession" actions where the user
          // genuinely wants a blank slate (handled separately).
          // We do clear stale connection-error state on a successful
          // connect so a banner from a previous failed session goes
          // away as soon as the new session is up.
          if (msg.data.connected) {
            connectionError.value = null;
            connectionErrorKind.value = null;
            connectionErrorDetails.value = null;
          }
          break;
        case 'vettEvent':
          handleVettEvent(msg.data);
          break;
        case 'connectionStatus':
          connected.value = msg.data.connected;
          connectionError.value = msg.data.error ?? null;
          connectionErrorKind.value = msg.data.kind ?? null;
          connectionErrorDetails.value = msg.data.details ?? null;
          break;
        case 'sessionLogPath':
          // Dedicated update — fires once after each session_start so the
          // UI knows where the JSONL log lives, even if the 'init' message
          // arrived before the log file was created.
          sessionLogPath.value = msg.data.path;
          break;
        case 'profilesRefreshed':
          // Pushed when the host re-runs `vett profiles --json` (e.g.
          // after the user picks a different profile or installs a new
          // one). Welcome view + picker re-render against the new list.
          profiles.value = msg.data.profiles;
          break;
        case 'resetChat':
          // Explicit reset triggered by `vett-chat.newSession` command
          // (or similar user-initiated action). Wipes message history,
          // tool calls, iteration counters, and session log path so the
          // next session starts on a true blank slate.
          resetChatState();
          break;
        case 'seedHistory':
          // Resume path: the host parsed a JSONL log and is replaying
          // the prior user/assistant messages so the chat panel shows
          // what was said before. Vett's --resume separately seeds the
          // agent's conversation context — this is the UI half.
          seedHistory(msg.data.messages);
          break;
        case 'seedFromLog':
          // Richer resume: replay the full envelope stream from the
          // JSONL through the same pipeline as live events. Brings back
          // the Raw / Logs / Gantt views and any inline dispatch cards
          // that seedHistory's text-only path couldn't reconstruct.
          replaySeedEnvelopes(msg.data.envelopes);
          break;
        case 'persistState':
          // Save the panel id + session log path so VS Code can hand
          // them back to our serializer after a window reload. Without
          // this call the panel restores empty; with it, the chat
          // resumes from the same JSONL.
          vscode.setState(msg.data);
          break;
        case 'settingsChanged':
          // Live-applied when the user changes a vett-chat.* setting.
          // Each field is optional so future settings can land here
          // without bumping the protocol or breaking older bundles.
          if (msg.data.toolCardDensity) {
            toolCardDensity.value = msg.data.toolCardDensity;
          }
          if (typeof msg.data.contextWindowTokens === 'number' && msg.data.contextWindowTokens > 0) {
            contextWindowTokens.value = msg.data.contextWindowTokens;
          }
          if (msg.data.dispatchViewStyle === 'log' || msg.data.dispatchViewStyle === 'structured') {
            dispatchViewStyle.value = msg.data.dispatchViewStyle;
          }
          break;
        case 'chatModeChanged':
          // Confirms a mode flip the host applied (typically right
          // after the user toggled in the header). Keeps the signal
          // in sync if the optimistic local update was rolled back
          // somewhere unexpected.
          chatMode.value = msg.data.mode;
          break;
        case 'worktreeStatus':
          worktreeStatus.value = msg.data.worktree;
          break;
        case 'useWorktreeSettingChanged':
          // Host saw the workspace setting flip (either via our drawer
          // toggle or an external edit to settings.json). Update the
          // signal so the drawer reflects current state. Current panel
          // keeps its captured mode unchanged — see panelWorktreeMode.
          useWorktreeSetting.value = msg.data.value;
          break;
        case 'rewindConversation':
          // Host-initiated UI rewind. Slices messages + tool calls +
          // dispatches to before the chosen turn / message. Files-side
          // restore (if requested) is a separate host-side path; this
          // handler only touches webview state.
          if (msg.data.mode === 'turn') {
            rewindToTurn(msg.data.userTurn);
          } else {
            rewindToMessageIndex(msg.data.index);
          }
          break;
        case 'prefillInput': {
          // Programmatic chat-input pre-fill. Used by voice input
          // (Whisper transcript), iterate-in-chat handoff, and any
          // future "send to chat" surface. Append vs replace controlled
          // by the data flag; the webview's textarea is bound to the
          // signal so the change shows up immediately.
          const cur = messageText.value;
          const incoming = msg.data.text ?? '';
          if (msg.data.append && cur.length > 0) {
            messageText.value = cur.endsWith(' ') ? cur + incoming : cur + ' ' + incoming;
          } else {
            messageText.value = incoming;
          }
          break;
        }
        case 'voiceInputStatus':
          voiceInputState.value = msg.data.state;
          break;
        case 'mentionContext':
          // Response to a `requestMentionContext` post — refreshes the
          // @-menu's file list, symbols, selection preview, problems
          // counts, and git availability. Multiple keystrokes can race;
          // we just take the latest reply since stale results are
          // harmless (the menu's own filter narrows them anyway).
          mentionFiles.value = msg.data.files;
          mentionSymbols.value = msg.data.symbols;
          mentionSelectionPreview.value = msg.data.selectionPreview;
          mentionProblemsCount.value = msg.data.problemsCount;
          mentionGit.value = msg.data.git;
          break;
      }
    }

    window.addEventListener('message', handler);

    // Signal to the extension that the webview is ready.
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <>
      <ErrorOverlay />
      <ChatView />
    </>
  );
}

// Globally captured JS errors / unhandled promise rejections, shown
// inline at the top of the panel so we don't have to dig in the
// VS Code Webview Developer Tools to see why the UI froze. Especially
// useful when the chat appears to hang mid-dispatch — silent JS
// errors stop signal updates dead, but until now they only logged
// to the webview's console which is hidden by default.
const captured = signal<string[]>([]);

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    const msg = `${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ''}`;
    captured.value = [...captured.value, msg];
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error
      ? `${e.reason.message}\n${e.reason.stack ?? ''}`
      : String(e.reason);
    captured.value = [...captured.value, `Unhandled promise rejection: ${reason}`];
  });
}

function ErrorOverlay() {
  const [, force] = useState(0);
  useEffect(() => captured.subscribe(() => force((n) => n + 1)), []);
  if (captured.value.length === 0) return null;
  return (
    <div style={{
      padding: '6px 10px',
      background: 'var(--vscode-inputValidation-errorBackground)',
      color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-foreground))',
      borderBottom: '2px solid var(--vscode-charts-red)',
      fontFamily: 'var(--vscode-editor-font-family)',
      fontSize: '11px',
      maxHeight: '200px',
      overflow: 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
        <strong>JS error{captured.value.length === 1 ? '' : `s (${captured.value.length})`} — UI may be frozen</strong>
        <button
          type="button"
          onClick={() => { captured.value = []; }}
          style={{ background: 'transparent', border: '1px solid currentColor', color: 'inherit', cursor: 'pointer', padding: '0 6px', fontSize: '10px' }}
        >dismiss</button>
      </div>
      {captured.value.map((m, i) => (
        <pre key={i} style={{ margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{m}</pre>
      ))}
    </div>
  );
}

// Per-mount debug id is exported and rendered inside ChatHeader so
// it doesn't disturb the chat panel's flex layout.
export const MOUNT_ID = Math.random().toString(36).slice(2, 7);
