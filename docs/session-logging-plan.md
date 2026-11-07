# Session 追加日志设计

状态：设计待实施。2026-11-07，日志行为依据已提交版本 `808adb8` 的实现和锁定的 pi 1.5.0 类型核对；身份约定已对齐 main 当前进行中的 run 统一改造。本次仅修改文档，未实现或验收下述行为。当前工具日志布局与既有验收见 [技术设计](technical-design.md) 和 [实施进度](implementation-status.md)。

## 1. 决策与边界

每个应用会话仅新增一个 `logs/{sessionId}/events.jsonl`，同会话的所有 run、steer/follow-up 和重启后的执行继续追加。取消按工具调用创建目录和文件。沿用 session 目录，便于复用固定路径删除及保留旧文件。

采用 UTF-8 JSON Lines，每行一个事件，结构为可信身份、事件类型和 payload。复用 pi 适用的事件名称，但不把全部 pi 事件及其原始 payload 直接序列化。

两类文件的职责固定：

| 文件                            | 职责                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `sessions/{sessionId}.jsonl`    | pi 原生会话树；消息、思考、工具参数/结果、用量和上下文恢复的唯一事实源                   |
| `logs/{sessionId}/events.jsonl` | 运行诊断事件和受限的进程输出增量；可缺失，不参与上下文构建、输入 ACK、用量结算或任务恢复 |

不增加 SQLite 表、sidecar、manifest 或持久化偏移索引，不修改 pi 原生格式。不改变 system prompt、工具声明、消息投影或模型请求。日志故障不能触发重试模型或重复执行用户任务。

## 2. 为什么不能直接保存全部 pi 事件

锁定依赖的 `AgentEvent` 中，`message_update` 同时携带当前消息和局部事件，`tool_execution_update` 携带 `partialResult`，并不承诺后者是增量。本项目 `ProcessRunner` 每次回调传累计输出，工具代理将其包装成 `partialResult`。因此直接保存 update 会重复写入越来越长的前缀，而不是线性保存新增字节。

当前 ProcessRunner 提供给模型/UI 的输出上限为 60 KiB；只记录 pi 更新无法保留超过该上限的进程输出。`message_end`、`turn_end`、`agent_end` 又包含已有消息/结果，原样打印会重复原生历史。审批、Main/Host 崩溃和进程退出等信息也不全属于 pi 事件。

所以日志使用统一封套，由三种来源写入：pi 的生命周期摘要、Main 的执行事件、监督器的输出增量。pi 升级只修改白名单适配器，不能自动扩大落盘字段。

## 3. 格式

```typescript
type SessionLogRecord = {
  v: 1;
  ts: string; // Main 接收并入队时生成的 UTC ISO 8601 时间
  runId: string | null; // 应用执行身份；维护事件允许为 null
  source: 'pi' | 'main' | 'process';
  type: string; // 与 source 一起确定 payload schema
  payload: Record<string, unknown>; // 实现时使用判别联合及运行时校验
};
```

应用层统一使用 run/runId：字段为 runId，应用生命周期事件为 run_start/run_end，预算、缓存、游标与旧布局路径都按 run 关联。`tool_execution_start/update/end` 是 pi SDK 固定事件名，原样保留，不改成 tool_run_*；不新增 executionId 别名或独立 epoch。

sessionId 由受控文件路径确定，不重复写入每行；runId 必须由 Main 的可信绑定补齐，不能接受工具参数或模型自行声明。工具相关 payload 使用 pi 的 `toolCallId`、`toolName`，有嵌套调用时保留经验证的 `parentToolCallId`。

物理行顺序是 Main 的追加顺序，时间戳仅供显示，不作为跨进程因果顺序或排序键。记录位置使用文件字节偏移；无需新增可持久化全局序号。沿用当前任务对象及 sessionId/runId 校验拒绝旧 run 的迟到事件，同 run 事件按私有通道顺序接收；不另设 epoch，不复用 Renderer 快照 seq 作为日志游标。

示例（每行独立 JSON；示意 ID 在实现中使用实际校验后的身份）：

```jsonl
{"v":1,"ts":"2026-11-07T12:00:00.000Z","runId":"run-A","source":"main","type":"run_start","payload":{}}
{"v":1,"ts":"2026-11-07T12:00:00.100Z","runId":"run-A","source":"pi","type":"tool_execution_start","payload":{"toolCallId":"call-1","toolName":"bash"}}
{"v":1,"ts":"2026-11-07T12:00:00.110Z","runId":"run-A","source":"process","type":"process_start","payload":{"toolCallId":"call-1"}}
{"v":1,"ts":"2026-11-07T12:00:00.200Z","runId":"run-A","source":"process","type":"output_delta","payload":{"toolCallId":"call-1","stream":"stdout","encoding":"base64","data":"T0sK"}}
{"v":1,"ts":"2026-11-07T12:00:00.300Z","runId":"run-A","source":"process","type":"process_end","payload":{"toolCallId":"call-1","exitCode":0,"reason":"exit","savedOutputBytes":3,"droppedOutputBytes":0}}
{"v":1,"ts":"2026-11-07T12:00:00.310Z","runId":"run-A","source":"pi","type":"tool_execution_end","payload":{"toolCallId":"call-1","toolName":"bash","isError":false}}
{"v":1,"ts":"2026-11-07T12:00:00.400Z","runId":"run-A","source":"main","type":"run_end","payload":{"state":"completed"}}
```

输出 data 为原始字节的 base64，示例解码为 `OK\n`。监督器已提供 stream/data，Main 在凭证脱敏后保留字节形式，不先将每块独立转成 UTF-8；这样能保留 NUL 和跨块多字节字符。base64 不是加密，应用日志具有与原生会话相同的本地数据敏感性。

### 3.1 事件白名单

| source  | type                                          | 保存字段及规则                                                                                       |
| ------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| main    | `run_start` / `run_end`                       | 可信执行身份；终态、受限错误码/脱敏摘要。end 在 Host/工具收束且此前日志写入排空后生成                |
| pi      | `agent_start` / `agent_end` / `agent_settled` | 仅 `willRetry`、`aborted` 等适用标志；不保存 messages。agent_end 不是应用执行终态                    |
| pi      | `tool_execution_start` / `tool_execution_end` | 工具身份、名称、parentToolCallId；end 保存 isError、可用的 durationMs，不重复 args/result            |
| pi      | `auto_retry_start` / `auto_retry_end`         | attempt、maxAttempts、delayMs、success，以及限长脱敏错误摘要                                         |
| pi      | `compaction_start` / `compaction_end`         | reason、aborted、willRetry、错误摘要；不保存压缩正文，不从日志恢复上下文                             |
| main    | `interaction_open` / `interaction_close`      | toolCallId、interactionId、交互类别、关闭原因；不保存凭证、完整问题/回答或授权正文，不凭日志恢复审批 |
| process | `process_start` / `process_end`               | toolCallId；退出码、监督器 reason、保存/丢弃字节数，不复制 argv、环境变量                            |
| process | `output_delta`                                | toolCallId、stdout/stderr、encoding=base64、data；只记录新增输出                                     |
| main    | `log_gap` / `log_recovered`                   | 原因及已知的丢失字节/记录数、关联 toolCallId（适用时）；不能声称未知丢失量为零                       |

不保存 `message_start/update/end`、`turn_start/end`、`entry_appended`、`queue_update` 的原始正文，不复制工具参数、模型请求或运行快照。不保存 `tool_execution_update`，也不把 SDK 的 `bash_execution_update` 当作本项目自定义工具的进程输出。其他事件默认忽略，扩展白名单必须说明用途并更新 schema/回归。

read/write/edit/ls/ask_clarification 等没有监督器输出的工具，仍有工具生命周期摘要，结果从原生 JSONL 查看，不为它们合成 stdout。工具被策略拒绝、尚未启动进程时，不伪造 process_start/end。

## 4. 单写与资源边界

- Main 的 SessionLogWriter 是该文件的唯一写者；Host 仅通过经校验的私有通道发送白名单摘要，不直接打开日志文件。Renderer 不参与写入。校验当前任务对象及 sessionId/runId，拒绝旧 run 的迟到消息；重启后新执行必须生成新 runId。
- 每个 session 独立串行写队列，完整编码一条记录后追加，处理短写，禁止多条记录的字节交错。执行切换沿用同一 writer；两个 session 的日志互不等待。
- 文件按需创建，目录 0700、文件 0600。固定 Main 路径，检查 canonical root、普通文件、链接与文件身份，保留现有受控路径策略。
- 每条编码后的 JSONL（含换行）最多 64 KiB；output_delta 每条原始数据最多 32 KiB。长输出切块，错误摘要最多 2 KiB。未完整编码/校验的 payload 不入队。
- 继续限制同一 run 所有进程累计保存的原始输出为 10 MiB，包含 stdout/stderr；base64 与封套开销不计入该配额。该配额不等于日志文件大小上限。首次达到配额记录 log_gap，后续输出继续消费但不保存，process_end 汇总保存/丢弃量，不按每个丢弃块写一条事件。
- writer 待写编码字节最多 512 KiB。写队列拥塞时丢弃新增输出日志并累计缺口，保留至多一条待写缺口摘要，恢复可写后先写摘要再写后续输出。控制记录同样受内存上限约束；若无法容纳则标记日志降级，不能无限排队或阻塞模型/工具管道。
- 日志写失败仅使日志能力降级，不更改工具成功/失败结果。通过受限 IPC 状态显示“日志保存不完整”，不把错误递归写回失效队列。短写后发生异常时暂停该文件后续追加，恢复前先按尾部规则隔离残片；恢复后追加 log_gap。持续失败时只保留内存降级状态，不承诺崩溃后能还原该状态。
- 不记录 API key、Authorization、完整运行环境或提供方请求/响应。沿用凭证脱敏边界；新增原始输出落盘路径须在 Main 脱敏后编码，覆盖凭证跨 chunk 的情况。配额和 gap 的字节统计基于脱敏后输出；脱敏可能改变字节，不宣称与进程原始输出逐字节相同。

首版不轮转、不按 run 切文件，也不自动淘汰历史记录；新日志文件数恒为每个 session 一个。会话累计文件大小仍随执行次数增长，10 MiB 并非整个会话的总上限。后续如需总量/保留期限策略，单独定义，不在本次静默覆盖或删除旧日志。读取必须有界，不能依赖整个会话总量较小。

## 5. 崩溃与恢复

每行最后一个 LF 是完整记录边界。正常结束/退出时排空写队列并关闭句柄；删除会话先禁止新输入及新工具准入，等待 Host/工具退出并收集已有执行的结束记录，再禁止 writer 入队、排空并关闭，最后按固定 session 目录清理。不能先关闭 writer 再让活动进程继续写。

不宣称 fsync 级断电耐久性；Main/Host 崩溃时允许丢失尚未写出的尾部事件。只有 start 没有 end，表示日志中的结果未知，不能据此补写工具成功或重放操作；应用恢复状态继续由现有 SQLite/原生 JSONL 规则处理。

重新打开文件先检查最多 64 KiB 尾部。若末尾未以 LF 结束，不改写/截断旧字节；先补一个 LF，再追加 log_recovered。若尾部本身是符合 schema 的完整 JSON，补换行只修复分隔符，reader 可读取该记录；否则隔离残片，reader 跳过并显示缺口。恢复记录保存可确定的隔离字节数与原因，不复制残片内容；超过尾部检查窗口时字节数标为未知，不能虚报精确值。已有换行但 JSON/版本/schema 无效的记录同样标为不可读取，不当成输出，也不隐瞒成正常完整日志。

读取损坏大行时采用流式丢弃至 LF，不能先将整行读入内存。重新启动不扫描所有 session 日志；仅打开当前需要写入或查看的文件，内存索引随按需分页扫描逐渐重建。

## 6. 查看与授权

保留工具卡片入口。展示该工具对应的 process 输出；生命周期与缺口记录用于说明状态，不把 JSON 封套直接当 stdout。非进程工具的结果继续由原生历史展示。缺失日志、无进程输出、输出被截断、文件损坏或尚未扫描完必须可区分。

- Renderer 只传 session/tool 身份与 Main 签发的短期游标，不传路径。每次打开/翻页重新核对活动工具或原生历史中的会话归属；读进程记录还需匹配 runId、toolCallId。
- 扫描器按物理偏移过滤记录，每次 IPC 最多扫描 1 MiB 原文件并最多返回 32 KiB 解码文本。达到扫描预算但没有匹配内容时仍返回 nextCursor/scanning 状态，不能把空页当 EOF。事件在 64 KiB 行边界内完整解析，跨扫描边界保留有限残片。
- 首次打开捕获文件身份与当时文件大小作为快照边界；继续分页只读到该边界。刷新建立新快照查看新增记录，避免活动追加导致阅读永远无法结束。文件被替换、缩短或游标失效时明确失败，不能静默跳到新文件。
- 每条 output_delta 校验 base64、解码长度和 schema；使用增量 UTF-8 解码处理跨记录字符，保留 stream 身份及 Main 接收顺序。已知 gap 清空对应解码残片并展示缺口，防止跨缺口拼出伪字符。
- Main 可保留有界的 `(runId, toolCallId) → 记录偏移` 内存缓存；例如总计最多 1000 个工具条目、8 MiB 偏移数据，LRU 淘汰后按游标重扫。缓存不是授权依据，不写磁盘，不在启动时全量建立。
- 旧 logs.list 的“列工具目录”改为同文件内扫描、按 runId 分组；每页最多 100 组且同样受扫描预算限制。logs.page 改为不透明游标，绑定 session/tool/run、快照、扫描位置和解码状态。游标最多保留 1000 个、空闲 10 分钟失效，Renderer 可重新打开。

## 7. 升级与实施范围

现有 `logs/{sessionId}/{toolHash}/{runId}.log` 不搬移、不转换、不合并。升级后只向 events.jsonl 追加，原生历史照常可读。为避免额外双读分支，本轮不新增旧布局的查看兼容；旧文件仍可由用户自行查看，UI 明确提示旧完整日志未接入新查看器。删除会话时，同一受控 session 目录中的新旧内部日志一起清理，workspace 始终保留。

| 模块                                             | 后续实施内容                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| node 日志格式/路径、Main SessionLogWriter        | JSONL schema、串行追加、限额、gap、尾部恢复与关闭                                                               |
| ProcessRunner                                    | 移除每工具 logFile 与 appendFileSync；将监督器增量/stream 和结束摘要交给 writer，保留执行监督及模型/UI 输出上限 |
| Host 事件适配、shared contracts、AgentProcess    | 增加白名单摘要通道，Main 校验身份；不复用全量 runtime snapshot，不传任意 SDK 对象                               |
| RuntimeService / ToolService / InteractionBroker | 可信执行与交互生命周期记录、终态排空及日志降级通知                                                              |
| LogService / IPC / ToolLogViewer                 | 有界过滤扫描、短期游标、UTF-8 解码、缺口与状态展示                                                              |
| DeletionService / 应用退出                       | 等待 writer 关闭后清理；失败可重启重试，不影响其他会话                                                          |

## 8. 验收要求

实施时按 [测试指南](testing-guide.md) 在现有 tools/lifecycle/sessions 功能目录扩展用例，注册到 catalog；普通回归使用合成数据，不调用真实模型。

1. 同 session 多 run、steer/follow-up、上千工具调用、跨重启都只产生一个新日志文件；双会话只各写自己的文件。没有新的 DB 表或 sidecar。
2. 连续累计 pi partialResult 不入盘；已知进程输出重建后只出现一次，超过 60 KiB 的部分仍可查看。stdout/stderr、NUL、中文跨块、换行和 base64 边界正确。
3. 同执行累计 10 MiB、64 KiB 单行、512 KiB 待写上限与日志故障降级生效；缺口计数和 UI 提示正确，工具不被日志故障重试或改判失败。
4. 模拟短写、ENOSPC、Host/Main 崩溃、未结束行、损坏/超长行、未知版本；恢复只追加，不改历史字节、不伪造成功、不重放任务。
5. 重启后冷扫描、无匹配页、1 MiB 扫描预算、32 KiB 文本分页、快照刷新、游标失效/跨会话、文件替换/符号链接与旧布局提示均有覆盖。
6. 删除/退出与活动写入竞争正确排空；删除 A 保留 workspace，不终止 B；内部清理失败仍可恢复。验证新旧日志共存。
7. 凭证跨 chunk 脱敏、无 argv/env/完整 pi 消息副本；实际请求的已有上下文前缀保持不变。实现若触及上下文适配，执行仓库规定的完整前缀回归。
8. 后台 CDP 检查工具日志尾部、分页、缺口/失败状态及阅读位置；检查实际截图。本次文档设计不代表这些用例已经通过。
