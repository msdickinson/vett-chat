import type { ProfileSummary } from '../shared/types';

/**
 * The one-line detail string the profile picker shows under each name.
 *
 * Split out of ChatViewProvider so it loads without a `vscode` shim — same
 * split as smartActionsHelpers, for the same reason.
 *
 * ⭐ WHY THIS COUNTS "+N more". `model`/`endpoint` are the TOP-LEVEL binding
 * only, so a team profile is described here by its leader alone. Across the
 * corpus on 2026-08-26, 12 of 49 profiles had a headline endpoint that hid at
 * least one other, and the hidden half is where breakage lives: a leader on a
 * healthy cloud endpoint with five members pointed at a vacated host renders,
 * in a dropdown, as entirely fine — the failure only shows up once someone has
 * spent a run on it. The suffix does not judge the extra bindings, it just
 * stops the row from implying there is only one.
 *
 * ⛔ EVERY NEW FIELD IS OPTIONAL AND MUST STAY THAT WAY. `endpoints`, `models`
 * and `parseError` come from a newer `vett` than the one installed here; the
 * 2026-08-25 build on PATH emits none of them (verified by running it, not
 * assumed). When they are absent this must render exactly what it always did,
 * so the extension keeps working against an older binary rather than showing
 * "+undefined more".
 */
export function profileDetail(
  p: Pick<ProfileSummary, 'description' | 'model' | 'endpoint' | 'provider' | 'tools'> &
    Partial<Pick<ProfileSummary, 'endpoints' | 'models' | 'parseError'>>,
): string {
  // Lead with the failure: a profile we could not read must not be described
  // by the empty strings that failure produced, which read as "unconfigured".
  if (p.parseError) return '⚠ could not parse this profile — its YAML is invalid';

  const parts: string[] = [];
  if (p.model) parts.push(`model=${p.model}${more(p.models, p.model)}`);
  if (p.endpoint) parts.push(`endpoint=${p.endpoint}${more(p.endpoints, p.endpoint)}`);
  else if (p.provider) parts.push(`provider=${p.provider}`);
  if (p.tools.length > 0) parts.push(`tools=[${p.tools.join(',')}]`);
  if (parts.length === 0 && p.description) return p.description;
  return parts.join('  ·  ');
}

/**
 * ` (+N more)` when a profile references bindings beyond the one on display.
 *
 * Counts values DISTINCT FROM `shown` rather than `all.length - 1`: the list is
 * deduped top-level-first, so the two agree in the normal case — but not when
 * the headline block is absent and `all[0]` is the leader's. Comparing by value
 * can only ever be right, whereas subtracting one assumes a position.
 */
function more(all: string[] | undefined, shown: string): string {
  if (!all || all.length === 0) return '';
  const others = all.filter((v) => v.toLowerCase() !== shown.toLowerCase()).length;
  return others > 0 ? ` (+${others} more)` : '';
}
