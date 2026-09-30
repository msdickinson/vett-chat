import vscode from '../vscode';
import { currentProfile, profile, profiles, showWelcome } from '../state/signals';

/**
 * One-screen first-run view. Goals:
 *
 * 1. Tell the user what this surface IS (proving ground: try profiles +
 *    configs before running real tickets) and what it ISN'T (long-running,
 *    queued ticket processing).
 * 2. Show the active profile and what it points at (model + endpoint),
 *    pulled from `vett profiles --json` so the welcome is always in
 *    sync with the actual profile YAML.
 * 3. One click to swap profile via the picker, or to dive into the YAML.
 * 4. "Got it" dismisses and persists; reopen via the Show Welcome command.
 */
export function WelcomeView() {
  const cur = currentProfile.value;
  // We have full profile metadata once `vett profiles --json` has
  // returned. If the catalog hasn't loaded yet, OR if the configured
  // profile isn't installed, we can't tell what it points at.
  const profileResolved = cur !== null;
  const haveEndpoint = profileResolved && cur!.endpoint.trim().length > 0;
  const haveModel = profileResolved && cur!.model.trim().length > 0;
  // For local providers, vett also accepts VETT_LLM_ENDPOINT env var so
  // an empty endpoint here isn't necessarily wrong. We warn rather than
  // block, and let vett's own validation surface a real error if so.
  const ready = profileResolved && haveEndpoint && haveModel;

  const dismiss = () => {
    showWelcome.value = false;
    vscode.postMessage({ type: 'dismissWelcome' });
  };

  return (
    <div
      style={{
        margin: '8px',
        padding: '12px 14px',
        border: '1px solid var(--vscode-panel-border)',
        borderRadius: '4px',
        background: 'var(--vscode-textBlockQuote-background)',
        fontSize: '13px',
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontSize: '15px', fontWeight: 'bold', marginBottom: '8px' }}>
        Welcome to VETT Chat
      </div>

      <p style={{ margin: '0 0 8px 0' }}>
        This is a <strong>proving ground</strong>. Use it to try profiles, models, and tool
        configurations against a real codebase before you commit them to ticket runs. Each
        chat spawns a local <code>vett</code> subprocess; nothing leaves your machine
        unless your LLM endpoint is remote.
      </p>

      <p style={{ margin: '0 0 12px 0', color: 'var(--vscode-descriptionForeground)' }}>
        Long-running, queued, multi-team ticket processing belongs in a separate
        pipeline. This surface is intentionally not that.
      </p>

      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>
          Active profile
        </div>
        <ConfigRow label="Profile" value={profile.value} ok={profileResolved} fallback="Profile not installed" />
        <ConfigRow
          label="Model"
          value={cur?.model ?? ''}
          ok={haveModel}
          fallback="Add `model:` under llm: in the profile YAML"
        />
        <ConfigRow
          label="Endpoint"
          value={cur?.endpoint ?? ''}
          ok={haveEndpoint}
          fallback={cur?.provider === 'local' ? 'Set llm.endpoint in profile or VETT_LLM_ENDPOINT' : '(provider-managed)'}
        />
        {cur && cur.tools.length > 0 && (
          <ConfigRow
            label="Tools"
            value={cur.tools.join(', ')}
            ok={true}
          />
        )}
        <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: '4px' }}>
          To change endpoint, model, or tools — edit the profile YAML
          (<code>~/.vett/profiles/{profile.value}.yaml</code> takes precedence over the bundled default).
        </div>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>
          {profiles.value.length > 1 ? 'Other profiles installed' : 'How profiles work'}
        </div>
        {profiles.value.length > 1 ? (
          <ul style={{ margin: '0', paddingLeft: '20px', fontSize: '12px' }}>
            {profiles.value
              .filter((p) => p.name !== profile.value)
              .slice(0, 6)
              .map((p) => (
                <li key={p.name} style={{ color: 'var(--vscode-descriptionForeground)' }}>
                  <code>{p.name}</code>
                  {p.model ? ` — ${p.model}` : ''}
                  {p.tools.includes('finish') ? ' (benchmark profile — auto-finishes, not great for chat)' : ''}
                </li>
              ))}
          </ul>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>
            A profile pins the endpoint, model, system prompt, and tools. Pick a chat-tuned profile
            (no auto-finish) for ongoing conversations; use benchmark profiles like <code>openhands</code>
            only for one-shot runs.
          </div>
        )}
      </div>

      {!ready && profileResolved && (
        <div
          style={{
            margin: '0 0 10px 0',
            padding: '6px 8px',
            fontSize: '12px',
            border: '1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-charts-yellow))',
            background: 'var(--vscode-inputValidation-warningBackground, transparent)',
            borderRadius: '3px',
          }}
        >
          Profile is missing endpoint or model. Edit the YAML, or rely on
          <code> VETT_LLM_ENDPOINT</code> / <code>VETT_LLM_MODEL</code> env vars.
        </div>
      )}

      {/* Onboarding shortcut: when the configured profile isn't ready
          (no endpoint / no model), surface a one-click "set up a model
          for me" path. Branches into local-detect or cloud-setup based
          on what the user picks. Hidden when the user already has a
          working setup so we're not pushy. */}
      {!ready && (
        <div
          style={{
            margin: '0 0 10px 0',
            padding: '8px 10px',
            border: '1px solid var(--vscode-charts-blue)',
            borderRadius: '3px',
            background: 'var(--vscode-textBlockQuote-background)',
            fontSize: '12px',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            New here? Set up a model in 30 seconds
          </div>
          <div style={{ color: 'var(--vscode-descriptionForeground)', marginBottom: '6px' }}>
            Local: probes Ollama, LM Studio, and vLLM on standard ports.<br />
            Cloud: paste an OpenAI / Anthropic / Google key — the key is stored in VS Code's
            SecretStorage, never written to YAML.
          </div>
          <button
            type="button"
            onClick={() => vscode.postMessage({ type: 'runOnboarding' })}
            style={primaryBtnStyle}
          >
            Set up a model
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => vscode.postMessage({ type: 'runOnboarding' })}
          style={secondaryBtnStyle}
          title="Auto-detect a local model server, or paste an OpenAI / Anthropic / Google key with a live key test."
        >
          Set up a model…
        </button>
        <button
          type="button"
          onClick={() => vscode.postMessage({ type: 'pickProfile' })}
          style={secondaryBtnStyle}
        >
          Pick Profile…
        </button>
        <button type="button" onClick={dismiss} style={primaryBtnStyle}>
          Got it
        </button>
      </div>
    </div>
  );
}

interface ConfigRowProps {
  label: string;
  value: string;
  ok: boolean;
  fallback?: string;
}

function ConfigRow({ label, value, ok, fallback }: ConfigRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
        padding: '2px 0',
      }}
    >
      <span
        title={ok ? 'Set' : 'Not set'}
        style={{
          width: '14px',
          textAlign: 'center',
          color: ok ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-yellow)',
          fontWeight: 'bold',
        }}
      >
        {ok ? '✓' : '!'}
      </span>
      <span style={{ minWidth: '90px', color: 'var(--vscode-descriptionForeground)' }}>{label}</span>
      <span
        style={{
          fontFamily: 'var(--vscode-editor-font-family)',
          fontSize: '11px',
          wordBreak: 'break-all',
          color: ok ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
        }}
      >
        {value || fallback || '—'}
      </span>
    </div>
  );
}

const primaryBtnStyle = {
  padding: '4px 14px',
  fontSize: '12px',
  background: 'var(--vscode-button-background)',
  color: 'var(--vscode-button-foreground)',
  border: 'none',
  borderRadius: '3px',
  cursor: 'pointer',
};

const secondaryBtnStyle = {
  padding: '4px 12px',
  fontSize: '12px',
  background: 'transparent',
  color: 'var(--vscode-foreground)',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '3px',
  cursor: 'pointer',
};
