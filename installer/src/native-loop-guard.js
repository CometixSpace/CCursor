/** Opt-in native Grok Agent execution; all prompts and compaction stay in Cursor. */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export const NATIVE_LOOP_MARKER = '__byokNativeInferenceV1';

export function buildNativeLoopPolicyPayload() {
  return `/* BYOK-NATIVE-INFERENCE-V1 */
globalThis.${NATIVE_LOOP_MARKER}=function(turn){
  try{
    var fs=require('fs'),path=require('path'),dir=path.join(require('os').homedir(),'.ccursor');
    var routes=JSON.parse(fs.readFileSync(path.join(dir,'routes.json'),'utf8'));
    if(routes.byokMode===0||routes.byokMode===false||routes.byokMode==='off')return;
    if(!Array.isArray(routes.nativeInferenceModels)||!routes.nativeInferenceModels.length)return;
    var id=turn.runOptions.requestedModel?.modelId||turn.modelDetails?.modelId;
    if(!routes.nativeInferenceModels.includes(id))return false;
    if(!Array.isArray(routes.redirect)||!routes.redirect.includes('aiserver.v1.InferenceService/RunInferenceSSE')||!routes.redirect.includes('aiserver.v1.BidiService/BidiAppend'))return false;
    var providers=JSON.parse(fs.readFileSync(path.join(dir,'providers.json'),'utf8'));
    return providers.providers.some(function(p){return p.type==='anthropic'&&p.models.some(function(m){return m.id===id&&/^grok-4\\.[67]$/.test(m.apiModel);});});
  }catch(e){return;}
};
/* BYOK-NATIVE-INFERENCE-V1-END */\n`;
}

export function enableNativeInference(source) {
  if (source.includes(`/*${NATIVE_LOOP_MARKER}*/`)) return { source, changed: false };
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const targets = [];
  walk.simple(ast, {
    FunctionDeclaration(node) {
      const text = source.slice(node.start, node.end);
      if (text.includes('byok-connect-routed') && text.includes('agent_host_local_loop') && node.body.body.length === 1) targets.push(node);
    },
  });
  if (targets.length !== 1) throw new Error(`Expected one native turn router, found ${targets.length}`);
  const target = targets[0];
  const arrow = target.body.body[0].argument;
  if (arrow?.type !== 'ArrowFunctionExpression' || !arrow.async || arrow.body.type !== 'BlockStatement') throw new Error('Native turn router shape changed');
  const options = target.params[0].name;
  const turn = arrow.params[0].name;
  const text = source.slice(target.start, target.end);
  // Keep Cursor's action/mode/run-option checks. No model-family impersonation
  // and no global feature-gate override. Unknown layouts fail before writing.
  const match = /const (\w+)=(\w+)\((\w+)\);if\(\1\.hasModelCredentials\)return (\w+)\("byok-connect-routed"\);const (\w+)=(\w+)\(\1\);return void 0!==\5\?(\w+)\(\5,\1\):\{runtime:"managed-local",reason:"eligible"\}/.exec(text);
  if (!match || match[3] !== turn) throw new Error('Native model-eligibility checks changed');
  const [, , facts, , connect, , eligible, fail] = match;
  const injection = `/*${NATIVE_LOOP_MARKER}*/const __byokNative=globalThis.${NATIVE_LOOP_MARKER}(${turn});if(__byokNative===false)return ${connect}("gate-off");if(__byokNative===true&&${options}.privateInference===undefined){if(!${options}.managedLocalAvailable)return ${connect}("managed-local-client-absent");if(${turn}.action.action.case==="subscriptionNotificationAction")return ${connect}("subscription-notification-connect-routed");const __byokFacts=${facts}(${turn}),__byokReason=${eligible}(__byokFacts);return __byokReason!==undefined?${fail}(__byokReason,__byokFacts):{runtime:"managed-local",reason:"eligible"};}`;
  const patched = buildNativeLoopPolicyPayload() + source.slice(0, arrow.body.start + 1) + injection + source.slice(arrow.body.start + 1);
  acorn.parse(patched, { ecmaVersion: 'latest', sourceType: 'script' });
  return { source: patched, changed: true };
}
