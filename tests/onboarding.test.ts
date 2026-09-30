import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderLocalProfileYaml, writeLocalProfile, renderCloudProfileYaml, writeCloudProfile, profilePath } from '../src/onboarding/profileWriter';
import { CLOUD_PROVIDERS } from '../src/onboarding/cloudOnboarding';

describe('renderLocalProfileYaml', () => {
  it('emits a profile with the supplied endpoint + model', () => {
    const yaml = renderLocalProfileYaml({
      name: 'ollama-detected',
      endpoint: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      source: 'Ollama (3 models)',
    });
    expect(yaml).toContain('name: ollama-detected');
    expect(yaml).toContain('endpoint: http://localhost:11434/v1');
    expect(yaml).toContain('model: qwen2.5-coder:7b');
    expect(yaml).toContain('provider: local');
  });

  it('preserves the bundled coding-profile tool list + middleware', () => {
    // The new profile should mirror the bundled `coding.yaml` shape so
    // a freshly-onboarded user gets the same chat-tuned defaults.
    const yaml = renderLocalProfileYaml({
      name: 'lm-studio-detected',
      endpoint: 'http://localhost:1234/v1',
      model: 'llama-3.2-3b-instruct',
      source: 'LM Studio (1 model)',
    });
    expect(yaml).toContain('- terminal');
    expect(yaml).toContain('- file_editor');
    expect(yaml).toContain('- think');
    expect(yaml).toContain('- output_truncation');
    expect(yaml).toContain('- stuck_detector');
    expect(yaml).toContain('max_iterations: 200');
  });

  it('mentions the source in the description for the YAML reader', () => {
    const yaml = renderLocalProfileYaml({
      name: 'vllm-detected',
      endpoint: 'http://localhost:8000/v1',
      model: 'qwen2.5-coder-32b-instruct',
      source: 'vLLM @ :8000',
    });
    expect(yaml).toContain('vLLM @ :8000');
  });
});

describe('renderCloudProfileYaml', () => {
  it('emits a profile that points at the right provider + model', () => {
    const yaml = renderCloudProfileYaml({
      name: 'openai-onboarding',
      providerYaml: 'openai',
      providerLabel: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      envVarName: 'OPENAI_API_KEY',
    });
    expect(yaml).toContain('name: openai-onboarding');
    expect(yaml).toContain('provider: openai');
    expect(yaml).toContain('model: gpt-4o-mini');
    expect(yaml).toContain('api_key_env: OPENAI_API_KEY');
  });

  it('does not embed the API key in the YAML', () => {
    // Sanity check: only the env var name should land on disk.
    const yaml = renderCloudProfileYaml({
      name: 'anthropic-onboarding',
      providerYaml: 'anthropic',
      providerLabel: 'Anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      model: 'claude-haiku-4-5-20251001',
      envVarName: 'ANTHROPIC_API_KEY',
    });
    expect(yaml).not.toMatch(/sk-/);
    expect(yaml).not.toMatch(/api_key:\s*[^_E]/i); // no `api_key:` followed by a real value
    expect(yaml).toContain('SecretStorage');
  });

  it('mirrors the chat-tuned coding profile shape', () => {
    // No `finish` (no auto-terminate), same middleware pair as
    // bundled coding.yaml, generous iteration budget.
    const yaml = renderCloudProfileYaml({
      name: 'google-onboarding',
      providerYaml: 'google',
      providerLabel: 'Google (Gemini)',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash',
      envVarName: 'GEMINI_API_KEY',
    });
    expect(yaml).toContain('- terminal');
    expect(yaml).toContain('- file_editor');
    expect(yaml).toContain('- think');
    expect(yaml).not.toContain('- finish');
    expect(yaml).toContain('- output_truncation');
    expect(yaml).toContain('- stuck_detector');
    expect(yaml).toContain('max_iterations: 200');
  });
});

describe('CLOUD_PROVIDERS', () => {
  it('covers OpenAI, Anthropic, and Google', () => {
    const ids = CLOUD_PROVIDERS.map((p) => p.id).sort();
    expect(ids).toEqual(['anthropic', 'google', 'openai']);
  });

  it('every provider points at an https endpoint and an env var name', () => {
    for (const p of CLOUD_PROVIDERS) {
      expect(p.testEndpoint.startsWith('https://')).toBe(true);
      expect(p.envVarName.length).toBeGreaterThan(0);
      expect(p.envVarName).toMatch(/^[A-Z_]+$/);
      expect(p.defaultModel.length).toBeGreaterThan(0);
    }
  });
});

describe('writeCloudProfile', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-chat-cloud-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes to ~/.vett/profiles/<name>.yaml', () => {
    const written = writeCloudProfile({
      name: 'openai-onboarding',
      providerYaml: 'openai',
      providerLabel: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      envVarName: 'OPENAI_API_KEY',
    });
    expect(written).toContain(path.join('.vett', 'profiles', 'openai-onboarding.yaml'));
    const content = fs.readFileSync(written, 'utf8');
    expect(content).toContain('provider: openai');
    expect(content).toContain('api_key_env: OPENAI_API_KEY');
  });

  it('overwrites an existing profile with the same name', () => {
    writeCloudProfile({
      name: 'openai-onboarding',
      providerYaml: 'openai',
      providerLabel: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      envVarName: 'OPENAI_API_KEY',
    });
    const written = writeCloudProfile({
      name: 'openai-onboarding',
      providerYaml: 'openai',
      providerLabel: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      envVarName: 'OPENAI_API_KEY',
    });
    const content = fs.readFileSync(written, 'utf8');
    expect(content).toContain('model: gpt-4o');
    expect(content).not.toContain('model: gpt-4o-mini');
  });
});

describe('writeLocalProfile', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vett-chat-onb-'));
    // os.homedir() reads HOME on POSIX, USERPROFILE on Windows.
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes to ~/.vett/profiles/<name>.yaml and creates the directory', () => {
    const written = writeLocalProfile({
      name: 'ollama-detected',
      endpoint: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      source: 'Ollama (3 models)',
    });

    expect(written).toContain(path.join('.vett', 'profiles', 'ollama-detected.yaml'));
    expect(fs.existsSync(written)).toBe(true);
    const content = fs.readFileSync(written, 'utf8');
    expect(content).toContain('name: ollama-detected');
    expect(content).toContain('model: qwen2.5-coder:7b');
  });
});

/**
 * THE ONBOARDED CLOUD PROFILE COULD NOT OPEN A SESSION.
 *
 * renderCloudProfileYaml emitted `provider` + `model` + `api_key_env` and no
 * `llm.endpoint`, on the reasoning that the provider knows its own URL — which
 * is true of ChatClientFactory, and was NOT true of the CLI guard standing in
 * front of it. Measured 2026-08-26 against the real binary:
 *
 *   vett chat --stdio --profile <onboarded cloud profile>  -> rc=2
 *     "endpoint and model are required ... (endpoint=, model=gpt-4o)"
 *
 * The two SHIPPED examples, openai-example and anthropic-example, failed the
 * same way for the same reason. So: paste a key, watch the live key test pass,
 * and get a profile that refuses to start.
 *
 * Fixed on both sides. vett gained a provider rung below the profile
 * (ChatClientFactory.DefaultEndpointFor), and this writer now names the
 * endpoint outright — because the INSTALLED vett is shared, predates that fix,
 * and is not ours to republish.
 *
 * NOTE `vett validate` passed the endpoint-less YAML with 0 errors. Validate
 * checks completeness, not startability; a green validate never asked whether
 * a session could be opened.
 */
describe('cloud profiles carry an explicit endpoint', () => {
  it.each(CLOUD_PROVIDERS.map((p) => [p.id, p] as const))(
    '%s writes llm.endpoint into the YAML',
    (_id, provider) => {
      const yaml = renderCloudProfileYaml({
        name: `${provider.id}-onboarding`,
        providerYaml: provider.providerYaml,
        providerLabel: provider.label,
        endpoint: provider.baseEndpoint,
        model: provider.defaultModel,
        envVarName: provider.envVarName,
      });
      expect(yaml).toContain(`endpoint: ${provider.baseEndpoint}`);
    },
  );

  // The URL that gets TESTED and the URL that gets WRITTEN must be the same
  // service, or onboarding validates one endpoint and then binds another —
  // a green key test followed by a profile pointing somewhere else.
  it.each(CLOUD_PROVIDERS.map((p) => [p.id, p] as const))(
    '%s baseEndpoint is exactly its testEndpoint minus /chat/completions',
    (_id, provider) => {
      expect(provider.testEndpoint).toBe(`${provider.baseEndpoint}/chat/completions`);
    },
  );
});

/**
 * A profile name becomes a FILENAME under ~/.vett/profiles, and both writers
 * writeFileSync over whatever path it produces. path.join resolves '..', so an
 * unvalidated name escapes the store — and extension.ts's overwrite prompt
 * consults profilePath(), so it would have been walked out of the store too and
 * reported "doesn't exist, safe to write" about the wrong file.
 *
 * Both call sites build the name from a fixed set today, so this is a
 * choke-point guard rather than a live exploit — the same one
 * WorktreeManager.assertSafePanelId applies to panel ids.
 */
describe('profile names cannot escape ~/.vett/profiles', () => {
  it.each([
    '..',
    '../../../../Documents/main',
    'a/../../b',
    'nested/name',
    '.hidden',
    '',
  ])('rejects %j', (name) => {
    expect(() => profilePath(name)).toThrow(/Refusing to write a profile named/);
    expect(() =>
      writeCloudProfile({
        name,
        providerYaml: 'openai',
        providerLabel: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        envVarName: 'OPENAI_API_KEY',
      }),
    ).toThrow(/Refusing to write a profile named/);
  });

  // The other side. A guard that rejects the names the product actually
  // generates would be reverted, not fixed.
  it.each(['openai-onboarding', 'ollama-detected', 'lmstudio-detected', 'my.profile_2'])(
    'accepts %s',
    (name) => {
      expect(() => profilePath(name)).not.toThrow();
    },
  );
});

/**
 * spec.model on the local path is NOT ours — it is a model id chosen from
 * whatever the detected server returned from /v1/models. Interpolated raw into
 * a single-line YAML scalar, a newline in that id closes the `model:` line and
 * appends arbitrary keys to a file the user is then invited to hand-edit.
 */
describe('remote-supplied values cannot inject YAML', () => {
  // Built from char codes so the payload cannot be mangled by whatever edits
  // this file next — a literal escape here is exactly what a careless rewrite
  // silently flattens, and a flattened payload tests nothing.
  const NL = String.fromCharCode(10);
  const BELL = String.fromCharCode(7);
  const INJECTED_MODEL = ['evil', 'api_key_env: SOMETHING_ELSE', 'tools:', '  - terminal'].join(NL);

  it('rejects a model id containing a newline', () => {
    expect(() =>
      renderLocalProfileYaml({
        name: 'ollama-detected',
        endpoint: 'http://localhost:11434/v1',
        model: INJECTED_MODEL,
        source: 'Ollama',
      }),
    ).toThrow(/contains a newline or control character/);
  });

  it('rejects an endpoint containing a control character', () => {
    expect(() =>
      renderLocalProfileYaml({
        name: 'ollama-detected',
        endpoint: 'http://localhost:11434/v1' + BELL,
        model: 'qwen2.5-coder:7b',
        source: 'Ollama',
      }),
    ).toThrow(/contains a newline or control character/);
  });

  it('names the field that was left out instead of failing inside a YAML helper', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderCloudProfileYaml({ name: 'x', providerYaml: 'openai', providerLabel: 'OpenAI', model: 'gpt-4o', envVarName: 'K' } as any),
    ).toThrow(/field 'endpoint': expected a string, got undefined/);
  });

  // ⭐ THE RANGE BUG. The first draft of this guard used a regex class ending
  // in ' --', which is a RANGE from space to hyphen — so it rejected every
  // ordinary hyphenated model id. These are the values the product sees on a
  // normal day and they must all pass.
  it.each([
    'gpt-4o',
    'gpt-4o-mini',
    'claude-haiku-4-5-20251001',
    'qwen2.5-coder:7b',
    'deepseek-v4-flash',
    'Qwen/Qwen2.5-VL-32B-Instruct',
  ])('accepts the ordinary model id %s', (model) => {
    const yaml = renderLocalProfileYaml({
      name: 'ollama-detected',
      endpoint: 'http://localhost:11434/v1',
      model,
      source: 'Ollama',
    });
    expect(yaml).toContain(model);
  });
});
