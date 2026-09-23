/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Demonstrates whether the module-global Ollama model id used by
 * `providerOfModel` / `isAllowedModel` is safe under concurrent requests.
 *
 * `resolveAgentConfig()` calls `setConfiguredOllamaModel(ollamaModel)` and the
 * request path reads that global later via `providerOfModel(model)`. On a
 * long-running Node server (a self-hosted `next start`, or any deployment that
 * isn't per-request isolated) two overlapping requests can interleave between
 * the write and the read.
 *
 *   npx tsx scripts/verify-ollama-global-race.ts
 */
import Module from 'module';

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, parent, isMain);
};

const {
  setConfiguredOllamaModel,
  providerOfModel,
  isAllowedModel,
} = require('@/lib/agent/models');

const A = 'project-a-model:7b';
const B = 'project-b-model:70b';

async function main(): Promise<void> {
  console.log('\n=== Ollama module-global interleaving test ===\n');

  // ── Sequential sanity: the mechanism works at all ─────────────────────────
  setConfiguredOllamaModel(A);
  const seqA = providerOfModel(A);
  setConfiguredOllamaModel(B);
  const seqB = providerOfModel(B);
  console.log(`sequential: A → ${seqA}, B → ${seqB}`);
  console.log(`  ${seqA === 'ollama' && seqB === 'ollama' ? '✓ mechanism works sequentially' : '✗ mechanism broken even sequentially'}\n`);

  // ── Interleaved: request A writes, request B writes, then A reads ─────────
  // This is exactly the await boundary shape: resolveAgentConfig() writes the
  // global, control yields (await on settings/db/provider work), then the
  // request reads providerOfModel(model) for its own model id.
  const log: string[] = [];

  async function requestA(): Promise<void> {
    setConfiguredOllamaModel(A);      // inside resolveAgentConfig
    await new Promise((r) => setTimeout(r, 30)); // awaiting DB / provider setup
    const provider = providerOfModel(A);        // later in the request path
    log.push(`request A: wanted "ollama" for ${A}, got ${JSON.stringify(provider)}`);
  }

  async function requestB(): Promise<void> {
    await new Promise((r) => setTimeout(r, 10));
    setConfiguredOllamaModel(B);      // a DIFFERENT project resolves meanwhile
  }

  await Promise.all([requestA(), requestB()]);

  const raced = log.some((line) => !line.includes('got "ollama"'));
  console.log('interleaved (2 projects resolving concurrently):');
  for (const line of log) console.log(`  ${line}`);
  console.log(
    raced
      ? '\n⚠️  RACE CONFIRMED: a concurrent request\'s model id clobbered this one,\n' +
        '    so providerOfModel()/isAllowedModel() returned the wrong answer for the\n' +
        '    in-flight request. On a shared server this can route a project to the\n' +
        '    wrong provider.'
      : '\n✓ no interleaving observed in this schedule',
  );

  // ── Is the global still what the LAST writer set? ──────────────────────────
  console.log(`\nfinal global value: ${isAllowedModel(B) ? B : isAllowedModel(A) ? A : '(neither)'}`);
  console.log(`isAllowedModel(${A}) = ${isAllowedModel(A)}   isAllowedModel(${B}) = ${isAllowedModel(B)}`);
  console.log(
    '\nNote: with a single global, ONLY the last-written model id is "allowed".\n' +
    'Any project whose id was overwritten fails isAllowedModel() and silently\n' +
    'falls back to the default model.',
  );
}

main().catch((error: unknown) => {
  console.error('THREW:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
