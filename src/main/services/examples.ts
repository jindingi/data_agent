import type Database from 'better-sqlite3';
import {
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppPaths } from '../../node/app-paths';
import { readExampleBundle, exampleHash } from '../../node/example-bundle';
import type { AgentConfigService } from './agent-config';
import type { ExampleStatus } from '../../shared/examples';

const key = 'examples.initialization';
interface Installation {
  state: 'pending' | 'done' | 'skipped';
  sessions?: ExampleStatus['sessions'];
}
/** One-time installation journal. Completed deletion never makes an installation pending again. */
export class ExampleService {
  private error: string | undefined;
  private initialSessionId: string | undefined;
  constructor(
    private db: Database.Database,
    private paths: AppPaths,
    private bundle: string,
    private configs: AgentConfigService,
    private faults?: { at(point: string): void },
  ) {}
  private installation(): Installation {
    const row = this.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : { state: 'skipped' };
  }
  private save(value: Installation) {
    this.db
      .prepare('INSERT OR REPLACE INTO app_metadata VALUES (?,?)')
      .run(key, JSON.stringify(value));
  }
  install(skip = false): ExampleStatus {
    if (skip && this.installation().state === 'pending') this.save({ state: 'skipped' });
    if (this.installation().state !== 'pending') return this.status();
    try {
      const { files, examples } = readExampleBundle(this.bundle);
      const staging = join(this.paths.home, 'example-staging');
      const directory = (path: string) => {
        if (existsSync(path)) {
          if (
            !lstatSync(path).isDirectory() ||
            lstatSync(path).isSymbolicLink() ||
            realpathSync(path) !== path
          )
            throw new Error('示例目标目录已重定向');
        } else mkdirSync(path, { mode: 0o700 });
      };
      directory(staging);
      // The persisted intent owns only these known paths. Existing mismatched bytes are never overwritten.
      const publish = (target: string, contents: Buffer, temporary: string) => {
        if (existsSync(target)) {
          const stat = lstatSync(target);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            exampleHash(readFileSync(target)) !== exampleHash(contents)
          )
            throw new Error('示例目标已有不同内容，已保留原文件');
          return;
        }
        directory(dirname(temporary));
        if (existsSync(temporary)) {
          const stat = lstatSync(temporary);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('示例临时文件已重定向');
          if (exampleHash(readFileSync(temporary)) !== exampleHash(contents))
            throw new Error('示例临时文件校验失败');
        } else writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
        this.faults?.at('staged');
        renameSync(temporary, target);
        this.faults?.at('published');
      };
      for (const example of examples) {
        if (this.db.prepare('SELECT id FROM sessions WHERE id=?').get(example.id))
          throw new Error('示例身份冲突');
        const workspace = join(this.paths.workspace, example.id);
        directory(workspace);
        const prefix = `${example.directory}/workspace/`;
        const workspaceFiles = [...files]
          .filter(([p]) => p.startsWith(prefix))
          .map(([p, b]) => [p.slice(prefix.length), b] as const);
        for (const name of ['netflix_titles.csv', 'SOURCE.md']) {
          const bytes = files.get(`datasets/netflix/${name}`);
          if (!bytes) throw new Error('示例输入或来源说明缺失');
          workspaceFiles.push([`data/${name}`, bytes]);
        }
        for (const [relative, bytes] of workspaceFiles) {
          const parts = relative.split('/');
          let parent = workspace;
          for (const name of parts.slice(0, -1)) {
            parent = join(parent, name);
            directory(parent);
          }
          publish(
            join(workspace, relative),
            bytes,
            join(staging, `${example.id}-${exampleHash(bytes)}.tmp`),
          );
        }
        publish(
          join(this.paths.sessions, `${example.id}.jsonl`),
          files.get(`${example.directory}/session.jsonl`)!,
          join(staging, `${example.id}.jsonl.tmp`),
        );
      }
      this.faults?.at('before-commit');
      this.db.transaction(() => {
        this.configs.importExampleBindings(examples.map((e) => e.binding));
        for (const example of examples) {
          const workspace = join(this.paths.workspace, example.id);
          this.db
            .prepare(
              `INSERT INTO sessions(id,title,workspace,session_file,pi_session_id,state,history_known,created_at,updated_at,run_id,run_state,agent_config_revision)
            VALUES (?,?,?,?,?,'persisted',1,?,?,?,'completed',?)`,
            )
            .run(
              example.id,
              example.title,
              workspace,
              join(this.paths.sessions, `${example.id}.jsonl`),
              example.piSessionId,
              example.createdAt,
              example.createdAt,
              example.runId,
              example.binding.revision,
            );
          for (const input of example.inputs)
            this.db
              .prepare(
                `INSERT INTO input_submissions(input_id,session_id,run_id,kind,state,entry_id,digest) VALUES (?,?,?,?,'committed',?,?)`,
              )
              .run(input.inputId, example.id, input.runId, input.kind, input.entryId, input.digest);
          this.db
            .prepare("INSERT INTO session_sources VALUES (?,?,'accepted')")
            .run(example.id, join(workspace, 'data/netflix_titles.csv'));
        }
        this.save({
          state: 'done',
          sessions: examples.map(({ id, title, report }) => ({ id, title, report })),
        });
        this.faults?.at('in-commit');
      })();
      this.initialSessionId = examples[0].id;
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : '示例初始化失败';
    }
    return this.status();
  }
  status(): ExampleStatus {
    const value = this.installation();
    const sessions = (value.sessions ?? []).flatMap((session) => {
      const row = this.db
        .prepare('SELECT title FROM sessions WHERE id=? AND archived=0')
        .get(session.id) as { title: string } | undefined;
      return row ? [{ ...session, title: row.title }] : [];
    });
    return {
      sessions,
      error: this.error,
      initialSessionId: sessions.some((s) => s.id === this.initialSessionId)
        ? this.initialSessionId
        : undefined,
    };
  }
}
