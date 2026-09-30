/**
 * SettingsView — full-panel form for per-session profile overrides.
 *
 * Sits as an overlay above the chat content (toggled by the gear in
 * ChatHeader / via `settingsOpen`). Each field corresponds to a CLI
 * flag on `vett chat` and is layered on top of the active profile YAML
 * at subprocess-spawn time.
 *
 * Apply respawns the vett subprocess with the new flags. Nothing is
 * persisted to disk in v1 — closing the panel forgets the overrides.
 * "Save as new profile" (write a fresh YAML) is intentionally deferred;
 * persistence today happens by editing the profile YAML directly.
 *
 * Local form state lives in Preact-internal signals so the user can
 * tweak fields without triggering re-renders elsewhere; we only post
 * applySettings on click.
 */

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import vscode from '../vscode';
import {
  settingsOpen,
  sessionOverrides,
  currentProfile,
  profile,
  useWorktreeSetting,
} from '../state/signals';
import type { SessionOverrides } from '../../src/shared/types';
// Value import, not just a type: teamArgs.ts is deliberately free of any
// `vscode` import so it can run in the extension host, in vitest, AND here in
// the webview bundle. One implementation of the rules, three callers.
import { describeTeamOverrides, mergeSettingsOverrides } from '../../src/process/teamArgs';

// Local form state — mirrors sessionOverrides at open time. We use
// strings for numeric fields so blank input stays blank (rather than
// snapping to 0) and we can validate on submit.
const formTemperature = signal<string>('');
const formTopP = signal<string>('');
const formMaxIterations = signal<string>('');
const formTimeoutMinutes = signal<string>('');
const formSystemPromptAppend = signal<string>('');
// Permission overrides — empty string means "use profile default."
type PermValue = '' | 'auto' | 'ask' | 'deny';
const formPermRead = signal<PermValue>('');
const formPermEdit = signal<PermValue>('');
const formPermTermSafe = signal<PermValue>('');
const formPermTermUnsafe = signal<PermValue>('');
const formPermMcp = signal<PermValue>('');
const formPermOther = signal<PermValue>('');

/** Hydrate the form from the latest sessionOverrides whenever the
 *  drawer opens. Without this, opening the drawer a second time after
 *  Apply would still show the previous edits because we keep local
 *  signals across mount/unmount. */
function syncFormFromSignal() {
  const o = sessionOverrides.value;
  formTemperature.value = o.temperature !== undefined ? String(o.temperature) : '';
  formTopP.value = o.topP !== undefined ? String(o.topP) : '';
  formMaxIterations.value = o.maxIterations !== undefined ? String(o.maxIterations) : '';
  formTimeoutMinutes.value = o.timeoutMinutes !== undefined ? String(o.timeoutMinutes) : '';
  formSystemPromptAppend.value = o.systemPromptAppend ?? '';
  formPermRead.value = (o.permissionRead as PermValue) ?? '';
  formPermEdit.value = (o.permissionEdit as PermValue) ?? '';
  formPermTermSafe.value = (o.permissionTerminalSafe as PermValue) ?? '';
  formPermTermUnsafe.value = (o.permissionTerminalUnsafe as PermValue) ?? '';
  formPermMcp.value = (o.permissionMcp as PermValue) ?? '';
  formPermOther.value = (o.permissionOther as PermValue) ?? '';
}

export function SettingsView() {
  if (!settingsOpen.value) return null;

  // Re-hydrate every time the drawer becomes visible.
  useEffect(() => {
    syncFormFromSignal();
  }, [settingsOpen.value]);

  const close = () => { settingsOpen.value = false; };

  const apply = () => {
    const overrides: SessionOverrides = {};
    const t = parseFloat(formTemperature.value);
    if (formTemperature.value.trim() !== '' && Number.isFinite(t)) overrides.temperature = t;
    const p = parseFloat(formTopP.value);
    if (formTopP.value.trim() !== '' && Number.isFinite(p)) overrides.topP = p;
    const mi = parseInt(formMaxIterations.value, 10);
    if (formMaxIterations.value.trim() !== '' && Number.isFinite(mi) && mi > 0) overrides.maxIterations = mi;
    const tm = parseInt(formTimeoutMinutes.value, 10);
    if (formTimeoutMinutes.value.trim() !== '' && Number.isFinite(tm) && tm > 0) overrides.timeoutMinutes = tm;
    if (formSystemPromptAppend.value.trim().length > 0) overrides.systemPromptAppend = formSystemPromptAppend.value;
    if (formPermRead.value) overrides.permissionRead = formPermRead.value;
    if (formPermEdit.value) overrides.permissionEdit = formPermEdit.value;
    if (formPermTermSafe.value) overrides.permissionTerminalSafe = formPermTermSafe.value;
    if (formPermTermUnsafe.value) overrides.permissionTerminalUnsafe = formPermTermUnsafe.value;
    if (formPermMcp.value) overrides.permissionMcp = formPermMcp.value;
    if (formPermOther.value) overrides.permissionOther = formPermOther.value;
    // The host merges the team shape back on (mergeSettingsOverrides) and
    // echoes a fresh init, but do it locally as well so the read-only "Team
    // for this chat" block below does not blink out and back between the
    // post and the echo.
    sessionOverrides.value = mergeSettingsOverrides(sessionOverrides.value, overrides);
    vscode.postMessage({ type: 'applySettings', data: { overrides } });
    settingsOpen.value = false;
  };

  const reset = () => {
    // Reset clears the fields THIS DRAWER OWNS. The team shape is not one
    // of them: it was chosen at start, it is already baked into the running
    // subprocess, and there is no control here that could put it back.
    sessionOverrides.value = mergeSettingsOverrides(sessionOverrides.value, {});
    formTemperature.value = '';
    formTopP.value = '';
    formMaxIterations.value = '';
    formTimeoutMinutes.value = '';
    formSystemPromptAppend.value = '';
    formPermRead.value = '';
    formPermEdit.value = '';
    formPermTermSafe.value = '';
    formPermTermUnsafe.value = '';
    formPermMcp.value = '';
    formPermOther.value = '';
    vscode.postMessage({ type: 'applySettings', data: { overrides: {} } });
  };

  const cur = currentProfile.value;
  const hasOverrides = Object.keys(sessionOverrides.value).length > 0;
  // Empty string when the chat runs profile defaults, so the block below is
  // absent rather than showing an empty "Team" heading on an ordinary chat.
  // When the resolved profile is in hand it carries its roster, so this
  // renders only the flags that would actually survive validation — the same
  // check the spawn path runs. Falling back to the bare name keeps the block
  // working before the profile list has loaded.
  const teamLine = describeTeamOverrides(sessionOverrides.value, cur ?? { name: profile.value });

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <div style={headerStyle}>
          <strong style={{ fontSize: '13px' }}>Session Settings</strong>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={close} style={closeBtnStyle} title="Close (changes not applied)">×</button>
        </div>

        <div style={bodyStyle}>
          <p style={mutedStyle}>
            Per-session overrides on top of the active profile. Applied as CLI flags
            when the chat (re)spawns; nothing is written to disk. Closing this panel
            without clicking Apply discards edits.
          </p>

          {teamLine && (
            <Section title="Team for this chat">
              <div style={teamShapeStyle}>{teamLine}</div>
              <p style={{ ...mutedStyle, margin: '6px 0 0' }}>
                Chosen when this chat was started with <strong>Custom…</strong>, and
                passed to vett as-is. It stays put when you Apply or Reset above —
                start another Custom chat to change it.
              </p>
            </Section>
          )}

          <Section title="Workspace">
            <div style={fieldStyle}>
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={useWorktreeSetting.value}
                  onChange={(e) => {
                    const v = (e.target as HTMLInputElement).checked;
                    useWorktreeSetting.value = v;
                    // Persists to workspace `settings.json` via the host.
                    // Takes effect on the next chat — current panel keeps
                    // its captured mode (panelWorktreeMode).
                    vscode.postMessage({ type: 'setUseWorktreeSetting', data: { value: v } });
                  }}
                />
                <span>Use isolated worktree for new chats</span>
              </label>
              <div style={hintStyle}>
                When on, vett edits land in <code style={inlineCodeStyle}>~/.vett/worktrees/&lt;panel-id&gt;/</code> and your source tree stays clean until you click <strong>Apply changes to main tree</strong> in the worktree-chip dropdown. When off, edits go directly into your workspace.
                {' '}Toggling respawns vett for this chat; in-flight turns are interrupted but message history is preserved.
                {' '}For non-git monorepos, isolation falls back to a recursive copy and can be slow — leave off in that case.
              </div>
            </div>
          </Section>

          <Section title="Profile">
            <div style={fieldStyle}>
              <label style={labelStyle}>Active</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontFamily: 'var(--vscode-editor-font-family)' }}>
                  {profile.value}
                </span>
                {cur?.model && (
                  <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '11px' }}>
                    · {cur.model}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => vscode.postMessage({ type: 'pickProfile' })}
                  style={subtleBtnStyle}
                >
                  Change…
                </button>
              </div>
              <div style={hintStyle}>
                Profile YAML is the source of truth for endpoint, model, API key,
                tools, and the system prompt. Use Change… to pick a different one.
              </div>
            </div>
          </Section>

          <Section title="Sampling">
            <div style={fieldStyle}>
              <label style={labelStyle}>Temperature</label>
              <input
                type="number"
                step="0.05"
                min="0"
                max="2"
                value={formTemperature.value}
                onInput={(e) => { formTemperature.value = (e.target as HTMLInputElement).value; }}
                placeholder={cur ? '(profile default)' : ''}
                style={inputStyle}
              />
              <div style={hintStyle}>0 = deterministic, 1 = balanced, 2 = wild. Blank = use profile.</div>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Top-p</label>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={formTopP.value}
                onInput={(e) => { formTopP.value = (e.target as HTMLInputElement).value; }}
                placeholder="(profile default)"
                style={inputStyle}
              />
              <div style={hintStyle}>Nucleus sampling cutoff. Blank = profile / provider default.</div>
            </div>
          </Section>

          <Section title="Budget">
            <div style={fieldStyle}>
              <label style={labelStyle}>Max iterations</label>
              <input
                type="number"
                step="1"
                min="1"
                value={formMaxIterations.value}
                onInput={(e) => { formMaxIterations.value = (e.target as HTMLInputElement).value; }}
                placeholder="(profile default)"
                style={inputStyle}
              />
              <div style={hintStyle}>Hard cap on agent loop iterations for this chat.</div>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Timeout (minutes)</label>
              <input
                type="number"
                step="1"
                min="1"
                value={formTimeoutMinutes.value}
                onInput={(e) => { formTimeoutMinutes.value = (e.target as HTMLInputElement).value; }}
                placeholder="(profile default)"
                style={inputStyle}
              />
              <div style={hintStyle}>Per-session wall-clock timeout.</div>
            </div>
          </Section>

          <Section title="Prompt">
            <div style={fieldStyle}>
              <label style={labelStyle}>System prompt append</label>
              <textarea
                value={formSystemPromptAppend.value}
                onInput={(e) => { formSystemPromptAppend.value = (e.target as HTMLTextAreaElement).value; }}
                placeholder="One-off instructions appended to the profile's system prompt. Example: 'Respond in Spanish.'"
                rows={5}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--vscode-editor-font-family)' }}
              />
              <div style={hintStyle}>
                Appended after VETT.md / AGENTS.md so the model weighs it most.
                Blank = no addendum.
              </div>
            </div>
          </Section>

          <Section title="Permissions">
            <div style={hintStyle}>
              Per-kind tool-call gates layered on top of the active profile.
              <code style={inlineCodeStyle}>auto</code> = run without prompting,
              <code style={inlineCodeStyle}>ask</code> = inline yellow card per call,
              <code style={inlineCodeStyle}>deny</code> = synthesize a denied-by-user error.
              Blank = use the profile's value (or VETT's built-in default).
            </div>
            <PermissionRow
              label="Read"
              hint="File reads, list dirs, status checks — typically auto."
              signal={formPermRead}
            />
            <PermissionRow
              label="Edit"
              hint="File writes (create / str_replace / insert / undo) and update_memory."
              signal={formPermEdit}
            />
            <PermissionRow
              label="Terminal (safe)"
              hint="Read-only commands like ls, cat, git status — typically auto."
              signal={formPermTermSafe}
            />
            <PermissionRow
              label="Terminal (unsafe)"
              hint="State-changing or unrecognized shell commands. ask is the safe default."
              signal={formPermTermUnsafe}
            />
            <PermissionRow
              label="MCP"
              hint="Tools discovered from connected MCP servers (mcp__server__tool)."
              signal={formPermMcp}
            />
            <PermissionRow
              label="Other"
              hint="Control-plane tools (think, finish, ask_user_question, leader tools)."
              signal={formPermOther}
            />
          </Section>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={reset}
            disabled={!hasOverrides}
            style={{ ...subtleBtnStyle, opacity: hasOverrides ? 1 : 0.5, cursor: hasOverrides ? 'pointer' : 'default' }}
            title={hasOverrides ? 'Clear all overrides and respawn' : 'No overrides to clear'}
          >
            Reset to profile
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={close} style={subtleBtnStyle}>Cancel</button>
          <button type="button" onClick={apply} style={primaryBtnStyle}>Apply &amp; Respawn</button>
        </div>
      </div>
    </div>
  );
}

interface PermissionRowProps {
  label: string;
  hint: string;
  signal: { value: PermValue };
}
function PermissionRow({ label, hint, signal }: PermissionRowProps) {
  const options: Array<{ value: PermValue; label: string }> = [
    { value: '', label: '(profile default)' },
    { value: 'auto', label: 'auto' },
    { value: 'ask', label: 'ask' },
    { value: 'deny', label: 'deny' },
  ];
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{label}</label>
      <div style={{ display: 'flex', gap: '4px' }}>
        {options.map((opt) => {
          const active = signal.value === opt.value;
          return (
            <button
              key={opt.value || 'default'}
              type="button"
              onClick={() => { signal.value = opt.value; }}
              style={{
                ...subtleBtnStyle,
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: active ? 600 : 400,
                background: active
                  ? 'var(--vscode-button-background)'
                  : 'transparent',
                color: active
                  ? 'var(--vscode-button-foreground)'
                  : 'var(--vscode-foreground)',
                borderColor: active
                  ? 'var(--vscode-focusBorder)'
                  : 'var(--vscode-panel-border)',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div style={hintStyle}>{hint}</div>
    </div>
  );
}

interface SectionProps { title: string; children: preact.ComponentChildren; }
function Section({ title, children }: SectionProps) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: 'var(--vscode-descriptionForeground)',
        marginBottom: '6px',
        borderBottom: '1px solid var(--vscode-panel-border)',
        paddingBottom: '2px',
      }}>{title}</div>
      {children}
    </div>
  );
}

const overlayStyle = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  zIndex: 50,
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'flex-end',
};

const panelStyle = {
  width: '420px',
  maxWidth: '90%',
  height: '100%',
  background: 'var(--vscode-sideBar-background)',
  borderLeft: '1px solid var(--vscode-panel-border)',
  display: 'flex',
  flexDirection: 'column' as const,
  boxShadow: '-4px 0 12px rgba(0,0,0,0.3)',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: '8px 12px',
  borderBottom: '1px solid var(--vscode-panel-border)',
  background: 'var(--vscode-editorWidget-background)',
};

const bodyStyle = {
  flex: 1,
  overflow: 'auto' as const,
  padding: '12px 16px',
};

const footerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 12px',
  borderTop: '1px solid var(--vscode-panel-border)',
  background: 'var(--vscode-editorWidget-background)',
};

const fieldStyle = {
  marginBottom: '12px',
};

const labelStyle = {
  display: 'block',
  fontSize: '11px',
  marginBottom: '4px',
  color: 'var(--vscode-foreground)',
  fontWeight: 600,
};

const inputStyle = {
  width: '100%',
  padding: '4px 6px',
  fontSize: '12px',
  background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border)',
  borderRadius: '3px',
  outline: 'none',
  boxSizing: 'border-box' as const,
};

const hintStyle = {
  fontSize: '10px',
  color: 'var(--vscode-descriptionForeground)',
  marginTop: '3px',
  fontStyle: 'italic' as const,
};

const inlineCodeStyle = {
  fontFamily: 'var(--vscode-editor-font-family)',
  fontSize: '10px',
  padding: '0 3px',
  margin: '0 2px',
  background: 'var(--vscode-textCodeBlock-background)',
  borderRadius: '2px',
};

const mutedStyle = {
  fontSize: '11px',
  color: 'var(--vscode-descriptionForeground)',
  marginBottom: '14px',
  marginTop: 0,
};

// The shape is rendered in the editor's mono face on the code-block ground:
// this is literal argv, not prose, and it should look like something you could
// paste into a terminal — because you can.
const teamShapeStyle = {
  fontFamily: 'var(--vscode-editor-font-family)',
  fontSize: '12px',
  padding: '6px 8px',
  borderRadius: '3px',
  background: 'var(--vscode-textCodeBlock-background)',
  color: 'var(--vscode-foreground)',
  wordBreak: 'break-word' as const,
};

const primaryBtnStyle = {
  padding: '4px 12px',
  fontSize: '11px',
  background: 'var(--vscode-button-background)',
  color: 'var(--vscode-button-foreground)',
  border: 'none',
  borderRadius: '3px',
  cursor: 'pointer',
};

const subtleBtnStyle = {
  padding: '4px 10px',
  fontSize: '11px',
  background: 'transparent',
  color: 'var(--vscode-foreground)',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '3px',
  cursor: 'pointer',
};

const closeBtnStyle = {
  padding: '0 8px',
  fontSize: '16px',
  lineHeight: '20px',
  background: 'transparent',
  color: 'var(--vscode-foreground)',
  border: 'none',
  cursor: 'pointer',
};
