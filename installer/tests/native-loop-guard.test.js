import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { enableNativeInference } from '../src/native-loop-guard.js';

// Synthetic patch-layout fixture, not a native runtime implementation.
const fixture = `
function c(reason){return {runtime:"connect",reason};}
function p(turn){return {hasModelCredentials:true,unsupported:turn.unsupported};}
function h(facts){return facts.unsupported?"unsupported":undefined;}
function d(reason){return {runtime:"fail",reason};}
function router(e){return async t=>{const gate="agent_host_local_loop";if(!t.runOptions.localLoopGateEnabled)return c("gate-off");const o=p(t);if(o.hasModelCredentials)return c("byok-connect-routed");const i=h(o);return void 0!==i?d(i,o):{runtime:"managed-local",reason:"eligible"}}}
`;

function load(routes = {}, provider = 'anthropic', apiModel = 'grok-4.7') {
  const patched = enableNativeInference(fixture);
  const configs = {
    'routes.json': { byokMode: 1, nativeInferenceModels: ['grok-4.7'], redirect: ['aiserver.v1.InferenceService/RunInferenceSSE', 'aiserver.v1.BidiService/BidiAppend'], ...routes },
    'providers.json': { providers: [{ type: provider, models: [{ id: 'grok-4.7', apiModel }] }] },
  };
  const context = vm.createContext({ require: name => ({
    fs: { readFileSync: file => JSON.stringify(configs[file.split('/').at(-1)]) },
    path: { join: (...parts) => parts.join('/') },
    os: { homedir: () => '/synthetic' },
  })[name] });
  vm.runInContext(patched.source, context);
  return { context, patched };
}

const turn = modelId => ({ runOptions: { requestedModel: { modelId }, localLoopGateEnabled: false }, action: { action: { case: 'userMessageAction' } } });

test('enables only an opted-in configured Grok model with a managed local client', async () => {
  const { context } = load();
  assert.equal((await context.router({ managedLocalAvailable: true })(turn('grok-4.7'))).runtime, 'managed-local');
  assert.equal((await context.router({ managedLocalAvailable: false })(turn('grok-4.7'))).runtime, 'connect');
  assert.equal((await context.router({ managedLocalAvailable: true })(turn('other'))).runtime, 'connect');
});

test('retains native action/run-option validation and private-inference selection', async () => {
  const { context } = load();
  assert.equal((await context.router({ managedLocalAvailable: true })({ ...turn('grok-4.7'), unsupported: true })).runtime, 'fail');
  assert.equal((await context.router({ managedLocalAvailable: true, privateInference: {} })(turn('grok-4.7'))).runtime, 'connect');
});

test('stays on the original path when disabled, missing routes, or unsupported', async () => {
  for (const [routes, provider, model] of [[{ byokMode: 0 }], [{ nativeInferenceModels: [] }], [{ redirect: [] }], [{}, 'openai-chat'], [{}, 'anthropic', 'other']]) {
    const { context } = load(routes, provider, model);
    assert.equal((await context.router({ managedLocalAvailable: true })(turn('grok-4.7'))).runtime, 'connect');
  }
});

test('is idempotent and rejects unknown runtime layouts before writing', () => {
  const { patched } = load();
  assert.equal(enableNativeInference(patched.source).changed, false);
  assert.throws(() => enableNativeInference('function unrelated(){}'), /Expected one/);
  assert.throws(() => enableNativeInference(fixture.replace('o.hasModelCredentials', 'o.renamedField')), /eligibility/);
});
