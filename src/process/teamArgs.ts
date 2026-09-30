import type { ProfileSummary, SessionOverrides } from '../shared/types';

/**
 * Turn the team-shape choices made in the Customize panel into `vett chat`
 * flags — or into errors, refusing to spawn.
 *
 * Split out of vettProcess so it loads without a `vscode` shim, same split as
 * profileDetail, for the same reason.
 *
 * ⭐ WHY THIS VALIDATES INSTEAD OF JUST FORMATTING. `--team` resolves every
 * role name against the profile's own member list and treats an unknown name as
 * an ERROR, not as a smaller team (TeamOverride.cs:132-145) — deliberately, so
 * a typo cannot silently produce a run whose denominator nobody can name. That
 * is the right behaviour for a CLI a human types. But a GUI that can compose an
 * invalid request has simply moved the failure later: the user picks a profile,
 * sets six counts, hits Start, and *then* gets a parse error from a subprocess.
 * So the same check runs here, before spawn, against the roster the binary
 * itself published.
 *
 * ⛔ WHEN THE ROSTER IS UNKNOWN, PASS THROUGH — DO NOT INVENT A VERDICT.
 * `profile.team` is absent from any `vett` older than 2026-08-28, and absent for
 * a solo profile. "I could not check" is not "I checked and it is wrong": in
 * that case the flags are forwarded and the binary decides, still fail-closed,
 * just one layer later. Refusing here would break the extension against every
 * older binary it is supposed to keep working with.
 */

export interface TeamArgsResult {
  /** Flags to append to the `vett chat` argv. Empty when nothing was set. */
  args: string[];
  /**
   * Why we refused. NON-EMPTY MEANS DO NOT SPAWN — `args` is not a partial
   * result to be used anyway. A team that is quietly smaller than the one asked
   * for is the exact failure the CLI already refuses to produce.
   */
  errors: string[];
}

/** Matches vett's own cap (TeamOverride.TryParseRoster). */
const MAX_SEATS = 64;

/**
 * Roles are emitted into a comma-separated, space-delimited spec, so a name
 * carrying either character cannot round-trip. No shipped profile has one, but
 * a corrupt `--team` string is silent where a refusal is loud.
 */
function unrepresentable(name: string): boolean {
  return /[,\s]/.test(name);
}

export function buildTeamArgs(
  overrides: SessionOverrides | undefined,
  profile: Pick<ProfileSummary, 'name'> & Partial<Pick<ProfileSummary, 'team'>>,
): TeamArgsResult {
  const args: string[] = [];
  const errors: string[] = [];
  const o = overrides;
  if (!o) return { args, errors };

  const roster = profile.team?.members;
  // The leader is addressable by --context but is NOT a --team roster entry:
  // you cannot ask for two leaders. Kept as separate sets so each flag checks
  // against exactly what it accepts.
  const memberNames = new Set((roster ?? []).map((m) => m.name.toLowerCase()));
  const contextNames = new Set(memberNames);
  const leader = profile.team?.leader;
  if (leader) contextNames.add(leader.toLowerCase());

  const known = (set: Set<string>, name: string) => set.has(name.toLowerCase());
  const defines = () => {
    const parts = (roster ?? []).map((m) => m.name);
    return parts.length > 0 ? ` It defines: ${parts.join(', ')}.` : '';
  };

  // --- roster -------------------------------------------------------------
  if (o.team && Object.keys(o.team).length > 0) {
    const spec: string[] = [];
    for (const [name, rawCount] of Object.entries(o.team)) {
      const count = Math.floor(rawCount);
      // 0 REMOVES a role. That is a legal shape, expressed by omission from
      // the spec rather than by "x0", which the parser rejects outright.
      if (!Number.isFinite(rawCount) || count < 0) {
        errors.push(`'${name}' asks for ${rawCount} seats.`);
        continue;
      }
      if (count === 0) continue;
      if (count > MAX_SEATS) {
        errors.push(
          `'${name}' asks for ${count} seats. The cap is ${MAX_SEATS} — already far past what any measured run has used.`,
        );
        continue;
      }
      if (roster && !known(memberNames, name)) {
        errors.push(`'${name}' is not a member of profile '${profile.name}'.${defines()}`);
        continue;
      }
      if (unrepresentable(name)) {
        errors.push(`'${name}' contains a comma or space and cannot be expressed as a team spec.`);
        continue;
      }
      spec.push(`${name} x${count}`);
    }
    // Every role zeroed is a team with no members — a different request from
    // "change nothing", and one the profile cannot serve. Say so.
    if (spec.length === 0 && errors.length === 0) {
      errors.push(
        `every role in '${profile.name}' was set to 0 seats. A team needs at least one member; use the solo profile instead.`,
      );
    }
    if (spec.length > 0) args.push('--team', spec.join(', '));
  }

  // --- width --------------------------------------------------------------
  // ⛔ 0 IS A REAL VALUE (unlimited), so `undefined` — never 0 — is the unset
  // sentinel. Treating 0 as "not set" would silently drop a deliberate request
  // for an uncapped fan-out.
  if (o.teamWidth !== undefined && o.teamWidth !== null) {
    const w = Math.floor(o.teamWidth);
    if (!Number.isFinite(o.teamWidth) || w < 0) {
      errors.push(`team width must be 0 (unlimited) or more, got ${o.teamWidth}.`);
    } else {
      args.push('--team-width', String(w));
    }
  }

  // --- context ladders ----------------------------------------------------
  const ctxFlag = (value: number | undefined | null, flag: string, label: string) => {
    if (value === undefined || value === null) return;
    const v = Math.floor(value);
    if (!Number.isFinite(value) || v <= 0) {
      errors.push(`${label} must be a positive number of tokens, got ${value}.`);
      return;
    }
    args.push(flag, String(v));
  };
  ctxFlag(o.leaderContext, '--leader-context', 'leader context');
  ctxFlag(o.workerContext, '--worker-context', 'worker context');

  if (o.roleContext && Object.keys(o.roleContext).length > 0) {
    const rules: string[] = [];
    for (const [name, rawTokens] of Object.entries(o.roleContext)) {
      const tokens = Math.floor(rawTokens);
      if (!Number.isFinite(rawTokens) || tokens <= 0) {
        errors.push(`context for '${name}' must be a positive number of tokens, got ${rawTokens}.`);
        continue;
      }
      if (roster && !known(contextNames, name)) {
        errors.push(`'${name}' is not a member of profile '${profile.name}'.${defines()}`);
        continue;
      }
      if (unrepresentable(name) || name.includes('=')) {
        errors.push(`'${name}' contains a character that cannot be expressed in a context spec.`);
        continue;
      }
      rules.push(`${name}=${tokens}`);
    }
    if (rules.length > 0) args.push('--context', rules.join(', '));
  }

  return { args, errors };
}

/**
 * One-line summary of a customized shape, for the panel header and the log —
 * so a run that was shaped says so, and a reader of the session log can tell a
 * customized run from a profile-default one without reconstructing the argv.
 */
export function describeTeamOverrides(
  overrides: SessionOverrides | undefined,
  profile: Pick<ProfileSummary, 'name'> & Partial<Pick<ProfileSummary, 'team'>>,
): string {
  const { args } = buildTeamArgs(overrides, profile);
  if (args.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    parts.push(`${args[i].replace(/^--/, '')} ${args[i + 1]}`);
  }
  return parts.join('  ·  ');
}

/**
 * The override keys that describe a TEAM SHAPE, as opposed to the per-request
 * knobs the Settings drawer owns.
 */
export const TEAM_SHAPE_KEYS = [
  'team',
  'teamWidth',
  'leaderContext',
  'workerContext',
  'roleContext',
] as const;

/**
 * Fold a fresh batch of Settings-drawer overrides onto the ones already in
 * force, KEEPING the team shape.
 *
 * ⛔ WHY THIS IS NOT JUST AN ASSIGNMENT. The drawer rebuilds its payload from
 * scratch on every Apply and the host takes it verbatim - deliberately, so a
 * field the user cleared means "back to the profile default". That contract is
 * correct for the eleven fields the form actually renders, and silently
 * destructive for the five it does not: start a chat with `implementer x6`,
 * nudge the temperature, press Apply, and the roster is gone. The next respawn
 * runs profile defaults while the panel still says custom - a write that
 * succeeds and deletes your content, with nothing to see.
 *
 * A form cannot express "leave this alone" about a field it does not know
 * exists, so the host preserves those keys on its behalf. The shape is set once
 * at start and is cleared by starting a different chat, not by this drawer.
 */
export function mergeSettingsOverrides(
  previous: SessionOverrides | undefined,
  fromForm: SessionOverrides,
): SessionOverrides {
  const merged: SessionOverrides = { ...fromForm };
  if (!previous) return merged;
  for (const key of TEAM_SHAPE_KEYS) {
    const carried = previous[key];
    if (carried !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[key] = carried;
    }
  }
  return merged;
}

/**
 * One-line shape summary for a profile picker row: what this profile IS,
 * before you change anything.
 *
 * Lives here rather than beside the picker so it can be tested - the picker
 * module imports `vscode` and cannot load outside the extension host. Same
 * split, same reason, as profileDetail.
 */
export function teamShapeLabel(
  p: Pick<ProfileSummary, 'name'> & Partial<Pick<ProfileSummary, 'team'>>,
): string {
  const t = p.team;
  if (!t) return '';
  const seats = t.members.reduce((n, m) => n + m.count, 0);
  const roles = t.members.map((m) => (m.count > 1 ? `${m.name} x${m.count}` : m.name)).join(', ');
  // NULL IS NOT 0. `0` means the author deliberately chose "unlimited"; `null`
  // means the key was never written, which `vett validate` reports as an ERROR
  // and which throws at runtime. Rendering the second as "unlimited" would
  // present a misconfigured profile as a deliberate one - and the user would
  // pick it precisely because it looked like the widest option available.
  const width =
    t.maxConcurrentDispatches === null || t.maxConcurrentDispatches === undefined
      ? 'width not set'
      : t.maxConcurrentDispatches === 0
        ? 'unlimited at once'
        : `${t.maxConcurrentDispatches} at once`;
  return `team: ${t.leader || 'leader'} + ${seats} (${roles}) · ${width}`;
}

/**
 * Total seats a roster asks for, leader excluded. Drives the panel's live
 * "N workers" readout and the over-width warning.
 */
export function seatCount(team: Record<string, number> | undefined): number {
  if (!team) return 0;
  return Object.values(team).reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0), 0);
}
