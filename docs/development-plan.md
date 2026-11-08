# MVP 分阶段开发、程序验收与 Agent 效果评测计划

更新日期：2026-11-07。依据 [产品需求](mvp-plan.md) 与 [技术文档](technical-design.md)。本文描述正式产品的实施与验收。技术不确定性已先在 validation/ 中实际验证，证据见 [验证入口与证据说明](../validation/README.md)；这些独立探针不等于正式产品已完成。下列阶段及其 ID 保留历史设计语境；持续维护命令和目录已迁移到 [测试指南](testing-guide.md)。旧 Pn 执行入口已退役，不再作为当前开发命令。

P0–P7 之外的交付后体验修复见 [UX0–UX5 计划](ux-remediation-plan.md)，当前实现范围见 [产品说明](mvp-plan.md) 和 [技术设计](technical-design.md)。新增用例须按功能注册；旧门禁记录保留，不能据此宣称新 UX 问题已解决。UI 设计与视觉评审遵循 [设计原则](design-principles.md)。

HTML 交互报告的实施及验收范围见 [实现计划](interactive-report-plan.md)：资源/配置、独立 skill 与隔离预览已接入，用例已按功能注册，确定性回归及打包专项通过；真实模型完整交付存在超时及请求次数超限，最终验收仍为 WIP。普通回归、打包、真实生成与质量 Judge 分别记录，不恢复 Pn 阶段 runner；未通过的真实生成或未测浏览器不能由静态门禁替代。

Skill 扩展改造已完成：只保留通用提示词和唯一快照结构，可信清单统一登记资源、类型和设置显示；适用场景与交付规则由 skill 自身维护，不兼容旧提示词协议。扩展性、上下文前缀、后台设置及资源冻结的定向回归通过；真实只读传输已重新录制、审阅并通过严格重放与重启恢复验证。该范围不替代完整发布或分析质量验收。

## 1. 两类验证与完成规则

| 类别            | 验证对象                                                   | 判定方式                                                                                        | 用途                                                        |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 程序/规则化验证 | 工作台的调用链、状态、交互、存储、安全策略、文件交付与展示 | 确定性测试与真实调用测试的可观察事实，例如指定 report.md 存在且非空；不判断分析数值与结论准确性 | 回归工作台逻辑，作为 P0–P7 程序门禁                         |
| LLM-as-a-judge  | Agent 的需求理解、数据处理、代码与分析方法、结论和解释     | 独立 Judge 阅读任务、数据、执行记录及产物，给出评价和证据；必要时自行计算辅助评判               | 评估 Agent 效果，指导 skills/提示优化，独立于工作台回归结果 |

当前由开发协作中的 AI Agent 担任 Judge，不开发产品内审核 Agent，不在展示报告前调用 Judge。Judge 评价不构成结果正确性的保证。具体评测流程与场景见第 15 节。

阶段顺序为 P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7。每阶段必须同时交付实现、可运行测试与机器可读验收结果，并创建该阶段完成 commit，再进入依赖它的下一阶段。允许并行做不依赖未完成功能的工作，但不能跳过门禁。

- 原阶段使用 `tests/phases/Pn.json`，现只作留档。后续工作按功能定向验收，完整发布用 `pnpm test -- --suite release --live`；任何完成阶段仍须测试、记录并 commit。
- 清单对应测试不存在、必需用例未运行、零用例、skip/todo、缺 DeepSeek 测试凭证、网络不可用、构建不存在，均不能计为通过。基础设施阻塞记 blocked，并保留错误；不可切换 mock 或其他模型伪装通过。
- 每阶段至少包含真实 Electron 的 CDP 验证。涉及 agent 的 P2–P7 另有指定的真实 DeepSeek 用例，确定性测试仍负责覆盖错误分支和竞态。
- 阶段门禁包含受影响的前置回归；最终 P7 执行所有确定性测试及指定 live 回归。只改文案可运行相应 UI 用例，但不能因此宣称整个阶段或发布验证完成。
- 修复失败后重跑相关用例；完整保留前次失败记录。不能无限重试模型直到碰巧通过文件交付断言；Judge 质量评价另行保留，不用重复采样隐藏差评。
- 所有自动验收都运行于独立临时数据根目录，禁止使用或清理真实 `~/.data_agent`。

P0–P7 已完成本机交付验收；当前能力见 [产品说明](mvp-plan.md) 与 [技术设计](technical-design.md)，持续验收以 [测试指南](testing-guide.md) 为准。阶段过程与当时结果可查 Git 历史和本地 test-results；不得把探针通过写成产品 E2E 已通过，也不能用旧阶段结果代替当前回归。

现有可执行入口（实际存在）：`python3 validation/policy/probe.py`、`validation/pi/` 的 SDK/live runner、`validation/runtime/` 的运行时准备与哈希/工具验证脚本、`validation/electron/` 的真实 CDP/打包 runner。精确环境、命令及证据见 [验证入口与证据说明](../validation/README.md)。产品开发应复用已验证机制，仅将工作台流程断言移入正式测试；旧探针的业务 oracle、metrics schema 和数值断言不迁移为产品门禁。只在集成发生变化时再验证相应边界。

本机 MVP 交付是 macOS arm64 `.app`；公开签名、公证、DMG、Intel 和其他 macOS 版本不作为 P7 硬门禁。

### 阶段完成后的 Git 提交

**P0–P7 每个阶段完成后必须提交代码。** 验收通过后，同步实现、测试和文档，检查暂存区无凭证、生成物或临时结果，再创建明确标注阶段的 commit；提交说明记录验收命令与结果。允许阶段内小步提交，但未通过必需验收只能标为 WIP，不能宣称阶段完成。阶段完成提交后核对 commit ID 与工作区状态，再进入下一阶段。详见 [版本管理规则](repository-workflow.md)。初始规划提交不计为 P0 完成，阶段提交也不自动 push。

## 2. 本地 DeepSeek 真实集成测试

已只读确认 `~/.zshrc` 中密钥环境变量名称是 **`DEEPSEEK_API_KEY`**。凭证值不写到源码、文档、命令参数、截图或测试输出。

| 项目         | 固定配置                                                                         |
| ------------ | -------------------------------------------------------------------------------- |
| 显示模型     | `DeepSeek-V41-Flash`（官方 DeepSeek-V4.1-Flash）                                 |
| pi provider  | `deepseek`                                                                       |
| API 地址     | `https://api.deepseek.com`                                                       |
| 请求 `model` | `deepseek-flash`                                                                 |
| API 方式     | pi 的 openai-completions 适配                                                    |
| 凭证         | `DEEPSEEK_API_KEY`；测试脚本读取继承环境，未设置时只解析 `~/.zshrc` 的字面量赋值 |
| 调用配置     | thinking enabled / high；验证 SDK 的实际请求映射                                 |

显示名称不直接用作 API model ID。官方当前将 `deepseek-flash` 映射至 V4.1 Flash，别名后续可能更新；每次 live 测试记录请求模型、响应模型字段、时间、SDK 版本、request ID（若有）和用量。[官方调用说明](https://api-docs.deepseek.com/)

真实只读对话入口（旧 `test:integration:live` 是该 E2E 场景的兼容别名）：

```sh
pnpm test:live -- --case models.live-conversation
```

缓存专项：`pnpm test:live -- --case conversation.live-cache` 使用真实 DeepSeek 执行两个有界只读任务，核对原生 JSONL cacheRead 与轮次投影。提供方在该样本未命中则如实失败，不无限重试；实际消息/工具声明前缀稳定另由确定性单元及 P5 回归证明。

单项调试可用 `pnpm test:live -- --case models.live-conversation`。`scripts/test/live-key.mjs` 优先读取继承环境；否则只解析 `~/.zshrc` 中 `DEEPSEEK_API_KEY` 的简单字面量赋值，拒绝命令替换/变量展开，不执行或 source 整个文件。缺 key 明确失败，不跳过 live、不寻找其他提供方的替代凭证。测试脚本通过真实设置页配置隔离实例；生产应用不读取 `.zshrc`，仍通过 BYOK 设置管理密钥。

本地 live 测试只发送合成 fixture、临时文件路径与必要工具结果。凭证仅进入 Main/Agent Host 的模型调用链，命令/Python 子进程显式移除；使用伪密钥哨兵验证日志脱敏，真实密钥只做内存内泄漏检查并输出布尔结果，不输出匹配内容。

真实分析若触发安全审批，可显式使用 `DATA_AGENT_EVAL_REVIEW=1` 审核模式：审核完整命令/脚本后，通过测试驱动点击真实 CDP 审批按钮，记录请求 digest、决定及理由。此类结果标注为含审核的端到端验收，不宣称无人值守通过；审批机制本身另由确定性用例回归。具体协议与超时见 [评测说明](../evaluations/README.md)。

### 请求限额与失败处理

- live 用例串行运行；单用例默认 10 分钟、至多 50 次模型请求，每次输出上限 16,384 tokens；整个指定 live suite 默认 30 分钟，达到任一上限失败并取消执行。这是验收配置，不是已测性能。
- SDK/HTTP 层暂时性连接错误、429、5xx 最多重试 2 次，计入原请求与时间上限；记录每次失败。401/403/模型不存在不重试，不切换模型。
- 文件交付等程序断言失败不自动重跑整场直到通过。网络问题归 blocked/infra_failed，工作台流程错误归 platform_failed，模型未交付指定文件归 task_incomplete；都不能把本次程序用例计为 passed，但 task_incomplete 不直接认定为工作台代码缺陷。分析准确性问题只记录在 Judge 报告，不混入程序验收通过率。
- 不承诺温度设为 0 就可复现真实模型。按调用、文件交付与执行事实断言，不比较整段自然语言或完整 thinking 内容。
- thinking + tools 的连续调用必须验证 reasoning_content 的正确保留；序列化交 pi SDK，不从 UI 文本重建。[官方 thinking/tool 约定](https://api-docs.deepseek.com/guides/thinking_mode/)

## 3. 测试入口与证据约定

通用工具维护使用 `pnpm test -- --feature tools` 及相关 approvals/conversation/agent-config 回归。修改共享工具契约、输出预算或执行监督器后运行完整普通 `pnpm test` 与 `pnpm quality`；按实际 HTTP 请求检查上下文前缀与输出边界。工具声明变化须审查录制兼容性，必要时只用合成只读场景显式重新录制并验证严格重放。旧阶段通过记录不覆盖新增的分页、SDK 错误结果或预算缺陷。

| 命令（按对应阶段实现）                | 责任                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                          | TypeScript、依赖方向、静态配置与文档链接检查；格式/Lint 使用 pnpm quality                                              |
| `pnpm test:unit`                      | Vitest 纯逻辑测试                                                                                                      |
| `pnpm test:integration`               | 确定性 SDK、SQLite、JSONL、IPC、文件与进程测试；不得访问真实模型网络                                                   |
| `pnpm test:integration:live`          | models.live-conversation 的兼容别名；实际是 Electron/CDP 测试                                                          |
| `pnpm dev:cdp`                        | 启动隔离的开发验证实例，输出 PID、endpoint、数据目录、ready 状态                                                       |
| `pnpm test:e2e`                       | 真 Electron + CDP + 确定性模型响应源，执行实际工具和 Python                                                            |
| `pnpm test:e2e:live`                  | 真 Electron + CDP + DeepSeek 的完整分析与恢复                                                                          |
| `pnpm runtime:prepare`                | 构建期准备固定版本 Python/库/rg/fd/字体，校验 hash 与许可证清单                                                        |
| `pnpm build` / `pnpm package:dir`     | 构建 JS 与本地 .app，供早期资源路径验证                                                                                |
| `pnpm test:e2e:packaged`              | 对明确指定的 .app 执行关键 CDP 用例，默认确定性模型                                                                    |
| `pnpm test:e2e:packaged:live`         | 对同一 .app 用固定 DeepSeek 完成分析与恢复                                                                             |
| `pnpm test -- --suite release --live` | 完整静态/确定性/打包/性能/live 回归，阶段入口已退役                                                                    |
| `pnpm verify:release`                 | 核对实际 .app 与当前构建/资源的 hash、架构、许可证和打包范围；必须与完整 P7 程序门禁一起通过，静态检查不能代替运行回归 |
| `pnpm eval:prepare`                   | 执行/收集固定 Agent 任务，打包 Judge 所需证据；仅表示证据准备结果，不自动给出质量分数                                  |

程序测试命令提供统一 `--case <case-id>` 过滤能力，由项目 runner 解析并转给对应测试框架；持续测试由 tests/catalog.json 注册，旧单项 ID 由 legacy-aliases.json 映射。下文阶段 ID 保留验收合同语境，当前功能用例与执行方法见测试指南。

每次执行生成 `test-results/<timestamp>/`：

- `summary.json`：选择计划、源码版本或源码树摘要、配置、平台/架构、依赖版本、用例总数/通过/失败、起止时间及日志/证据；进程失败返回非零。
- `junit.xml`、脱敏 Main/Host/runner 日志，失败时的 screenshot/DOM 快照；CDP trace 能稳定取得时补充保存。
- SQLite 只读摘要、JSONL 结构检查结果、fixture 与产物 hash、文件存在/非空检查、PNG 解码结果；不输出分析数值的准确性断言。
- live 增加请求/响应模型名、request ID（若有）、用量、重试与耗时；不保存 Authorization header。
- 一个便于阅读的 `report.md`，必须来自同一份机器结果。失败证据保留，测试临时目录按保留策略清理，不能清理真实用户目录。

SQLite 断言使用兼容的只读检查器（可用随包 Python sqlite3），不将 Electron ABI 的 better-sqlite3 强行加载进不同 Node ABI 的测试进程。

## 4. CDP 验证方式

采用 Playwright Test 的 `chromium.connectOverCDP(endpoint)`，连接测试启动器创建的真实 Electron。不能以单独的 Vite 网页预览代替桌面集成。[Playwright CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)、[Electron 调试端口](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport)

- 每个测试实例独立 DATA_AGENT_HOME、Electron userData、workspace、凭证配置和端口。同一恢复用例重启时复用自己的数据；其他用例隔离。
- 调试入口只在明确开发/自动化启动时开启，检查监听地址为 loopback、端口归属为当前实例；正常生产启动不开放。测试不关闭 CSP/contextIsolation。
- 用 role/name 和必要的稳定 testid 操作界面。等待可观察状态或进程同步点，不靠固定 sleep。
- 不在 page.evaluate 中直接调用业务逻辑/写数据库来制造成功。主 E2E 仅替换外部模型响应，保留 SDK、IPC、工具、数据库、文件和 Python 的实际执行。
- 原生文件/目录选择框不是 DOM；可用实际文件 input，或在测试启动时替换有限的 FilePicker 返回值。仅替换选择结果，路径登记和大小校验仍真实运行，工作台不解析 CSV；系统弹窗外观不纳入自动化通过声明。
- 开发 agent 每完成一项可见功能即可接入 dev:cdp 验证，再把关键流程固化为 spec。可用兼容该 endpoint 的 CDP MCP/CLI；不兼容时运行项目 Playwright 脚本。Chrome DevTools MCP 对 Electron 的兼容性需实测，不能假定。[MCP 支持范围](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- Renderer Network 面板不能证明 Agent Host 的模型请求已验证，需要合并 Host 日志与 live 断言。

实际 macOS 测试实例运行期间通过与 PID 绑定的 caffeinate 防止系统/显示休眠，进程结束即释放；不改变正常产品启动行为。

## 5. 程序回归样本与断言边界

程序回归使用小型合成 CSV、中文/空格路径、同名不同目录文件、超限文件、恶意 Markdown、符号链接与坏 JSONL。固定数据用于重复执行，不携带分析正确性的机器断言。工作台仅登记文件路径与大小；BOM、GB18030、引号内换行、坏日期或重复列不触发工作台解析。

- 确定性测试：提供固定模型响应与工具调用，实际执行工具和 Python，验证应用路由、审批、状态、恢复和文件展示。测试脚本生成的文件可以预知，但不将其中的业务数字当作分析能力验收。
- 真实模型测试：任务明确要求在指定输出位置生成非空 `report.md`，图表场景另要求 `chart.png`。检查实际请求/工具链、执行收束、文件存在/非空、受控渲染与导出；不比较报告数字、排名、结论或图中系列。
- PNG 解码、尺寸上限和固定中文字体的字符覆盖属于展示/运行时检查，不证明图表准确。Markdown 安全渲染也不证明报告准确。
- 单文件与选用文件合计 100,000,000 bytes 是文件级规则；100,000,001 bytes 拒绝。大型 fixture 固定生成，不提交大文件。
- 状态测试故意提供非空但分析错误的报告：工作台仍应正常展示，不发明“数值校验失败”。缺失文件或不可解码图片则显示对应文件状态；两者不可混淆。
- “无法解析数据”的 Agent 回答不意味着工作台流程故障。若用例约定了文件而未生成，记录 task_incomplete；是否应当修复、澄清或拒绝分析由 Judge 评价。

分析准确性、口径与异常数据处理的样本移至第 15 节，只由 Judge 综合评价，不由 oracle/metrics schema 控制阶段门禁。

## 6. P0 — 工程骨架与可自动驱动的桌面

**目标：** 建立可构建、可启动、可通过 CDP 操作的真实应用，验证工具链；不接模型或执行用户代码。

**开发交付：** 单 package 目录、固定依赖与锁文件；electron-vite 四入口；React/shadcn 基础布局；preload 白名单与 Zod 校验；utilityProcess ready/ping；CDP 启动/关闭脚本；测试报告与阶段清单；better-sqlite3 native 编译加载探针。

| Case ID      | 自动成功标准                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-CHECK     | pnpm check 通过；renderer 无 Node/pi/main 导入；shared 无进程依赖                                                                               |
| P0-CDP       | 启动后 30 秒内发现正确窗口；通过 CDP 输入文本、切换面板并读取状态；未捕获异常为 0                                                               |
| P0-DEV       | 隔离目录启动真实 pnpm dev，通过 CDP 检查合法 IPC、设置连接、新建会话和刷新恢复；同源不同文档的 IPC 仍拒绝；不覆盖 out/、release/ 或真实用户数据 |
| P0-IPC       | 合法 ping 成功；未知 channel/非法参数返回明确错误且无副作用；Host 崩溃可检测                                                                    |
| P0-ISOLATION | 两个测试实例使用不同 userData/业务根目录；生产启动无调试监听；无测试数据写入真实全局目录                                                        |
| P0-PACKAGE   | package:dir 生成可启动 .app；其中 native SQLite 加载成功；Main/Host 两个编译入口存在                                                            |

**门禁：** 历史阶段门禁（当前命令见 [测试指南](testing-guide.md)）。证据记录 Electron/Node/ABI、macOS/架构、本机 macOS 版本、首个 .app 启动和 CDP 截图。P0 构建最小 .app，只验收已实现入口与 native SQLite；完整 Python/rg/fd/字体资源在 P3 加入并验收。自动验收目标固定为 macOS 15.7.4 / Apple M4 / arm64 / 24 GiB；未测试架构不得标为支持。

## 7. P1 — SQLite、workspace 与原生会话文件

**目标：** 应用能可靠管理会话及目录，重启后仍对应同一份数据。

**开发交付：** schema migrations、SessionRepository/SessionService、工作区分配、标题/日期/归档、应用 ID 与 pi ID 关联、受控 ResourceLoader、SessionManager 精确路径接入、只读完整性预检、creating/draft/persisted/missing 状态与启动对账。

| Case ID         | 自动成功标准                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| P1-SCHEMA       | 空库迁移到当前版本；重复启动不重复迁移；模拟迁移失败后不留下半完成 schema                                    |
| P1-EMPTY        | CDP 新建会话即出现 SQLite 行和独立 workspace；未聊天允许 JSONL 不存在；重启后标题/路径/app ID 不变           |
| P1-TREE         | 确定性 SDK 会话写到 sessions/{appId}.jsonl；header/parentId 链有效；用 SDK 重开恢复原消息，不另写聊天表      |
| P1-METADATA     | CDP 重命名/归档/搜索/重新打开行为与 SQLite 一致；两个会话路径不同                                            |
| P1-RECOVERY     | 已有历史文件缺失、零字节、坏行/尾部截断时明确报恢复异常并保留原件，不静默变空会话                            |
| P1-INPUT-REF    | 添加原路径引用后数据库记录文件名/路径，无 CSV 副本；源文件删除后读失败有明确错误，不重建源文件、不建立版本库 |
| P1-COORDINATION | 模拟建目录后 DB 更新失败、首次消息落盘后元数据更新失败；重启可对账，不覆盖已存在历史，无双 writer            |

**门禁：** 历史阶段门禁（当前命令见 [测试指南](testing-guide.md)），包含 P0 的启动/IPC 回归。此阶段不需要真实模型；可用真实 SDK + 确定性响应源生成历史。

## 8. P2 — pi 直接集成、流式 UI 与真实 DeepSeek

**目标：** UI 输入经 IPC 到达真实 pi session，模型输出与工具过程可以展示和恢复；先验证只读工具。

**开发交付：** SessionRuntime、EventAdapter、快照/seq/epoch、模型配置与 CredentialService、固定 DeepSeek 测试配置、read 工具受控接入、thinking/text/tool 卡、Markdown 基础渲染。沿用已验证的 DeepSeek 模型配置和身份桥接；目录里缺失的模型配置明确注册，不依赖随机默认模型。

| Case ID          | 自动成功标准                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-STREAM        | 确定性 text/thinking/tool 参数交错输出按消息与 content index 正确合并；工具以 toolCallId 关联，无重复/串卡                                                                            |
| P2-SNAPSHOT      | 流式中重载 Renderer；持久历史与未落盘 partial/tool/审批/队列共同恢复，新 seq 不重复；旧 epoch 或其他会话事件不污染视图                                                                |
| P2-IDENTITY      | 同文本 prompt/steer/follow-up 具有不同 inputId，可靠关联原生 entry；用户仿造标记原文保留，应用 ID 不进入模型上下文；落盘后 DB ACK 前崩溃不自动重放                                    |
| P2-LIVE-READ     | 用 DEEPSEEK_API_KEY 调用 deepseek-flash；模型实际调用 read，工具结果包含临时文件内容；该结果送入后续请求，UI 正文与 SDK 事件一致；不评价模型是否准确复述；允许简单场景无非空 thinking |
| P2-LIVE-CONTEXT  | 第二轮请求使用同一 session，实际模型上下文保留第一轮消息与工具结果；JSONL 可恢复，响应可展示；thinking + tools 无序列化 400 错误，不按答案准确性断言                                  |
| P2-CREDENTIAL    | 缺 key 或错误模型前置 reject 后释放会话状态和并发许可，可立即再次提交；伪 key 哨兵不进入日志/JSONL/Renderer 事件；model ID 请求值是 deepseek-flash，不是显示名                        |
| P2-LIVE-THINKING | 使用已验证可产生思考的多步工具任务，核验实际非空 thinking 及工具续传的 reasoning_content；简单任务无 thinking 不伪造、不误报 SDK 失败                                                 |
| P2-CDP-LIVE      | 从真实窗口提问并看到流式结果、展开 read 工具卡；重启后显示相同历史；live 证据包含实际请求与用量                                                                                       |

补充回归 `P2-PREFLIGHT` 验证主进程错误释放、双会话准入和排队凭证绑定；`P2-READ-BOUNDS` 验证读取上限/敏感符号链接；`P2-REQUEST-LIMIT`（当前 `conversation.request-limit`）验证第 51 次请求未进入提供方。四个 live Case ID 复用同一次有独立结果的真实窗口多轮场景，分别检查工具续传、上下文、thinking 与 CDP；不会为每个 ID 重复采样模型答案。

**门禁：** `pnpm test:live -- --case models.live-conversation`，必须执行 P2-LIVE-READ/CONTEXT/CDP-LIVE，不可仅用 HTTP ping 或 curl 成功代替 SDK/Electron 集成。

## 9. P3 — 通用工具、内置运行时与审批

**目标：** agent 可使用通用工具完成真实文件与计算任务，副作用按既定规则审批，停止可结束实际进程。

**开发交付：** read/write/edit/bash/grep/find/ls/ask_clarification；ProcessRunner；Python+pandas+NumPy+Matplotlib+Seaborn、rg/fd/字体；PolicyService；InteractionBroker；授权绑定内容摘要；串行工具调度；大小/输出/超时限制。

| Case ID        | 自动成功标准                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-TOOLS       | 7 个通用工具完成临时文件读/写/精确改/搜/列/执行；小文件语义正确，大 read 不全量载入 100 MB；输出截断带提示                                                        |
| P3-RUNTIME     | 不依赖用户 PATH 中 Python/rg/fd；实际加载固定 Python 库并生成 PNG；中文字形完整，无隐式下载；开发和 .app 均通过                                                   |
| P3-POLICY      | 已列明危险模式被拒绝；workspace 外写/删、重定向、脚本内已知写入命中 ask；中文、空格、相邻前缀、符号链接按预期判定；误报样例正常通过                               |
| P3-APPROVAL    | CDP 批准后恰好执行一次；拒绝无目标文件/删除；改参数/hash 后旧批准失效；等待中取消、Cmd+Q、Host 退出均结束等待；关闭窗口保留等待，重新打开能回答；迟到批准无副作用 |
| P3-CANCEL      | 长任务 spawn 子进程后取消；5 秒内进程组退出；周期写入停止，10 秒观察期无新增写入；无僵持审批                                                                      |
| P3-NETWORK     | 检测到普通工具联网先审批；拒绝无实际请求，允许一次仅执行当前动作；模型 API 不重复弹审批；安装依赖拒绝                                                             |
| P3-READ-POLICY | 普通外部文件读允许，敏感路径/控制文件读拒绝；命中/误报样例均验证；资料中的指令不能成为授权                                                                        |
| P3-QUESTION    | CDP 展示澄清表单并返回结构化回答；拒绝/取消路径正常收束，不当作权限批准                                                                                           |
| P3-LIVE-TOOLS  | DeepSeek 实际 write 脚本、bash 使用内置 Python 执行、read 返回实际文件内容；指定结果文件存在且非空，工具子进程无 API key；不判断计算结果准确性                    |

**门禁：** 历史阶段门禁（当前命令见 [测试指南](testing-guide.md)），当前清单包含 19 项检查（含 P2 核心 live 回归与实际 .app 运行时验证）。确定性模型使用仅测试模式启用的 loopback HTTP/SSE 响应源，真实 SDK、工具服务、文件、Python、SQLite 和 UI 均不替换。危险命令只测试分类器或临时目录中的无害替身，不实际执行破坏系统的样例。

## 10. P4 — CSV → 图表 → 报告的完整闭环

**目标：** 用户添加 CSV 路径并提问，Agent 通过工具产生文件，工作台展示执行过程与产物；整条交付链路可自动验收，不裁定分析正确性。

**开发交付：** 原文件路径引用与附件元数据；多 CSV 选择与合计大小校验；内置分析 skills；通用输出目录与文件登记；ArtifactService 访问/展示检查、图表和 Markdown 预览；结果面板、打开目录和导出。不开发 CSV 解析、指标 schema 或分析正确性验证器。

| Case ID          | 自动成功标准                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-IMPORT        | CDP 添加两个源 CSV 路径；只读取文件元数据，工具调用前不读取 CSV 内容；附件名称/路径/大小正确，同名不同目录可区分；不复制/修改源文件，单个/合计超限均拒绝，prompt 不自动内嵌文件全文 |
| P4-DETERMINISTIC | 确定性模型响应经实际 SDK/工具/Python 使用两个原 CSV 路径，生成非空 report.md 与 chart.png；工具过程、文件登记、Markdown/图片展示及导出串联正常；不检查业务数值                      |
| P4-ARTIFACT      | 存在的文件经类型/大小/路径检查登记，Markdown/图片可展示，导出后链接可用；无需 metrics.json 或 manifest.json；即使有同名 JSON 也不信任其路径或状态声明                               |
| P4-CLARIFY       | 确定性模型请求 ask_clarification；CDP 展示并返回用户选择，工具结果进入下一请求，执行可继续；工作台不自行判断数据是否有歧义或强制触发澄清                                            |
| P4-LIVE-ANALYSIS | DeepSeek 经真实 UI 收到多 CSV 路径与任务，实际调用工具并结束，指定 report.md/图表存在且非空并可展示；报告与图表准确性只交给独立 Judge 评测                                          |
| P4-MULTIFILE     | 选择、移除和同名不同路径的附件按实际路径提交；多个文件路径均能被通用工具读取，工作台不检查关联键、重复值或金额。关联质量见 J2                                                       |
| P4-RESULT-STATE  | SDK 正常结束显示“执行完成”；文件缺失/空文件/损坏 PNG 分别显示未生成、空文件或无法展示。非空但内容错误的报告仍可展示，不能标成分析正确或因数值错误被工作台拦截                       |
| P4-VERSIONS      | 重复生成报告复用会话目录和同路径 artifact ID；更新 hash/预览，删除文件移出登记；旧版本目录兼容可读                                                                                  |

**门禁：** 历史阶段门禁（当前命令见 [测试指南](testing-guide.md)），必须包含 `pnpm test:live -- --case artifacts.live-analysis`。Agent 可在总执行预算内自行修复；程序门禁仅检查既定交付条件，不增加数值断言。另执行 J1/J2 效果评测并记录评价，质量分数不作为工作台回归门禁。

## 11. P5 — 多轮、插话、停止与崩溃恢复

**目标：** 用户连续追问或运行中调整任务时，队列、进程、存储和 UI 的状态一致。

**开发交付：** 原生 steer/followUp、一条一条消费、run_inputs 投递记录与临时 input_drafts、run/input 关联、取消全链路、后台运行切换会话、恢复快照、retry/compaction UI、退出与崩溃对账。

| Case ID          | 自动成功标准                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P5-MULTITURN     | 第一轮完成后追问并要求生成新 report.md，创建新 run 但共用输出位置；同名文件更新且预览刷新，第二轮请求保持既有前缀并追加历史；不检查排名是否正确                                                               |
| P5-STEER         | 确定性模型与工具同步点：当前整批工具先结束，下一模型请求才含 steer；正在执行的脚本不被假装立刻改写                                                                                                            |
| P5-FOLLOWUP      | 连发两条 follow-up，每条恰好消费一次且顺序正确；属于同一持续执行 run、不同 input；相同文本的两条输入不靠字符串去重                                                                                            |
| P5-STOP          | 等待工具/审批/澄清时停止均可收束；未消费输入变未发送，SDK 队列清理；取消后不自动跑下条；退出重启后未发送文字仍可找回，已 committed 的临时草稿清理                                                             |
| P5-CRASH         | 运行中强杀 Host/Main，受控工具进程组在 5 秒内结束，随后 10 秒无继续写入；重启后原 run interrupted、历史/产物可见、批准失效、不重复执行副作用；unknown 文字可放回输入框，跨新 run 保留且只能在所属会话显式移除 |
| P5-SWITCH        | A/B 同时运行且消息/工具/审批不串会话；C FIFO 排队；停止 A 不影响 B，C 获得许可；没有同一 JSONL 双 writer                                                                                                      |
| P5-WINDOW        | 关闭最后窗口后 A/B 继续，审批保持暂停；重开恢复活动投影；Cmd+Q 取消全部并保存，重启不自动执行排队输入，全局排队的原提问文字保留未发送                                                                         |
| P5-RETRY-COMPACT | 确定性触发重试与压缩；UI 状态正确，不能在尚有 retry 时宣布完成，重试期间主动停止必须标 cancelled；压缩后仍可浏览完整历史并继续                                                                                |
| P5-LIVE-RESUME   | DeepSeek 第一轮生成非空报告 → 关闭重启应用 → 追问并要求新报告；实际请求保留原生会话上下文，新文件非空，消息与产物不重复，仍使用指定模型；不评价追问答案准确性                                                 |

**门禁：** 历史阶段门禁（当前命令见 [测试指南](testing-guide.md)）。恢复以 SDK 原生树为上下文来源，不靠重新发送整段聊天。不能把“页面能显示缓存”当作模型已恢复。

## 12. P6 — 文件边界、模型设置与交互质量

**目标：** 支持约定的文件大小与执行负载，准确呈现文件/工具错误，形成可用的模型设置与结果阅读体验。

**开发交付：** 文件元数据校验、路径缺失和工具报错展示；DeepSeek/OpenRouter 动态模型/BYOK 设置与能力控件、验证状态；流式 Markdown 性能、长对话分页/虚拟化、日志上限；图片与链接校验；100 MB 基准脚本；删除/清理流程。

| Case ID            | 自动成功标准                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6-FILE-BOUNDARY   | BOM/GB18030/坏日期/重复列/空 CSV 均仅登记路径，不按内容拒绝或解析；超限按文件元数据拒绝。确定性工具返回解析错误时 UI 如实展示，Agent 可继续修复或解释；源文件缺失展示读取错误                                                         |
| P6-100MB           | 在记录配置的 Apple Silicon、至少 16 GB 内存基准机上，确定性分析 每次合计 100 MB 的固定多表样本在 180 秒内结束，单任务 Python 进程树采样峰值 RSS ≤2 GiB；另运行两个并发分析记录总 RSS/耗时；30 次 CDP 面板交互响应 p95 ≤500 ms，无崩溃 |
| P6-SETTINGS        | CDP 保存/修改/清除伪 key 后重启状态正确，持久化仅为加密值；模型切换在两次 run 之间生效；不支持的 thinking 选项不显示                                                                                                                  |
| P6-RENDER          | 恶意 Markdown 无脚本执行、无自动远程图片请求、无任意 file 读取；长消息可阅读、工具结果有界；PNG 与静态报告正确展示                                                                                                                    |
| P6-DELETE          | 删除先停止任务；仅清理明确选择的登记应用产物；保留外部父目录、原始 CSV 和用户手工放入的未登记文件；模拟部分失败可继续清理，不丢路径记录                                                                                               |
| P6-LIVE-REGRESSION | 使用固定 DeepSeek 配置再次执行文件交付与多轮流程，指定报告存在且非空，设置页面名称与实际请求 model ID 对应；分析质量另记录在 Judge 报告                                                                                               |

除表中主用例外，P6 清单包含 `P6-DELETE-STORAGE`、`P6-LOG-STORAGE`、`P6-READ-ENCODING`、`P6-OUTPUT-LIMIT`、`P6-LOG-LIMIT` 、`P6-LOG-UI` 和 `P6-DRAFTS`，当前对应回归验证恢复清单/路径隔离、二进制反馈、500 MiB 产物终止、bash 超过 2 KiB 才落盘与每 run 10 MiB 日志上限，以及切换会话时未提交的输入框文字隔离。日志 UI 已按后续需求移除，P6-LOG-UI 兼容入口现验证 Agent 按路径读取与界面无日志入口。基准固定两份各 50 MB 文件，通过实际 UI 发送计时；并发采样与所有 30 次交互耗时保存在本地结果，不以独立脚本代替工作台流程。

**门禁：** 历史阶段门禁（当前命令见 [测试指南](testing-guide.md)）。180 秒/2 GiB/CDP p95 为产品门禁；独立 Python 的实际基准已见验证记录，不能当作含 UI/LLM 的实测。本机配置满足基准要求。若初次测量表明目标需调整，必须记录数据与理由并显式修订门禁，不能在报告中悄悄放宽。

## 13. P7 — 本机 macOS 应用最终验收

**目标：** 验证本机实际 `.app`，不依赖开发目录、系统 Python 或首次联网安装。

**开发交付：** 完整本机 arm64 `.app`、runtime manifest、许可证材料、资源路径与 native ABI 检查、回归报告。公开分发签名/公证/DMG 后置，不阻塞本机交付。

| Case ID        | 自动成功标准                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P7-THEME-INPUT | 打包应用经 CDP 验证深浅切换、刷新和重启持久化；Enter 实际提交、Shift+Enter 换行、空格保留、空白/输入法/长按不误发，兼容 ⌘ Enter；保存主题与预览截图供人工复核 |
| P7-USABILITY   | 真实磁盘 File 经 CDP 拖拽进入 preload 并登记原路径；不解析 CSV；输入区思考设置持久化；复制 Markdown 与文件内容一致；窄窗口可展开阅读报告并返回输入            |
| P7-PACKAGE     | 全新临时用户数据目录、移除开发者工具 PATH 后启动 .app；无本地源码绝对路径，所有必需资源/库存在且 hash/架构匹配                                                |
| P7-OFFLINE     | 测试启动器阻断外网、仅保留 loopback，使用本地确定性响应源完成导入/分析/绘图/恢复；无 pip/npm/二进制自动下载；该用例与需要联网的 P7-LIVE 分开运行              |
| P7-CDP         | 对实际 .app 经 CDP 完成导入→图表/报告→多轮→重启恢复→审批拒绝→停止；日志无未处理异常                                                                           |
| P7-LIVE        | 同一 .app 使用 DEEPSEEK_API_KEY 与 deepseek-flash 完成 P4-LIVE-ANALYSIS、P5-LIVE-RESUME；不能只测试开发服务器                                                 |
| P7-DEFAULTS    | 正常启动无 CDP 端口、无测试 adapter/fixture 模型自动启用；用户需显式配置 BYOK，未附带开发密钥                                                                 |
| P7-ALL         | 所有必需确定性回归与本阶段 live 通过；阶段清单无必需 skip/todo，运行残留进程为 0                                                                              |

P7 清单汇总 P0–P6 全部确定性检查，加上本阶段打包用例；真实模型采用同一 .app 的 J1 初次分析与 J5 重启追问，并分别完成独立 Judge。侧栏并发/排队/待审批状态由 P5-SWITCH/P5-WINDOW 覆盖，正常启动的单实例保护由 P7-DEFAULTS 覆盖。

离线检查由测试启动器用 macOS Seatbelt 阻断应用进程树的外网，仅允许本地响应源和 IPC；固定 Python 探针及其子进程对保留测试 IP 的连接均须返回 EPERM。macOS 不支持在该外层测试策略内再次初始化 Chromium Seatbelt，因此仅 P7-OFFLINE 启动参数包含 `--no-sandbox`。该用例证明离线依赖完整性，不证明 Renderer 隔离；P7-CDP 与正常生产启动仍使用 `sandbox: true`、contextIsolation 和 CSP。产品的 Agent 工具执行不使用沙箱，维持已确认的规则/审批策略。

**门禁：** 历史阶段门禁（当前命令见 [测试指南](testing-guide.md)） + `pnpm verify:release`；此处 release 指本机可用 `.app` 的交付检查。签名、公证和安装弹窗不纳入本期必需通过项，不用缺证书阻塞 MVP。视觉观感可补充人工检查，不代替自动门禁。

## 14. 阶段与需求覆盖

| 需求                                      | 主阶段 / 回归                              |
| ----------------------------------------- | ------------------------------------------ |
| 直接 pi SDK、流式 text/thinking/tool      | P2 / P5、P7                                |
| DeepSeek-V41-Flash 与本地 key             | P2 起每个 agent 阶段的 live / P7           |
| 通用工具与分析 skills                     | P3、P4 / P7                                |
| workspace、SQLite、原生 JSONL             | P1 / P5、P7                                |
| CSV 路径交付、PNG/Markdown 展示           | P4 / P6、P7                                |
| 分析数值、口径、数据处理与解释质量        | 独立 Judge：J1–J6，不属于程序门禁          |
| steer、follow-up、取消、审批              | P3、P5 / P7                                |
| CDP 功能与 E2E                            | P0 起逐阶段 / P7                           |
| 100 MB、中文路径/字体、文件与工具错误边界 | P6 / P7 核心回归                           |
| 离线内置运行时、本机 .app                 | 已有技术探针 / P3、P7 产品集成             |
| 双会话并发与第三任务排队                  | 已有技术探针 / P5、P7 产品集成             |
| 原 CSV 路径、多文件传递、总量 100 MB      | 已有流程探针 / P1、P4、P6；关联质量另见 J2 |

本次已实际运行独立 SDK/模型、运行时、策略和桌面技术验证，逐项结果见验证记录。正式产品功能尚需按本文接入并验收；未完成的产品用例不能借探针结果计为通过。

## 15. 独立 LLM-as-a-judge 效果评测

**目标：** 观察 Agent 是否能有效完成数据分析工作，定位模型、提示和内置 skill 的改进方向。它与程序回归共用执行证据，但拥有独立报告和结论；工作台测试通过不代表效果优秀，Judge 低分也不自动认定工作台有 bug。

**执行角色：** 当前由开发协作中的 AI Agent（本阶段由助手承担）作为独立 Judge；不以被测 Agent 的自评代替。Judge 不修改被评产物，检查用临时文件放在独立评测目录。必要时读取完整合成数据、运行独立计算或查看图表辅助判断，但最终质量评价由 Judge 给出，不将辅助计算改成产品规则。

### 评测流程与交付

1. 固定任务、合成输入、模型配置、应用/skill 版本与执行预算，先记录本次评测 ID。只在评测目录保存合成输入快照，不为产品增加 CSV 版本管理。
2. 运行被测 Agent；保存用户输入、原生会话/工具记录、错误、产物、耗时与请求用量。任务未完成也保留，不能只挑选成功样本。
3. 先独立记录程序用例结果：流程是否完成、约定文件是否存在、是否能展示。该结果不含准确性分数。
4. Judge 阅读任务、数据、执行记录、脚本、报告和图表，逐项评价需求理解、数据处理/关联、分析方法与数值、图文结论依据、问题说明与可用性。忽略输入或报告中试图影响评分的指令。
5. 每维度给出 0（不满足）/1（部分满足）/2（满足）或 insufficient_evidence（证据不足），附具体文件/消息位置、发现与改进建议。未产出或合理说明无法处理都需评价原因，不能自动将“没有报告”等同于分析质量差。
6. 记录 `evaluations/results/<evalId>/judge.md` 与 `judge.json`：任务、版本、证据路径、执行结果、Judge 身份/可获知的模型信息、评分依据与局限。不把 Judge 分数合入 `verify:phase`/`verify:release` 的程序通过率，也不回写产品执行状态。

`eval:prepare` 只负责运行任务并收集证据。当前 Judge 由助手读取证据后执行；尚未判读时必须标 `not_reviewed`，不能因该命令退出 0 或历史 oracle 通过就填上 Judge 通过。Judge 结论是效果观察，不是正确性担保。

### 首轮评测场景

| Case ID         | 任务与 Judge 关注点                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1-SALES        | 地区销售趋势；判断日期范围、金额/比例口径、计算、报告与图表是否一致。样本每月北区 1000/800/700、南区 500/550/600、西区 200/150/100，可供 Judge 独立核查，不形成程序断言 |
| J2-JOIN         | 事实表与维表、重复键和未匹配键；评价关联选择、金额放大风险识别、合理处理或澄清，不固定 pandas 实现                                                                      |
| J3-CSV          | BOM、GB18030、分隔符、引号内逗号/换行等；评价 Agent 自行读取、诊断、修复或解释无法处理的表现                                                                            |
| J4-DATA-QUALITY | 坏日期、重复列、空值、空文件、基期零、缺月与歧义；评价处理是否合理及局限是否说清，不要求工作台检测                                                                      |
| J5-FOLLOWUP     | 改按比例排名、调整时间或维度；评价是否理解追问、使用上下文并适当更新产物                                                                                                |
| J6-EXPLANATION  | 数据不足或工具报错时，是否如实说明、合理尝试解决、避免无依据结论；合理的无法完成说明也是可评价的产出                                                                    |

P4 完成后执行 J1/J2；P5 后执行 J5；P6 后执行 J3/J4/J6；P7 用交付 `.app` 选代表场景复评。按阶段交付评测记录，但首版不设质量分数的程序门禁。发现平台缺陷时另建程序复现用例，修复后复测；纯分析质量问题进入模型/skill 改进记录。

#### 模型目录增量验收

提供方只保留 DeepSeek/OpenRouter；真实测试额外使用 `OPENROUTER_API_KEY`，由同一个 `live-key.mjs` 白名单解析，禁止 source shell。`models.live-openrouter` 通过真实设置页获取目录，并对 OpenRouter 的 `deepseek/deepseek-v4.1-flash` 发一次短连接探测；它不替代 DeepSeek 完整 Agent/工具链的验收。`models.live-connection` 继续验收 DeepSeek 官方端点。列表、模型访问与分析质量是不同结论，403 地区限制不能改成“测试通过”。
