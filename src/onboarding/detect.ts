/**
 * Local-model auto-detection probes for the onboarding wizard.
 *
 * Each probe is a short HTTP GET against a known port + path with a
 * tight timeout. We never block the wizard on a slow / unreachable
 * port — failures collapse to "not detected." Probes run in parallel
 * via Promise.all in `detectAll`.
 *
 * Three families are checked today:
 *   - Ollama        :11434  (GET /api/tags)
 *   - LM Studio     :1234   (GET /v1/models)
 *   - vLLM          :8000, :8001 (GET /v1/models)
 *
 * Cloud providers (OpenAI / Anthropic / Google) are NOT probed —
 * those need an API key, which is a separate onboarding flow.
 */
import * as http from 'http';

export interface DetectionResult {
  kind: 'ollama' | 'lm-studio' | 'vllm';
  baseUrl: string;
  /** OpenAI-compat /v1 base for vett's `endpoint` field. Adds the
   *  trailing `/v1` for OpenAI-compat servers; Ollama's native API
   *  also exposes an OpenAI-compat layer at `/v1`. */
  endpointForVett: string;
  /** Up to ~50 model ids surfaced by the server. */
  models: string[];
  /** Human-readable label for the QuickPick row. */
  label: string;
}

export async function detectAll(timeoutMs = 1500): Promise<DetectionResult[]> {
  const probes: Array<Promise<DetectionResult | null>> = [
    probeOllama('http://localhost:11434', timeoutMs),
    probeOpenAICompat('http://localhost:1234', 'lm-studio', 'LM Studio', timeoutMs),
    probeOpenAICompat('http://localhost:8000', 'vllm', 'vLLM @ :8000', timeoutMs),
    probeOpenAICompat('http://localhost:8001', 'vllm', 'vLLM @ :8001', timeoutMs),
  ];
  const results = await Promise.all(probes.map((p) => p.catch(() => null)));
  return results.filter((r): r is DetectionResult => r !== null);
}

/** Ollama exposes `/api/tags` returning `{ models: [{name, ...}, ...] }`.
 *  Recent Ollama also exposes OpenAI-compat at `/v1`, which is what
 *  vett's `provider: local` uses — we point the endpoint there. */
async function probeOllama(baseUrl: string, timeoutMs: number): Promise<DetectionResult | null> {
  try {
    const body = await httpGetJson(`${baseUrl}/api/tags`, timeoutMs);
    if (!body || !Array.isArray(body.models)) return null;
    const models = body.models
      .map((m: any) => (typeof m?.name === 'string' ? m.name : null))
      .filter((s: string | null): s is string => !!s)
      .slice(0, 50);
    if (models.length === 0) return null;
    return {
      kind: 'ollama',
      baseUrl,
      endpointForVett: `${baseUrl}/v1`,
      models,
      label: `Ollama (${models.length} model${models.length === 1 ? '' : 's'})`,
    };
  } catch {
    return null;
  }
}

/** Generic OpenAI-compat probe — used for LM Studio, vLLM, etc.
 *  Reads `/v1/models` and returns the `data[].id` list. */
async function probeOpenAICompat(
  baseUrl: string,
  kind: 'lm-studio' | 'vllm',
  label: string,
  timeoutMs: number,
): Promise<DetectionResult | null> {
  try {
    const body = await httpGetJson(`${baseUrl}/v1/models`, timeoutMs);
    if (!body || !Array.isArray(body.data)) return null;
    const models = body.data
      .map((m: any) => (typeof m?.id === 'string' ? m.id : null))
      .filter((s: string | null): s is string => !!s)
      .slice(0, 50);
    if (models.length === 0) return null;
    return {
      kind,
      baseUrl,
      endpointForVett: `${baseUrl}/v1`,
      models,
      label: `${label} (${models.length} model${models.length === 1 ? '' : 's'})`,
    };
  } catch {
    return null;
  }
}

/** Minimal HTTP GET that returns parsed JSON or throws on any failure
 *  / timeout. We do NOT use the global `fetch` because the VS Code
 *  Node runtime version isn't pinned across all platforms; the `http`
 *  module is part of every Node release. */
function httpGetJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode === undefined || res.statusCode >= 400) {
        res.resume();
        settle(() => reject(new Error(`HTTP ${res.statusCode}`)));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          settle(() => resolve(body));
        } catch (e) {
          settle(() => reject(e));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); settle(() => reject(new Error('timeout'))); });
    req.on('error', (e) => settle(() => reject(e)));
  });
}
