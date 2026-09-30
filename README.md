# VETT Chat

[![CI](https://github.com/msdickinson/vett-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/msdickinson/vett-chat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A VS Code panel for the [VETT](https://github.com/msdickinson/vett) agent loop and agent teams, on local or hosted models.**

> **State:** VETT Chat is in regular use, but it's still being put through
> its paces, so expect some rough edges (see Known issues below). VETT itself
> is the more mature part.

Each chat runs `vett chat --stdio` as a local subprocess in your workspace
and renders what the agent does: messages, tool calls, and, for team
profiles, each worker's dispatch. The model is whatever your VETT profile
points at: vLLM, Ollama, LM Studio, or a hosted API. The extension adds no
service of its own. Nothing leaves your machine unless the profile's
endpoint is remote.

## What it does

- **Chat with the VETT agent** in a sidebar or editor tab, on the open
  workspace. It is the same loop VETT benchmarks with, so a profile behaves
  the same in chat as in a run.
- **Teams.** With a team profile, the lead's dispatches show up as cards you
  can expand. `New Chat (Custom Team)` sets seats per role, how many work at
  once, and leader/worker context for one chat, without editing the YAML.
- **Profiles are the config.** Endpoint, model, key, prompt and tools live in
  the VETT profile. `Vett Chat: Pick Profile` lists what `vett profiles
  --json` reports.
- **Model setup.** `Set Up a Model…` probes common local ports (Ollama 11434,
  LM Studio 1234, vLLM 8000/8001) or takes a key for OpenAI, Anthropic or
  Google. Keys go into VS Code's SecretStorage, never into the YAML.
- **Inline edit** (`Ctrl+I` / `Cmd+I`), plus CodeLens and QuickFix entries,
  through `vett edit`, with a diff to Apply / Cancel / Iterate.
- **Optional git-worktree isolation** per chat (`vett-chat.useWorktree`),
  and a checkpoint before each message so you can roll files back.
- **Session logs** as JSONL in `~/.vett/chat-sessions/`, in the same event
  format VETT uses for runs. Resume past chats; view them as a timeline.
- **Voice input**, optional: needs `ffmpeg` and a Whisper-compatible
  endpoint (`vett-chat.whisperEndpoint`).

## Requirements

- **VS Code** 1.85 or newer
- **VETT**, installed as a .NET tool. Download `VettBench.*.nupkg` from
  [VETT's Releases](https://github.com/msdickinson/vett/releases), then

  ```bash
  dotnet tool install --global --add-source <folder-with-the-nupkg> VettBench
  vett --help
  ```

  Or build it from source; see [VETT's install notes](https://github.com/msdickinson/vett#install).
- **A model endpoint** that your VETT profile points at.

### How it finds `vett`

In order, first match wins:

1. the `vett-chat.vettPath` setting, if set
2. `~/.dotnet/tools/vett` (where `dotnet tool install --global` puts it)
3. `~/go/bin/vett` (older installs)
4. `vett` on your `PATH`

If none is found, the panel shows every path it checked.

## Install

Download `vett-chat-<version>.vsix` from
[Releases](https://github.com/msdickinson/vett-chat/releases), then

```bash
code --install-extension vett-chat-<version>.vsix
```

or in VS Code: Extensions → `…` → Install from VSIX. It is not on the
Marketplace.

## Configure

Pick a profile with `vett-chat.profile` (default `coding`). VETT looks for
it in `<workspace>/profiles/`, then `~/.vett/profiles/`, then its built-in
defaults. To change the model or endpoint, edit the profile, not the
extension settings. `vett validate --profile <name>` says what is missing.

The other settings (tool-card density, context-window gauge size, worktree
mode, voice) are under `vett-chat` in VS Code settings.

## Build from source

Needs Node.js 22.

```bash
npm ci
npm run build          # type-check, then bundle to dist/
npm test               # vitest unit tests
npm run package        # writes vett-chat-<version>.vsix
```

Press F5 in VS Code to run it in an Extension Development Host.

`npm run test:integration` loads the built extension in a real VS Code
extension host and checks activation, commands, views and settings. It
needs a local VS Code install, so CI does not run it; see
[integration/README.md](integration/README.md).

## Known issues / state

- It has had little real use. Expect rough edges beyond this list.
- The `vett-chat.useWorktree` setting text and the Settings drawer still say
  a workspace without git falls back to a recursive copy. That fallback was
  removed: without git, the chat shows a warning and runs directly in the
  workspace instead.
- Team shaping (`New Chat (Custom Team)`) checks role names against the
  roster that `vett profiles --json` publishes. Against an older `vett`
  that publishes no roster, the flags are passed on unchecked and `vett`
  decides.
- Removed in 0.3.0: the `vett-chat.endpoint`, `vett-chat.model` and
  `vett-chat.apiKey` settings. Put those in a profile instead.
- No Marketplace listing and no PNG icon yet (see `assets/README.md`).

Release history is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
