# 可复用技术验证

此目录保留正式开发可参考或复用的脚本，**不是产品代码或已完成的产品验收**。当前实现见 [技术设计](../docs/technical-design.md)，正式回归见 [测试指南](../docs/testing-guide.md)；程序回归检查流程和文件交付，分析质量另交独立 Judge。

| 入口 | 可复用范围 | 运行说明 |
| --- | --- | --- |
| pi | 原生 SDK、输入身份、队列、事件、JSONL 恢复及真实模型连通 | [pi README](pi/README.md) |
| electron | 真 Electron/CDP、SQLite、MessagePort、Streamdown、并发、取消、进程回收与打包资源 | [Electron README](electron/README.md) |
| runtime | standalone Python、锁定 wheels、字体、rg/fd、哈希和许可材料获取 | [runtime README](runtime/README.md) |
| policy | 有限路径规则与一次性审批机制；非生产安全实现 | `python3 validation/policy/probe.py` |

安装/下载步骤需要联网，live 命令会调用真实模型并产生费用。所有测试使用合成内容及自己的临时目录，不使用用户真实应用状态。当前验证目标为 macOS arm64；不能将其他系统未运行的测试称为已通过。

## 证据与版本管理

源码、配置和 lockfile 纳入 Git。运行结果、日志、截图、JSONL/数据库、下载资源与打包产物按 [版本管理规则](../docs/repository-workflow.md) 仅保留本地；新检出仓库应通过命令重新生成，不依赖旧结果文件。

历史计划、验证报告和研究已归入被忽略的 `docs/archived/`；`validation/local-notes/` 和旧销售分析探针也不纳入 Git。旧探针中 oracle/metrics schema/报告数值断言不构成工作台职责或程序门禁；既有通过结果也不是 Judge 评价。正式测试证据与 Judge 报告分别生成到被忽略的结果目录。
