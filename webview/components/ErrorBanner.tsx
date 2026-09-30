import vscode from '../vscode';
import {
  connectionError,
  connectionErrorKind,
  connectionErrorDetails,
  currentProfile,
} from '../state/signals';
import type { ConnectionErrorKind } from '../../src/shared/types';

interface BannerCopy {
  title: string;
  body: string;
  /** True when this kind is fixable by changing settings — controls whether
   * the "Open Settings" button shows up. */
  showOpenSettings: boolean;
  /** True when this kind is fixable by opening a workspace folder. */
  showOpenFolder: boolean;
}

function copyFor(kind: ConnectionErrorKind | null, errorMsg: string | null): BannerCopy {
  switch (kind) {
    case 'binary_not_found':
      return {
        title: 'VETT binary not found',
        body:
          'VETT Chat needs the `vett` binary to run. Install it with `dotnet tool install --global ' +
          '--add-source ./bin/nupkg VettBench` from a clone of the vett repo, or set ' +
          '`vett-chat.vettPath` to point at a binary you already have.',
        showOpenSettings: true,
        showOpenFolder: false,
      };
    case 'workspace':
      return {
        title: 'No workspace folder open',
        body:
          'VETT Chat operates inside the active workspace. Open a folder so the agent has ' +
          'somewhere to read and edit files.',
        showOpenSettings: false,
        showOpenFolder: true,
      };
    case 'subprocess_exit':
      return {
        title: 'VETT exited unexpectedly',
        body:
          'The vett subprocess crashed before the session could continue. The most common cause ' +
          'is a misconfigured profile or endpoint. Check the details below, then retry.',
        showOpenSettings: true,
        showOpenFolder: false,
      };
    case 'llm_endpoint': {
      // Endpoint is owned by the profile YAML, not extension settings,
      // so the actionable copy points at the profile rather than at
      // the settings page. We pull the endpoint from the active
      // profile's metadata when available.
      const ep = currentProfile.value?.endpoint ?? '';
      return {
        title: ep ? `LLM endpoint unreachable: ${ep}` : 'LLM endpoint unreachable',
        body:
          'The LLM endpoint refused the connection, timed out, or returned an auth error. ' +
          'Verify llm.endpoint, llm.model, and the API key env var in your profile YAML, then retry.',
        showOpenSettings: true,
        showOpenFolder: false,
      };
    }
    case 'agent_error':
      return {
        title: 'Agent error',
        body: errorMsg ?? 'An unexpected error occurred inside the agent. Retry the session, or check the details below.',
        showOpenSettings: false,
        showOpenFolder: false,
      };
    default:
      return {
        title: errorMsg ?? 'Disconnected',
        body: 'The chat session is not currently connected. Retry to start a new session.',
        showOpenSettings: false,
        showOpenFolder: false,
      };
  }
}

export function ErrorBanner() {
  if (!connectionError.value && !connectionErrorKind.value) {
    return null;
  }

  const copy = copyFor(connectionErrorKind.value, connectionError.value);
  const details = connectionErrorDetails.value;

  return (
    <div
      role="alert"
      style={{
        margin: '8px',
        border: '1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-charts-red))',
        borderRadius: '4px',
        background: 'var(--vscode-inputValidation-errorBackground, var(--vscode-textBlockQuote-background))',
        color: 'var(--vscode-foreground)',
      }}
    >
      <div style={{ padding: '8px 10px', borderBottom: details ? '1px solid var(--vscode-panel-border)' : 'none' }}>
        <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '4px' }}>
          {copy.title}
        </div>
        <div style={{ fontSize: '12px', lineHeight: 1.4 }}>{copy.body}</div>
      </div>

      {details && (
        <details style={{ padding: '6px 10px' }}>
          <summary style={{ cursor: 'pointer', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
            Details
          </summary>
          <pre
            style={{
              marginTop: '6px',
              padding: '6px',
              background: 'var(--vscode-editor-background)',
              border: '1px solid var(--vscode-panel-border)',
              borderRadius: '3px',
              fontSize: '11px',
              maxHeight: '160px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {details}
          </pre>
        </details>
      )}

      <div
        style={{
          display: 'flex',
          gap: '6px',
          padding: '6px 10px',
          borderTop: '1px solid var(--vscode-panel-border)',
          background: 'var(--vscode-sideBar-background)',
        }}
      >
        <button
          type="button"
          onClick={() => vscode.postMessage({ type: 'newSession' })}
          style={primaryBtnStyle}
        >
          Retry
        </button>
        {copy.showOpenSettings && (
          <button
            type="button"
            onClick={() => vscode.postMessage({ type: 'openSettings' })}
            style={secondaryBtnStyle}
          >
            Open Settings
          </button>
        )}
        {copy.showOpenFolder && (
          <button
            type="button"
            onClick={() => vscode.postMessage({ type: 'openFolder' })}
            style={secondaryBtnStyle}
          >
            Open Folder…
          </button>
        )}
      </div>
    </div>
  );
}

const primaryBtnStyle = {
  padding: '4px 12px',
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
