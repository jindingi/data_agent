# pi SDK 可复用验证

验证原生 SDK、输入身份桥接、流式事件、队列与 JSONL 恢复；不会修改 pi 源码仓库。它是技术 harness，不是正式 Agent Host。

## 安装与运行

使用 Node 22.22.0 或满足锁定 SDK 要求的版本；npm 包 `@earendil-works/pi-coding-agent` 和 `pi-ai` 固定为 1.5.0，完整依赖见 package-lock.json。

```sh
cd validation/pi
npm ci --ignore-scripts
node verify.mjs
```

`verify.mjs` 默认使用确定性 faux provider，不联网调用模型。真实 SDK 的会话、事件和 JSONL 仍实际运行。生成的 `runs/<timestamp>-*/summary.json`、会话与日志不进入 Git；失败保留并返回非零。

真实 DeepSeek smoke（从本目录执行）：

```sh
python3 run-live.py
python3 run-live.py --audit-only
```

启动器优先读取环境中的 `DEEPSEEK_API_KEY`，否则只解析 `~/.zshrc` 的简单字面量赋值，不 source shell、不输出 key。使用 PATH 中的 Node，可用 `VALIDATION_NODE` 指定解释器。缺凭证失败；`--audit-only` 只扫描本地证据是否含 key，不发请求。所有输入为合成 nonce；live 验证读取、上下文恢复与协议配置，不评价数据分析准确性。

## 适配与覆盖

- 每条 prompt/steer/followUp 加应用 input ID 外层 envelope；同文本仍具有不同身份。
- 可信 context hook 仅剥除最外层，用户自己写的类似文本保留。标准 message/custom entry 维持 pi 原生树格式。
- `message_end` 早于 SDK append，不能当落盘确认；在收束时读取完整 record，幂等补 custom ACK。重开会话后复核，不保证 fsync 级断电持久性。
- 确定性覆盖相同文本输入、活动 partial、恢复、preflight rejection 和取消后不重放。
- 正式产品的 UUID/登记表、SQLite/IPC 和受信资源加载分别由 `src/agent/input-identity.ts`、`src/main/services/runtime/` 及 `src/agent/resource-loader.ts` 实现；不能直接将此探针等同于产品实现。
- `pi-smoke.mjs` 被同级 Electron harness 复用，验证 utilityProcess/MessagePort 与真实 pi SDK 的衔接。
- 模型不保证每轮返回 thinking；live 只展示和记录实际内容。模型别名也不是不可变权重版本。

旧 `verify-analysis.mjs`、`collect-results.mjs` 和汇总结果只留本地，不作为此入口的依赖。分析质量按产品计划单独做 Judge 评测。
