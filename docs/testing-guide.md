# 自动测试与模型录制/重放

更新：2026-11-07。本文是持续维护测试的当前入口。P0–P7 是已经完成的开发阶段，不再用作测试组织方式；历史结果不改写，旧 ID 映射见 [legacy-aliases.json](../tests/legacy-aliases.json)。阶段 JSON 只作历史清单留档，`verify:phase -- Pn` 明确报错并提示新入口，不会静默执行缩水的旧门禁。

## 目录与职责

```text
tests/
  catalog.json                  # 唯一可执行测试目录：ID、功能、层级、模型模式、环境、标签
  legacy-aliases.json            # 旧 ID → 新 ID；重复场景去重
  features/
    application/                # 启动、dev、CDP、IPC、隔离
    sessions/                   # 元数据、JSONL、恢复、删除
    composer/                   # 输入、草稿、原文件引用、发送/主题
    conversation/               # 多轮、steer/follow-up、重试/压缩、缓存前缀
    lifecycle/                  # 并发/FIFO、停止、窗口、崩溃
    models/                     # 设置/BYOK、模型前置检查、真实/重放协议链路
    agent-config/               # 配置修订/迁移、会话绑定、工具禁用、上下文前缀与设置 UI
    tools/                      # 执行、取消、资源限制、完整日志
    approvals/                  # 路径策略、联网、审批、澄清
    artifacts/                  # 文件交付/另存及跨轮工作区（保留原用例 ID）
    workspace/                  # 按层目录、受控文件操作与浏览 UI
    preview/                    # 有界文本/代码/CSV/Markdown/PNG 预览
    transcript/                 # 消息阅读、执行过程、渲染安全
    usage/                      # 本轮用量、队列归属、并发与恢复
    performance/                # 100 MB 固定多表基准
    packaging/                  # 实际 .app、离线、迁移路径、内置运行时
  support/                      # CDP 操作、受控模型录制/重放等共用机制
  fixtures/model/               # 审阅过的脱敏真实响应，进入 Git
  tooling/                      # runner、选择器、依赖边界、提交钩子自身的回归
  phases/                       # 只读历史清单，不再驱动 runner
scripts/test/
  verify.mjs                    # CLI 编排与退出状态
  selection.mjs                 # 参数、功能筛选、affected 依赖分析
  case-registry.mjs             # 目录校验、别名、构建/付费要求
  execution.mjs                 # 一次构建，按层执行，不为每条 native 用例重跑整个目录
  report.mjs                    # JSON/JUnit/Markdown 结果
  release-audit.mjs             # 完整发布套件的资源与残留进程审计
  harness.mjs / dev-harness.mjs # 隔离后台 Electron/CDP
  model-fixture.mjs              # 手写确定性 HTTP/SSE 场景
```

一个功能的纯逻辑、原生集成与 UI 用例相邻，后缀分别为 `.unit.test.ts`、`.integration.test.ts`、`.e2e.mjs`。ID 使用 `feature.behavior`，如 `usage.queue-boundaries`；文件名直接描述行为。共享机制放 support；不把全部场景堆回一个 runner。

`catalog.json` 是实际执行目录，新增测试必须注册。工具回归检查文件覆盖、重复 ID、E2E 导出与 native 测试标题的一致性，防止“写了测试却没跑”。单元 ID 对应一个文件，报告同时记录实际断言数量；集成 ID 对应标题前缀；E2E ID 对应一个场景。场景数不能与旧阶段别名数或 Vitest 断言数混为一谈。

## 常用命令

```sh
pnpm quality                                      # 静态门禁
pnpm test:list                                    # 全目录含 live/packaged，绝不执行
pnpm test -- --feature usage                       # 本轮用量的 unit + integration（若有）+ E2E
pnpm test -- --feature conversation --level e2e     # 指定功能与层级
pnpm test -- --case usage.queue-boundaries         # 单场景
pnpm test -- --case usage.details,preview.files    # 多场景；也支持重复 --case
pnpm test -- --suite smoke                         # 单元/tooling + 明确标记的关键原生/CDP
pnpm test                                         # 普通回归，与 --suite regression 相同
pnpm test:e2e                                     # 全部普通 E2E，不再只跑旧 P0/P1
pnpm test -- --affected --base HEAD~1 --dry-run     # 查看提交差异 + 本地修改会选中什么、为什么
pnpm test -- --affected --base HEAD~1              # 执行受影响的普通回归
pnpm test -- --feature packaging                   # 全部非 live 打包用例
pnpm test -- --feature performance                 # 固定 100 MB 基准
pnpm test:live -- --case conversation.live-cache   # 显式真实模型调用
pnpm test -- --case models.live-recording --live   # 生成候选录制，不自动覆盖正式 fixture
```

`--feature`、`--case` 可用逗号或重复参数；不同筛选维度取交集。`--list` / `--dry-run` 输出用例、模型模式、build/package/live 要求，不启动 Electron、不读取密钥、不构建。未知名称、空的显式选择、未实现用例均报错。旧单项 ID 可以暂时使用，例如 `--case UX-TURN-USAGE`；结果只记新 ID。

普通回归包含 unit、native integration、tooling、非打包 E2E，默认排除 live、packaged、性能基准和录制任务。`--feature packaging` / `--packaged` 才启用打包；`--feature performance` 才启用基准。显式 `--case` 可选择任意用例，但执行 live 仍必须带 `--live`。单独 `--live` 只选择真实模型测试；与 `--suite` 一起使用时向套件加入 live。

完整发布验收：

```sh
# 包含 quality、全部普通回归、100 MB 基准、实际 .app、资源及残留进程审计；不含 live
pnpm test -- --suite release
# 另包含所有指定 live 用例；涉及未知命令仍须审核，不自动批准
DATA_AGENT_EVAL_REVIEW=1 pnpm test -- --suite release --live
```

release 不允许再用 feature/case/level/affected 缩小后声称完整验收。录制是一项显式维护操作，不自动进入任何套件或批量 live 运行。`pnpm verify:release` 只是资源检查，不等价于上述完整验收。

## 如何选择受影响测试

`--affected` 合并 `base...HEAD`、工作区/暂存区和未跟踪文件；不传 base 时只比较 HEAD 后的本地修改。它使用 TypeScript 模块解析追踪本地传递依赖，并用显式功能关系覆盖 Renderer → IPC → Main → Host 等静态 import 无法看见的边界。用 `--dry-run` 查看每个 ID 的选择原因。

shared/preload/node/storage、公共 UI、入口、构建/测试基础设施、资源和锁文件变更扩大回归；无法归属的源码保守扩大，不把“没找到 import”当成不影响 E2E。文档/README 不触发运行时测试，仍须 `pnpm quality`。affected 是有理由的保守选择器，不是完整依赖证明；发布前仍跑完整发布门禁。默认 affected 也不自动花费 token 或打包，需要显式扩大范围。

## 测试究竟是否调用真实模型

| 模式     | 做什么                                       | 验证边界                                                                |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| none     | 纯逻辑/存储/启动或 SDK 内存 faux provider    | 无外部模型；`none` 表示没有 HTTP 模型请求，并非没有任何替身             |
| scripted | 本机 HTTP/SSE 固定响应、工具调用、错误或等待 | 真实 pi SDK、IPC、工具、Python、SQLite 和 UI；可重复制造审批/失败/竞态  |
| replay   | 本机 HTTP 逐条匹配请求，重放审阅过的真实响应 | 验证实际提供方响应在 SDK/工作台中的处理，不验证当下模型质量或服务可用性 |
| live     | 真实 DeepSeek                                | 模型/提供方当前兼容性、实际缓存/计费 usage、效果评测所需的新输出        |

普通自动化实例在未提供模型夹具时使用本机拒绝端点，防止漏配夹具时访问默认提供方；非 live runner 禁止读取真实测试密钥。真实 live 使用 `DEEPSEEK_API_KEY`，读取逻辑仍为环境或 `.zshrc` 的字面量赋值，不 source shell。

录制/重放放在 **HTTP 提供方边界**，不直接把最终 UI 文本或 runtime.snapshot 塞进页面。真实模型产生的 tool call 会由当前工具重新执行，实际 tool result 必须匹配下一条录制请求；当前 SDK 仍执行 reasoning/text/tool/usage 归一化、JSONL 落盘和 UI 更新。因此能回归协议和产品链路，也会揭示工具输出或提示词发生变化。

## 录制与更新夹具

`models.live-recording` 使用合成文本和只读 read 工具，限定最多 4 次请求、单请求 90 秒、请求/响应各 2 MB。正式首份 fixture 是 `tests/fixtures/model/read-tool.deepseek.json`：真实 DeepSeek 的两次请求，工具续传与 usage。该场景以合成 BYOK 配置应用，真实密钥仅留在录制代理；不录 Authorization 或任意响应头。原始候选与测试状态留在忽略的 test-results，审阅后才复制到正式 fixtures 并提交。

```sh
pnpm test -- --case models.live-recording --live
# 读取 summary.json 中 candidate 路径，检查仅合成数据、无凭证/私有路径、请求与响应完整。
# 确认是预期行为变更后，将 candidate.json 复制为 tests/fixtures/model/read-tool.deepseek.json。
pnpm test -- --case models.recorded-conversation   # 在新路径中无真实模型重放并验证恢复
pnpm test:tooling                                 # 录制器、匹配和负例回归
```

录制包含 schema 版本、来源/日期、pi SDK 版本、完整请求及 hash、响应状态、内容类型、SSE 帧及 hash。仅将该场景明确声明的 workspace、测试根目录、隔离 app 根目录和仓库路径替换成占位符；不忽略 system prompt、tools、模型设置、消息顺序或工具结果。非业务响应 ID/服务端时间原样保留，不伪装成新计费。

重放逐请求严格匹配；缺请求、多请求、request/schema/SDK/hash 不匹配都失败，**没有 live fallback**。只重放 SSE 数据边界，采用缩短的固定间隔，不承诺还原服务端延迟、TCP 分包或性能。取消、重试、并发、错误状态仍主要用 scripted 用例精确控制。fixture 的 usage 是录制样本，不是本次回归实际消耗的 tokens。

SDK、提示词、工具 schema 或实际工具输出变化导致 fixture 过期时，先判断差异是否符合设计，再显式重新录制、审阅和提交；不能删掉匹配字段来掩盖回归。纯 UI 改动通常无需重新录制。已有历史 JSONL 只含最终消息，不足以反推出原始流式传输，不能冒充录制。

## 执行环境、结果与交付

- unit 使用 Node/Vitest；native integration 使用 Electron 自带 Node/Vitest，保持 SQLite ABI。每层只启动一批 Vitest，按文件和 ID 筛选；未执行/skip/todo 不算选中用例通过。
- E2E 使用真实 Electron + CDP，默认后台隐藏窗口。隔离 userData、业务目录、构建和 package；不触碰 `~/.data_agent`、在用 out 或 release。`--no-build/--no-package` 必须配合 `--run-root` 和匹配源码指纹的历史隔离产物；过期产物失败。
- 每次执行生成 `test-results/<时间>/summary.json`、`junit.xml`、`report.md`，包括选择计划、源码指纹、每项状态与日志；截图/DOM/SQLite/JSONL 不进 Git。纯筛选不产生这些目录。
- 提交前仍须相关功能验收和 `pnpm quality`，Husky 自动检查不能绕过。每个完成阶段创建 commit，不自动 push。
- 当前 CI 的 Linux job 运行静态、unit 和 tooling；macOS 的原生/CDP/packaging 仍按本机命令验收，不能声称远端已跑过 Electron。
- 程序回归判断工作台流程、状态与约定交付物，不判断分析结论准确性。真实模型效果用 [evaluations](../evaluations/README.md) 与独立 Judge；重放不替代质量评测。

## 模型设置回归

`pnpm test -- --feature models` 默认不读取真实 Key、不调用线上模型。新增的 `models.configuration` 经真实 pi SDK 验证覆盖地址、短请求预算、401/403/404/429/500/503 与网络错误分类，以及按模型能力选择推荐级别；`models.preflight` 还验证地址/凭证事务回滚与排队任务配置快照。`conversation.cache-prefix-unit` 使用生产 Base URL 覆盖路径验证最终 HTTP URL 和上下文前缀。

`models.connections-ui` 使用后台 Electron/CDP 与合成 HTTP 服务，覆盖固定凭证遮罩、独立提供方管理、跨模型/提供方/弹窗的内存草稿、保存失败保留输入、地址持久化、真实 SDK 连接测试、鉴权错误脱敏、凭证移除确认、搜索无结果、焦点恢复、三种尺寸和深浅主题。`models.settings` 保持原有 Key 轮换/移除/重启及思考参数验收；`models.recorded-conversation` 严格匹配既有录制，不因 UI 修改放宽匹配。

应用诊断测试使用“检查本地引擎”；这不会消耗模型请求，也不能替代“测试模型连接”。普通测试中的连接测试只访问本机合成 HTTP 服务，不能据此声称已经在线验证所有模型/代理服务。

连接探测还覆盖“首段内容已到达，但服务端始终不发结束事件”的流：收到非空内容即通过并 abort，避免把等不到 DONE 误报为连接失败；只收到空帧不能通过。虚拟时钟验证无响应/首内容等待的 20 秒超时分类与计时器清理。CDP 对三种尺寸和深浅主题断言“更换 Key”与输入框中心差不超过 1 px，并保存凭证区域截图。

`pnpm test -- --case models.live-connection --live` 仅运行一次真实 DeepSeek 设置页探测，使用 `live-key.mjs` 读取测试 Key，不创建会话、不发文件、不自动重试、不保留原始响应。它独立于录制重放与普通回归；服务端不可用时如实失败，不改为 skip 或反复重试取绿。

### 动态模型目录与 OpenRouter

- `models.configuration` 覆盖 `/models` schema、类型/工具过滤、未知提供方排除与脱敏错误；`models.discovery-store` 覆盖 SQLite 缓存恢复、连接修订竞态、清理退役凭证及连接变更后的列表失效。`models.connections-ui` 覆盖 provider-first 表单、保存后获取、获取失败与重试、只显示支持提供方、草稿保留、遮罩、尺寸/主题和滚动；`models.settings` 覆盖选模型、级别、下一轮配置与重启。
- `tests/support/model/listing.mjs` 是明确的合成目录响应，普通 scripted/replay/拒绝模型服务器仅对 `GET /v1/models` 返回此列表。重放的 POST 请求哈希/原始响应校验不变，目录设置不计入录制中的模型调用次数，不能把它说成线上目录录制或真实鉴权。普通 runner 同时移除 DeepSeek/OpenRouter 环境密钥。
- `pnpm test -- --case models.live-connection,models.live-openrouter --live` 使用真实设置/IPC/SDK，各做一次短探测（另有目录 GET）。OpenRouter 测试密钥为 `OPENROUTER_API_KEY`，只从环境或 `.zshrc` 字面量读取；默认测试模型 `deepseek/deepseek-v4.1-flash`，不自动遍历模型直到通过。成功只证明此组合当前连通，失败不计为通过。
- 所有 UI 测试使用隔离、后台隐藏窗口。模型网络栈变更需运行普通全量回归，以验证实际工具、前缀和重放链路未变。

## Agent 配置回归

`pnpm test -- --feature agent-config` 执行配置 schema 与真实 SDK 请求测试、SQLite 版本/历史恢复、并发排队绑定与 Main 工具检查、后台 CDP 设置交互。`agent-config.requests` 比较实际序列化请求，覆盖 skill 开关、全部工具关闭、工具循环、steer/follow-up、新附件和重启；普通全量中的 `conversation.retry-compaction` 继续覆盖明确的压缩边界。`agent-config.settings` 覆盖三尺寸/深浅主题、未保存关闭确认、保存冲突保留草稿、只读版本详情与新会话不提前创建。

重放场景把 APP_ROOT 路径绑定到当前 skill 快照根，并在请求前核对快照正文与内置正文相同；只是可移植路径发生变化，完整请求匹配、原响应与 usage 样本保持不变。没有删除提示词或工具字段的匹配，也没有 live 回退。

`agent-config.requests` 同时比较预览与最终 HTTP 请求中的 system 文本，覆盖启用/关闭 skill 和全工具关闭；历史预览必须等于原生记录且 JSONL 字节不变。`agent-config.settings` 验证展开加载、草稿更新、真实 XML 标签与顺序、工具/skill 关闭后的预览、会话详情与实际请求逐字一致，并检查预览不增加模型调用或会话数量。

存储简化回归：sessions.storage-migration 使用旧 schema 10 的 WAL fixture，覆盖六表迁移、完整输入顺序、配置引用/覆盖、事务失败回滚、旧删除清单废弃、备份与未知高版本拒绝。普通测试不读取真实用户库。工作区用例验证实际目录，不再等待产物登记或 output_versions 发布。

执行身份简化回归：`sessions.run-migration` 验证 schema 11 → 12 的字段改名/删除、状态与错误/待投递输入保留、DDL 失败回滚、WAL 一致性备份及重复打开不再备份；`sessions.metadata-writes`、`conversation.snapshot` 和 `approvals.policy` 覆盖旧 run 的状态/ACK、快照和审批不能作用于当前 run。普通全量回归继续覆盖队列、重启及实际请求前缀。
