# 文档索引

这里保留描述当前代码、产品边界和持续工作流程的文档。功能事实以实际实现为准；调整产品行为时同步相关文档，验收结果另行记录。

| 文档                                       | 内容                                         | 主要核对入口                                                             |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------ |
| [产品说明](product.md)                     | 当前能力、交互与范围                         | `src/shared/`、`src/main/services/`、`src/renderer/features/`            |
| [本机使用](usage.md)                       | 设置、分析、会话、文件和报告操作             | `src/renderer/`、`src/main/ipc/commands.ts`                              |
| [技术设计](technical-design.md)            | 进程、上下文、工具、模型、工作区及 HTML 隔离 | `src/main/`、`src/agent/`、`src/node/`                                   |
| [SQLite 设计](sqlite-design.md)            | 当前表、迁移、身份和状态机                   | `src/main/storage/`、`src/main/services/runtime/`                        |
| [设计原则](design-principles.md)           | 后续 UI 开发与评审约束                       | `components.json`、`src/renderer/components/ui/`、`src/renderer/styles/` |
| [测试指南](testing-guide.md)               | 按功能测试、模型模式、隔离产物与发布验收     | `package.json`、`tests/catalog.json`、`scripts/test/`                    |
| [代码质量](code-quality.md)                | 格式、Lint、依赖边界和提交门禁               | `eslint.config.mjs`、`.husky/pre-commit`、`scripts/test/check.mjs`       |
| [版本管理](repository-workflow.md)         | 应入库内容、归档和提交规则                   | `.gitignore`、`.husky/`                                                  |
| [AI 开发指南](../AGENTS.md)                | 仓库开发入口与强制边界                       | 上述正式文档及代码                                                       |
| [Agent 效果评测](../evaluations/README.md) | 合成任务、审批审核与独立 Judge               | `scripts/eval/`、`evaluations/fixtures/`、`evaluations/rubrics/`         |
| [技术探针](../validation/README.md)        | 独立可复用探针及重跑方式                     | `validation/` 中允许入库的源代码                                         |

开发、重构、UX、交互报告和日志候选计划、技术验证报告、临时研究归入 `docs/archived/`，仅留本地且不纳入 Git、格式化或正式文档链接检查。归档前已提交的版本可从 Git 历史恢复；新检出仓库不依赖这些文件。`test-results/` 和 `evaluations/results/` 继续保存各自工具生成的证据，不为整理文档搬动运行产物。

产品说明由原 `mvp-plan.md` 更名而来，保留当前范围与行为；过程计划不再作为实现或验收入口。正式文档不记录某次回归通过数字、临时目录或阶段流水，长期约束应直接归入对应文档。
