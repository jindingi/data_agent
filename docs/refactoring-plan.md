# 软件工程审查与重构计划

更新：2026-11-07。依据前端与主进程/Agent/测试两个 subagent 的源码审查，并结合主 agent 核对。**R0–R6 已完成；最终完整 P7 为 68/68 通过。** 竞态与性能影响除另有说明外是源码推导的风险，不是已经复现的事故。

本计划与 [UX 修复计划](ux-remediation-plan.md) 协调执行，不重新设计产品范围。现有 Electron Main / preload / Renderer / pi utilityProcess 分层合理，保留 SQLite 单写、pi 原生 JSONL、通用工具、安全策略和两会话准入。不要引入 ACP、新状态框架或通用 Repository 基类解决当前具体问题。

## 1. 实施前审查结论与证据

引用路径和符号而非行数，避免本轮格式化导致定位失效。详细一次性审查笔记在本机忽略目录，下面保留可随仓库维护的结论。

| 优先级 | 源码事实与影响                                                                                                                                                                                                                         | 计划                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 高     | `src/renderer/app/App.tsx` 同时承担草稿/提交、会话导航、模型配置、快捷键、窗口布局、拖放和大量 JSX。`send()` 接收后清草稿，没有校验提交期间的草稿 revision；存在清掉后来输入的风险。单纯移到一个 useAppController 不会减少复杂度       | R3，与 UX2 合并状态改造 |
| 高     | `src/shared/contracts/ipc.ts` 的 request 返回 Result<unknown>；Renderer `lib/desktop.ts` 的 request<T> 由调用者指定类型，且普通 Error 丢失结构化 code。请求 Zod 校验存在，但命令与返回值缺乏类型关联；Host 控制请求也存在 unknown 断言 | R2                      |
| 高     | `src/main/services/runtime.ts` 的 RuntimeService 混合 FIFO 准入、输入 SQL、恢复、Host/工具生命周期、产物版本和退出/删除协调，多个 optional 字段及 Promise 隐含状态关系；维护复杂性已确认                                               | R4                      |
| 高     | `scripts/test/verify.mjs` 按 case 前缀选择打包，共享 out/release；harness 隔离数据但未普遍隔离构建。测试驱动同时负责编排、构建、native 启动、报告及清理，增加误覆盖在用包的风险                                                        | R1，先于广泛重构测试    |
| 中     | ArtifactPanel.refresh 的 generation 隔离会话切换，但同会话重叠请求可乱序覆盖；App.modelBusy 与 ModelSettings.busy 各自管理同一个配置操作，迟到响应和跨入口并发缺少统一所有者                                                           | R3，与 UX3/UX4 合并     |
| 中     | RuntimeService.update 每份流式 snapshot 更新 runs 并遍历 inputs 写数据库；SessionRuntime.schedule 定时发布、EventAdapter.snapshot 克隆全历史。展示刷新与持久化耦合已确认，实际耗时/卡顿尚需基准                                        | R4                      |
| 中     | SessionRuntime.create 集中 SDK 装配、身份 hooks、上下文、预算、产物切换、usage/evidence 与事件处理。SDK 集中管理合理，但运行策略与装配纠缠                                                                                             | R5                      |
| 中     | ToolService.closed、ProcessRunner.logBytes 无 run 完成后的明确释放；RuntimeService 缓存终态完整历史到删除/退出。无回收策略是事实，尚未证明实际内存事故                                                                                 | R4/R5                   |
| 中     | ArtifactService 聚合版本 SQL、扫描/hash、PNG/读取校验与导出；verifiedBytes 可整文件读入，较大文件导致峰值分配风险。ToolService.perform 汇集各工具实现与共同策略                                                                        | R5                      |
| 中     | Dialog 硬编码关闭设置、Markdown 链接/媒体规则分散、globals.css 追加覆盖；App 根级状态使刷新影响范围较大。语义重复已确认，性能优化要测量后决定                                                                                          | R3 与 UX1/UX4           |
| 中     | e2e/p3.mjs 向其他阶段导出 rpc 等公共驱动；case 注册分散。check.mjs 只正规化相对导入，不解析 tsconfig alias，存在门禁覆盖缺口，未发现因此发生的实际越层导入                                                                             | R1/R2                   |

## 2. 拆分原则

模块围绕一起变化的行为组织，通过小而明确的接口隐藏内部流程。接口除了类型，还包括时序、错误、取消及清理责任。

- 不按 200/300 行机械切文件；不把状态、几十个 setter 和操作全部透传给“展示组件”，也不把巨大 App 搬成巨大 hook。
- 每类状态有唯一所有者：草稿与提交身份、模型配置、产物阅读、运行准入各自明确。事件监听/请求的取消与迟到响应处理由创建它的模块负责。
- 纯转换与 I/O 分离；现有服务作外部入口，逐步提取有行为的内部模块。只有当前真实变化点需要 adapter，不设计未来 provider 插件层。
- 用命名 dependencies 对象替代长位置参数；必需依赖不可用 optional + 非空断言伪装。
- 行为保持的提取与产品行为调整分别记录。兼容既有 SQLite migration、JSONL、inputId/epoch/seq 和错误语义，不顺手重写协议。
- 测试通过模块接口观察行为；避免主要靠访问 private 状态。先用确定性交错/故障注入捕获风险，再提取实现。

## 3. 结构选择

下面保留最初目标结构；实际模块见 [技术设计](technical-design.md)。实现未创建无独立行为的 WorkbenchLayout/ConversationView，也未为拆文件增加 controller。预览状态由 ArtifactPanel 单一持有，日志与回答共用的安全链接原语保持场景权限；运行账本最终命名 run-ledger.ts，完整性 I/O 为 artifacts-io.ts。

```text
src/renderer/
  app/App.tsx                         # 窗口布局组合与顶层入口
  app/WorkbenchLayout.tsx
  app/use-desktop-shortcuts.ts
  features/sessions/SessionSidebar.tsx # 导航、列表与会话操作
  features/conversation/ConversationView.tsx
  features/composer/Composer.tsx
  features/composer/use-composer.ts    # 草稿revision、提交快照、恢复
  features/models/use-model-settings.ts
  features/artifacts/use-artifact-browser.ts
  components/markdown/                # 共同渲染策略；保留会话/产物权限差异
  components/ui/                      # Dialog、Tooltip、图标按钮等交互原语
src/shared/contracts/
  ipc.ts                              # 公开协议入口及命令→响应映射
src/main/services/
  runtime.ts                          # 保持公开用例入口
  runtime/admission.ts                # FIFO和许可所有权
  runtime/run-repository.ts           # run及输入账本/恢复所需查询
  runtime/lifecycle.ts                # Host/工具/产物终态收束
  artifacts/                          # 元数据、完整性读取/导出等内部职责
src/agent/
  session-runtime.ts                  # 唯一pi session生命周期
  runtime-context.ts / request-budget.ts / request-evidence.ts
tests/support/                        # CDP驱动、fixture、故障注入
scripts/test/
  run-context.mjs / case-registry.mjs  # 隔离路径及显式能力需求
```

命名可在实施时依据现有接口微调，不能为完成目录图创建空包装层。样式按组件职责归并，先消除互相覆盖的旧规则，不要求全面切 CSS Modules 或更换 Tailwind。

## 4. 阶段与自动验收

R0 为本轮工程门禁；R1 → R2 后，R3 和 R4 可在互不修改同一接口时独立推进；R5 依赖 R4 的生命周期契约；R6 汇总。下列 R-* 名称是原计划的验收目标，不全是独立 runner ID；已注册 R-WRITES、R-EXPORT、R-RESOURCE-RELEASE，其余目标映射至 unit 与 P0–P7/UX 用例，正式清单以 case-registry 和 tests/phases/P7.json 为准。

### R0 — 格式基线和提交门禁（本轮）

目标：代码可读、规则可执行，后续提交不能继续累积未格式化代码。

- 接入 Prettier、ESLint、Husky、lint-staged、编辑器配置与全量 quality 命令；格式化正式工程，修正本轮 lint 报告。
- 不做职责拆分；少量语义明确的 lint 修正单独说明。保留有理由的局部例外，不靠整体关闭规则。
- 成功标准：全量 quality、现有单元测试、真实钩子正反例通过；真实 pnpm dev/CDP 定向回归通过。Git 暂存文件自动格式化、不可修复 lint 阻断、部分暂存不丢修改。
- 提交格式基线与工具，后续重构另行提交；详细规则见 [代码质量规范](code-quality.md)。

### R1 — 测试运行上下文与回归基线

目标：后续验证不会覆盖用户运行中的 out/release，测试能力需求可追踪。

- 引入 TestRunContext，统一 source/build 身份、buildDir、bundlePath、业务目录、userData、端口；构建、启动、资源验证使用同一上下文。
- case registry 显式声明 dev/built/packaged/live/native 需求，phase 只组合 ID；保留原正式用例身份与结果记录。
- 把 e2e/p3 中的通用驱动迁移到 tests/support；不让阶段用例文件成为其他阶段的工具库。
- `R-ISOLATION`：两个独立测试根互不覆写；共享目录哨兵 hash 不变；只终止本次测试创建的进程。
- `R-REGISTRY`：重复/未知/未实现 ID、缺必需能力均明确失败；旧 phase 的必需用例无丢失。
- 回归真实 P0-DEV；运行最小 built/packaged smoke 证明路径贯通，不用旧包代替当前代码。与 UX0 共用交付和证据，不重复造 harness。
- 完成提交：`refactor(r1): isolate test runs and centralize case metadata`。

### R2 — 类型契约、错误与依赖入口

目标：调用者无需猜返回类型，进程和领域模块依赖明确。

- 建立 command → response 映射，Renderer/Host request 从命令推断结果；保留 error.code 与安全 details，不允许任意 request<T> 强行转换。
- Main 保留统一 sender/frame/URL/schema 审查，再分派领域处理；命名依赖对象明确必需服务。
- 改进现有依赖检查，对 alias、动态 import 和再导出有正反例；将根 AGENTS.md 纳入正式文档链接检查。
- `R-CONTRACTS`：错误请求/错误响应类型编译失败，合法命令推导精确类型；序列化错误保留 code、不泄露凭证。
- `R-IMPORTS`：合法依赖通过，跨层相对/alias/动态导入/再导出被拒绝。
- 运行 IPC 来源拒绝、实际 preload 桥与会话往返用例；类型检查不能替代 E2E。
- 完成提交：`refactor(r2): type IPC responses and clarify service dependencies`。

### R3 — Renderer 职责与状态所有权

目标：App 负责组合；一次操作的状态、取消、恢复逻辑集中可测。

- 先保持行为提取布局、导航、composer、模型配置和产物阅读模块；不要在纯提取提交里改变新会话语义。
- 按 UX2 实现草稿 revision/快照/稳定 inputId；按 UX3 实现产物请求 ticket、选择/阅读位置稳定；按 UX4 统一模型配置入口及控件契约。
- `R-DRAFT-RACE`：提交等待时新增文本/附件、切换会话、响应失败/重试，均不清错草稿；重复 inputId 不二次执行。
- `R-STALE-RESPONSE`：人为倒序返回同会话产物请求及跨会话请求，只接受有效请求；卸载后无副作用。
- `R-MODEL-OWNER`：两个设置入口使用同一 busy/提交状态，失败恢复、迟到响应不覆盖新配置；发送所用模型与当时选择一致。
- 按 UX2 迁移原先“新会话立即持久化”的测试，保留存储用例，不为维持旧断言保留错误体验。
- 公共 Markdown 组件显式接收展示场景；不能统一成最宽松的文件/链接权限。两主题 CDP 与长内容验收沿用 UX1–UX4。
- 完成时分别提交保持行为的模块提取和 UX 行为调整；不重复宣称两套计划已全部完成。

### R4 — 运行生命周期、账本与快照

目标：准入、持久化、运行状态转换与终态清理有清晰所有者。

- 优先提取 SQL 输入账本和纯状态转换；随后提取 FIFO admission 与生命周期协调，RuntimeService 保持公开入口。
- 明确 Host 结束、工具退出、审批取消、产物发布、许可释放、删除/退出收束的顺序及失败路径。
- 区分 UI 快照发布与耐久状态更新；内容 delta 不重复写未变化的 run/input 元数据。先保留快照协议，不直接开发新增量总线。
- `R-LIFECYCLE`：双会话并发、第三个排队、停止 A 不影响 B、启动失败释放许可、删除等待写者结束；迟到 epoch/seq 无副作用。
- `R-IDENTITY`：重复 inputId 不重复执行，相同文本不同 inputId 均保留；恢复未知输入不自动重发；保留旧 JSONL 兼容。
- `R-WRITES`：使用计数 adapter 证明纯文本 delta 不引起账本写入，真正状态/ACK 变化被持久化；记录长会话快照字节和耗时作为比较基线。
- 复用既有 P2 输入/快照、P5 steer/follow-up/停止/崩溃回归，增加关键 await 前后的确定性故障注入；不以偶尔跑通代替竞态验证。
- 完成提交：`refactor(r4): separate run accounting admission and lifecycle`。

### R5 — Host 策略、工具与产物资源

目标：保留统一安全执行外壳，内部职责独立可测，run 完成能释放资源。

- 从 SessionRuntime 提取上下文生成、预算和证据记录；只有 SessionRuntime 拥有 pi session，不形成第二套 prompt/steer 调度。
- 按通用操作提取工具实现，共享 policy/approval/cancel 入口；按实际需要拆 artifact 元数据与完整性读取/导出。
- 定义 releaseRun：执行及迟到消息处理结束后释放计数/标记；终态历史缓存有界或按需重建，数据库/JSONL 不因此删除。
- 大文件导出采用有界读取/校验及临时目标提交；路径替换/完整性失败不能留下貌似成功的最终文件。
- `R-BUDGET`：请求上限、审批暂停计时、取消不执行、脚本变更重新检查继续满足既有用例。
- `R-RESOURCE-RELEASE`：重复完成/停止多个 run 后可观测 registry/map 回到基线；旧任务迟到消息被拒绝，不用随机 GC/RSS 波动代替所有权检查。
- `R-EXPORT`：大文件导出 hash 一致、不覆盖、失败清理、路径安全；产物登记/多版本/日志/删除回归通过，不验证报告业务结论。
- 完成提交：`refactor(r5): isolate host policies and bound run resources`。

### R6 — 全链路验收与文档收束

- 在 R1 隔离上下文中验证真实 dev、built 和 packaged；执行原 P7 必需门禁及资源校验，不跳过必要 live 用例。
- 使用既有 DEEPSEEK_API_KEY / DeepSeek 模型与请求预算；保持模型错误与工作台错误分类，不无限重试掩盖失败。
- 同步技术设计的实际目录、模块职责、接口和恢复契约，更新本计划与 UX 计划完成映射；旧数据样本只用合成 fixture 验证，不动用户数据。
- 成功标准：必需程序验收通过、与本次实施相关的 UX 视觉检查已复核、无跨进程越权/数据兼容回归。LLM-as-a-judge 继续独立，不以重构或 lint 通过宣称分析更准确。
- 完成提交：`test(r6): verify refactored desktop workflows`。

## 5. 与 UX 计划的关系及状态

| 工程阶段 | 当前状态                                               | 与 UX 的关系                                      |
| -------- | ------------------------------------------------------ | ------------------------------------------------- |
| R0       | 已完成；quality、unit、真实 hook 正反例、P0-DEV 均通过 | 所有后续提交的基础门禁，不等于任何 UX 问题已修复  |
| R1       | 已完成                                                 | 与 UX0 合并安全验证基础设施                       |
| R2       | 已完成                                                 | 为跨进程草稿/提交改造提供类型契约                 |
| R3       | 已完成；完整回归通过                                   | 提取后承载 UX1–UX4；具体行为以 UX 计划为准        |
| R4       | 已完成；完整回归通过                                   | 影响 UX2 输入身份、并发与恢复，不改变产品范围     |
| R5       | 已完成；完整回归通过                                   | 保证工具/产物生命周期，独立于视觉改造             |
| R6       | 已完成；68/68 通过                                     | 可与 UX5 共享同一轮完整回归证据，覆盖范围必须注明 |

每阶段通过必要验收后创建本地 commit，不自动 push。遇到与现有行为不一致的需求，应在对应 UX 行为提交中处理；纯模块提取阶段不得静默改变用户流程。

### R1 验证记录（2026-11-07）

已实现独立 app/build/bundle 上下文、生产依赖树、公共 CDP 驱动、用例重复检测与显式打包需求。`P0-PACKAGE` 在隔离目录实际启动通过；构建目录复用须指定 `--run-root` 且源码指纹匹配，否则拒绝 `--no-build`。测试失败记录保留，锁文件字节哈希与开发依赖打包冲突均已修复。

### R2 验证记录（2026-11-07）

命令响应由 CommandResponses 推导，Main 的 success 构造检查响应类型，Renderer 保留 AppError.code；Host RPC 校验预期响应类别。IPC 安全入口、命令分派与命名依赖已分离。类型负例、相对/alias/动态导入/再导出边界测试、真实 P0-IPC 和 P1-METADATA 通过。

### R3 实施进展（2026-11-07）

App 已拆出 SessionSidebar、SessionHeader、Composer/useComposer、RunControls/useActivity、SettingsDialog/useModelSettings、Report/ZoomImage/usePanelSize。草稿、模型写入与预览请求各自有状态所有者；布局组合留在 App，不迁移为全能 controller。草稿 revision/token 单元正反例及 UX-DRAFTS、UX-READING、P6-DRAFTS、P6-SETTINGS 通过。新增模型搜索/提供方分组、弹窗错误、焦点返回、图片放大与输入框自增高。旧测试已迁移调用方式，完整旧门禁已在 R6 通过。

### R4 实施记录（2026-11-07）

运行账本 RunLedger、FIFO/许可 RunAdmission、终态写者收束 RunLifecycle 已提取，RuntimeService 改用命名依赖。元数据仅在运行状态/输入 ACK 变化时写入，JSONL 继续由 pi 写；R-WRITES 证明连续文本 snapshot 不增加 SQL 写入，ACK/终态仍耐久。停止等待 Host、工具及版本发布后释放许可；终态缓存最多保留 8 个 task 和 8 个恢复 snapshot，历史仍可按需从 JSONL 读取。工具计数在写者结束后显式释放（与 R5 共用）。R-WRITES、P2-PREFLIGHT、P5-SWITCH、unit 和 quality 通过，完整 P5/删除/崩溃门禁已在 R6 通过。

### R5 实施记录（2026-11-07）

SessionRuntime 保留唯一 pi 生命周期，system/current context、请求证据和请求/活跃时间预算已分别提取。ToolService 继续拥有 policy→审批→重新检查→取消的统一外壳，ToolOperations 只执行已检查的通用操作。releaseRun 显式释放工具 closed/tails 与进程日志计数。

导出使用同一已验证文件描述符、64 KiB chunk 和 SHA256 校验，先在独占目标目录的隐藏 staging 中写入/同步，全部校验后提交；失败清理本次 staging/新导出，已有同名导出拒绝覆盖。预览仍按已有 Markdown/PNG 上限有界读取。R-EXPORT（20 MiB）、R-RESOURCE-RELEASE（5 轮）、P2-REQUEST-LIMIT、P3-CANCEL、unit 和 quality 通过。完整安全策略/产物门禁已在 R6 通过。

### R6 最终验收（2026-11-07）

完整命令 `DATA_AGENT_EVAL_REVIEW=1 pnpm verify:phase -- P7`：68/68 通过，测试进程残留为 0。证据在 `test-results/2026-11-07T02-18-35.380Z/summary.json`；该目录包含独立构建、实际 .app、资源 hash 清单、CDP 截图与真实模型执行证据。测试源码指纹 `d7e9973dc7bfbe50b0287afcc21eb81e0b394f3e855f0f1017cd35171aeb9c50`；随后只补充验收文档，不改产品代码。quality、9 个 unit、3 个 tooling 检查通过，最终提交继续经过真实 Husky 门禁。

收尾修复包括菜单→对话框残留的指针拦截、重命名错误就地呈现、危险删除样式、删除后的本地草稿清理、文件选择迟到响应与合计大小、导出位置受控打开；迁移 9 将旧 receipt 正文变为摘要，输入内容仍以 pi JSONL 为永久事实源。Runtime 的工具/产物依赖改为必需，准入测试使用真实服务并等待实际异步状态。

全部自动窗口默认隐藏，不激活、不抢焦点，后台 CDP 操作/截图仍可用；普通启动不受影响。旧自动打开面板、旧构建路径及旧图片 DOM 结构的测试假设已迁移为显式打开/选择版本和语义定位。失败及中止记录保留，没有用 skip 或降低有效生命周期断言换取通过。

实际重构提交：R1 `9f30b74`、R2 `2765ea8`、UX1 `69e475b`、UX2 `afa447e`、R3 `0334daf`、R4 `debe1e8`、R5 `de2ecaf`；本节与最后修复由 R6 提交收束。原结构图中的纯布局包装未机械创建，实际所有权与文件位置见技术设计。业务分析准确性没有被当作程序门禁，本轮未修改分析 skill，也未新增 Judge 质量分数。
