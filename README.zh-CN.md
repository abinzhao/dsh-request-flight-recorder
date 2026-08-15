# dsh-request-flight-recorder

[English](./README.md)

面向 DeepSeek Harness 的无正文模型请求诊断插件。插件通过 Cordis 观察官方
Agent Loop 请求，关联请求组装与流式结束状态，并在有界内存中保留飞行记录，
用于定位模型请求结构和流式生命周期问题。

## 能力

- 精确记录 Session、Turn、Step 和请求 Attempt 坐标。
- 记录 Provider、Model、生成参数、消息结构计数和工具 Schema 大小。
- 记录 Prompt Section、Context、Tool 和变量名称，但不记录对应值。
- 记录首个 Chunk 延迟、总耗时、Token Usage、Finish Reason 和结构化失败状态。
- 提供进程健康状态、保留记录组合查询和确定性的无正文 Diff。
- 当 Profile 提供 Commands 服务时，注册可选的官方 `/flight` 人类命令。

记录器不会注册模型 Tool、Skill、Prompt Section 或 Context Provider，也不会
改变 Agent Loop 或 Prompt 语义。

## 兼容性

版本 `1.0.0` 面向 DeepSeek Harness `0.1.0-rc.6`、Cordis `^4.0.1` 和
Node.js `^22.19.0 || ^24.0.0`。DSH RC 版本可能修改扩展契约，请使用与目标
DSH 版本匹配的插件版本。

## 安装

### npm

通过 npm 安装时，使用官方 DSH 插件命令将包添加到 Profile：

```sh
dsh plugin --profile web add dsh-request-flight-recorder
```

### GitHub Commit

从公开 GitHub 仓库安装时，应固定不可变 Commit，不要依赖持续移动的分支：

```sh
dsh plugin --profile web add "github:abinzhao/dsh-request-flight-recorder#<commit-sha>"
```

### 本地仓库

在当前仓库中运行：

```sh
dsh plugin --profile web add .
```

也可以安装打包产物：

```sh
pnpm pack
dsh plugin --profile web add ./dsh-request-flight-recorder-1.0.0.tgz
```

验证 Profile 合成结果：

```sh
dsh --profile web --dump-config
```

输出中应包含 `request-flight-recorder` 行。包内 Bundle 会添加以下默认配置：

```yaml
- insert:
    - id: request-flight-recorder
      name: dsh-request-flight-recorder
      config:
        capacity: 128
```

`capacity` 必须是正安全整数，用于限制当前进程保留的记录数量。健康计数独立于
记录淘汰，不会随 Ring Buffer 淘汰而回退。

## 人类命令

当当前 Profile 包含官方 Commands 服务时，可以使用：

```text
/flight
/flight latest
/flight list
/flight list 20
/flight show <request-id-prefix>
/flight diff
/flight diff <from-prefix> <to-prefix>
/flight health
```

`/flight` 和 `/flight latest` 显示当前 Session 最新的保留记录；`/flight list`
默认返回 10 行，显式上限必须在 1 到 20 之间。无参数 Diff 比较最新两条记录。
ID 仅在当前 Session 内按唯一前缀解析；缺失或存在歧义时会拒绝查询。输出为
纯文本，最多 4,096 个 UTF-16 code unit。

示例输出：

```text
flight abcdef12
turn 1 · step 1 · attempt 1
model deepseek/deepseek-chat
request 1 message · 10 system chars · 1 tool
tools read_file(2)
prompt sections identity · contexts workspace · variables cwd
outcome finished:stop · ttft 5ms · total 20ms · tokens 12 in / 4 out
```

命令设置了 `recordInput: false`，因此原始参数不会复制到 `command/run` 记录。
命令结果文本可能由当前 DeepSeek Harness Profile 或其 Session/历史插件持久化，
应将命令输出视为内部诊断数据。

## Service API

插件注册进程内只读服务 `ctx.requestFlightRecorder`：

```ts
const latest = ctx.requestFlightRecorder.latest(session.id)
const records = ctx.requestFlightRecorder.list({
  sessionId: session.id,
  provider: 'deepseek',
  model: 'deepseek-chat',
  outcome: 'finished',
  limit: 10,
})
const record = ctx.requestFlightRecorder.get(requestAttemptId)
const health = ctx.requestFlightRecorder.health()
const comparison = ctx.requestFlightRecorder.diff(fromId, toId)
const info = ctx.requestFlightRecorder.info()
const snapshot = ctx.requestFlightRecorder.snapshot()

const unsubscribe = ctx.requestFlightRecorder.subscribe(({ revision }) => {
  if (ctx.requestFlightRecorder.snapshot().revision >= revision) {
    render(ctx.requestFlightRecorder.snapshot())
  }
})
unsubscribe()
```

查询会组合所有已提供的过滤条件，并按从新到旧返回。记录、数组、健康快照和
Diff 结果均被冻结。公开 API 不提供修改、正文读取、导出或持久化操作。

`FLIGHT_RECORDER_PROTOCOL_VERSION` 和 `FLIGHT_RECORD_SCHEMA_VERSION` 均为
`1`。`snapshot()` 原子返回握手信息、Revision、Health 和记录；`subscribe()`
提供合并后的失效通知，不是持久事件日志。

## 硬限制

`FLIGHT_LIMITS` 是稳定的 v1 契约：

| 字段 | 最大值 |
|---|---:|
| `nameCharacters` | 256 |
| `tools` | 128 |
| `promptSections` | 256 |
| `promptContexts` | 256 |
| `promptVariables` | 256 |
| `messageCounterKeys` | 64 |
| `toolSchemaNodes` | 4096 |

结构观察超过限制时，记录会写入精确的 omissions 计数。超过 256 个 UTF-16
code unit 的名称会整项省略，不保留前缀。

## 隐私边界

记录器使用明确的字段白名单，不会保留 Prompt 正文、消息正文、工具描述、
工具参数、工具结果或 Prompt 变量值。它会保留 Provider、Model、Tool、
Prompt Section、Context 和变量等结构名称，以及计数和耗时。

上游异常消息可能包含 Provider 返回的细节。记录器不会保留原始错误消息、
Stack、Cause、自定义 Error 名称或非 Error 抛出值，只保存有限错误分类，同时
保持下游原始异常对象身份不变。插件与其他 Profile 插件运行在同一个 Node.js
进程中，不构成安全隔离边界。

记录器自身不会将记录写入磁盘。有界 Ring Buffer 会在进程退出、HMR Dispose
或 Service Dispose 时清空。这不会阻止 Commands 或 Session/历史服务执行其
自身的持久化。

## 关联与流式行为

插件只观察携带官方 Agent Loop 标记的请求，并使用相同的 `AbortSignal`、
Agent 对象身份和 Session ID 关联 `system-prompt/assemble`、`agent/request`
和 `llm/stream`。任一坐标缺失或不匹配时，插件会跳过记录，不会猜测关联。

流观察器保持 Chunk 对象身份、顺序、背压、消费者取消、返回值和抛出异常的
对象身份不变。观察回调失败不会替换模型流行为。

## Invariant Companion

`dsh-request-flight-recorder/invariant` 向官方 Invariant Registry 注册包所有权，
但不会重复安装运行时检查。有界保留已由 Ring Buffer 同步保证，同时不存在
可用于交叉校验的第二条独立事件源。

## 故障排查

- 缺少 Bundle 行：运行 `dsh --profile web --dump-config`，确认所选 Profile
  已安装该包。
- 没有 `/flight` 命令：核心记录器仍可工作，但当前 Profile 没有提供可选的
  Commands 服务。
- 没有记录：插件只捕获官方 Agent Loop 请求，直接 LLM 调用会被有意忽略。
- `correlation misses` 持续增长：检查自定义 Agent Loop 集成是否共享
  `AbortSignal`、Agent 身份和 Session ID。
- 较早记录消失：如果有界淘汰过于频繁，可提高 `capacity`。

## 卸载

```sh
dsh plugin --profile web remove dsh-request-flight-recorder
```

## 开发

```sh
pnpm install
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm build
pnpm bench
pnpm exec publint
```

贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全漏洞请按
[SECURITY.md](./SECURITY.md) 私下报告。

## 参考文档

- [公共 API](./docs/api.md)
- [记录 Schema 与限制](./docs/data-schema.md)
- [隐私威胁模型](./docs/privacy-threat-model.md)
- [架构](./docs/architecture.md)
- [兼容性](./docs/compatibility.md)
- [从 0.2 迁移](./docs/migration.md)
- [基准测试](./docs/benchmarks.md)

## License

[MIT](./LICENSE)
