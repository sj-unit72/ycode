/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Confirms the module-global race is FIXED: two projects resolving
 * `resolveAgentConfig()` concurrently each get their own model options, and each
 * resolves its own Ollama model id to provider 'ollama'.
 *
 * Same harness shape as verify-ollama-config-race.ts, but asserting the
 * corrected behaviour instead of demonstrating the bug:
 *
 *     resolveAgentConfig(userId) → getAgentProvider(model, userId)
 *
 *   npx tsx scripts/verify-ollama-config-race-fixed.ts
 */
import Module from 'module';

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, parent, isMain);
};

let currentTenant: string | null = null;

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

const { resolveAgentConfig } = require('@/lib/agent/config');
const { providerOfModelFrom, isAllowedModelFrom, providerOfModel } = require('@/lib/agent/models');

const log: string[] = [];
let failures = 0;

async function requestResolve(tenant: string, expectedModel: string, delayMs: number): Promise<void> {
  currentTenant = tenant;
  const config = await resolveAgentConfig(null);
  const ownModel = config.ollamaModel;

  await new Promise((r) => setTimeout(r, delayMs)); // DB / provider / network awaits

  // Resolve against THIS request's own option list — no shared state.
  const provider = providerOfModelFrom(config.modelOptions, ownModel);
  const allowed = isAllowedModelFrom(config.modelOptions, ownModel);
  const ok = provider === 'ollama' && allowed && ownModel === expectedModel;
  if (!ok) failures += 1;
  log.push(
    `  ${ok ? '✓' : '✗'} tenant ${tenant}: model=${ownModel} → providerOfModelFrom=${JSON.stringify(provider)} isAllowed=${allowed}`,
  );
}

async function main(): Promise<void> {
  console.log('\n=== Concurrent resolveAgentConfig() — post-fix ===\n');

  // Prove there is no shared-state backdoor left: the bare providerOfModel()
  // must NOT know a project-specific model (that was the leak).
  console.log('no shared state:');
  const leaked = providerOfModel('project-a:7b') === 'ollama' || providerOfModel('project-b:70b') === 'ollama';
  console.log(`  ${leaked ? '✗ bare providerOfModel still resolves project models (leak remains)' : '✓ bare providerOfModel() knows no project model (no shared state)'}`);
  if (leaked) failures += 1;

  console.log('\nconcurrent (real server shape):');
  await Promise.all([
    requestResolve('A', 'project-a:7b', 40),
    requestResolve('B', 'project-b:70b', 5),
  ]);
  for (const line of log) console.log(line);

  console.log('');
  if (failures > 0) {
    console.log(`✗ FAILED: ${failures} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log('✓ PASS: each in-flight request resolved its OWN Ollama model id to the right provider.');
  }
}

main().catch((error: unknown) => {
  console.error('THREW:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
