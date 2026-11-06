# 独立 Agent 效果评测

`pnpm eval:prepare -- --case J1-SALES` 或 `J2-JOIN` 使用真实 Electron、pi SDK、DeepSeek-V41-Flash 和通用工具运行固定的合成任务。测试 key 按项目约定从 `DEEPSEEK_API_KEY` 或 `~/.zshrc` 的字面量赋值取得，不输出 key。结果保存在被忽略的 `evaluations/results/`，失败也保留。

准备命令只检查流程与文件交付，并记录 `judgeStatus: not_reviewed`。它不生成准确性评分。开发助手随后阅读任务、合成输入、原生会话、脚本、报告和图表，按 [评测量表](rubrics/data-analysis.md) 写 `judge.md` / `judge.json`。Judge 可以独立计算核对，但其结果不加入程序回归断言或工作台运行状态。

P4 的 `P4-LIVE-ANALYSIS` 共用 J1 场景，其原始证据保存在对应 `test-results/`。Judge 记录可引用该原始证据，无须重复运行模型来采样更好的答案。J2 单独执行。缺少交付或等待用户交互的尝试同样需要说明原因，不删除、不伪装成已通过。

JSON 记录至少包含评测 ID、Judge 身份、输入与运行证据位置、程序检查状态、六维评分、每项依据、局限和改进建议；分数允许 `insufficient_evidence`。评分没有预设通过线，不构成结果正确性担保。

真实模型可能生成需要安全审批的命令。默认准备命令遇到交互即保存失败证据；需要实际审核时，使用 `DATA_AGENT_EVAL_REVIEW=1 pnpm eval:prepare -- --case J2-JOIN`，阶段门禁可使用 `DATA_AGENT_EVAL_REVIEW=1 pnpm verify:phase -- P4`。审核模式最多等待 15 分钟（普通模式 5 分钟），不能当作无人值守验收。

审核者读取输出目录下的 `pending-interactions.json`，检查完整命令、脚本内容、目标路径及副作用，再在同目录写 `review-<interactionId>.json`，内容为 `{"digest":"该请求的 digest","decision":"allow_once 或 deny","reason":"具体审核依据"}`。测试驱动仅接受匹配 digest 的审批，并通过 CDP 点击真实审批按钮，保留决定与理由；不会绕过产品策略或预先批准未知代码。生产应用不读取这些文件。拒绝或超时的尝试保留，不自动重试到成功；如重新执行，应记录原因及先前证据。
