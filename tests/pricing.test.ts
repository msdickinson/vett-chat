import { describe, it, expect } from 'vitest';
import {
  computeCost,
  formatCost,
  getPricing,
  isLikelyLocalModel,
} from '../webview/utils/pricing';

/**
 * Pure-helper coverage for the cost rendering pipeline. The PRICING
 * table itself rots — this file pins the FALLBACK / DISPATCH behavior
 * (unknown → null → $0, local-marker → null, computeCost arithmetic)
 * so a future table edit doesn't quietly drop the safety nets that
 * keep unknown models from displaying garbage cost.
 */
describe('pricing fallbacks', () => {
  describe('getPricing', () => {
    it('returns null for undefined model', () => {
      expect(getPricing(undefined)).toBeNull();
    });

    it('returns null for empty model name', () => {
      expect(getPricing('')).toBeNull();
    });

    it('returns null for an unknown model name', () => {
      expect(getPricing('totally-made-up-model-2099')).toBeNull();
    });

    it('returns null for any model containing a local-marker substring', () => {
      // Self-hosted markers short-circuit to null BEFORE the table is
      // consulted, even when the name happens to contain a cloud match.
      expect(getPricing('qwen3-coder')).toBeNull();
      expect(getPricing('llama-3.1-70b')).toBeNull();
      expect(getPricing('deepseek-coder')).toBeNull();
      expect(getPricing('Mixtral-8x22B')).toBeNull(); // case-insensitive
    });

    it('matches case-insensitively against the rules table', () => {
      const opus = getPricing('Claude-Opus-4-7');
      expect(opus).not.toBeNull();
      expect(opus!.inputPer1M).toBeGreaterThan(0);
    });

    it('first-match-wins ordering: specific patterns ahead of general', () => {
      // gpt-4o-mini must NOT match gpt-4 or gpt-4o (its cheaper pricing
      // sits at index 0 of the gpt-4o-mini rule, ahead of the broader
      // gpt-4o / gpt-4 substrings).
      const mini = getPricing('gpt-4o-mini');
      const big = getPricing('gpt-4o-2024');
      expect(mini).not.toBeNull();
      expect(big).not.toBeNull();
      expect(mini!.inputPer1M).toBeLessThan(big!.inputPer1M);
    });
  });

  describe('isLikelyLocalModel', () => {
    it('returns false for undefined', () => {
      expect(isLikelyLocalModel(undefined)).toBe(false);
    });

    it('flags self-hosted family substrings as local', () => {
      expect(isLikelyLocalModel('qwen3-coder')).toBe(true);
      expect(isLikelyLocalModel('Llama-3.1-70b')).toBe(true);
      expect(isLikelyLocalModel('phi-4')).toBe(true);
    });

    it('does not flag cloud models', () => {
      expect(isLikelyLocalModel('gpt-4o')).toBe(false);
      expect(isLikelyLocalModel('claude-opus-4-7')).toBe(false);
      expect(isLikelyLocalModel('gemini-1.5-pro')).toBe(false);
    });
  });

  describe('computeCost', () => {
    it('returns 0 when pricing is null (unknown model)', () => {
      // The CRITICAL contract for the audit pin: an unknown model
      // resolves to null pricing, which computeCost translates to $0
      // — so the chat UI never displays bogus dollar amounts for a
      // model the table doesn't know about.
      const pricing = getPricing('totally-unknown-model');
      expect(pricing).toBeNull();
      expect(computeCost(pricing, 1_000_000, 500_000)).toBe(0);
    });

    it('returns 0 for local models (null pricing)', () => {
      const pricing = getPricing('qwen3-coder');
      expect(pricing).toBeNull();
      expect(computeCost(pricing, 5_000_000, 5_000_000)).toBe(0);
    });

    it('computes input + output cost from per-1M rates', () => {
      const pricing = { inputPer1M: 3.0, outputPer1M: 15.0 };
      // 100k input @ $3/M = $0.30; 50k output @ $15/M = $0.75; total $1.05
      expect(computeCost(pricing, 100_000, 50_000)).toBeCloseTo(1.05, 6);
    });

    it('zero tokens with real pricing returns $0', () => {
      const pricing = { inputPer1M: 3.0, outputPer1M: 15.0 };
      expect(computeCost(pricing, 0, 0)).toBe(0);
    });
  });

  describe('formatCost', () => {
    // Pinning the formatter is part of the unknown-model story: $0
    // must render as a stable string, and the bands matter so the UI
    // doesn't flicker between formats as cost crosses thresholds.
    it('renders $0 exactly when usd is 0', () => {
      expect(formatCost(0)).toBe('$0.00');
    });

    it('renders sub-millicent as <$0.001', () => {
      expect(formatCost(0.0001)).toBe('<$0.001');
    });

    it('renders millicent-to-cent with 4 decimals', () => {
      expect(formatCost(0.0042)).toBe('$0.0042');
    });

    it('renders cent-to-dollar with 3 decimals', () => {
      expect(formatCost(0.234)).toBe('$0.234');
    });

    it('renders dollar+ with 2 decimals', () => {
      expect(formatCost(12.345)).toBe('$12.35');
    });
  });
});
