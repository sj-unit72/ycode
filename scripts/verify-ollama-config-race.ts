/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Definitive test of the module-global Ollama model id under TRUE concurrency,
 * driving the real `resolveAgentConfig()` against a stubbed settings store.
 *
 * Two projects are resolved concurrently (as they would be on a shared server),
 * each with a different Ollama model id, and each then reads back which provider
 * serves its own model — exactly what the chat route does:
 *
 *     resolveAgentConfig(userId) → getAgentProvider(model, userId) → providerOfModel(model)
 *
 * If the global leaks between them, one project resolves to provider `null`
 * (wrong provider / missing key) even though its own settings were correct.
 *
 *   npx tsx scripts/verify-ollama-config-race.ts
 */
import Module from 'module';

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, parent, isMain);
};

// Intercept the settings repository at the module-loader level: ESM exports are
// getter-only, so the stub has to be installed as a module substitution rather
// than by assigning over the namespace. Two tenants are simulated as two
// different OLLAMA_MODEL settings keyed off a request-scoped marker, so each
// "request" sees its own project's row.
let currentTenant: string | null = null;

const SETTINGS_MODULE = require.resolve('@/lib/repositories/settingsRepository');
const stubLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  if (parent && request.endsWith('repositories/settingsRepository')) {
    return {
      getSettingsByKeys: async () => ({
        ai_ollama_base_url: 'http://127.0.0.1:11434',
        ai_ollama_model: currentTenant === 'A' ? 'project-a:7b' : 'project-b:70b',
      }),
      setSettings: async () => undefined,
    };
  }
  return stubLoad.call(this, request, parent, isMain);
};
void SETTINGS_MODULE;

const { resolveAgentConfig } = require('@/lib/agent/config');
const { providerOfModel, isAllowedModel } = require('@/lib/agent/models');

const log: string[] = [];
let failures = 0;

async function requestResolve(tenant: string, expectedModel: string, delayMs: number): Promise<void> {
  // Request-scoped context (how a real server would carry tenant/user identity).
  currentTenant = tenant;
  const config = await resolveAgentConfig(null);   // ← writes the module global
  const ownModel = config.ollamaModel;

  await new Promise((r) => setTimeout(r, delayMs)); // DB / provider / network awaits

  // Later in the same request: which provider serves MY model?
  const provider = providerOfModel(ownModel);
  const allowed = isAllowedModel(ownModel);
  const ok = provider === 'ollama' && allowed;
  if (!ok) failures += 1;
  log.push(
    `  ${ok ? '✓' : '✗'} tenant ${tenant}: model=${ownModel} → providerOfModel=${JSON.stringify(provider)} isAllowed=${allowed}`,
  );
}

async function main(): Promise<void> {
  console.log('\n=== Concurrent resolveAgentConfig() interleaving ===\n');

  // ── Control: sequential resolution is correct ─────────────────────────────
  console.log('sequential (control):');
  currentTenant = 'A';
  let cfg = await resolveAgentConfig(null);
  const seqA = providerOfModel(cfg.ollamaModel);
  currentTenant = 'B';
  cfg = await resolveAgentConfig(null);
  const seqB = providerOfModel(cfg.ollamaModel);
  console.log(`  A → ${JSON.stringify(seqA)}   B → ${JSON.stringify(seqB)}`);
  const controlOk = seqA === 'ollama' && seqB === 'ollama';
  console.log(`  ${controlOk ? '✓ control passes (mechanism correct one-at-a-time)' : '✗ control FAILS'}\n`);

  // ── Concurrent: two requests in flight at once ────────────────────────────
  console.log('concurrent (real server shape):');
  await Promise.all([
    requestResolve('A', 'project-a:7b', 40),
    requestResolve('B', 'project-b:70b', 5),
  ]);
  for (const line of log) console.log(line);

  console.log('');
  if (failures > 0) {
    console.log(
      `⚠️  RACE CONFIRMED: ${failures} in-flight request(s) resolved to the WRONG provider\n` +
      '    because a concurrent request overwrote the shared module-global model id.\n' +
      '    In the chat route this means providerOfModel() can return null →\n' +
      '    "No API key configured for …" or a silent fall back to the default model.',
    );
    process.exitCode = 1;
  } else {
    console.log('✓ no interleaving in this schedule (but the shared global is still single-valued)');
  }

  // ── The structural point, independent of timing ───────────────────────────
  console.log(
    '\nStructural note (timing-independent): the global holds ONE model id.\n' +
    'Only the most recently resolved project can satisfy isAllowedModel(); every\n' +
    'other project\'s Ollama model id fails that check until it resolves again.',
  );
}

main().catch((error: unknown) => {
  console.error('THREW:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
