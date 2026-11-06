// Importable real SDK probe for Electron utilityProcess; no CLI side effects or credential access.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { registerFauxProvider, streamSimple } from '@earendil-works/pi-ai/compat';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';

export async function runPiSmoke(cwd, onEvent = () => {}) {
  mkdirSync(cwd, { recursive: true });
  const faux = registerFauxProvider({ provider: `electron-validation-${randomUUID()}` });
  const model = faux.getModel();
  const runtime = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: null, modelsStorePath: join(cwd, 'models.json'), allowModelNetwork: false });
  runtime.registerProvider(model.provider, { api: faux.api, apiKey: 'validation-placeholder', baseUrl: model.baseUrl, models: faux.models });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, 'agent'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPromptOverride: () => 'Reply exactly with the supplied synthetic response.' });
  await resourceLoader.reload();
  const sessionFile = join(cwd, 'electron-native-session.jsonl');
  const manager = SessionManager.open(sessionFile, cwd, cwd);
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, 'agent'), modelRuntime: runtime, model, tools: [], sessionManager: manager, settingsManager, resourceLoader });
  session.agent.streamFunction = streamSimple;
  const events = [];
  session.subscribe(event => { events.push(event.type); onEvent({ type: event.type, role: event.message?.role, text: event.type === 'message_update' ? event.message.content.filter(x => x.type === 'text').map(x => x.text).join('') : undefined }); });
  try {
    faux.setResponses([fauxAssistantMessage('PI_ELECTRON_SMOKE_OK')]);
    await session.prompt('Return the synthetic smoke token.');
    const assistant = session.messages.findLast(m => m.role === 'assistant');
    assert(assistant.content.some(p => p.type === 'text' && p.text === 'PI_ELECTRON_SMOKE_OK'));
    assert(events.includes('message_update') && events.includes('agent_settled'));
    const entries = readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(entries.some(e => e.type === 'message' && e.message.role === 'assistant'));
    const restored = SessionManager.open(sessionFile, cwd, cwd).buildSessionContext();
    assert.equal(restored.messages.filter(m => m.role === 'user').length, 1);
    return { node: process.version, electron: process.versions.electron ?? null, sdk: '1.5.0', status: 'passed', events, persistedMessages: entries.filter(e => e.type === 'message').length, restoredMessages: restored.messages.length };
  } finally { await session.dispose(); faux.unregister(); }
}
