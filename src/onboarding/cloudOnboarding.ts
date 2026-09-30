/**
 * Cloud-provider onboarding — paste a key, validate it with a 1-token
 * live test, write a working profile YAML.
 *
 * Three providers covered today: OpenAI, Anthropic, Google (Gemini).
 * Each uses an OpenAI-compatible /chat/completions endpoint with
 * Bearer auth, so the test path is uniform — only the URL + default
 * model differ.
 *
 * Keys are stored in VS Code's `SecretStorage` under
 * `vett-chat.<envvar-lowercase>`. Vett itself reads via env var
 * (the profile carries `api_key_env: <ENVVAR>`). The host injects
 * the saved secret into the spawned subprocess's environment at
 * startup time — see `ChatPanelProvider.preloadCloudSecrets`.
 *
 * Live test failures map to actionable error messages: 401 → wrong
 * key; 404 → wrong model; 429 → rate limit hit, key probably works;
 * 5xx → provider down. Anything else falls back to the raw status.
 */
import * as https from 'https';

export type CloudProvider = 'openai' | 'anthropic' | 'google';

export interface CloudProviderInfo {
  id: CloudProvider;
  label: string;
  /** Model used for the live key test. Cheap and ubiquitous so the
   *  test is fast and unlikely to hit a model-not-available error. */
  defaultModel: string;
  /** Full URL of the OpenAI-compatible chat-completions endpoint. */
  testEndpoint: string;
  /** Base URL written to the profile's `llm.endpoint`. This is
   *  `testEndpoint` minus the trailing `/chat/completions` — vett's client
   *  appends that itself.
   *
   *  Written explicitly even though vett knows these URLs internally
   *  (ChatClientFactory.DefaultEndpointFor). Until 2026-08-26 vett's endpoint
   *  guard ran before that default could apply, so a profile with no
   *  `llm.endpoint` exited 2 with "endpoint and model are required" — which
   *  is what every profile this flow wrote did. That is fixed in vett, but the
   *  INSTALLED vett binary is shared and predates the fix, so naming the
   *  endpoint here is what makes an onboarded profile work today. */
  baseEndpoint: string;
  /** Env var name vett expects in the profile's `api_key_env` field
   *  AND the key under which we'll inject the secret at spawn time. */
  envVarName: string;
  /** Where the user finds / creates an API key in their console. */
  consoleUrl: string;
  /** YAML provider value (matches `LlmConfig.Provider` in C#). */
  providerYaml: string;
}

export const CLOUD_PROVIDERS: CloudProviderInfo[] = [
  {
    id: 'openai',
    baseEndpoint: 'https://api.openai.com/v1',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    testEndpoint: 'https://api.openai.com/v1/chat/completions',
    envVarName: 'OPENAI_API_KEY',
    consoleUrl: 'https://platform.openai.com/api-keys',
    providerYaml: 'openai',
  },
  {
    id: 'anthropic',
    baseEndpoint: 'https://api.anthropic.com/v1',
    label: 'Anthropic (Claude)',
    // Bumped to a recent Haiku for cheap, fast test calls. User can
    // edit the YAML afterwards to point at Sonnet/Opus for real chat.
    defaultModel: 'claude-haiku-4-5-20251001',
    testEndpoint: 'https://api.anthropic.com/v1/chat/completions',
    envVarName: 'ANTHROPIC_API_KEY',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    providerYaml: 'anthropic',
  },
  {
    id: 'google',
    baseEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    label: 'Google (Gemini)',
    defaultModel: 'gemini-2.0-flash',
    // Google's OpenAI-compat surface lives under /v1beta/openai/.
    testEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    envVarName: 'GEMINI_API_KEY',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    providerYaml: 'google',
  },
];

export interface TestResult {
  ok: boolean;
  status?: number;
  /** Short human-readable message — surfaced to the user in a toast.
   *  On success, summarizes the response (model echoed, tokens used). */
  message: string;
}

/** Send a tiny chat-completion request to verify the key + model.
 *  Returns ok=true on 2xx; otherwise maps common statuses to actionable
 *  error copy. Network errors / timeouts → ok=false with the underlying
 *  error message. */
export async function testCloudKey(
  provider: CloudProviderInfo,
  apiKey: string,
  model: string = provider.defaultModel,
  timeoutMs = 10_000,
): Promise<TestResult> {
  if (!apiKey || !apiKey.trim()) return { ok: false, message: 'API key is empty.' };

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: "Reply with the single word 'ok'." }],
    max_tokens: 5,
    temperature: 0,
  });

  try {
    const { status, payload } = await httpsPostJson(provider.testEndpoint, body, apiKey, timeoutMs);
    if (status >= 200 && status < 300) {
      const echoModel = (payload?.model as string | undefined) ?? model;
      return { ok: true, status, message: `Key works against ${provider.label} · model=${echoModel}` };
    }
    return { ok: false, status, message: explainHttpError(status, payload) };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return { ok: false, message: `Test request failed: ${msg}` };
  }
}

function explainHttpError(status: number, payload: any): string {
  // Try to surface the provider's own error message when present —
  // OpenAI-shape: { error: { message, type, code } }; some providers
  // wrap differently but this covers the common ones.
  const providerMsg =
    (typeof payload?.error?.message === 'string' && payload.error.message) ||
    (typeof payload?.message === 'string' && payload.message) ||
    '';
  if (status === 401 || status === 403) {
    return `${status} — invalid API key${providerMsg ? `: ${providerMsg}` : ''}`;
  }
  if (status === 404) {
    return `${status} — model not available on this account${providerMsg ? `: ${providerMsg}` : ''}`;
  }
  if (status === 429) {
    return `${status} — rate-limited or out of credit (key is probably valid)${providerMsg ? `: ${providerMsg}` : ''}`;
  }
  if (status >= 500) {
    return `${status} — provider server error; try again later${providerMsg ? `: ${providerMsg}` : ''}`;
  }
  return `${status}${providerMsg ? ` — ${providerMsg}` : ''}`;
}

interface HttpResult { status: number; payload: any; }

function httpsPostJson(url: string, body: string, apiKey: string, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const u = new URL(url);
    const opts: https.RequestOptions = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // Anthropic's OpenAI-compat shim accepts Bearer but ALSO
        // honors x-api-key. Sending both is a no-op for the others
        // and improves robustness if a future provider edge-cases
        // the auth pathway.
        'x-api-key': apiKey,
      },
      timeout: timeoutMs,
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload: any = null;
        try { payload = text.length > 0 ? JSON.parse(text) : null; }
        catch { /* leave as null; explainHttpError handles missing payload */ }
        settle(() => resolve({ status: res.statusCode ?? 0, payload }));
      });
    });
    req.on('timeout', () => { req.destroy(); settle(() => reject(new Error('timeout'))); });
    req.on('error', (e) => settle(() => reject(e)));
    req.write(body);
    req.end();
  });
}
