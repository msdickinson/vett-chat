import vscode from '../vscode';
import { profile, currentProfile, viewMode, chatMode, settingsOpen, sessionOverrides, worktreeStatus, worktreeMenuOpen } from '../state/signals';
import type { ViewMode } from '../state/signals';
import type { ChatMode } from '../../src/shared/types';

/**
 * Compact header strip shown above the chat. Surfaces the active profile
 * (one click to swap) and a "+" button that ends the current session
 * and starts fresh — without forcing the user to remember the Command
 * Palette commands.
 *
 * Multi-session tabs will replace this single profile chip with a tab
 * strip in v0.4. For now, single-session, but the slot is here.
 */
export function ChatHeader() {
  const cur = currentProfile.value;
  const tooltip = cur
    ? `${cur.name}\nmodel: ${cur.model || '—'}\nendpoint: ${cur.endpoint || '(provider default)'}`
    : `${profile.value} (profile not found)`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 6px',
        borderBottom: '1px solid var(--vscode-panel-border)',
        background: 'var(--vscode-sideBar-background)',
        flexShrink: 0,
        fontSize: '12px',
      }}
    >
      <button
        type="button"
        onClick={() => vscode.postMessage({ type: 'pickProfile' })}
        title={tooltip}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '2px 8px',
          background: 'transparent',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: '12px',
          color: 'var(--vscode-foreground)',
          cursor: 'pointer',
          fontSize: '11px',
          maxWidth: '60%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: 'var(--vscode-charts-green)' }}>●</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {profile.value}
        </span>
        {cur?.model && (
          <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
            · {cur.model}
          </span>
        )}
      </button>

      {/* Worktree chip — clickable, opens a dropdown with Apply /
          Discard / Open in new window. Hidden when worktree mode is
          off (a "main tree" chip would just add visual noise without
          adding info — the absence of the chip IS the signal). */}
      <WorktreeChip />

      <div style={{ flex: 1 }} />

      {/* Plan / Execute mode toggle. Two modes; clicking flips and
          tells the host to respawn vett with the new --mode flag.
          Plan mode strips write-capable tools and adds a "produce a
          markdown plan, don't modify state" system-prompt addendum. */}
      <div style={segmentStyle}>
        <ModeSegment label="Exec" target="execute" tip="Execute mode (default) — full tool access. Agent can edit files and run commands." />
        <ModeSegment label="Plan" target="plan"    tip="Plan mode — read-only design phase. Vett removes terminal + finish, prepends a 'produce a markdown plan, don't modify state' addendum. Toggle back to Exec to apply the plan." />
      </div>

      {/* Four-way segmented toggle: Live (curated), Logs (compact
          event timeline), Raw (full event firehose, no truncation),
          Gantt (AI Timeline's gantt chart embedded for the current
          session). */}
      <div style={segmentStyle}>
        <ViewSegment label="Live"  target="live"  tip="User-friendly chat (default)" />
        <ViewSegment label="Logs"  target="logs"  tip="Chronological event timeline (compact tool previews)" />
        <ViewSegment label="Raw"   target="raw"   tip="Same timeline but with full untruncated data" />
        <ViewSegment label="Gantt" target="gantt" tip="AI Timeline gantt chart for the current session" />
      </div>

      <button
        type="button"
        onClick={() => { settingsOpen.value = !settingsOpen.value; }}
        title={
          Object.keys(sessionOverrides.value).length > 0
            ? `Session overrides active (${Object.keys(sessionOverrides.value).length}). Click to edit.`
            : 'Session settings: temperature, top-p, max iterations, prompt append…'
        }
        style={{
          ...iconBtnStyle,
          background: Object.keys(sessionOverrides.value).length > 0
            ? 'var(--vscode-charts-yellow)'
            : iconBtnStyle.background,
          color: Object.keys(sessionOverrides.value).length > 0
            ? 'var(--vscode-editor-background)'
            : iconBtnStyle.color,
          fontWeight: Object.keys(sessionOverrides.value).length > 0 ? 600 : 'normal',
        }}
      >
        ⚙
      </button>

      <button
        type="button"
        onClick={() => vscode.postMessage({ type: 'newSession' })}
        title="Start a new chat session (clears history)"
        style={iconBtnStyle}
      >
        + New
      </button>
    </div>
  );
}

interface SegmentProps { label: string; target: ViewMode; tip: string; }
function ViewSegment({ label, target, tip }: SegmentProps) {
  const active = viewMode.value === target;
  return (
    <button
      type="button"
      onClick={() => { viewMode.value = target; }}
      title={tip}
      style={{
        padding: '2px 8px',
        background: active ? 'var(--vscode-button-background)' : 'transparent',
        color: active ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
        border: 'none',
        cursor: 'pointer',
        fontSize: '11px',
      }}
    >
      {label}
    </button>
  );
}

interface ModeSegmentProps { label: string; target: ChatMode; tip: string; }
function ModeSegment({ label, target, tip }: ModeSegmentProps) {
  const active = chatMode.value === target;
  return (
    <button
      type="button"
      onClick={() => {
        if (chatMode.value === target) return;
        // Optimistic flip — host echoes a `chatModeChanged` to confirm.
        // If the host fails to respawn, the user sees the toggle in
        // its new position and the next message either lands in the
        // new mode (success) or surfaces an error banner.
        chatMode.value = target;
        vscode.postMessage({ type: 'setChatMode', data: { mode: target } });
      }}
      title={tip}
      style={{
        padding: '2px 8px',
        background: active
          ? (target === 'plan'
              ? 'var(--vscode-charts-yellow)'
              : 'var(--vscode-button-background)')
          : 'transparent',
        color: active
          ? (target === 'plan'
              ? 'var(--vscode-editor-background)'
              : 'var(--vscode-button-foreground)')
          : 'var(--vscode-foreground)',
        border: 'none',
        cursor: 'pointer',
        fontSize: '11px',
        fontWeight: active ? 600 : 'normal',
      }}
    >
      {label}
    </button>
  );
}

const segmentStyle = {
  display: 'flex',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '3px',
  overflow: 'hidden' as const,
};

const iconBtnStyle = {
  padding: '2px 8px',
  background: 'transparent',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '3px',
  color: 'var(--vscode-foreground)',
  cursor: 'pointer',
  fontSize: '11px',
};

/** Chip + dropdown for the active worktree. The dropdown closes when
 *  any item is clicked OR when the chip is clicked again. We don't add
 *  a click-outside listener because settings/profile menus don't
 *  either — keeps interaction symmetry with the rest of the header. */
function WorktreeChip() {
  const ws = worktreeStatus.value;
  if (!ws.enabled) return null;
  const open = worktreeMenuOpen.value;
  const modeLabel = ws.mode === 'git-worktree' ? 'git worktree' : 'copy mode';
  const tip = `${modeLabel} · ${ws.path}\nbranch: ${ws.branch ?? '—'}\nworkspace: ${ws.workspaceRoot}\n\nClick for actions.`;
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => { worktreeMenuOpen.value = !open; }}
        title={tip}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '2px 8px',
          background: open ? 'var(--vscode-button-secondaryBackground, transparent)' : 'transparent',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: '12px',
          color: 'var(--vscode-foreground)',
          cursor: 'pointer',
          fontSize: '11px',
        }}
      >
        <span style={{ fontSize: '10px' }}>📁</span>
        <span>{ws.shortId ?? 'worktree'}</span>
        <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
          · {ws.mode === 'git-worktree' ? 'git' : 'copy'}
        </span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 20,
            background: 'var(--vscode-menu-background, var(--vscode-editorWidget-background))',
            border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            minWidth: '260px',
            fontSize: '12px',
            padding: '4px 0',
          }}
        >
          <WorktreeMenuItem
            label="Review changes per file…"
            description="Per-file diff with Accept / Reject — picks one at a time"
            onClick={() => {
              worktreeMenuOpen.value = false;
              vscode.postMessage({ type: 'worktreeReviewChanges' });
            }}
          />
          <WorktreeMenuItem
            label="Apply all changes to main tree…"
            description="Copy every modified file into your workspace as uncommitted changes"
            onClick={() => {
              worktreeMenuOpen.value = false;
              vscode.postMessage({ type: 'worktreeApply' });
            }}
          />
          <WorktreeMenuItem
            label="Open worktree in new window"
            description="Inspect agent edits side-by-side with your workspace"
            onClick={() => {
              worktreeMenuOpen.value = false;
              vscode.postMessage({ type: 'worktreeOpenInWindow' });
            }}
          />
          <div style={{ borderTop: '1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border))', margin: '4px 0' }} />
          <WorktreeMenuItem
            label="Restore to checkpoint…"
            description="Roll worktree files back to a snapshot taken before an earlier turn"
            onClick={() => {
              worktreeMenuOpen.value = false;
              vscode.postMessage({ type: 'restoreCheckpoint' });
            }}
          />
          <div style={{ borderTop: '1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border))', margin: '4px 0' }} />
          <WorktreeMenuItem
            label="Discard worktree"
            description="Throw away agent edits; chat keeps running directly in your workspace"
            danger
            onClick={() => {
              worktreeMenuOpen.value = false;
              vscode.postMessage({ type: 'worktreeDiscard' });
            }}
          />
        </div>
      )}
    </div>
  );
}

interface WorktreeMenuItemProps {
  label: string;
  description: string;
  danger?: boolean;
  onClick: () => void;
}
function WorktreeMenuItem({ label, description, danger, onClick }: WorktreeMenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        padding: '6px 10px',
        cursor: 'pointer',
        color: danger ? 'var(--vscode-errorForeground, var(--vscode-foreground))' : 'var(--vscode-foreground)',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >
      <div style={{ fontWeight: 500 }}>{label}</div>
      <div style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '10px', marginTop: '2px' }}>
        {description}
      </div>
    </button>
  );
}
