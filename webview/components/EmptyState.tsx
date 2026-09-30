import vscode from '../vscode';
import { currentProfile, profile, messageText } from '../state/signals';
import { SLASH_COMMANDS } from './SlashCommands';

/**
 * Centered empty-state for a freshly-opened chat panel. Branded VETT
 * CHAT title, single tagline, active profile chip, and a few starter
 * suggestions that fill the textarea on click.
 *
 * Layout: large title at top, content
 * centered, input area handles the rest.
 */
export function EmptyState() {
  const cur = currentProfile.value;
  const ready = cur !== null && (cur.model || cur.provider !== 'local');

  return (
    <div style={containerStyle}>
      <div style={brandStyle}>VETT CHAT</div>
      <div style={taglineStyle}>
        Type a message to start, or <code>/help</code> to see commands.
      </div>

      {/* Profile chip */}
      <button
        type="button"
        onClick={() => vscode.postMessage({ type: 'pickProfile' })}
        title={cur ? `Click to swap profile` : `Profile "${profile.value}" not found`}
        style={profileChipStyle}
      >
        <span style={{ color: ready ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-yellow)' }}>●</span>
        <span style={{ fontWeight: 'bold' }}>{profile.value}</span>
        {cur?.model && (
          <span style={{ color: 'var(--vscode-descriptionForeground)' }}>· {cur.model}</span>
        )}
      </button>

      {cur?.tools.includes('finish') && (
        <div style={warnStyle}>
          This profile has the <code>finish</code> tool and will auto-terminate.
          Pick a chat-tuned profile (e.g. <code>coding</code>) for ongoing chats.
        </div>
      )}

      {/* Starter prompts. Click → fill the textarea so the user can
          edit before hitting send. Quick way to demo capabilities. */}
      <div style={startersHeaderStyle}>Try</div>
      <div style={startersGridStyle}>
        {STARTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { messageText.value = s; }}
            style={starterStyle}
            onMouseOver={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground)'; }}
            onMouseOut={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Slash command hint row */}
      <div style={cmdsHintStyle}>
        Slash commands: {SLASH_COMMANDS.map((c) => (
          <code key={c.name} style={cmdChipStyle}>{c.name}</code>
        ))}
      </div>
    </div>
  );
}

const STARTERS = [
  'What does this codebase do?',
  'List the files in the current folder.',
  'Run the tests and tell me what fails.',
  'Find every TODO comment.',
];

const containerStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  textAlign: 'center' as const,
  padding: '32px 16px',
  color: 'var(--vscode-foreground)',
};

const brandStyle = {
  fontSize: '22px',
  fontWeight: 'bold' as const,
  letterSpacing: '0.04em',
  marginBottom: '6px',
};

const taglineStyle = {
  color: 'var(--vscode-descriptionForeground)',
  fontSize: '13px',
  marginBottom: '20px',
};

const profileChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 10px',
  background: 'transparent',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '14px',
  color: 'var(--vscode-foreground)',
  cursor: 'pointer',
  fontSize: '12px',
  marginBottom: '14px',
};

const warnStyle = {
  padding: '6px 10px',
  fontSize: '11px',
  border: '1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-charts-yellow))',
  background: 'var(--vscode-inputValidation-warningBackground, transparent)',
  borderRadius: '4px',
  marginBottom: '14px',
  maxWidth: '420px',
};

const startersHeaderStyle = {
  fontSize: '11px',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--vscode-descriptionForeground)',
  marginTop: '8px',
  marginBottom: '6px',
};

const startersGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: '6px',
  width: '100%',
  maxWidth: '440px',
  marginBottom: '20px',
};

const starterStyle = {
  padding: '8px 10px',
  background: 'transparent',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '4px',
  color: 'var(--vscode-foreground)',
  cursor: 'pointer',
  fontSize: '12px',
  textAlign: 'left' as const,
  fontFamily: 'var(--vscode-font-family)',
};

const cmdsHintStyle = {
  fontSize: '11px',
  color: 'var(--vscode-descriptionForeground)',
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: '4px',
  alignItems: 'center',
  justifyContent: 'center',
  maxWidth: '440px',
};

const cmdChipStyle = {
  padding: '1px 6px',
  background: 'var(--vscode-textBlockQuote-background)',
  borderRadius: '3px',
  fontSize: '10px',
};
