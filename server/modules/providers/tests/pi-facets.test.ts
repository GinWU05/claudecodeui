import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PI_ENV_CREDENTIAL_KEYS, PiProviderAuth } from '@/modules/providers/list/pi/pi-auth.provider.js';
import { PiMcpProvider } from '@/modules/providers/list/pi/pi-mcp.provider.js';
import {
  PI_PREDEFINED_MODELS,
  PiProviderModels,
  parsePiListModelsOutput,
  pickPiDefaultModel,
  reconcilePiRunModel,
  resolvePiAgentDir,
} from '@/modules/providers/list/pi/pi-models.provider.js';
import { PiSkillsProvider } from '@/modules/providers/list/pi/pi-skills.provider.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError } from '@/shared/utils.js';

// ---------------------------------------------------------------------------
// Shared isolation helpers
// ---------------------------------------------------------------------------

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

// Environment scrubbing uses the auth adapter's own manifest of the env
// variables pi 0.85.1 reads as credentials (pi's env-api-keys mapping), so
// "no credentials" tests stay honest even when the developer machine running
// the suite has a real key exported.

const withEnvironmentCredentials = async (
  values: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> => {
  const savedEntries = PI_ENV_CREDENTIAL_KEYS.map(
    (key) => [key, process.env[key]] as const,
  );
  try {
    for (const key of PI_ENV_CREDENTIAL_KEYS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of savedEntries) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const withPath = async (nextPath: string, run: () => Promise<void>): Promise<void> => {
  const originalPath = process.env.PATH;
  process.env.PATH = nextPath;
  try {
    await run();
  } finally {
    process.env.PATH = originalPath;
  }
};

/**
 * Writes a `pi` stub that exits 0 for `--version` and answers
 * `auth check … --json` with the given document (nothing when null, which
 * leaves the probe unable to resolve credentials).
 */
const writeFakePiCli = async (
  binDir: string,
  authCheckJson: Record<string, unknown> | null = null,
): Promise<string> => {
  await mkdir(binDir, { recursive: true });
  // A shebang script resolves through the kernel on macOS/Linux; the CI and
  // developer suites for this repo never run the server tests on Windows.
  const authLine = authCheckJson
    ? `printf '%s' '${JSON.stringify(authCheckJson).replace(/'/g, "'\\''")}'`
    : ':';
  await writeFile(
    path.join(binDir, 'pi'),
    `#!/bin/sh\nif [ "$1" = "auth" ]; then ${authLine}; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  return binDir;
};

const withIsolatedPiHome = async (run: (homeDir: string) => Promise<void>): Promise<void> => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-facets-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await run(tempRoot);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const writeSkill = async (skillDir: string, name: string, description: string): Promise<void> => {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    'utf8',
  );
};

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

test('the env credential manifest covers the probed providers and names its exclusions', () => {
  // The credential probe asks pi about exactly these providers; each must have
  // its env key in the manifest, or a usable key could sit in the environment
  // while the scrubbed tests report "no credentials".
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_CODING_CN_API_KEY']) {
    assert.ok(PI_ENV_CREDENTIAL_KEYS.includes(key), `${key} is missing from the manifest`);
  }

  // Deliberate exclusions (see the manifest's comment): special gateways and
  // the AWS credential chain are not plain per-provider API keys.
  assert.equal(PI_ENV_CREDENTIAL_KEYS.includes('ANT_LING_API_KEY'), false);
  assert.equal(PI_ENV_CREDENTIAL_KEYS.includes('OPENCODE_API_KEY'), false);
  assert.equal(PI_ENV_CREDENTIAL_KEYS.some((key) => key.startsWith('AWS_')), false);
});

test('auth reports an installed pi with no credentials as merely unauthenticated', async () => {
  await withIsolatedPiHome(async (homeDir) => {
    const binDir = await writeFakePiCli(path.join(homeDir, 'bin'));
    await withPath(binDir, async () => {
      await withEnvironmentCredentials({}, async () => {
        const status = await new PiProviderAuth().getStatus();

        assert.equal(status.provider, 'pi');
        assert.equal(status.installed, true);
        assert.equal(status.authenticated, false);
        assert.equal(status.method, null);
        // pi has no account identity, so there is no email to report.
        assert.equal(status.email, null);
        // An unauthenticated pi is a neutral state, not an error the UI should
        // render as a failure.
        assert.equal(status.error, undefined);
      });
    });
  });
});

test('auth reports pi as not installed when the CLI is missing from PATH', async () => {
  await withIsolatedPiHome(async (homeDir) => {
    const emptyDir = path.join(homeDir, 'empty-bin');
    await mkdir(emptyDir, { recursive: true });
    await withPath(emptyDir, async () => {
      await withEnvironmentCredentials({}, async () => {
        const status = await new PiProviderAuth().getStatus();

        assert.equal(status.installed, false);
        assert.equal(status.authenticated, false);
      });
    });
  });
});

test('auth accepts provider API keys exported into the environment', async () => {
  await withIsolatedPiHome(async (homeDir) => {
    // pi itself resolves env API keys, so its auth check answers ready with
    // authType api_key — the adapter passes that contract through.
    const binDir = await writeFakePiCli(path.join(homeDir, 'bin'), {
      status: 'ready',
      provider: 'anthropic',
      authType: 'api_key',
    });
    await withPath(binDir, async () => {
      await withEnvironmentCredentials({ ANTHROPIC_API_KEY: 'test-key-placeholder' }, async () => {
        const status = await new PiProviderAuth().getStatus();

        assert.equal(status.authenticated, true);
        assert.equal(status.method, 'api_key');
        assert.equal(status.email, null);
      });
    });
  });
});

test('auth does not treat an empty auth store as usable credentials', async () => {
  await withIsolatedPiHome(async (homeDir) => {
    // pi 0.85.1 resolves typed entries through its credential store: an
    // empty `auth.json` establishes nothing, so the adapter must not report
    // oauth credentials for a file that merely exists.
    const binDir = await writeFakePiCli(path.join(homeDir, 'bin'), {
      status: 'not_ready',
      provider: 'anthropic',
      reason: 'credentials_not_configured',
    });
    const agentDir = path.join(homeDir, '.pi', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, 'auth.json'), '{}\n', 'utf8');
    await withPath(binDir, async () => {
      await withEnvironmentCredentials({}, async () => {
        const status = await new PiProviderAuth().getStatus();

        assert.equal(status.authenticated, false);
        assert.equal(status.method, null);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

const LIST_MODELS_OUTPUT = [
  'provider  model             context  max-out  thinking  images',
  'linewise  claude-fable-5    200K     128K     yes       yes   ',
  'linewise  claude-haiku-4-5  200K     64K      yes       yes   ',
  'linewise  claude-opus-5-5   200K     128K     yes       yes   ',
  '',
].join('\n');

const liveModels = (overrides: Partial<ConstructorParameters<typeof PiProviderModels>[0]> = {}) => new PiProviderModels({
  listModels: async () => LIST_MODELS_OUTPUT,
  readSettings: async () => ({ defaultProvider: 'linewise', defaultModel: 'claude-opus-5-5' }),
  ...overrides,
});

test('the curated fallback catalog declares a label and effort list for every model', () => {
  const values = PI_PREDEFINED_MODELS.OPTIONS.map((option) => option.value);
  assert.ok(values.includes(PI_PREDEFINED_MODELS.DEFAULT));
  for (const option of PI_PREDEFINED_MODELS.OPTIONS) {
    assert.ok(option.label.trim().length > 0, `${option.value} needs a label`);
    assert.ok(Array.isArray(option.effort?.values));
  }
});

test('parsePiListModelsOutput turns the pi table into provider/model options', () => {
  assert.deepEqual(parsePiListModelsOutput(LIST_MODELS_OUTPUT), [
    { value: 'linewise/claude-fable-5', label: 'claude-fable-5', description: 'linewise', effort: { values: [] } },
    { value: 'linewise/claude-haiku-4-5', label: 'claude-haiku-4-5', description: 'linewise', effort: { values: [] } },
    { value: 'linewise/claude-opus-5-5', label: 'claude-opus-5-5', description: 'linewise', effort: { values: [] } },
  ]);
  assert.deepEqual(parsePiListModelsOutput(''), []);
  assert.deepEqual(parsePiListModelsOutput('provider  model  context\n'), []);
});

test('pickPiDefaultModel follows pi settings and ignores models pi does not list', () => {
  const options = parsePiListModelsOutput(LIST_MODELS_OUTPUT);
  assert.equal(pickPiDefaultModel(options, { defaultProvider: 'linewise', defaultModel: 'claude-haiku-4-5' }), 'linewise/claude-haiku-4-5');
  assert.equal(pickPiDefaultModel(options, { defaultModel: 'claude-fable-5' }), 'linewise/claude-fable-5');
  assert.equal(pickPiDefaultModel(options, { defaultModel: 'linewise/claude-fable-5' }), 'linewise/claude-fable-5');
  assert.equal(pickPiDefaultModel(options, { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4' }), null);
  assert.equal(pickPiDefaultModel(options, null), null);
});

test('resolvePiAgentDir honors PI_CODING_AGENT_DIR like pi does', () => {
  assert.equal(resolvePiAgentDir({}), path.join(os.homedir(), '.pi', 'agent'));
  assert.equal(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '/tmp/pi-agent' }), '/tmp/pi-agent');
  assert.equal(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '~/custom' }), path.join(os.homedir(), 'custom'));
});

test('the pi models facet serves the live list with pi\'s own default', async () => {
  const models = liveModels();
  const definition = await models.getSupportedModels();
  assert.equal(definition.DEFAULT, 'linewise/claude-opus-5-5');
  assert.equal(definition.OPTIONS.length, 3);
  assert.equal(models.isLive(), true);
  assert.deepEqual(await models.getCurrentActiveModel('session-1'), { model: 'linewise/claude-opus-5-5' });
});

test('the pi models facet defaults to the first listed model when settings name none', async () => {
  const definition = await liveModels({ readSettings: async () => null }).getSupportedModels();
  assert.equal(definition.DEFAULT, 'linewise/claude-fable-5');
});

test('the pi models facet falls back to the curated catalog when pi fails', async () => {
  const failing = liveModels({ listModels: async () => { throw new Error('spawn pi ENOENT'); } });
  assert.deepEqual(await failing.getSupportedModels(), PI_PREDEFINED_MODELS);
  assert.equal(failing.isLive(), false);
  const empty = liveModels({ listModels: async () => '' });
  assert.deepEqual(await empty.getSupportedModels(), PI_PREDEFINED_MODELS);
});

test('the pi models facet caches the list for the TTL and dedupes concurrent loads', async () => {
  let calls = 0;
  let now = 1_000;
  const models = liveModels({
    listModels: async () => { calls += 1; return LIST_MODELS_OUTPUT; },
    now: () => now,
    ttlMs: 60_000,
  });
  await Promise.all([models.getSupportedModels(), models.getSupportedModels()]);
  assert.equal(calls, 1);
  now += 59_000;
  await models.getSupportedModels();
  assert.equal(calls, 1);
  now += 2_000;
  await models.getSupportedModels();
  assert.equal(calls, 2);
});

test('reconcilePiRunModel swaps models pi cannot route to for pi\'s default, only on a live list', () => {
  const definition = {
    OPTIONS: [
      ...parsePiListModelsOutput(LIST_MODELS_OUTPUT),
      { value: 'custom/my-model', label: 'Mine', isCustom: true },
    ],
    DEFAULT: 'linewise/claude-opus-5-5',
  };
  const live = { definition, live: true };
  assert.equal(reconcilePiRunModel('linewise/claude-haiku-4-5', live), 'linewise/claude-haiku-4-5');
  assert.equal(reconcilePiRunModel('linewise/claude-haiku-4-5:high', live), 'linewise/claude-haiku-4-5:high');
  assert.equal(reconcilePiRunModel('claude-haiku-4-5', live), 'claude-haiku-4-5');
  assert.equal(reconcilePiRunModel('custom/my-model', live), 'custom/my-model');
  assert.equal(reconcilePiRunModel('anthropic/claude-sonnet-4', live), 'linewise/claude-opus-5-5');
  assert.equal(reconcilePiRunModel(undefined, live), 'linewise/claude-opus-5-5');
  // Against the curated fallback nothing is known about what pi can route to.
  const fallback = { definition: PI_PREDEFINED_MODELS, live: false };
  assert.equal(reconcilePiRunModel('linewise/claude-haiku-4-5', fallback), 'linewise/claude-haiku-4-5');
  assert.equal(reconcilePiRunModel(undefined, fallback), undefined);
});

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

test('listSkills reads pi user skills, settings.json sources and workspace skills', async () => {
  await withIsolatedPiHome(async (homeDir) => {
    const configuredDir = path.join(homeDir, 'configured-skills');
    await writeSkill(path.join(configuredDir, 'deploy-notes'), 'deploy-notes', 'Deploy checklist.');
    await writeSkill(
      path.join(homeDir, '.pi', 'agent', 'skills', 'release-check'),
      'release-check',
      'Release checklist.',
    );

    const workspacePath = path.join(homeDir, 'workspace');
    await writeSkill(
      path.join(workspacePath, '.pi', 'skills', 'repo-lint'),
      'repo-lint',
      'Repository lint.',
    );

    const agentDir = path.join(homeDir, '.pi', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, 'settings.json'),
      `${JSON.stringify({ skills: [configuredDir] })}\n`,
      'utf8',
    );

    const skills = await new PiSkillsProvider().listSkills({ workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.deepEqual([...byName.keys()].sort(), ['deploy-notes', 'release-check', 'repo-lint']);
    assert.equal(byName.get('deploy-notes')?.command, '/deploy-notes');
    assert.equal(byName.get('deploy-notes')?.scope, 'user');
    assert.equal(byName.get('deploy-notes')?.provider, 'pi');
    assert.equal(byName.get('deploy-notes')?.description, 'Deploy checklist.');
    assert.equal(byName.get('release-check')?.scope, 'user');
    assert.equal(byName.get('repo-lint')?.scope, 'project');
    assert.equal(byName.get('repo-lint')?.command, '/repo-lint');
  });
});

test('listSkills skips settings.json skill directories that no longer exist', async () => {
  await withIsolatedPiHome(async (homeDir) => {
    const configuredDir = path.join(homeDir, 'configured-skills');
    await writeSkill(path.join(configuredDir, 'deploy-notes'), 'deploy-notes', 'Deploy checklist.');

    const agentDir = path.join(homeDir, '.pi', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, 'settings.json'),
      `${JSON.stringify({ skills: [configuredDir, path.join(homeDir, 'gone-skills')] })}\n`,
      'utf8',
    );

    const skills = await new PiSkillsProvider().listSkills({
      workspacePath: path.join(homeDir, 'workspace'),
    });

    assert.deepEqual(skills.map((skill) => skill.name), ['deploy-notes']);
  });
});

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

test('pi reports no MCP servers in any scope', async () => {
  const servers = await new PiMcpProvider().listServers({
    workspacePath: path.join(os.tmpdir(), 'pi-facets-mcp'),
  });

  assert.deepEqual(servers, { user: [], local: [], project: [] });
});

test('pi rejects MCP server writes as unsupported', async () => {
  const mcp = new PiMcpProvider();

  await assert.rejects(
    () => mcp.upsertServer({
      name: 'docs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'docs-server'],
      scope: 'project',
      workspacePath: path.join(os.tmpdir(), 'pi-facets-mcp'),
    }),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'NOT_SUPPORTED'
      && /Pi does not support MCP/.test(error.message)
    ),
  );
});

// ---------------------------------------------------------------------------
// token usage
// ---------------------------------------------------------------------------

test('pi token usage returns an explicit unsupported result', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => ({
      session_id: 'app-session',
      provider: 'pi',
      provider_session_id: 'provider-session',
      project_path: null,
      jsonl_path: null,
      custom_name: null,
      model: null,
      effort: null,
      forked_from_session_id: null,
      isArchived: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
  });

  const result = await service.getSessionTokenUsage('app-session');

  assert.equal(result.unsupported, true);
  assert.equal(result.used, 0);
  assert.equal(result.total, 0);
  assert.deepEqual(result.breakdown, { input: 0, output: 0 });
});
