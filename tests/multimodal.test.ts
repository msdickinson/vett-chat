import { describe, it, expect } from 'vitest';
import { isLikelyVisionModel } from '../webview/utils/multimodal';

/**
 * Pin the vision-model heuristic. The gate refuses image attachments
 * for any model that doesn't match — so a regression here would either
 * (a) silently let images through to a text-only endpoint and surface
 * an opaque 400, or (b) block legitimate vision models from accepting
 * pasted screenshots. Both bad. Lock the matchlist + the no-match
 * defaults so neither slips.
 */
describe('isLikelyVisionModel', () => {
  it('returns false for empty / undefined input', () => {
    expect(isLikelyVisionModel(undefined)).toBe(false);
    expect(isLikelyVisionModel('')).toBe(false);
    expect(isLikelyVisionModel('   ')).toBe(false);
  });

  it('matches OpenAI vision-capable models', () => {
    expect(isLikelyVisionModel('gpt-4o')).toBe(true);
    expect(isLikelyVisionModel('gpt-4o-2024-08-06')).toBe(true);
    expect(isLikelyVisionModel('gpt-4-turbo')).toBe(true);
    expect(isLikelyVisionModel('gpt-4-vision-preview')).toBe(true);
    expect(isLikelyVisionModel('gpt-5')).toBe(true);
    expect(isLikelyVisionModel('o1-preview')).toBe(true);
    expect(isLikelyVisionModel('o3')).toBe(true);
  });

  it('rejects OpenAI text-only / mini variants', () => {
    expect(isLikelyVisionModel('gpt-3.5-turbo')).toBe(false);
    expect(isLikelyVisionModel('o1-mini')).toBe(false);
    expect(isLikelyVisionModel('o3-mini')).toBe(false);
  });

  it('matches Claude 3+ family', () => {
    expect(isLikelyVisionModel('claude-3-opus')).toBe(true);
    expect(isLikelyVisionModel('claude-3-5-sonnet')).toBe(true);
    expect(isLikelyVisionModel('claude-opus-4-7')).toBe(true);
    expect(isLikelyVisionModel('claude-sonnet-4-6')).toBe(true);
    expect(isLikelyVisionModel('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('matches Gemini 1.5+', () => {
    expect(isLikelyVisionModel('gemini-1.5-pro')).toBe(true);
    expect(isLikelyVisionModel('gemini-1.5-flash')).toBe(true);
    expect(isLikelyVisionModel('gemini-2.0-flash')).toBe(true);
    expect(isLikelyVisionModel('gemini-pro-vision')).toBe(true);
  });

  it('matches self-hosted vision families', () => {
    expect(isLikelyVisionModel('Qwen2.5-VL-32B-Instruct')).toBe(true);
    expect(isLikelyVisionModel('qwen2-vl-7b')).toBe(true);
    expect(isLikelyVisionModel('llava-1.6-mistral')).toBe(true);
    expect(isLikelyVisionModel('Pixtral-12B')).toBe(true);
    expect(isLikelyVisionModel('molmo-7b-d')).toBe(true);
    expect(isLikelyVisionModel('InternVL2-8B')).toBe(true);
    expect(isLikelyVisionModel('llama-3.2-11b-vision')).toBe(true);
  });

  it('rejects text-only self-hosted models', () => {
    // The exact case from the audit: qwen3b-tools profile uses a
    // text-only Qwen variant. Must NOT match.
    expect(isLikelyVisionModel('qwen3b-tools')).toBe(false);
    expect(isLikelyVisionModel('Qwen2.5-3B-Instruct-AWQ')).toBe(false);
    expect(isLikelyVisionModel('my-local-mtp')).toBe(false);
    expect(isLikelyVisionModel('qwen3-coder-next')).toBe(false);
    expect(isLikelyVisionModel('llama-3.1-70b')).toBe(false);
    expect(isLikelyVisionModel('mistral-7b-instruct')).toBe(false);
    expect(isLikelyVisionModel('deepseek-coder')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isLikelyVisionModel('GPT-4O')).toBe(true);
    expect(isLikelyVisionModel('CLAUDE-3-OPUS')).toBe(true);
    expect(isLikelyVisionModel('QWEN2.5-VL')).toBe(true);
  });
});
