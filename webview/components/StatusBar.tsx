import { connected, totalInputTokens, totalOutputTokens, currentIteration, sessionLogPath, toolCalls, currentProfile, totalCostUsd, contextWindowTokens, lastMainTurnInputTokens } from '../state/signals';
import { formatCost, getPricing, isLikelyLocalModel } from '../utils/pricing';
import vscode from '../vscode';

/**
 * Format a token count with a k-suffix for compactness once it crosses
 * 1000. e.g. 12345 → "12.3k". Below 1000 we keep the full number so
 * early-conversation counts read naturally.
 */
function fmtTokens(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 100_000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n / 1000) + 'k';
}

export function StatusBar() {
  const totalIn = totalInputTokens.value;
  const totalOut = totalOutputTokens.value;
  // Gauge numerator: most-recent main-thread llm_response.input_tokens.
  // That's the actual prompt size sitting in the model's context for
  // the current turn — the only number that's meaningfully bounded by
  // the context window. Cumulative sums (totalIn + totalOut) grow
  // unboundedly across turns + count sub-agent runs and quickly
  // overshoot the window for no good reason.
  const ctxFill = lastMainTurnInputTokens.value;
  const ctxMax = contextWindowTokens.value;
  const pct = Math.min(1, ctxFill / ctxMax);
  const calls = toolCalls.value.length;
  const iter = currentIteration.value?.iteration ?? 0;
  const cur = currentProfile.value;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '4px 8px',
      fontSize: '11px',
      color: 'var(--vscode-descriptionForeground)',
      borderTop: '1px solid var(--vscode-panel-border)',
      background: 'var(--vscode-sideBar-background)',
      flexShrink: 0,
    }}>
      <span
        title={connected.value ? 'Connected to vett subprocess' : 'No active vett subprocess'}
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: connected.value
            ? 'var(--vscode-charts-green)'
            : 'var(--vscode-charts-red)',
          flexShrink: 0,
        }}
      />

      {iter > 0 && <span title={`${calls} tool calls so far`}>iter {iter} · {calls} calls</span>}

      {/* Token gauge — always visible once we have any usage so the
          user gets a sense of how close to compaction they are. */}
      {(ctxFill > 0 || totalIn + totalOut > 0) && (
        <div
          title={
            `Current main-thread prompt: ${ctxFill.toLocaleString()} tokens / ${ctxMax.toLocaleString()} window` +
            `\nSession totals: ${totalIn.toLocaleString()} in · ${totalOut.toLocaleString()} out (incl. sub-agents)` +
            (cur?.model ? `\nmodel: ${cur.model}` : '')
          }
          style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto' }}
        >
          <span>{fmtTokens(ctxFill)} / {fmtTokens(ctxMax)}</span>
          <div style={{
            width: '60px',
            height: '4px',
            background: 'var(--vscode-panel-border)',
            borderRadius: '2px',
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${(pct * 100).toFixed(1)}%`,
              height: '100%',
              background: pct > 0.85
                ? 'var(--vscode-charts-yellow)'
                : 'var(--vscode-charts-blue)',
              transition: 'width 200ms',
            }} />
          </div>
        </div>
      )}

      {/* Cumulative session cost. Only shown when the model has known
          pricing AND we've spent something — for self-hosted runs the
          cost is structurally 0 and a "$0.00" badge is more clutter
          than signal. */}
      {(() => {
        const cur = currentProfile.value;
        const pricing = getPricing(cur?.model);
        const local = isLikelyLocalModel(cur?.model);
        const cost = totalCostUsd.value;
        if (!pricing || cost === 0) {
          // For local models, show a tiny "free" tag so users
          // understand why $-cost isn't displayed.
          if (local && (totalIn + totalOut) > 0) {
            return (
              <span
                title={`Self-hosted model — no per-token cost\nmodel: ${cur?.model ?? '—'}`}
                style={{
                  fontSize: '10px',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: 'var(--vscode-badge-background)',
                  color: 'var(--vscode-badge-foreground)',
                  opacity: 0.7,
                }}
              >
                local
              </span>
            );
          }
          return null;
        }
        return (
          <span
            title={
              `Cumulative cost: ${formatCost(cost)}\n` +
              `pricing: $${pricing.inputPer1M.toFixed(2)} / 1M in · $${pricing.outputPer1M.toFixed(2)} / 1M out\n` +
              `model: ${cur?.model ?? '—'}`
            }
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--vscode-charts-foreground, var(--vscode-foreground))',
            }}
          >
            {formatCost(cost)}
          </span>
        );
      })()}

      {sessionLogPath.value && (
        <button
          type="button"
          onClick={() => vscode.postMessage({ type: 'revealSessionLog' })}
          title={`Reveal in OS:\n${sessionLogPath.value}`}
          style={{
            marginLeft: (ctxFill > 0 || totalIn + totalOut > 0) ? '0' : 'auto',
            padding: '2px 8px',
            fontSize: '10px',
            color: 'var(--vscode-textLink-foreground)',
            background: 'transparent',
            border: '1px solid var(--vscode-panel-border)',
            borderRadius: '3px',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          log
        </button>
      )}
    </div>
  );
}
