import { inspectFiles } from '../services/file-selection';
import { shell, clipboard, net } from 'electron';
import type { Command, CommandResponses, Result } from '../../shared/contracts/ipc';
import { AppError } from '../../shared/errors';
import type { HistoryItem } from '../../shared/models';
import type { MessageView } from '../../shared/runtime';
import type { HandlerDependencies } from './dependencies';
function success<K extends keyof CommandResponses>(
  _type: K,
  value: CommandResponses[K],
): Result<CommandResponses[K]> {
  return { ok: true, value };
}
export async function dispatchCommand(
  command: Command,
  {
    agentConfigs,
    info,
    host,
    sessions,
    picker,
    changed,
    credentials,
    runtime,
    catalogReady,
    testBaseUrl,
    interactions,
    automationControl,
    artifacts,
    workspaceFiles,
    logs,
    deletion,
  }: HandlerDependencies,
) {
  switch (command.type) {
    case 'workspace.list':
      return success(
        command.type,
        await workspaceFiles.list(command.sessionId, command.directoryId, command.showHidden),
      );
    case 'workspace.resolve':
      return success(
        command.type,
        await workspaceFiles.resolveLink(command.sessionId, command.entryId, command.href),
      );
    case 'workspace.preview':
      return success(
        command.type,
        await workspaceFiles.preview(command.sessionId, command.entryId),
      );
    case 'workspace.copy': {
      const preview = await workspaceFiles.preview(command.sessionId, command.entryId);
      if (preview.text === undefined)
        throw new AppError('TEXT_UNAVAILABLE', '当前文件没有可复制的文本');
      clipboard.writeText(preview.text);
      return success(command.type, null);
    }
    case 'workspace.reveal':
      shell.showItemInFolder(await workspaceFiles.location(command.sessionId, command.entryId));
      return success(command.type, null);
    case 'workspace.saveAs': {
      const source = await workspaceFiles.location(command.sessionId, command.entryId);
      const target = await picker.chooseSaveFile(source);
      return success(
        command.type,
        target ? await workspaceFiles.saveAs(command.sessionId, command.entryId, target) : null,
      );
    }

    case 'agentConfig.preview': {
      const result = await host.request({
        type: 'agentConfig.preview',
        binding: agentConfigs.preview(command.config, command.expectedRevision),
        workspace: '/〈新会话工作区〉',
      });
      return success(command.type, { text: result.text, source: result.source });
    }
    case 'agentConfig.get':
      return success(command.type, agentConfigs.settings());
    case 'agentConfig.save':
      return success(command.type, agentConfigs.save(command.config, command.expectedRevision));
    case 'sessions.agentConfig': {
      const details = agentConfigs.details(command.sessionId);
      if (details.binding) {
        const session = sessions.get(command.sessionId);
        const result = await host.request({
          type: 'agentConfig.preview',
          binding: details.binding,
          workspace: details.workspace,
          ...(session.state === 'persisted' && session.piSessionId
            ? { history: { file: session.sessionFile, piSessionId: session.piSessionId } }
            : {}),
        });
        details.prompt = { text: result.text, source: result.source };
      }
      return success(command.type, details);
    }
    case 'files.choose':
      return success(command.type, inspectFiles(await picker.chooseFiles()));
    case 'files.inspect':
      return success(command.type, inspectFiles(command.paths));
    case 'workspace.choose':
      return success(command.type, (await picker.chooseDirectory()) ?? null);
    case 'conversation.submit':
      await catalogReady;
      return success(
        command.type,
        await runtime.submitConversation(command.input, command.sessionId, command.parent),
      );
    case 'automation.control': {
      if (!automationControl) throw new AppError('UNSUPPORTED_COMMAND', '自动化入口未开启');
      return success(command.type, automationControl(command.action, command.sessionId));
    }
    case 'artifacts.list':
      return success(command.type, artifacts.list(command.sessionId));
    case 'files.preview':
      return success(command.type, await sessions.previewFile(command.sessionId, command.fileId));
    case 'files.copy': {
      const preview = await sessions.previewFile(command.sessionId, command.fileId);
      if (preview.text === undefined)
        throw new AppError('TEXT_UNAVAILABLE', '当前文件没有可复制的文本');
      clipboard.writeText(preview.text);
      return success(command.type, null);
    }
    case 'files.reveal':
      shell.showItemInFolder(await sessions.inputLocation(command.sessionId, command.fileId));
      return success(command.type, null);
    case 'artifacts.reveal':
      shell.showItemInFolder(await artifacts.location(command.sessionId, command.artifactId));
      return success(command.type, null);
    case 'artifacts.preview':
      return success(command.type, await artifacts.preview(command.sessionId, command.artifactId));
    case 'artifacts.copy': {
      const preview = await artifacts.preview(command.sessionId, command.artifactId);
      if (preview.artifact.state !== 'ready' || preview.text === undefined)
        throw new AppError('TEXT_UNAVAILABLE', '当前文件没有可复制的文本');
      clipboard.writeText(preview.text);
      return success(command.type, null);
    }
    case 'artifacts.export': {
      const parent = await picker.chooseExportDirectory();
      return success(
        command.type,
        parent ? await artifacts.exportVersion(command.sessionId, command.versionId, parent) : null,
      );
    }
    case 'artifacts.revealExport': {
      shell.showItemInFolder(await artifacts.exportLocation(command.sessionId, command.path));
      return success(command.type, null);
    }
    case 'workspace.open': {
      const error = await shell.openPath(sessions.get(command.sessionId).workspace);
      if (error) throw new AppError('OPEN_FAILED', '无法打开工作区');
      return success(command.type, null);
    }
    case 'link.open': {
      const url = new URL(command.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new AppError('INVALID_LINK', '只允许打开普通 HTTP/HTTPS 链接');
      await shell.openExternal(url.href);
      return success(command.type, null);
    }
    case 'system.info':
      return success(command.type, info());
    case 'models.settings':
      await catalogReady;
      return success(command.type, credentials.settings());
    case 'models.discover':
      await catalogReady;
      return success(
        command.type,
        await credentials.discover(command.provider, testBaseUrl, (input, init) =>
          net.fetch(input instanceof URL ? input.href : input, {
            ...init,
            credentials: 'omit',
            cache: 'no-store',
          }),
        ),
      );
    case 'models.connection':
      await catalogReady;
      return success(
        command.type,
        credentials.saveConnection(command.provider, command.baseUrl, command.key),
      );
    case 'models.test': {
      await catalogReady;
      credentials.validate(command.model);
      const baseUrl = testBaseUrl ?? credentials.endpoint(command.model.provider);
      const result = await host.request({
        type: 'models.test',
        model: command.model,
        apiKey: credentials.key(command.model.provider),
        ...(baseUrl ? { baseUrl } : {}),
      });
      return success(command.type, { elapsedMs: result.elapsedMs });
    }
    case 'models.select':
      await catalogReady;
      return success(command.type, credentials.select(command.model));
    case 'models.thinking':
      await catalogReady;
      return success(command.type, credentials.setThinking(command.level));
    case 'models.key':
      await catalogReady;
      return success(command.type, credentials.save(command.provider, command.key));
    case 'runtime.submit':
      await catalogReady;
      return success(command.type, await runtime.submit(command.sessionId, command.input));
    case 'runtime.activeStates':
      return success(command.type, runtime.activeStates());
    case 'runtime.snapshot':
      return success(command.type, await runtime.restoreSnapshot(command.sessionId));
    case 'runtime.discardDraft':
      runtime.discardDraft(command.sessionId, command.inputId);
      return success(command.type, null);
    case 'runtime.cancel':
      await runtime.cancel(command.sessionId);
      return success(command.type, null);
    case 'interaction.answer': {
      const input = command;
      interactions.answer(
        {
          id: input.interactionId,
          sessionId: input.sessionId,
          runId: input.runId,
          hostEpoch: input.hostEpoch,
          digest: input.digest,
        },
        input.answer,
      );
      return success(command.type, null);
    }
    case 'system.ping':
      return success(command.type, await host.ping(command.text));
    case 'sessions.deletePreview':
      return success(command.type, deletion.preview(command.sessionId));
    case 'sessions.delete':
      return success(command.type, await deletion.remove(command.sessionId));
    case 'logs.list':
      return success(command.type, await logs.list(command.sessionId, command.toolCallId));
    case 'logs.page':
      return success(
        command.type,
        await logs.page(command.sessionId, command.logId, command.offset),
      );
    case 'sessions.list':
      return success(command.type, sessions.list(command.search, command.archived));
    case 'sessions.create': {
      const directory = command.chooseWorkspace ? await picker.chooseDirectory() : undefined;
      if (command.chooseWorkspace && !directory) return success(command.type, null);
      const value = sessions.create(directory);
      changed();
      return success(command.type, value);
    }
    case 'sessions.open': {
      if (!runtime.snapshot(command.sessionId)) sessions.reconcile(command.sessionId);
      const session = sessions.get(command.sessionId);
      const active = await runtime.restoreSnapshot(session.id);
      // Active history comes from its sole writer's snapshot, not a second SessionManager.
      const transcript =
        !active && session.state === 'persisted' && session.piSessionId
          ? ((await host.readHistory(
              session.sessionFile,
              session.workspace,
              session.piSessionId,
            )) as { items: HistoryItem[]; messages: MessageView[] })
          : { items: [], messages: active?.messages ?? [] };
      return success(command.type, {
        session,
        files: sessions.files(session.id),
        history: transcript.items,
        messages: transcript.messages,
      });
    }
    case 'sessions.rename': {
      const value = sessions.rename(command.sessionId, command.title);
      changed();
      return success(command.type, value);
    }
    case 'sessions.archive': {
      const value = sessions.archive(command.sessionId, command.archived);
      changed();
      return success(command.type, value);
    }
    case 'files.pick': {
      const value = sessions.addFiles(command.sessionId, await picker.chooseFiles());
      changed();
      return success(command.type, value);
    }
    case 'files.add': {
      const value = sessions.addFiles(command.sessionId, command.paths);
      changed();
      return success(command.type, value);
    }
    case 'files.remove': {
      const value = sessions.removeFile(command.sessionId, command.fileId);
      changed();
      return success(command.type, value);
    }
  }
}
