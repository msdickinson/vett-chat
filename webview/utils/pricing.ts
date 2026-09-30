/**
 * Per-million-token pricing for common cloud models. Used to render a
 * notional $-cost per LLM request in the chat UI.
 *
 * Local-served models (Ollama, vLLM, LM Studio, llama.cpp) cost
 * nothing per token and return `null` here — UI shows "free".
 *
 * Pricing accuracy: these are public list prices as of late 2025. They
 * change. If a user's bill matters, they'll notice the displayed
 * number is stale and ask. For agent-tweaking iteration, "right
 * order of magnitude" is what matters.
 */

export interface ModelPricing {
  /** Dollars per 1M input tokens. */
  inputPer1M: number;
  /** Dollars per 1M output tokens. */
  outputPer1M: number;
}

interface PricingRule {
  /** Substring to look for in the model name. First match wins, so
   *  put more-specific patterns ahead of more-general ones. */
  match: string;
  pricing: ModelPricing;
}

const PRICING: PricingRule[] = [
  // Anthropic — Claude 4.x family (substrings ordered specific → general)
  { match: 'claude-opus-4-7', pricing: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  { match: 'claude-opus-4-6', pricing: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  { match: 'claude-opus-4', pricing: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  { match: 'claude-sonnet-4', pricing: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { match: 'claude-haiku-4', pricing: { inputPer1M: 0.8, outputPer1M: 4.0 } },
  { match: 'claude-3-5-sonnet', pricing: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { match: 'claude-3-5-haiku', pricing: { inputPer1M: 0.8, outputPer1M: 4.0 } },
  { match: 'claude-3-opus', pricing: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  { match: 'claude-3-sonnet', pricing: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { match: 'claude-3-haiku', pricing: { inputPer1M: 0.25, outputPer1M: 1.25 } },

  // OpenAI
  { match: 'gpt-5', pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { match: 'gpt-4o-mini', pricing: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { match: 'gpt-4o', pricing: { inputPer1M: 2.5, outputPer1M: 10.0 } },
  { match: 'gpt-4-turbo', pricing: { inputPer1M: 10.0, outputPer1M: 30.0 } },
  { match: 'gpt-4', pricing: { inputPer1M: 30.0, outputPer1M: 60.0 } },
  { match: 'o1-preview', pricing: { inputPer1M: 15.0, outputPer1M: 60.0 } },
  { match: 'o1-mini', pricing: { inputPer1M: 3.0, outputPer1M: 12.0 } },
  { match: 'o1', pricing: { inputPer1M: 15.0, outputPer1M: 60.0 } },
  { match: 'o3-mini', pricing: { inputPer1M: 1.1, outputPer1M: 4.4 } },
  { match: 'o3', pricing: { inputPer1M: 10.0, outputPer1M: 40.0 } },

  // Google
  { match: 'gemini-2.0-flash', pricing: { inputPer1M: 0.075, outputPer1M: 0.3 } },
  { match: 'gemini-1.5-pro', pricing: { inputPer1M: 1.25, outputPer1M: 5.0 } },
  { match: 'gemini-1.5-flash', pricing: { inputPer1M: 0.075, outputPer1M: 0.3 } },
];

/** Substrings that, if present in the model name, mean the model is
 *  served locally (no per-token cost). Most self-hosted Qwen / Llama /
 *  Mistral / DeepSeek runs land here. */
const LOCAL_MARKERS = [
  'qwen',
  'llama',
  'deepseek',
  'mistral',
  'mixtral',
  'codellama',
  'starcoder',
  'phi-',
  'gemma',
  'nemotron',
  'glm',
  'yi-',
];

/**
 * Look up pricing for a model name. Returns null when the model is
 * either self-hosted/local (use "free" in UI) or unknown (use "—").
 *
 * Match is case-insensitive substring against the rules table; first
 * match wins.
 */
export function getPricing(model: string | undefined): ModelPricing | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const marker of LOCAL_MARKERS) {
    if (lower.includes(marker)) return null;
  }
  for (const rule of PRICING) {
    if (lower.includes(rule.match.toLowerCase())) return rule.pricing;
  }
  return null;
}

/** True when the model name looks self-hosted (caller decides whether
 *  to render "free" vs "—" for unknown). */
export function isLikelyLocalModel(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return LOCAL_MARKERS.some((m) => lower.includes(m));
}

/** Compute dollar cost for an in/out token pair against a model's
 *  pricing. Returns 0 when pricing is null (local or unknown). */
export function computeCost(
  pricing: ModelPricing | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!pricing) return 0;
  return (
    (inputTokens * pricing.inputPer1M) / 1_000_000 +
    (outputTokens * pricing.outputPer1M) / 1_000_000
  );
}

/** Format a cost as a chat-friendly string. Sub-cent → 4 decimals,
 *  cent-to-dollar → 3 decimals, ≥$1 → 2 decimals. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return '$' + usd.toFixed(4);
  if (usd < 1) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(2);
}
