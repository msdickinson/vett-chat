/**
 * Generates a vett profile YAML from auto-detected endpoint + model
 * (local) or from a validated cloud-provider key, and writes it to
 * `~/.vett/profiles/<name>.yaml`. Intentionally hand-rolled string
 * templates rather than pulling a YAML library into the extension
 * bundle — the format is stable and the file is meant to be edited
 * by hand afterwards.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CloudProfileSpec {
  /** Profile name (also the YAML filename). */
  name: string;
  /** Vett's `llm.provider` value: openai / anthropic / google. */
  providerYaml: string;
  /** Display label for the YAML header comment. */
  providerLabel: string;
  /** Default model id; user can override post-write by editing the YAML. */
  model: string;
  /** OpenAI-compatible base URL for the provider. See
   *  CloudProviderInfo.baseEndpoint for why this is written explicitly. */
  endpoint: string;
  /** Env var name vett expects in `api_key_env`. The actual key value
   *  lives in VS Code SecretStorage, NOT in the YAML. */
  envVarName: string;
}

export interface LocalProfileSpec {
  /** Profile name (also the YAML filename). */
  name: string;
  /** OpenAI-compat /v1 base URL (e.g. `http://localhost:11434/v1`). */
  endpoint: string;
  /** Model id. */
  model: string;
  /** One-line description for the YAML header. */
  source: string;
}

/**
 * A profile name becomes a FILENAME under `~/.vett/profiles`. `path.join`
 * resolves `..`, so an unvalidated name escapes the profile store, and both
 * writers then `writeFileSync` over whatever it lands on — no existence check,
 * no prompt (`confirmOverwriteProfile` in extension.ts consults
 * `profilePath()`, which would have been walked out of the store too, so it
 * says "doesn't exist, safe to write" about the wrong file).
 *
 * Both call sites today build the name from a fixed set — `${provider.id}-
 * onboarding` off CLOUD_PROVIDERS and `${chosen.kind}-detected` off the
 * detector — so there is no live exploit. This is a choke-point guard, the
 * same one WorktreeManager.assertSafePanelId applies to panel ids: these
 * functions are exported, and the next caller to hand them a typed name is
 * the one that gets hurt.
 */
function assertSafeProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error(
      `Refusing to write a profile named ${JSON.stringify(name)}. Expected only ` +
        'letters, digits, dot, dash and underscore, starting with a letter or digit. ' +
        'This name becomes a filename under ~/.vett/profiles and is written without ' +
        'a further overwrite check.',
    );
  }
}

/**
 * Render a value as a single-line YAML scalar.
 *
 * `spec.model` and `spec.endpoint` on the LOCAL path are not ours: they come
 * from whatever the detected server returned from `/v1/models`. A value
 * carrying a newline would close the `model:` line and inject arbitrary keys
 * into the generated profile — `api_key_env`, extra `tools`, a different
 * `endpoint` — in a file the user is then told is safe to hand-edit. Newlines
 * and control characters are rejected outright; values that merely need
 * quoting get quoted (YAML 1.2 accepts JSON's double-quoted form), so ordinary
 * ids like `gpt-4o` render exactly as before.
 */
function yamlScalar(value: string, field: string): string {
  // Explicit code-point scan rather than a regex character class. The first
  // draft of this guard wrote a class whose tail was a RANGE from space (0x20)
  // to hyphen (0x2D), so it rejected `gpt-4o` — the most ordinary model id
  // there is. A guard that blocks the common case is worse than no guard,
  // because it gets deleted instead of corrected.
  if (typeof value !== 'string') {
    // A caller that omits a field reaches here as undefined. Without this the
    // failure was "TypeError: value is not iterable" from inside a YAML
    // helper — true, and useless for finding which field was left out.
    throw new Error(
      `Refusing to write profile field '${field}': expected a string, got ${typeof value}.`,
    );
  }
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) {
      throw new Error(
        `Refusing to write profile field '${field}': the value contains a newline ` +
          'or control character, which would inject additional YAML keys into the ' +
          `generated profile. Value: ${JSON.stringify(value)}`,
      );
    }
  }
  // Quote only when a bare scalar would be ambiguous or would change meaning.
  const needsQuoting = value === '' || /^[\s>|*&!%@`'"[\]{},]|:\s|\s#|[:\s]$/.test(value);
  return needsQuoting ? JSON.stringify(value) : value;
}

/** Resolve the absolute filesystem path for a profile name. Pure —
 *  doesn't touch the disk. Callers can use this to check
 *  `fs.existsSync(profilePath(name))` BEFORE invoking the writers,
 *  which otherwise overwrite blindly.
 *
 *  Throws on a name that would escape `~/.vett/profiles` — see
 *  {@link assertSafeProfileName}. Callers that probe with an untrusted name
 *  should catch, and treat the throw as "not a writable profile". */
export function profilePath(name: string): string {
  assertSafeProfileName(name);
  return path.join(os.homedir(), '.vett', 'profiles', `${name}.yaml`);
}

/** Write a fresh local-model profile YAML to ~/.vett/profiles/<name>.yaml.
 *  Returns the absolute path written. Throws on filesystem failure —
 *  callers should surface the error to the user via showErrorMessage.
 *  Overwrites silently — gate at the caller via {@link profilePath} +
 *  `fs.existsSync` if you want a confirmation prompt. */
export function writeLocalProfile(spec: LocalProfileSpec): string {
  assertSafeProfileName(spec.name);
  const dir = path.join(os.homedir(), '.vett', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${spec.name}.yaml`);
  fs.writeFileSync(filePath, renderLocalProfileYaml(spec), { encoding: 'utf8' });
  return filePath;
}

/** Write a fresh cloud-provider profile YAML to ~/.vett/profiles/<name>.yaml.
 *  The API key itself is NOT in the YAML — vett reads it from the env var
 *  named in `api_key_env`, which the host populates from VS Code's
 *  SecretStorage at subprocess-spawn time. Returns the absolute path
 *  written. */
export function writeCloudProfile(spec: CloudProfileSpec): string {
  assertSafeProfileName(spec.name);
  const dir = path.join(os.homedir(), '.vett', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${spec.name}.yaml`);
  fs.writeFileSync(filePath, renderCloudProfileYaml(spec), { encoding: 'utf8' });
  return filePath;
}

/** Build the YAML body for a cloud-provider profile. Mirrors the
 *  bundled `coding.yaml` shape (chat-tuned tools + middleware, no
 *  auto-finish) with the LLM block configured for the chosen provider.
 *  The key itself is referenced by env var name only. */
export function renderCloudProfileYaml(spec: CloudProfileSpec): string {
  assertSafeProfileName(spec.name);
  return `name: ${yamlScalar(spec.name, 'name')}
description: |
  ${spec.providerLabel} cloud profile generated by Vett Chat onboarding.
  The API key lives in VS Code's SecretStorage; the host injects it as
  ${spec.envVarName} when spawning vett. Edit this file to switch model
  or tweak temperature; do NOT paste the key into the YAML.

llm:
  provider: ${yamlScalar(spec.providerYaml, 'provider')}
  endpoint: ${yamlScalar(spec.endpoint, 'endpoint')}
  model: ${yamlScalar(spec.model, 'model')}
  api_key_env: ${yamlScalar(spec.envVarName, 'api_key_env')}
  temperature: 0.3
  top_p: 0.95
  request_timeout_seconds: 300
  num_retries: 5

system_prompt: |
  You are a coding assistant working directly in the user's project directory.
  You have access to a bash terminal and a file editor. Use them to help the
  user with their coding tasks.

  Guidelines:
  - Be concise. Show your work through tool calls, not long explanations.
  - Read files before editing them so you understand the existing code.
  - Run tests after making changes to verify correctness.
  - If you need more information from the user, say so clearly.
  - When you complete a task, briefly summarize what you did.

tools:
  - terminal
  - file_editor
  - think

middleware:
  - output_truncation
  - stuck_detector

max_iterations: 200
timeout_minutes: 60
`;
}

/** Build the YAML body for a local-model profile. Mirrors the bundled
 *  `coding.yaml` shape — same tools, same middleware, same iteration
 *  budget — only the LLM block is parameterized. */
export function renderLocalProfileYaml(spec: LocalProfileSpec): string {
  assertSafeProfileName(spec.name);
  return `name: ${yamlScalar(spec.name, 'name')}
description: |
  Auto-detected local model (${spec.source}). Generated by Vett Chat onboarding.
  Edit this file to customize tools, system prompt, or LLM settings.

sandbox:
  type: local
  default_cwd: .

llm:
  provider: local
  endpoint: ${yamlScalar(spec.endpoint, 'endpoint')}
  model: ${yamlScalar(spec.model, 'model')}
  temperature: 0.3
  top_p: 0.95
  request_timeout_seconds: 300
  num_retries: 3

system_prompt: |
  You are a coding assistant working directly in the user's project directory.
  You have access to a bash terminal and a file editor. Use them to help the
  user with their coding tasks.

  Guidelines:
  - Be concise. Show your work through tool calls, not long explanations.
  - Read files before editing them so you understand the existing code.
  - Run tests after making changes to verify correctness.
  - If you need more information from the user, say so clearly.
  - When you complete a task, briefly summarize what you did.

tools:
  - terminal
  - file_editor
  - think

middleware:
  - output_truncation
  - stuck_detector

max_iterations: 200
timeout_minutes: 60
`;
}
