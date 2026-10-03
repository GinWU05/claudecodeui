import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Curated pi catalog, served only when the live `pi --list-models` probe fails
 * (pi missing, crashed, timed out, or listed nothing). The live list is what
 * pi can actually route to with the user's own providers/credentials; this
 * fallback merely keeps the picker populated.
 */
export const PI_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-haiku-3-5', label: 'Claude Haiku 3.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-opus-4-1', label: 'Claude Opus 4.1', description: 'Anthropic', effort: { values: [] } },
    { value: 'zai-coding-cn/glm-5.3', label: 'GLM 5.3', description: 'Z.ai Coding CN', effort: { values: [] } },
    { value: 'zai-coding-cn/glm-5.3-flash', label: 'GLM 5.3 Flash', description: 'Z.ai Coding CN', effort: { values: [] } },
    { value: 'zai-coding-cn/glm-5.2', label: 'GLM 5.2', description: 'Z.ai Coding CN', effort: { values: [] } },
    // pi's catalog has no bare `gpt-5.6` — the 5.6 generation ships as
    // luna/sol/terra tiers (sol is the flagship), so only concrete ids are
    // listed. Verified against the pi 0.85.1 model catalog.
    { value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI', effort: { values: [] } },
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', description: 'OpenAI', effort: { values: [] } },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI', effort: { values: [] } },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4',
};

/** How long one `pi --list-models` answer is reused. */
export const PI_MODELS_CACHE_TTL_MS = 60_000;
const PI_LIST_MODELS_TIMEOUT_MS = 10_000;

/**
 * pi's config directory, resolved the way pi resolves it: `PI_CODING_AGENT_DIR`
 * (with `~` expansion) or `~/.pi/agent`.
 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    if (override === '~') return os.homedir();
    if (override.startsWith('~/')) return path.join(os.homedir(), override.slice(2));
    return override;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

/**
 * Parses the table `pi --list-models` prints:
 *
 *   provider  model             context  max-out  thinking  images
 *   linewise  claude-haiku-4-5  200K     64K      yes       yes
 *
 * Each row becomes `{ value: '<provider>/<model>', label: model, description: provider }`.
 */
export function parsePiListModelsOutput(stdout: string): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [provider, model] = line.split(/\s+/);
    if (!provider || !model) continue;
    if (provider.toLowerCase() === 'provider' && model.toLowerCase() === 'model') continue;
    const value = `${provider}/${model}`;
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: model, description: provider, effort: { values: [] } });
  }
  return options;
}

/**
 * pi's own default (`defaultProvider` / `defaultModel` in settings.json),
 * matched against the listed options; null when unset or not listed.
 */
export function pickPiDefaultModel(
  options: ProviderModelOption[],
  settings: { defaultProvider?: unknown; defaultModel?: unknown } | null,
): string | null {
  const provider = typeof settings?.defaultProvider === 'string' ? settings.defaultProvider.trim() : '';
  const model = typeof settings?.defaultModel === 'string' ? settings.defaultModel.trim() : '';
  if (!model) return null;
  const candidates = provider && !model.includes('/') ? [`${provider}/${model}`] : [model];
  for (const candidate of candidates) {
    if (options.some((option) => option.value === candidate)) return candidate;
  }
  // `defaultModel` without a provider: the first listed model with that id.
  return options.find((option) => option.label === model)?.value ?? null;
}

export type PiModelsDependencies = {
  listModels: () => Promise<string>;
  readSettings: () => Promise<{ defaultProvider?: unknown; defaultModel?: unknown } | null>;
  now: () => number;
  ttlMs: number;
};

const defaultPiModelsDependencies: PiModelsDependencies = {
  listModels: () => new Promise((resolve, reject) => {
    execFile('pi', ['--list-models'], {
      timeout: PI_LIST_MODELS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE ?? '1' },
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  }),
  readSettings: async () => {
    try {
      const raw = await readFile(path.join(resolvePiAgentDir(), 'settings.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  ttlMs: PI_MODELS_CACHE_TTL_MS,
};

/** Provider registry model adapter: pi's live model list, curated fallback. */
export class PiProviderModels implements IProviderModels {
  private readonly dependencies: PiModelsDependencies;
  private cached: { at: number; definition: ProviderModelsDefinition; live: boolean } | null = null;
  private inFlight: Promise<{ definition: ProviderModelsDefinition; live: boolean }> | null = null;

  constructor(dependencies: Partial<PiModelsDependencies> = {}) {
    this.dependencies = { ...defaultPiModelsDependencies, ...dependencies };
  }

  /** The catalog plus whether it came from pi itself (vs. the curated fallback). */
  async getCatalog(): Promise<{ definition: ProviderModelsDefinition; live: boolean }> {
    const now = this.dependencies.now();
    if (this.cached && now - this.cached.at < this.dependencies.ttlMs) {
      return this.cached;
    }
    if (!this.inFlight) {
      this.inFlight = this.loadCatalog().then((result) => {
        this.cached = { ...result, at: this.dependencies.now() };
        return result;
      }).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async loadCatalog(): Promise<{ definition: ProviderModelsDefinition; live: boolean }> {
    let options: ProviderModelOption[] = [];
    try {
      options = parsePiListModelsOutput(await this.dependencies.listModels());
    } catch {
      options = [];
    }
    if (options.length === 0) {
      return { definition: PI_PREDEFINED_MODELS, live: false };
    }
    const settings = await this.dependencies.readSettings().catch(() => null);
    const DEFAULT = pickPiDefaultModel(options, settings) ?? options[0].value;
    return { definition: { OPTIONS: options, DEFAULT }, live: true };
  }

  /** Whether the last loaded catalog was pi's live list; false before any load. */
  isLive(): boolean {
    return this.cached?.live ?? false;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return (await this.getCatalog()).definition;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // pi's per-session model lives in the JSONL transcript, which the sessions
    // facet already surfaces; the registry answers with pi's own default.
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}

/** The registry's pi models facet; the runtime reads its liveness flag. */
export const piProviderModels = new PiProviderModels();

/**
 * The model a pi run should be launched with. A model pi cannot route to (a
 * stale pick from an older catalog, e.g. `anthropic/...` without credentials)
 * is replaced by the catalog default — but only when the catalog is pi's live
 * list; against the curated fallback nothing is known, so the pick is kept.
 */
export function reconcilePiRunModel(
  requestedModel: string | null | undefined,
  catalog: { definition: ProviderModelsDefinition; live: boolean },
): string | undefined {
  const model = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (!model) return catalog.live ? catalog.definition.DEFAULT || undefined : undefined;
  if (!catalog.live) return model;
  // pi also accepts a bare model id and an optional `:<thinking>` suffix.
  const base = model.replace(/:[a-z]+$/i, '');
  const known = catalog.definition.OPTIONS.some((option) => (
    option.value === model || option.value === base || option.label === base
  ));
  return known ? model : catalog.definition.DEFAULT || undefined;
}
