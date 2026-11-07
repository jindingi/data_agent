# 代码格式、静态检查与提交门禁

更新：2026-11-07。本文件是当前已接入的工程工具规范；后续模块拆分见 [重构计划](refactoring-plan.md)。产品与安全规则仍以 [AGENTS.md](../AGENTS.md) 和 [技术设计](technical-design.md) 为准。

## 工具选择与范围

- Prettier 负责布局与格式，ESLint flat config 负责代码问题，两者职责分开。采用 [Prettier 官方集成建议](https://prettier.io/docs/integrating-with-linters)，使用 eslint-config-prettier 消除格式规则冲突，不通过 ESLint 执行 Prettier。
- ESLint 10 + typescript-eslint recommended 检查正式 TS/TSX/JS 脚本；React 开启 rules-of-hooks 与 exhaustive-deps，均为 error。遵循 [typescript-eslint 配置](https://typescript-eslint.io/getting-started/) 和 [React Hooks 规则说明](https://react.dev/reference/eslint-plugin-react-hooks)。本项目未启用 React Compiler，因此不把 Compiler 专用诊断整体加入本轮门禁。
- Husky 安装 Git pre-commit，lint-staged 处理暂存文件，流程参考 [Husky](https://typicode.github.io/husky/get-started.html) 和 [Prettier pre-commit](https://prettier.io/docs/precommit)。具体版本由 package.json/pnpm-lock.yaml 锁定，不使用全局工具版本。
- .editorconfig 提供编辑器基本缩进/换行设置；.prettierrc.json 固定两空格、分号、单引号、尾逗号、100 列和 LF。Markdown 保留原段落换行。

覆盖正式 src、tests、scripts、evaluations/fixtures、根工程配置，以及 Prettier 支持的 CSS/HTML/JSON/YAML/Markdown。Python/shell 不假装由 ESLint 覆盖；现有运行时/策略测试继续负责其行为。忽略下载运行时、构建产物、凭证、测试结果和本机研究。validation 是独立旧探针工程，暂不混入正式工程的批量格式基线；迁移其代码进正式目录时必须通过门禁。

忽略目录需要从根锚定，例如 `/runtime/` 不能写成会误伤 `src/renderer/features/runtime/` 的任意层级 runtime。新增目录时检查实际工具覆盖，不能以零匹配作为通过。

## 每次提交实际运行什么

`pnpm install --frozen-lockfile` 的 prepare 执行 Husky 安装；本仓库 hooksPath 应为 `.husky/_`。`.husky/pre-commit` 依次执行：

1. lint-staged：对暂存源码执行 `eslint --fix --max-warnings=0`，再执行 `prettier --write`；配置/文档等执行对应格式化。修正后的内容进入本次暂存。
2. `pnpm lint`：全量正式代码检查，零 warning 容忍。
3. `pnpm check`：类型检查、进程依赖检查及文档链接检查。

任何步骤失败即中止 commit。可修复的格式会自动修正，而不是要求开发者手工补空格；语法错误或不可自动修复的 lint 问题阻止提交。lint-staged 默认暂存/恢复机制保留未暂存修改，不使用 `git add .` 自动吞入无关工作。

全量检查读取工作树；其他未暂存代码若存在 lint/类型错误也可能阻止提交，不应为通过门禁覆盖用户工作。应完成或隔离该工作，不删除检查。部分暂存的行仍由 lint-staged 处理，不承诺整个类型检查在独立 index checkout 中进行。

AI 和日常开发禁止使用 `--no-verify`、`HUSKY=0` 或改 hooksPath 绕过门禁；不得为了绿灯全局关闭规则。Git 本地 hooks 在技术上可由拥有本机权限的人绕过，因此另提供 [.github/workflows/quality.yml](../.github/workflows/quality.yml) 全量复核。工作流尚未在远端运行；仓库分支保护不是代码能够自动保证的，本轮不配置 remote 或发布。

## 日常命令

| 命令                | 行为                                                          |
| ------------------- | ------------------------------------------------------------- |
| `pnpm format`       | 格式化所有未忽略的受支持文件，会修改文件                      |
| `pnpm format:check` | 只检查格式，不修改                                            |
| `pnpm lint`         | 全量 lint，warning 也失败                                     |
| `pnpm lint:fix`     | 自动修复可修复项，剩余问题仍失败                              |
| `pnpm quality`      | format:check → lint → 类型/架构/链接检查                      |
| `pnpm test:tooling` | 独立临时 Git 仓库中验证真实提交钩子，不提交或改写当前仓库历史 |
| `pnpm prepare`      | 安装/恢复本仓库 Husky hooks；依赖需已安装                     |

`pnpm quality` 不运行构建、模型请求或 Electron，也不代替相关单元、集成、CDP 测试。CI 安装使用 `--ignore-scripts`，避免为静态检查下载 Electron 或重建 SQLite；钩子测试自行在临时仓库安装 Husky。

统一文件预览新增直接依赖 highlight.js 11.11.1，按语言显式导入 core/grammar；职责与大小限制见 [技术设计](technical-design.md)。它不替代 ESLint/Prettier，也不执行预览代码；安全展示及文件访问边界由 `UX-FILE-PREVIEW` 与 `P4-ARTIFACT` 回归。

模型选择器直接依赖固定版本 `@radix-ui/react-popover` 1.1.15 与 `cmdk` 1.1.1，复用弹层定位/焦点和可搜索列表键盘行为；不自建另一套主题或手写完整组合框。`models.connections-ui` 验证搜索空态、选择、键盘/输入法、焦点和三种尺寸的深浅主题布局。

## 例外与评审规则

- 只允许局部、附原因的规则抑制。本轮保留 async generation counter 在 effect cleanup 中递增的语义：它是失效票据，不是 React DOM ref，不能机械改成捕获旧值。
- Live 错误脱敏后不能把含 key 的原始 error 放回 cause，因此相关位置对 preserve-caught-error 有局部例外。其他错误尽量保留安全的 cause。
- 不以 warning 累积作为永久基线，不添加整目录禁用来掩盖问题。新增规则先明确要发现什么、覆盖哪些文件，以及存量问题怎么处理。
- 不设置统一文件行数门槛代替设计判断。格式化后 App.tsx 行数增加是可读性改善；其职责拆分必须按 [重构计划](refactoring-plan.md) 单独进行。
- 格式基线与业务重构分开提交。新增依赖或工具配置同步此文档与 AGENTS；生成物、密钥、临时验证结果不入 Git。

## 门禁本身的验收

`tests/tooling/pre-commit.test.mjs` 在独立目录安装真实 hooks 并尝试 git commit，验证：未格式化的合法源码自动变为标准格式；TS/JS 未使用变量、源码语法错误、非法 Hook 调用和 JSON 格式解析错误阻止提交；失败不推进 HEAD；部分暂存时未暂存修改仍保留。夹具中的 check 仅检查配置语法，正式项目的类型/架构检查由真实 `pnpm quality` 另行运行，不能互相冒充。

运行时 `resources/runtime-lock.json` 的原始字节参与产物清单哈希，排除自动格式化，修改后必须重新准备运行时；不能只因为 JSON 等价而跳过哈希校验。
