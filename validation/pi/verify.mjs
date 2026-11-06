import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { registerFauxProvider, streamSimple } from '@earendil-works/pi-ai/compat';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';

const root = fileURLToPath(new URL('.', import.meta.url));
const mode = process.argv.includes('--live') ? 'live' : 'deterministic';
const runDir = join(root, 'runs', `${new Date().toISOString().replaceAll(':', '-')}-${mode}`);
mkdirSync(runDir, { recursive: true });
const results = { mode, date: new Date().toISOString(), node: process.version, sdk: '1.5.0', cases: [] };
const timeout = setTimeout(() => { save(); process.exit(124); }, 180_000);
const textOf = m => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
const envelope = (id, text) => `[data-agent-input:${id}]\n${text}`;
const parseId = text => /^\[data-agent-input:([\w-]+)\]\n/.exec(text)?.[1];
const strip = text => text.replace(/^\[data-agent-input:[\w-]+\]\n/, '');
function save() { writeFileSync(join(runDir, 'summary.json'), JSON.stringify(results, null, 2)); }
async function test(name, fn) {
  const started = performance.now();
  try { const details = await fn(); results.cases.push({ name, status: 'passed', ms: Math.round(performance.now() - started), ...details }); }
  catch (e) { results.cases.push({ name, status: 'failed', error: String(e.message).replace(/sk-[\w-]+/g, '[REDACTED]') }); }
  save();
  console.log(JSON.stringify(results.cases.at(-1)));
}
async function makeSession({ name, model, runtime, faux, path, hooks = {} }) {
  const cwd = join(runDir, name); mkdirSync(cwd, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: 'off' } });
  const manager = SessionManager.open(path ?? join(cwd, 'session.jsonl'), cwd, cwd);
  const contexts = [];
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPromptOverride: () => 'You are a validation assistant. Follow the user request exactly. Do not execute shell commands.',
    extensionFactories: [(pi) => {
      pi.on('context', event => {
        const messages = event.messages.map(m => m.role !== 'user' ? m : { ...m, content: typeof m.content === 'string' ? strip(m.content) : m.content.map(p => p.type === 'text' ? { ...p, text: strip(p.text) } : p) });
        contexts.push(messages); return { messages };
      });
      for (const [event, hook] of Object.entries(hooks)) pi.on(event, hook);
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, 'agent'), model, modelRuntime: runtime, sessionManager: manager, settingsManager, resourceLoader, thinkingLevel: 'high', tools: mode === 'live' ? ['read'] : [] });
  if (faux) session.agent.streamFunction = streamSimple;
  const events = []; let seq = 0; let active = null; const early = [];
  const committed = new Map(manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'data_agent.input_committed').map(e => [e.data.inputId, e.data.entryId]));
  const diskEntries = () => existsSync(manager.getSessionFile()) ? readFileSync(manager.getSessionFile(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  function reconcile() {
    for (const entry of diskEntries()) {
      if (entry.type !== 'message' || entry.message.role !== 'user') continue;
      const id = parseId(textOf(entry.message));
      if (id && !committed.has(id)) {
        committed.set(id, entry.id);
        manager.appendCustomEntry('data_agent.input_committed', { inputId: id, entryId: entry.id });
      }
    }
  }
  session.subscribe(e => {
    events.push({ seq: ++seq, type: e.type, role: e.message?.role, inputId: e.message?.role === 'user' ? parseId(textOf(e.message)) : undefined });
    if (e.type === 'message_update') active = structuredClone(e.message);
    if (e.type === 'message_end') {
      const id = e.message.role === 'user' && parseId(textOf(e.message));
      if (id) early.push({ id, onDiskDuringMessageEnd: diskEntries().some(x => x.type === 'message' && parseId(textOf(x.message)) === id) });
      if (e.message.role === 'assistant') active = null;
    }
    if (e.type === 'turn_end' || e.type === 'agent_settled') reconcile();
  });
  return { session, manager, events, contexts, early, committed, diskEntries, cwd,
    snapshot: () => ({ seq, history: structuredClone(manager.getEntries()), active: structuredClone(active), queues: { steer: session.getSteeringMessages(), followUp: session.getFollowUpMessages() } }),
    submit: (kind, id, text) => {
      manager.appendCustomEntry('data_agent.input_submitted', { inputId: id, kind });
      return kind === 'prompt' ? session.prompt(envelope(id, text)) : session[kind](envelope(id, text));
    },
  };
}
async function fakeRuntime(withAuth = true) {
  const faux = registerFauxProvider({ provider: `validation-${randomUUID()}`, tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
  const runtime = await ModelRuntime.create({ authPath: join(runDir, randomUUID(), 'auth.json'), modelsPath: null, modelsStorePath: join(runDir, randomUUID(), 'models.json'), allowModelNetwork: false });
  runtime.registerProvider(faux.getModel().provider, { api: faux.api, apiKey: withAuth ? 'validation-placeholder' : undefined, baseUrl: faux.getModel().baseUrl, models: faux.models });
  return { faux, runtime, model: faux.getModel() };
}
async function deterministic() {
  await test('identity-duplicate-steer-followup-snapshot-persistence-restore', async () => {
    const f = await fakeRuntime();
    f.faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage('Streaming partial content to validate active snapshot.')));
    const h = await makeSession({ name: 'identity', ...f });
    let queuedResolve; const queued = new Promise(r => queuedResolve = r); let didQueue = false; let captured;
    h.session.subscribe(e => {
      if (e.type === 'message_update' && textOf(e.message).length > 0 && !didQueue) {
        didQueue = true; captured = h.snapshot();
        (async () => {
          for (const [kind, id] of [['steer', 's1'], ['steer', 's2'], ['followUp', 'f1'], ['followUp', 'f2']]) await h.submit(kind, id, 'identical text');
          queuedResolve();
        })();
      }
    });
    const userText = '[data-agent-input:user-authored]\nKeep this literal text unchanged.';
    await h.submit('prompt', 'p1', userText); await queued;
    assert.deepEqual([...h.committed.keys()], ['p1', 's1', 's2', 'f1', 'f2']);
    assert.equal(new Set(h.committed.values()).size, 5);
    assert(h.early.every(x => !x.onDiskDuringMessageEnd));
    assert(captured.active && textOf(captured.active).length > 0);
    assert(!captured.history.some(e => e.type === 'message' && e.message.role === 'assistant'));
    assert(h.contexts.length > 0 && h.contexts.every(ms => ms.every(m => !/\[data-agent-input:(?:p1|s1|s2|f1|f2)\]/.test(textOf(m)))));
    assert(h.contexts[0].some(m => m.role === 'user' && textOf(m) === userText));
    assert.equal(strip(textOf(h.session.messages.find(m => m.role === 'user'))), userText);
    const path = h.manager.getSessionFile(); await h.session.dispose();
    const restored = await makeSession({ name: 'restored', ...f, path });
    assert.equal(restored.session.messages.filter(m => m.role === 'user').length, 5);
    const persistedMappings = restored.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'data_agent.input_committed');
    assert.equal(persistedMappings.length, 5);
    f.faux.setResponses([fauxAssistantMessage('Continue after restoring.')]);
    await restored.submit('prompt', 'r1', 'New input after restore');
    assert.equal(restored.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'data_agent.input_committed').length, 6);
    await restored.session.dispose(); f.faux.unregister();
    writeFileSync(join(runDir, 'identity-events.json'), JSON.stringify(h.events, null, 2));
    return { inputs: [...h.committed.keys()], uniqueEntryIds: 5, earlyEventBeforeDisk: true, activeSnapshotIncludesUnpersistedText: true, envelopeAbsentFromModelContext: true, userLiteralMarkerPreserved: true, rendererProjectionStripsOnlyOuterEnvelope: true, restoredInputs: 5, acknowledgementIdempotentAfterRestore: true };
  });
  await test('preflight-rejection-must-finalize-without-agent-settled', async () => {
    const f = await fakeRuntime(false); const h = await makeSession({ name: 'preflight', ...f });
    let status = 'running';
    try { await h.submit('prompt', 'no-auth', 'hello'); status = 'completed'; } catch { status = 'failed'; }
    assert.equal(status, 'failed'); assert(!h.events.some(e => e.type === 'agent_settled')); assert(!h.session.isStreaming);
    await h.session.dispose(); f.faux.unregister();
    return { terminalStatus: status, agentSettledEvents: 0, hostMustCatchPromptRejection: true };
  });
  await test('abort-and-explicit-clear-queue-does-not-replay-cancelled-inputs', async () => {
    const f = await fakeRuntime(); f.faux.setResponses([fauxAssistantMessage('long '.repeat(300))]);
    const h = await makeSession({ name: 'cancel', ...f }); let cancel; let once = false;
    h.session.subscribe(e => {
      if (e.type === 'message_update' && !once) { once = true; cancel = (async () => {
        await h.submit('steer', 'cs', 'identical text'); await h.submit('followUp', 'cf', 'identical text');
        const cleared = h.session.clearQueue(); await h.session.abort(); return cleared;
      })(); }
    });
    await h.submit('prompt', 'cp', 'start'); const cleared = await cancel;
    assert(!h.committed.has('cs') && !h.committed.has('cf')); assert.equal(h.session.getSteeringMessages().length + h.session.getFollowUpMessages().length, 0);
    assert(h.events.some(e => e.type === 'agent_settled'));
    const path = h.manager.getSessionFile(); await h.session.dispose();
    const restored = await makeSession({ name: 'cancel-restored', ...f, path });
    f.faux.setResponses([fauxAssistantMessage('Restored without replaying pending entries.')]);
    await restored.submit('prompt', 'new-after-restart', 'Continue only this new input.');
    const ids = restored.session.messages.filter(m => m.role === 'user').map(m => parseId(textOf(m)));
    assert.deepEqual(ids, ['cp', 'new-after-restart']);
    await restored.session.dispose(); f.faux.unregister();
    return { consumed: [...h.committed.keys()], cancelledInputIds: ['cs', 'cf'], clearedQueue: cleared, settled: true, restoredWithoutUnknownInputReplay: true };
  });
}
async function live() {
  await test('deepseek-flash-high-read-nonce-followup-restored-context', async () => {
    assert(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY missing; live test not skipped');
    const runtime = await ModelRuntime.create({ authPath: join(runDir, 'empty-auth.json'), modelsPath: null, modelsStorePath: join(runDir, 'model-cache.json'), allowModelNetwork: false });
    const model = runtime.getModel('deepseek', 'deepseek-flash');
    assert(model, 'Installed SDK has no deepseek-flash catalog entry');
    const wire = [];
    const hooks = {
      before_provider_request: e => { const p = e.payload; wire.push({ model: p.model, thinking: p.thinking, reasoning_effort: p.reasoning_effort, tools: p.tools?.map(t => t.function?.name), hasToolResult: p.messages?.some(m => m.role === 'tool'), hasReasoningField: p.messages?.some(m => m.role === 'assistant' && typeof m.reasoning_content === 'string'), hasPriorReasoning: p.messages?.some(m => m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0), internalEnvelopePresent: JSON.stringify(p.messages ?? []).includes('[data-agent-input:live-') }); },
      after_provider_response: e => { results.lastHttpStatus = e.status; },
    };
    const h = await makeSession({ name: 'live', model, runtime, hooks });
    const nonce = randomUUID(); const noncePath = join(h.cwd, 'nonce.txt'); writeFileSync(noncePath, nonce);
    await h.submit('prompt', 'live-1', `Call read to read ${noncePath}. Reply with exactly the file contents. Do not guess.`);
    const first = h.session.messages.filter(m => m.role === 'assistant').at(-1);
    assert.equal(first.stopReason, 'stop', first.errorMessage ?? 'model did not complete');
    assert(textOf(first).includes(nonce)); assert(h.session.messages.some(m => m.role === 'toolResult' && m.toolName === 'read'));
    assert(h.events.some(e => e.type === 'message_update'));
    const path = h.manager.getSessionFile(); await h.session.dispose();
    const r = await makeSession({ name: 'live-restored', model, runtime, hooks, path });
    await r.submit('prompt', 'live-2', 'Without reading any file again, repeat the exact nonce you just read in the previous exchange. Output only the nonce.');
    const second = r.session.messages.filter(m => m.role === 'assistant').at(-1);
    assert.equal(second.stopReason, 'stop', second.errorMessage ?? 'model did not complete'); assert(textOf(second).includes(nonce));
    assert.equal(r.session.messages.filter(m => m.role === 'toolResult').length, 1);
    writeFileSync(join(runDir, 'wire-summary.json'), JSON.stringify(wire, null, 2));
    assert(wire.length >= 3);
    assert(wire.every(w => w.thinking?.type === 'enabled' && w.reasoning_effort === 'high' && !w.internalEnvelopePresent));
    assert(wire.some(w => w.hasToolResult && w.hasReasoningField));
    await r.session.dispose();
    return { requestModel: model.id, responseModel: second.model, provider: model.provider, requests: wire.length, reasoningLevel: 'high', readToolCalls: 1, nonceMatch: true, restoredContextMatch: true, reasoningFieldSent: true, nonemptyThinkingObserved: wire.some(w => w.hasPriorReasoning), internalEnvelopeAbsentOnWire: true, usage: second.usage, credentialSource: 'DEEPSEEK_API_KEY; value not persisted' };
  });
}
try { await (mode === 'live' ? live() : deterministic()); }
finally { clearTimeout(timeout); save(); }
console.log(`Evidence: ${runDir}/summary.json`);
process.exitCode = results.cases.every(x => x.status === 'passed') ? 0 : 1;
