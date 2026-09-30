import { useEffect } from 'preact/hooks';
import { signal, computed } from '@preact/signals';
import vscode from '../vscode';
import type { HostToLauncher, LauncherSession, OpenSession } from '../../src/shared/types';

/** Sessions known to the host, sorted newest-first. */
const sessions = signal<LauncherSession[]>([]);
/** Chat panels currently open in the editor area. */
const openSessions = signal<OpenSession[]>([]);
/** Active profile name, surfaced as a small subtitle. */
const profile = signal('coding');
/** Free-text filter — matches against session title. */
const query = signal('');

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return sessions.value;
  return sessions.value.filter(
    (s) => s.title.toLowerCase().includes(q) || s.fileName.toLowerCase().includes(q),
  );
});

/**
 * Sidebar launcher. Lists past chat sessions, lets the user search,
 * spawn new chats, resume, or delete. Each "open" / "new chat" action
 * goes to the host, which materializes the chat as an editor-area
 * panel. The launcher itself never holds chat state.
 */
export function LauncherApp() {
  useEffect(() => {
    const handler = (event: MessageEvent<HostToLauncher>) => {
      const msg = event.data;
      if (msg.type === 'sessions') {
        sessions.value = msg.data.sessions;
        profile.value = msg.data.profile;
        openSessions.value = msg.data.openSessions ?? [];
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'launcherReady' });
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header: just the profile chip on its own row. VS Code already
          shows "Vett Chat: Sessions" in the view title bar above us, so
          repeating the brand inside the panel is pure noise. */}
      <div style={headerStyle}>
        <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>Profile</span>
        <button
          type="button"
          onClick={() => vscode.postMessage({ type: 'pickProfile' })}
          title={`Active profile: ${profile.value} — click to change`}
          style={profileChipStyle}
        >
          ● {profile.value}
        </button>
      </div>

      {/* Two ways in, deliberately unequal in weight. The plain button is
          what you press ninety times out of a hundred; "Custom" is the door
          to the team-shape step, and it earns its own affordance because
          until now the only way to run a differently-sized team was to
          author a whole second profile YAML. */}
      <div style={newChatRowStyle}>
        <button
          type="button"
          onClick={() => vscode.postMessage({ type: 'newChat' })}
          style={{ ...newChatBtnStyle, flex: 1 }}
          title={`Start a chat on the ${profile.value} profile as-is`}
        >
          + New Chat
        </button>
        <button
          type="button"
          onClick={() => vscode.postMessage({ type: 'newChatCustom' })}
          style={customChatBtnStyle}
          title="Pick a profile and set how many workers, how many at once, and how much memory - for this chat only"
        >
          Custom...
        </button>
      </div>

      <div style={{ padding: '4px 8px' }}>
        <input
          type="text"
          placeholder="Search sessions…"
          value={query.value}
          onInput={(e) => { query.value = (e.target as HTMLInputElement).value; }}
          style={searchStyle}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Open chats — chat panels currently in the editor area. Clicking
            a row reveals the panel rather than spawning a new one. */}
        {openSessions.value.length > 0 && (
          <>
            <div style={sectionHeaderStyle}>OPEN</div>
            {openSessions.value.map((s) => <OpenRow key={s.id} session={s} />)}
          </>
        )}

        {/* Past chats — the JSONL logs on disk, click to resume. */}
        {(openSessions.value.length > 0 || sessions.value.length > 0) && (
          <div style={sectionHeaderStyle}>PAST</div>
        )}
        {filtered.value.length === 0 ? (
          <div style={emptyStyle}>
            {sessions.value.length === 0
              ? 'No chats yet. Click + New Chat to start one.'
              : 'No past sessions match your search.'}
          </div>
        ) : (
          filtered.value.map((s) => <SessionRow key={s.path} session={s} />)
        )}
      </div>
    </div>
  );
}

interface SessionRowProps {
  session: LauncherSession;
}

function SessionRow({ session }: SessionRowProps) {
  const title = session.title || session.fileName;
  const ageLabel = relativeTime(session.mtimeMs);
  return (
    <div
      style={rowStyle}
      onClick={() => vscode.postMessage({ type: 'openSession', data: { path: session.path } })}
      onMouseOver={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-list-hoverBackground)'; }}
      onMouseOut={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    >
      <div style={titleColStyle}>
        <div style={titleStyle}>{title}</div>
        {session.turns > 0 && (
          <div style={subtitleStyle}>{session.turns} turn{session.turns === 1 ? '' : 's'}</div>
        )}
      </div>
      <div style={ageStyle}>{ageLabel}</div>
      <button
        type="button"
        title={`Delete "${title}" — JSONL log removed from disk`}
        onClick={(e) => {
          e.stopPropagation();
          // Browser confirm()/alert() are no-ops inside VS Code webviews
          // (the host blocks them), so the × button silently did nothing.
          // Skip the prompt and let the host route the request to a real
          // VS Code modal — see ChatViewProvider's deleteSession case.
          vscode.postMessage({ type: 'deleteSession', data: { path: session.path } });
        }}
        style={deleteBtnStyle}
      >
        ×
      </button>
    </div>
  );
}

interface OpenRowProps { session: OpenSession }
function OpenRow({ session }: OpenRowProps) {
  return (
    <div
      style={{ ...rowStyle, fontWeight: 'bold' }}
      onClick={() => vscode.postMessage({ type: 'revealOpenSession', data: { id: session.id } })}
      onMouseOver={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-list-hoverBackground)'; }}
      onMouseOut={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    >
      <span style={{ color: 'var(--vscode-charts-green)', marginRight: '4px' }}>●</span>
      <div style={titleColStyle}>
        <div style={titleStyle}>{session.title}</div>
      </div>
    </div>
  );
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 10px 6px',
  borderBottom: '1px solid var(--vscode-panel-border)',
};

const profileChipStyle = {
  padding: '2px 8px',
  background: 'transparent',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '12px',
  color: 'var(--vscode-foreground)',
  cursor: 'pointer',
  fontSize: '10px',
};

const newChatRowStyle = {
  display: 'flex',
  gap: '6px',
  margin: '8px',
};

const newChatBtnStyle = {
  padding: '6px 10px',
  background: 'var(--vscode-button-secondaryBackground, var(--vscode-button-background))',
  color: 'var(--vscode-button-secondaryForeground, var(--vscode-button-foreground))',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '13px',
  textAlign: 'left' as const,
};

const customChatBtnStyle = {
  ...newChatBtnStyle,
  textAlign: 'center' as const,
  flex: '0 0 auto',
  color: 'var(--vscode-descriptionForeground)',
};

const searchStyle = {
  width: '100%',
  padding: '4px 8px',
  background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border)',
  borderRadius: '3px',
  fontSize: '12px',
  boxSizing: 'border-box' as const,
  outline: 'none',
};

const sectionHeaderStyle = {
  padding: '8px 10px 4px',
  fontSize: '10px',
  letterSpacing: '0.08em',
  color: 'var(--vscode-descriptionForeground)',
  fontWeight: 'bold' as const,
};

const emptyStyle = {
  padding: '24px 16px',
  textAlign: 'center' as const,
  color: 'var(--vscode-descriptionForeground)',
  fontSize: '12px',
};

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 10px',
  cursor: 'pointer',
  borderBottom: '1px solid var(--vscode-panel-border)',
  fontSize: '12px',
};

const titleColStyle = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
};

const titleStyle = {
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
  color: 'var(--vscode-foreground)',
};

const subtitleStyle = {
  fontSize: '10px',
  color: 'var(--vscode-descriptionForeground)',
  marginTop: '1px',
};

const ageStyle = {
  fontSize: '10px',
  color: 'var(--vscode-descriptionForeground)',
  whiteSpace: 'nowrap' as const,
};

const deleteBtnStyle = {
  padding: '0 6px',
  background: 'transparent',
  border: 'none',
  color: 'var(--vscode-descriptionForeground)',
  cursor: 'pointer',
  fontSize: '14px',
  lineHeight: 1,
};
