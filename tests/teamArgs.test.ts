import { describe, it, expect } from 'vitest';
import {
  buildTeamArgs,
  describeTeamOverrides,
  mergeSettingsOverrides,
  seatCount,
  TEAM_SHAPE_KEYS,
  teamShapeLabel,
} from '../src/process/teamArgs';
import type { SessionOverrides, TeamSummary } from '../src/shared/types';

/**
 * TEAM-SHAPE COMPOSITION GATE.
 *
 * What this protects: `--team` treats an unknown role name as an ERROR, not as
 * a smaller team (TeamOverride.cs:132-145). That is correct for a CLI, but it
 * means a GUI which can compose an unknown name has only moved the failure —
 * the user configures a whole run, hits Start, and gets a subprocess parse
 * error that reads like a broken binary.
 *
 * ⛔ THE BACKWARD-COMPATIBILITY ARM IS THE LIVE CONFIGURATION, NOT THE EXOTIC
 * ONE. `profile.team` is published only by a `vett` from 2026-08-28 or newer,
 * and is legitimately absent for every solo profile. "Could not check" must
 * forward, not refuse — refusing would break the extension against every older
 * binary it is supposed to keep working with.
 */

const flashTeam: TeamSummary = {
  leader: 'lead',
  maxConcurrentDispatches: 4,
  members: [
    { name: 'implementer', count: 1 },
    { name: 'researcher', count: 1 },
    { name: 'reviewer', count: 1 },
  ],
};

const profile = { name: 'ds-team-flash', team: flashTeam };

describe('buildTeamArgs', () => {
  it('emits nothing when nothing was customized', () => {
    expect(buildTeamArgs(undefined, profile)).toEqual({ args: [], errors: [] });
    expect(buildTeamArgs({}, profile)).toEqual({ args: [], errors: [] });
  });

  it('builds the roster spec vett parses, in "role xN" form', () => {
    const { args, errors } = buildTeamArgs({ team: { implementer: 6, reviewer: 2 } }, profile);
    expect(errors).toEqual([]);
    expect(args).toEqual(['--team', 'implementer x6, reviewer x2']);
  });

  /**
   * ⭐ THE SPACE IS LOad-BEARING, NOT COSMETIC. vett's parser only reaches its
   * "count glued to the name" branch when the entry has NO space in it, and
   * that branch splits on the LAST 'x' — so a role legitimately containing an
   * x followed by digits would be silently re-read as a different role with a
   * different count. Emitting "name xN" with the space keeps every entry on the
   * unambiguous branch.
   */
  it('always emits a space before the count, keeping vett off its glued-count branch', () => {
    const { args } = buildTeamArgs({ team: { implementer: 5 } }, profile);
    expect(args[1]).toBe('implementer x5');
    expect(args[1]).not.toBe('implementerx5');
  });

  it('refuses a role the profile does not define, and names what it does define', () => {
    const { args, errors } = buildTeamArgs({ team: { implementor: 3 } }, profile);
    expect(args).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'implementor' is not a member");
    // The message has to carry the real names or the user cannot fix the typo.
    expect(errors[0]).toContain('implementer');
    expect(errors[0]).toContain('researcher');
  });

  it('matches role names case-insensitively, as the resolver does', () => {
    const { args, errors } = buildTeamArgs({ team: { Implementer: 2 } }, profile);
    expect(errors).toEqual([]);
    expect(args).toEqual(['--team', 'Implementer x2']);
  });

  it('treats 0 seats as REMOVING a role rather than as an error', () => {
    const { args, errors } = buildTeamArgs({ team: { implementer: 4, researcher: 0 } }, profile);
    expect(errors).toEqual([]);
    expect(args).toEqual(['--team', 'implementer x4']);
  });

  it('refuses a roster where every role was zeroed, instead of sending an empty spec', () => {
    const { args, errors } = buildTeamArgs({ team: { implementer: 0, reviewer: 0 } }, profile);
    expect(args).toEqual([]);
    expect(errors[0]).toContain('every role');
  });

  it('refuses a seat count past vett’s own cap', () => {
    const { errors } = buildTeamArgs({ team: { implementer: 65 } }, profile);
    expect(errors[0]).toContain('cap is 64');
  });

  /**
   * ⛔ 0 IS A REAL WIDTH (unlimited). If `undefined` were not the only unset
   * sentinel, a deliberate request for an uncapped fan-out would be silently
   * dropped — and the run would quietly cap at the profile default while the
   * panel showed "unlimited".
   */
  it('forwards width 0 as unlimited, and omits the flag only when truly unset', () => {
    expect(buildTeamArgs({ teamWidth: 0 }, profile).args).toEqual(['--team-width', '0']);
    expect(buildTeamArgs({ teamWidth: 8 }, profile).args).toEqual(['--team-width', '8']);
    expect(buildTeamArgs({}, profile).args).toEqual([]);
  });

  it('refuses a negative width', () => {
    const { args, errors } = buildTeamArgs({ teamWidth: -1 }, profile);
    expect(args).toEqual([]);
    expect(errors[0]).toContain('team width');
  });

  it('builds the per-role context spec and accepts the LEADER by name', () => {
    const { args, errors } = buildTeamArgs(
      { leaderContext: 120000, roleContext: { implementer: 60000, lead: 90000 } },
      profile,
    );
    expect(errors).toEqual([]);
    expect(args).toContain('--leader-context');
    expect(args[args.indexOf('--leader-context') + 1]).toBe('120000');
    expect(args[args.indexOf('--context') + 1]).toBe('implementer=60000, lead=90000');
  });

  it('refuses a context rule for a role that is not on the team', () => {
    const { errors } = buildTeamArgs({ roleContext: { nobody: 1000 } }, profile);
    expect(errors[0]).toContain("'nobody' is not a member");
  });

  it('refuses a non-positive context', () => {
    expect(buildTeamArgs({ leaderContext: 0 }, profile).errors[0]).toContain('leader context');
    expect(buildTeamArgs({ roleContext: { implementer: -5 } }, profile).errors[0]).toContain('implementer');
  });

  /**
   * THE LIVE CASE for every `vett` older than 2026-08-28, and for every solo
   * profile. Absence of a roster is "I could not check", which is not a verdict
   * — the flags go through and the binary stays the one that decides.
   */
  it('forwards unverifiable names when the profile publishes no roster', () => {
    const older = { name: 'ds-team-flash' };
    const { args, errors } = buildTeamArgs({ team: { anything: 3 } }, older);
    expect(errors).toEqual([]);
    expect(args).toEqual(['--team', 'anything x3']);
  });

  it('refuses a role name that cannot survive the spec format', () => {
    const odd = { name: 'p', team: { ...flashTeam, members: [{ name: 'a b', count: 1 }] } };
    const { args, errors } = buildTeamArgs({ team: { 'a b': 2 } }, odd);
    expect(args).toEqual([]);
    expect(errors[0]).toContain('cannot be expressed');
  });

  it('combines every flag in one argv', () => {
    const { args, errors } = buildTeamArgs(
      { team: { implementer: 6, reviewer: 2 }, teamWidth: 8, leaderContext: 120000 },
      profile,
    );
    expect(errors).toEqual([]);
    expect(args).toEqual([
      '--team', 'implementer x6, reviewer x2',
      '--team-width', '8',
      '--leader-context', '120000',
    ]);
  });
});

describe('describeTeamOverrides', () => {
  it('is empty for an unshaped run, so a default run cannot look customized', () => {
    expect(describeTeamOverrides({}, profile)).toBe('');
  });

  it('summarizes a shaped run for the header and the log', () => {
    const s = describeTeamOverrides({ team: { implementer: 6 }, teamWidth: 8 }, profile);
    expect(s).toBe('team implementer x6  ·  team-width 8');
  });
});

describe('teamShapeLabel', () => {
  it('names the leader, the seat total, and every role', () => {
    const s = teamShapeLabel(profile);
    expect(s).toContain('lead');
    expect(s).toContain('+ 3');
    expect(s).toContain('implementer');
    expect(s).toContain('reviewer');
  });

  it('collapses repeated roles into xN rather than listing them twice', () => {
    const s = teamShapeLabel({
      name: 'p',
      team: { ...flashTeam, members: [{ name: 'implementer', count: 6 }] },
    });
    expect(s).toContain('implementer x6');
    expect(s).toContain('+ 6');
  });

  /**
   * ⛔ THE DISTINCTION THIS ROW EXISTS TO PRESERVE. `0` is a deliberate
   * "unlimited"; `null` is a profile that never declared the key at all —
   * a `vett validate` ERROR and a runtime throw. Collapsing null into 0 would
   * paint a broken profile as the widest one on offer, which is exactly the
   * one a user shopping for fan-out would pick.
   */
  it('never renders an undeclared width as unlimited', () => {
    const unlimited = teamShapeLabel({ name: 'p', team: { ...flashTeam, maxConcurrentDispatches: 0 } });
    const missing = teamShapeLabel({ name: 'p', team: { ...flashTeam, maxConcurrentDispatches: null } });
    expect(unlimited).toContain('unlimited at once');
    expect(missing).toContain('width not set');
    expect(missing).not.toContain('unlimited');
  });

  it('is empty for a solo profile, so it cannot claim a team that is not there', () => {
    expect(teamShapeLabel({ name: 'coding' })).toBe('');
  });
});

describe('mergeSettingsOverrides', () => {
  /**
   * ⛔ THE REGRESSION THIS FILE EXISTS FOR. Shipped broken and caught in audit:
   * SettingsView.apply() rebuilds its payload from the eleven fields it
   * renders, and the host assigned it straight over sessionOverrides. So
   * starting `implementer x6` and then nudging the temperature DELETED the
   * roster — the respawn ran profile defaults while the panel still read as
   * customized. A write that succeeds and destroys your content.
   */
  it('keeps the team shape when the Settings drawer applies its own fields', () => {
    const started: SessionOverrides = {
      team: { implementer: 6, reviewer: 2 },
      teamWidth: 8,
      leaderContext: 120000,
    };
    const fromForm: SessionOverrides = { temperature: 0.2, maxIterations: 40 };

    const merged = mergeSettingsOverrides(started, fromForm);

    expect(merged.team).toEqual({ implementer: 6, reviewer: 2 });
    expect(merged.teamWidth).toBe(8);
    expect(merged.leaderContext).toBe(120000);
    expect(merged.temperature).toBe(0.2);
    expect(merged.maxIterations).toBe(40);
  });

  it('still lets the drawer clear a field it owns', () => {
    const merged = mergeSettingsOverrides(
      { temperature: 0.9, team: { implementer: 3 } },
      {},
    );
    // Absent from the form payload means "back to the profile default" — that
    // contract is unchanged for the fields the form actually renders.
    expect(merged.temperature).toBeUndefined();
    expect(merged.team).toEqual({ implementer: 3 });
  });

  it('survives Reset, which posts an empty payload', () => {
    const merged = mergeSettingsOverrides({ teamWidth: 0, workerContext: 30000 }, {});
    // ⛔ 0 IS A REAL WIDTH (unlimited). A carry-over written as a truthiness
    // check would drop exactly this value and silently re-cap the fan-out.
    expect(merged.teamWidth).toBe(0);
    expect(merged.workerContext).toBe(30000);
  });

  it('carries nothing when the chat was never customized', () => {
    expect(mergeSettingsOverrides({}, { topP: 0.5 })).toEqual({ topP: 0.5 });
    expect(mergeSettingsOverrides(undefined, { topP: 0.5 })).toEqual({ topP: 0.5 });
  });

  it('covers every team key, so a new one cannot be forgotten here', () => {
    const shape: SessionOverrides = {
      team: { implementer: 2 },
      teamWidth: 4,
      leaderContext: 90000,
      workerContext: 40000,
      roleContext: { reviewer: 20000 },
    };
    const merged = mergeSettingsOverrides(shape, {});
    for (const key of TEAM_SHAPE_KEYS) {
      expect(merged[key], `team key '${key}' was dropped`).toEqual(shape[key]);
    }
  });
});

describe('seatCount', () => {
  it('sums seats and ignores removed or invalid roles', () => {
    expect(seatCount({ implementer: 6, reviewer: 2 })).toBe(8);
    expect(seatCount({ implementer: 6, reviewer: 0 })).toBe(6);
    expect(seatCount(undefined)).toBe(0);
  });
});
