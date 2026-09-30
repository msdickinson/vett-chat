import * as vscode from 'vscode';
import type { ProfileSummary, SessionOverrides } from '../shared/types';
import type { ProfileService } from '../process/profileService';
import { profileDetail } from './profileDetail';
import { buildTeamArgs, seatCount, teamShapeLabel } from '../process/teamArgs';

/**
 * "New Chat (Custom)" — pick a profile, then shape the team for THIS run only.
 *
 * ⭐ WHY THIS EXISTS AT ALL. Every knob here already existed on the CLI
 * (`--team`, `--team-width`, `--leader-context`, `--context`), and the
 * extension already forwarded per-session overrides. What was missing was the
 * one thing that makes them usable: the extension spawned
 * `['chat','--stdio','--profile',profile,'--cwd',cwd]` and nothing else, so it
 * could not ask how many workers you wanted — nothing told it that "workers"
 * existed. The roster now comes from `vett profiles --json`.
 *
 * ⛔ THE ROSTER IS READ, NEVER GUESSED. Role names are offered exactly as the
 * binary published them, because `--team` rejects an unknown name outright
 * rather than quietly building a smaller team. A picker that let you type a
 * role would be a picker that can compose a run which dies at spawn.
 *
 * ⛔ NOTHING HERE IS PERSISTED. The profile YAML is untouched; these choices
 * live for one session. That is the whole point of the feature: a
 * simple per-chat override, without spinning up a whole new team config.
 * Persisting silently would recreate the 2,912-line generated
 * profiles this replaces.
 */

/** What the customize flow produced. `undefined` = the user backed out. */
export interface CustomizedSession {
  profile: string;
  overrides: SessionOverrides;
}

const START = '$(play) Start chat';
const RESET = '$(discard) Reset to profile defaults';

/** Roles a profile declares, as seats — the panel's working copy. */
function initialSeats(p: ProfileSummary): Record<string, number> {
  const seats: Record<string, number> = {};
  for (const m of p.team?.members ?? []) seats[m.name] = m.count;
  return seats;
}

async function pickProfile(
  profileService: ProfileService,
  current: string,
): Promise<ProfileSummary | undefined> {
  const listed = await profileService.list(true);
  if (!listed.ok) {
    vscode.window.showErrorMessage(`Vett Chat: couldn't list profiles — ${listed.error}`);
    return undefined;
  }
  if (listed.profiles.length === 0) {
    vscode.window.showWarningMessage(
      'No vett profiles found. Install vett or run `vett install defaults` in your workspace.',
    );
    return undefined;
  }

  const items = listed.profiles.map((p) => ({
    label: p.name,
    description: [p.name === current ? '(current)' : '', p.team ? '' : 'solo']
      .filter(Boolean)
      .join(' '),
    // The shape first when there is one — it is what this flow is for.
    detail: teamShapeLabel(p) || profileDetail(p),
    profile: p,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a profile to customize for this chat',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.profile;
}

async function askNumber(
  prompt: string,
  value: number | undefined,
  opts: { min: number; max: number; allowBlank?: string },
): Promise<number | undefined | 'cancelled'> {
  const answer = await vscode.window.showInputBox({
    prompt,
    value: value === undefined ? '' : String(value),
    placeHolder: opts.allowBlank,
    validateInput: (raw) => {
      const t = raw.trim();
      if (t === '') return opts.allowBlank ? null : 'Enter a number.';
      if (!/^\d+$/.test(t)) return 'Numbers only.';
      const n = Number(t);
      if (n < opts.min || n > opts.max) return `Must be between ${opts.min} and ${opts.max}.`;
      return null;
    },
  });
  if (answer === undefined) return 'cancelled';
  const t = answer.trim();
  return t === '' ? undefined : Number(t);
}

export async function customizeTeamShape(
  profileService: ProfileService,
  currentProfile: string,
): Promise<CustomizedSession | undefined> {
  const profile = await pickProfile(profileService, currentProfile);
  if (!profile) return undefined;

  // A solo profile has no roster to resize. Starting straight away is the
  // honest response — showing an empty team editor would imply the knobs do
  // something here.
  if (!profile.team) {
    return { profile: profile.name, overrides: {} };
  }

  const seats = initialSeats(profile);
  let width: number | undefined;
  let leaderContext: number | undefined;
  let workerContext: number | undefined;

  for (;;) {
    const total = seatCount(seats);
    const rows: (vscode.QuickPickItem & { action?: string; role?: string })[] = [];

    rows.push({
      label: START,
      detail: `${profile.name} — ${profile.team.leader || 'leader'} + ${total} worker${total === 1 ? '' : 's'}`,
      action: 'start',
    });

    rows.push({ label: 'Workers', kind: vscode.QuickPickItemKind.Separator });
    for (const m of profile.team.members) {
      const n = seats[m.name] ?? 0;
      rows.push({
        label: `$(person) ${m.name}`,
        description: n === 0 ? 'removed' : `${n} seat${n === 1 ? '' : 's'}`,
        detail: n === m.count ? undefined : `profile default: ${m.count}`,
        role: m.name,
        action: 'seats',
      });
    }

    rows.push({ label: 'Limits', kind: vscode.QuickPickItemKind.Separator });
    rows.push({
      label: '$(dashboard) Working at once',
      description:
        width === undefined
          ? `profile default${
              profile.team.maxConcurrentDispatches === null
                ? ''
                : ` (${profile.team.maxConcurrentDispatches === 0 ? 'unlimited' : profile.team.maxConcurrentDispatches})`
            }`
          : width === 0
            ? 'unlimited'
            : String(width),
      detail: 'How many members may run concurrently. 0 = unlimited.',
      action: 'width',
    });
    rows.push({
      label: '$(book) Leader memory',
      description: leaderContext === undefined ? 'profile default' : `${leaderContext} tokens`,
      detail: 'Give the leader a bigger window than the workers when it holds the whole plan.',
      action: 'leaderContext',
    });
    rows.push({
      label: '$(book) Worker memory',
      description: workerContext === undefined ? 'profile default' : `${workerContext} tokens`,
      detail: 'Applies to every member.',
      action: 'workerContext',
    });

    rows.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    rows.push({ label: RESET, action: 'reset' });

    const picked = await vscode.window.showQuickPick(rows, {
      placeHolder: `Customize ${profile.name} for this chat — pick Start when ready`,
      matchOnDetail: true,
    });
    if (!picked) return undefined; // Escape = back out, start nothing.

    if (picked.action === 'start') break;

    if (picked.action === 'reset') {
      for (const m of profile.team.members) seats[m.name] = m.count;
      width = leaderContext = workerContext = undefined;
      continue;
    }

    if (picked.action === 'seats' && picked.role) {
      const n = await askNumber(`How many '${picked.role}' seats? (0 removes the role)`, seats[picked.role], {
        min: 0,
        max: 64,
      });
      if (n !== 'cancelled' && n !== undefined) seats[picked.role] = n;
      continue;
    }

    if (picked.action === 'width') {
      const n = await askNumber('How many members may work at once? (0 = unlimited)', width, {
        min: 0,
        max: 64,
        allowBlank: 'blank = use the profile default',
      });
      // ⛔ `undefined` from a blank box means "use the profile default" and
      // must be preserved as undefined — 0 is a REAL width meaning unlimited.
      if (n !== 'cancelled') width = n;
      continue;
    }

    if (picked.action === 'leaderContext' || picked.action === 'workerContext') {
      const which = picked.action === 'leaderContext' ? 'leader' : 'worker';
      const n = await askNumber(`${which} compaction trigger, in tokens`,
        picked.action === 'leaderContext' ? leaderContext : workerContext, {
          min: 1000,
          max: 10_000_000,
          allowBlank: 'blank = use the profile default',
        });
      if (n !== 'cancelled') {
        if (picked.action === 'leaderContext') leaderContext = n;
        else workerContext = n;
      }
      continue;
    }
  }

  // Only send what actually differs from the profile. An override that merely
  // restates the default is not harmless: it pins the run to today's YAML, so a
  // later edit to the profile silently stops applying to "unchanged" sessions.
  const changed: Record<string, number> = {};
  let anySeatChange = false;
  for (const m of profile.team.members) {
    const n = seats[m.name] ?? 0;
    if (n !== m.count) anySeatChange = true;
    changed[m.name] = n;
  }

  const overrides: SessionOverrides = {};
  if (anySeatChange) overrides.team = changed;
  if (width !== undefined) overrides.teamWidth = width;
  if (leaderContext !== undefined) overrides.leaderContext = leaderContext;
  if (workerContext !== undefined) overrides.workerContext = workerContext;

  // Last gate before a panel is created. The same validator the spawn path
  // uses, run here so the message lands on the form the user is still looking
  // at rather than on an empty chat window.
  const { errors } = buildTeamArgs(overrides, profile);
  if (errors.length > 0) {
    vscode.window.showErrorMessage(`This team shape cannot run: ${errors.join(' ')}`);
    return undefined;
  }

  return { profile: profile.name, overrides };
}
