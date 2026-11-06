import { Type, type TSchema } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { toolOperationSchema } from '../../shared/tools';
import type { ToolExecutor } from '../tool-client';

export function genericTools(client: ToolExecutor, redact: <T>(value: T) => T): ToolDefinition[] {
  const path = Type.String({ description: 'Absolute path or path relative to the current output directory.' });
  const definitions: { name: string; label: string; description: string; parameters: TSchema }[] = [
    { name: 'read', label: '读取文件', description: 'Read a text file. offset is a 1-based line number. Output is bounded; read larger datasets with Python if needed.', parameters: Type.Object({ path, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }) },
    { name: 'write', label: '写入文件', description: 'Write UTF-8 text to a file, creating parent directories. Existing contents are replaced. External writes require approval. Write scripts and reports using this tool.', parameters: Type.Object({ path, content: Type.String({ maxLength: 256 * 1024 }) }) },
    { name: 'edit', label: '精确修改', description: 'Replace exactly one occurrence of oldText in a UTF-8 file with newText. Fails without changes if oldText is absent or ambiguous.', parameters: Type.Object({ path, oldText: Type.String({ minLength: 1 }), newText: Type.String() }) },
    { name: 'bash', label: '执行命令', description: 'Execute bash in the current output directory. python/python3, rg and fd use bundled versions. No user shell startup files. No installing dependencies. Common dangerous operations are blocked; external writes, detected networking and dynamic execution request approval. Default timeout 180 seconds.', parameters: Type.Object({ command: Type.String({ maxLength: 100_000 }), timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 180 })) }) },
    { name: 'grep', label: '搜索内容', description: 'Search text using ripgrep regex. Output and file count are bounded. Hidden/sensitive files and directory symlinks are excluded from recursive search.', parameters: Type.Object({ pattern: Type.String(), path, ignoreCase: Type.Optional(Type.Boolean()) }) },
    { name: 'find', label: '查找文件', description: 'Find regular files using an fd filename regex. Hidden/sensitive paths are excluded. Up to 256 matches.', parameters: Type.Object({ pattern: Type.String(), path }) },
    { name: 'ls', label: '列出目录', description: 'List up to 500 directory entries, showing file, directory or symlink type.', parameters: Type.Object({ path }) },
    { name: 'ask_clarification', label: '询问用户', description: 'Ask a concise clarification question and wait for an answer. This is not a permission approval and cannot authorize filesystem/network operations.', parameters: Type.Object({ question: Type.String({ maxLength: 4000 }), options: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })) }) },
  ];
  return definitions.map(definition => ({ ...definition, async execute(toolCallId, params, signal, onUpdate) {
    if (!params || typeof params !== 'object') throw new Error('工具参数必须是对象');
    const operation = toolOperationSchema.parse(redact({ ...params, name: definition.name }));
    const result = await client.execute(toolCallId, operation, signal, output => onUpdate?.({ content: [{ type: 'text', text: output }], details: {} }));
    if (result.isError) throw new Error(result.output);
    return { content: [{ type: 'text', text: result.output }], details: result.details ?? {} };
  } }));
}
