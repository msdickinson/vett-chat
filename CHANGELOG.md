# Changelog

## 0.4.1

### Fixed

- **The Settings drawer no longer deletes the team shape.** Starting a chat with
  `Custom…` and then pressing Apply (or Reset) in Session Settings silently wiped
  the roster, fan-out width and per-seat context: the drawer rebuilds its payload
  from the eleven fields it renders and the host assigned that straight over the
  session overrides. The next respawn ran profile defaults while the panel still
  read as customized. The host now carries the five team-shape keys across a
  settings Apply (`mergeSettingsOverrides`); the drawer's own fields keep their
  existing "missing means profile default" contract. Found in audit before first
  use. Regression-tested and mutation-verified, including that width `0`
  (unlimited) survives — a truthiness carry-over would have dropped exactly that.
- **The team shape is now visible.** Session Settings shows a read-only
  "Team for this chat" block with the flags actually being passed, and says it is
  unaffected by Apply/Reset. Previously a shaped run was indistinguishable from a
  profile-default one anywhere in the UI.

## 0.4.0 - New Chat (Custom): shape the team at start time

### Added
- **`+ New Chat` now has a `Custom...` sibling**, plus a gear button in the
  Sessions title bar and a `Vett Chat: New Chat (Custom Team)` command. It
  opens a Customize step: pick a profile, then set how many seats each role
  gets, how many members may work at once, and how much memory the leader and
  the workers get - for that chat only. The profile YAML is never written.
- `vett profiles --json` (vett >= 2026-08-28) now publishes each profile's
  roster, and the picker reads it. That is what made this possible at all:
  before, nothing told the extension that a profile even HAS roles, so it
  could not have asked how many you wanted.
- The chosen profile is per-panel. Picking one in Customize does not repoint
  the workspace `vett-chat.profile` setting, so a one-off custom run cannot
  silently become the new default for every future chat.

### Behaviour worth knowing
- A shape that cannot run is refused BEFORE the subprocess starts, naming the
  roles the profile actually defines. `--team` treats an unknown role as an
  error rather than as a smaller team, so without this check a typo surfaced
  as a parse error from a dead subprocess.
- A seat count of 0 removes that role. Zeroing every role is refused.
- Fan-out width `0` means unlimited and is forwarded as such - it is a real
  value, not "unset".
- Against a vett older than 2026-08-28 no roster is published. The flags are
  then forwarded unchecked and the binary decides: "could not check" is not
  "checked and wrong".


## 0.3.0 — Profile-driven, type-while-busy

### Architectural shift
The extension is now a thin shell over `vett`. Profiles in vett are the
single source of truth for endpoint, model, API key, system prompt, and
tools. The extension only decides which profile to invoke — to change
LLM config, edit the profile YAML.

### Removed (breaking for upgraders)
- `vett-chat.endpoint` setting
- `vett-chat.model` setting
- `vett-chat.apiKey` setting

If you previously set those, move them into a profile YAML before
upgrading. The recommended path is to drop a per-user override at
`~/.vett/profiles/<name>.yaml` (e.g. copy the bundled `coding.yaml`
and pin your endpoint+model under `llm:`).

### Added
- **Profile picker** via the Command Palette (`Vett Chat: Pick Profile`)
  — shows every installed profile with model, endpoint, provider, and
  tools. Selection is written to `vett-chat.profile`.
- **Type-while-busy queue**: typing and hitting Send while the agent is
  mid-turn now queues the message inline (with a dashed border + "queued"
  label) and flushes it the moment the agent reaches a ready state. The
  Send button reads "Queue" while busy and "Send" while idle. Cancel sits
  alongside Send while busy.
- **Welcome view shows the active profile's resolved config** —
  endpoint/model/tools come from `vett profiles --json` so what you see
  in welcome matches what vett will actually use.

### Vett CLI changes (paired)
- `vett profiles --json` emits a JSON array (name, description, model,
  endpoint, provider, maxIterations, tools, sandboxType) used by the
  extension's profile picker and welcome view.
- Profile resolution now also checks `~/.vett/profiles/<name>.yaml` —
  per-user overrides without committing into a workspace.

## 0.2.0 — Private beta

First release suitable for sharing with users outside the dev loop.

### Added
- First-run welcome view — explains that Chat is a *proving ground* for
  trying profiles/models/endpoints, not a real ticket-processing
  surface. Walks through endpoint configuration in three steps and
  surfaces current config status (endpoint / model / profile) inline.
  Re-show on demand via the new `Vett Chat: Show Welcome` command.
- Connection failure UX: any failure mode (binary missing, no
  workspace folder, subprocess crash, LLM endpoint unreachable, agent
  error) now renders an `ErrorBanner` with kind-specific copy, the last
  stderr lines as expandable details, and Retry / Open Settings /
  Open Folder buttons.
- Cancel button — while an agent turn is actively in flight, the Send
  button swaps to a Cancel button. Optimistically clears the spinner and
  marks any in-flight tool calls as `(cancelled)`.

### Changed
- Settings descriptions rewritten as `markdownDescription` with concrete
  examples (vLLM/Ollama/OpenAI URLs, model names, install command for
  the `vett` binary). `vett-chat.apiKey` now scoped to `machine` so it
  doesn't sync across machines via Settings Sync.
- Tool result rendering now reads `result_preview` from
  `tool_call_end` events (was reading the non-existent `result_length`
  field — results were rendering blank). Truncated results display the
  full original size and point at the on-disk session log.
- Subprocess exit errors now include the last 20 lines of stderr as
  details, so users see *why* vett died rather than just an exit code.

### Documentation
- Internal design notes (not included in this repository): a
  feature-by-feature comparison with an earlier web chat, and the
  distribution plan (sideload for beta, marketplace for v1.0,
  auto-update story, telemetry stance: "collects nothing").

## 0.1.0

Initial release: subprocess-driven chat panel against `vett chat
--stdio`, JSONL session log for AI Timeline replay, basic tool-call
cards.
