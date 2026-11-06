# 版本管理与阶段提交规则

## 应纳入 Git

- 根 README、产品说明、技术设计、开发/验收计划，以及长期维护的架构决策与工作流程。
- 正式产品源码、内置 skills、测试源代码、小型合成 fixtures、构建/测试配置和依赖 lockfile；当前产品源码尚未创建。
- `validation/` 中明确保留的可复用源代码：pi 会话/事件/恢复探针，Electron/CDP/打包/进程生命周期 harness，策略机制探针，以及固定运行时和工具下载、哈希验证脚本。
- 可复用脚本所需的小型静态资源，例如 `resource-probe.txt`。下载资源的地址、版本、hash 与许可获取方式随脚本维护，不提交可重新下载的大型二进制。

## 仅留本地，由 .gitignore 排除

| 内容 | 路径/示例 | 原因 |
| --- | --- | --- |
| 临时源码调研与当次结论 | `docs/research/`、`docs/validation-report.md` | 包含本机 checkout 路径、日期与一次性证据；长期结论已归入技术设计 |
| 临时旧业务实验 | `validation/pi/verify-analysis.mjs`、`collect-results.mjs`；runtime 的 run/probe/offline、销售 schemas/fixtures | 原先混合业务 oracle 与流程的实验，不作为工作台回归合同 |
| 验证结果与本机状态 | results/runs/artifacts、results.json、截图、数据库、JSONL、Judge 报告、构建日志 | 每次执行生成，可能含本机路径或用户数据 |
| 下载、依赖与构建产物 | node_modules、Python、fonts、rg/fd、缓存、relocated、dist/.app、markdown-bundle.js | 可按锁定配置重建，体积较大 |
| 本地凭证与环境 | `.env*`（模板除外）、`.data_agent/`、`.local/` | 不属于项目源码；真实 key 不得提交 |
| 其他一次性材料 | `validation/local-notes/`、临时脚本/历史 README、release API 响应 | 仅用于本机回溯 |

`validation/` 使用源码允许清单，避免临时生成物被意外加入。新增长期维护脚本时应同时更新允许清单及 README；正式产品 `src/`、`tests/`、`scripts/` 不受该清单限制。不要使用 `git add -f` 绕过排除规则。文件留本地，不因初始化 Git 而删除。

## 每阶段完成后提交

P0–P7 的每个阶段必须在规定程序验收通过、对应 Judge 记录按计划完成后创建一次明确的阶段完成 commit。Judge 分数不属于程序门禁，结果与证据仍只留本地。允许在阶段内提交较小的实现 commit，但它们不能代替完成提交。

1. 完成该阶段实现、必要测试和文档同步，按阶段清单运行验收。
2. 检查 `git status --short`、`git diff`、暂存区 diff；仅暂存该阶段应交付的源码/测试/配置/文档，检查凭证与生成物未入库。
3. 提交前运行 `git diff --cached --check`。失败、blocked 或未运行的必需检查不能描述成阶段完成；可如实提交 WIP，但不推进阶段完成状态。
4. 创建描述实际完成内容的 commit，例如 `feat(P2): integrate pi sessions and streaming UI`。提交说明记录阶段、已运行命令与结果，Judge 是否完成；不附密钥、本机原始日志或大型报告。
5. 用 `git log -1` 和 `git status --short` 核对结果，向用户报告 commit ID、阶段及验证结论；不把其他未完成修改混入提交。

提交到本地仓库即可。配置 remote、push 或公开发布不属于阶段完成的默认要求。初始规划提交不代表 P0 已完成；正式功能完成后仍须按上述规则逐阶段提交。
