/**
 * Heuristic check: does a given model name look like it supports image
 * inputs? We use this to gate the paste / snip / drag-drop UX so the
 * user gets a clear "this model is text-only" toast instead of the
 * LLM-side 400 they would otherwise hit on text-only profiles.
 *
 * Strict-by-default: only model names that match a known vision family
 * return true. Unknown self-hosted names won't match — users can either
 * rename the profile to include a recognized substring (e.g. add `-vl`)
 * or, longer term, declare `multimodal: true` in the profile YAML
 * (separate change). Better to refuse a real vision model than to
 * silently ship images to a text-only one and get the 400.
 *
 * Pure — no DOM / vscode dependencies. Tested standalone.
 */

const VISION_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI
  /\bgpt-4o\b/,
  /\bgpt-4-turbo\b/, // GPT-4 Turbo with vision (Apr 2024+)
  /\bgpt-4-vision\b/,
  /\bgpt-5\b/,
  /\bo1(?!-mini)\b/, // o1 supports vision; o1-mini does NOT
  /\bo3(?!-mini)\b/,
  /\bo4\b/,
  // Anthropic — Claude 3+ supports vision; 4.x family across the board.
  /\bclaude-3\b/,
  /\bclaude-3-5\b/,
  /\bclaude-3-7\b/,
  /\bclaude-opus-4\b/,
  /\bclaude-sonnet-4\b/,
  /\bclaude-haiku-4\b/,
  /\bclaude-opus\b/,
  /\bclaude-sonnet\b/,
  // Google — Gemini 1.5+ supports vision.
  /\bgemini-1\.5\b/,
  /\bgemini-2\b/,
  /\bgemini-pro-vision\b/,
  // Self-hosted vision-capable model families. Word boundaries are
  // intentionally loose — names like `InternVL2-8B` lowercase to
  // `internvl2-8b`, where `\binternvl\b` would fail because `2`
  // follows immediately. Substring match is fine; these tokens are
  // distinctive enough not to false-positive on text-only models.
  /-vl-/,        // qwen-vl-7b, qwen2.5-vl-32b
  /-vl\d/,       // qwen-vl2, etc.
  /-vl$/,        // bare -vl suffix
  /^vl-/,        // bare vl- prefix
  /vision/,      // *-vision-*, gemini-pro-vision, llama-3.2-11b-vision
  /llava/,
  /pixtral/,
  /molmo/,
  /internvl/,
  /idefics/,
  /cogvlm/,
];

export function isLikelyVisionModel(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase().trim();
  if (!lower) return false;
  return VISION_PATTERNS.some((re) => re.test(lower));
}
