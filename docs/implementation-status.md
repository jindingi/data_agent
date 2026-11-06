# 实施进度

此表记录已验收能力；阶段要求以 [开发计划](development-plan.md) 为准，不能用本表缩小范围。每阶段通过后创建完成提交。原始日志、截图和机器结果只留本地 `test-results/`。

| 阶段 | 当前状态 | 实现与验证 |
| --- | --- | --- |
| P0 | 已通过 | 正式四入口构建、React/shadcn/Tailwind 界面、窄 IPC、utilityProcess ping/退出、SQLite、CDP 隔离和本机 .app。`pnpm verify:phase -- P0` 的 5 项必需用例通过，内含 2 项单元测试；实际开发态和打包态均运行 |
| P1 | 已通过 | SQLite 会话/原路径引用、新建/重命名/搜索/归档/恢复、自选新会话父目录、pi 原生 JSONL 只读预检与读取、可信 ResourceLoader、创建/历史落盘对账。`pnpm verify:phase -- P1` 的 10 项检查通过，包含 P0 前置回归和 7 项 P1 必需检查 |
| P2 | 已通过 | 独立 Host 的真实 pi SessionRuntime、白名单快照/seq/epoch、原生输入身份与落盘恢复、模型选择/BYOK、受控 read、thinking/text/tool/Markdown 展示、基本并发准入与停止。`pnpm verify:phase -- P2` 的 15 项必需检查通过，含 4 个真实 DeepSeek/CDP 检查与前置回归 |
| P3 | 待实施 | 通用工具、内置运行时、审批与停止 |
| P4 | 待实施 | 文件输入、图表/报告交付与展示 |
| P5 | 待实施 | 多轮、插话、并发、后台与崩溃恢复 |
| P6 | 待实施 | 边界、模型设置与交互质量 |
| P7 | 待实施 | 完整本机应用交付与最终验收 |

P0 验证使用 macOS 15.7.4 / Apple M4 / arm64，Electron 45.2.3 / ABI 150。第一轮设置按钮因快捷键混入可访问名称导致定位失败，修正明确标签后全量门禁通过；失败记录保留。P0 验收时未进行真实模型调用或 Judge 评测；后续模型验证见 P2。完整分析功能尚未完成。

P1 验证使用实际 SQLite 与 pi 1.5.0 的 SessionManager，原生模块测试在 Electron 自带 Node 下运行，避免 ABI 混用。首轮两个 UI 用例因“新会话”和“选择新会话工作区”的模糊定位失败，修复明确标签并等待选中状态后全量通过。CSV 引用用无法作为正常 CSV 解析的合成字节验证工作台不做内容解析；原文件移除后显示缺失，不复制或重建。

P1 收尾增加了真实 createAgentSession + faux provider 的继续会话测试，验证应用固定提示有效、工作区 AGENTS.md 与扩展不自动加载。类型检查覆盖集成测试后发现并修正 cacheWarming 参数形状；恢复断言按原始消息身份和内容判断，允许 SDK 自身附加记录。最终全量 P1 门禁通过；新增 SDK 依赖后的实际 .app 启动/SQLite/Host IPC 回归也通过。

P2 通过真实 Electron 窗口保存 BYOK、选择多份原文件、提问、展开 read 卡片、流式中刷新窗口、第二轮提问及退出后恢复。真实请求使用 deepseek/deepseek-flash、high thinking，证据记录请求/响应模型、用量、工具结果摘要 hash、reasoning_content 是否存在与非空；不记录 Authorization 或 key。四个 live 检查共享同一真实多轮场景，不靠重复采样模型答案达标。程序断言仅验证链路、正文呈现和状态，不评价分析结论。

P2 首轮完整门禁的凭证哨兵发现 EventAdapter 将完整配置对象展开进 Host 快照：Main 的 schema 过滤已阻止额外字段进入 Renderer，但 Host 不应发送这些字段。修正为显式身份白名单、严格快照 schema，并在流式投影和原生 message_end 持久化前脱敏。失败记录保留；修复后完整门禁通过。补充测试覆盖模型/凭证前置失败不占运行名额、两个活跃会话与 FIFO 排队、排队任务绑定提交时凭证、同文本 steer/follow-up 快照恢复、磁盘写入早于 ACK 的恢复不重放，以及第 21 次模型调用不进入提供方。

当前仅开放受控只读工具。P3 仍需实现工具写入/执行、Python 资源、审批和进程树回收；P4 仍需产物登记/图表/报告展示；P5–P7 仍需后台/异常/完整交付验收。当前停止只涉及已接入的模型和 read，不宣称已覆盖未来工具子进程的生命周期。尚未进行 Judge 评测，按计划从 P4 开始。
