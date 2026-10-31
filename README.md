# DSH 优化实践集（DeepSeek Harness Optimizations）

> 面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai)用户的实战优化集合：一个增强自动上下文压缩的本地插件、一套经过 8 次真实运行验证的网页调研流水线编排规范、以及 4 份可直接挂载的个人 Agent 预设。全部成果均在 DSH 0.2.1-rc.5 上实测验收。

## 目录结构

```
compaction-checkpoint/   # 自动上下文压缩增强插件（@local/dsh-compaction-checkpoint，v2）
web-research-pipeline/   # 网页调研报告流水线 v2.5.1（模板 + 阶段语义 + 编排脚本）
presets/                 # 4 份个人 Agent 预设（快速/全能执行/规划/协作集群）
docs/                    # 使用说明与验收报告（含完整踩坑记录）
examples/                # 插件真实产出的压缩摘要样例
```

## 1. compaction-checkpoint —— 自动上下文压缩增强插件

**结论先行：DSH 本来就有可用的自动压缩（4 插件栈），本插件不替换它，而是覆写 `summarize()` 一步，把 8 节模板升级为 12 节结构化校验模板。**

### 解决的三个真实缺陷

| 缺陷 | 后果 | 修复 |
| --- | --- | 验收 |
| 摘要缺少"已完成并验证"与"失败尝试"字段 | 模型分不清"做完了"与"正要做"，重复执行或重走死路 | 新增 Completed and Verified / Failed Attempts / Do Not Repeat 节 |
| 无事实分层、无新旧要求替代关系 | 旧指令与新指令平起平坐，压缩后任务漂移 | 全文 [fact]/[speculation]/[unverified] 标记 + Requirements Superseded 节 |
| 无校验闸门、失败不可见 | 残缺摘要悄悄替换完整历史 | 真 Markdown 解析校验器，fail-closed：不合格不切换，失败冷却 60s |

### v2 可靠性修复

- 流式响应无 `finish` 即拒绝（原默认 stop 是漏洞）
- 重试分类 format/interface/cancel：interface 类零重试，不与 provider 层重试叠加
- 失败冷却 60s/会话，拦截无效重试
- 结构化校验器：标题恰好一次、按序、围栏不冒充、关键节反填充
- 单测 39/39；headless 回归 13 次压缩全插件产物

### 安装

1. 把 `compaction-checkpoint/` 复制到 DSH profile 的插件目录（如 `~/.dsh/profiles/<profile>/node_modules/@local/dsh-compaction-checkpoint`）
2. 在 preset 的 `compaction` group 内追加（**必须在 isolate group 内，域外注入静默不生效**）：

```yaml
- id: compaction-checkpoint
  name: '@local/dsh-compaction-checkpoint'
  config:
    enabled: true
    maxSummaryAttempts: 2
```

3. 验证方法：实际触发一次压缩后查会话日志，摘要 PREAMBLE 为插件开头句（详见 docs）。
⚠️ 不能只看"任务跑完没报错"——isolate group 域外 `ctx.inject` 会静默不触发。

详细原理、踩坑记录（`ERR_MODULE_NOT_FOUND`、双实例冲突、isolate group 陷阱）与验收数据见 [docs/DSH-自动上下文压缩增强-使用说明与验收.md](docs/DSH-自动上下文压缩增强-使用说明与验收.md)。

## 2. web-research-pipeline —— 网页调研报告流水线 v2.5.1

主会话直连编排的 4 阶段流水线：**collect → digest → report → qc**，SHA256 指纹链保证上游变化自动传播到下游重做。

核心设计（8 次运行换来的硬规则，勿回退）：

- **阶段返回 schema 只允许简单字段**（status/verdict/issues）——绝不含哈希/指纹字段。实证：模型算完哈希会把值当回复发，6 次运行 5 次违约。
- 指纹的产出与验证都在代理内部完成；编排层只信枚举白名单与 ABORT 守卫。
- 阶段 null → ABORTED 不标成功；重跑 = 从磁盘断点续跑。
- 指纹算法版本显式声明（`fingerprintAlgo: body-v2`）——口径类规则必须带版本号落进产物，否则两种口径并存。
- QC 五查终审 PASS/FAIL；FAIL → 修复指令 → 报告重写 → 复查（最多一轮）。

入口：[web-research-pipeline/TEMPLATE.md](web-research-pipeline/TEMPLATE.md)（唯一入口说明）+ [STAGES.md](web-research-pipeline/STAGES.md)（阶段语义，人类文档）。验收报告见 docs。

## 3. presets —— 4 份个人 Agent 预设

[presets/cordis.patch.yml](presets/cordis.patch.yml) 包含可直接挂载的 4 预设：

| 预设 | 用途 |
| --- | --- |
| personal-fast（快速模式） | 问答、小改动，最小工具集 |
| personal-executor（全能执行助手） | 日常综合任务，含规划/委派/goal 工具 |
| personal-planner（方案规划与审查） | 只读规划，无写入与终端 |
| personal-cluster（协作集群） | 多子代理并行分工与汇总复核 |

全部预设均挂载了 compaction-checkpoint 插件与浏览器工具相关配置，且是**已实证可用的整行覆写写法**（preset 条目级 insert 只能命中顶层合成树；改 preset 内部必须整体覆写 `preset-<id>` 行，config 全字段重述）。

## 环境陷阱备忘（Windows + DSH 实测）

这些坑都真实踩过并写进了实现，供后来者参考：

1. **自写插件禁止 import `@deepseek-ai/*`**：Harness 包在 app.asar 内，从 profile 解析必报 `ERR_MODULE_NOT_FOUND`；`link:`/`file:` 安装无解。正确做法=插件零 Harness 依赖，一切服务走 `ctx`。
2. **isolate group 域外注入静默失败**：`ctx.inject(['compaction',...])` 在 group 域外回调不触发、无报错。验证必须看实际产物，不能只看"没报错"。
3. **patch 层换实现要换 id**：不能用不同 name 覆盖同一 id（静默跳过）；须先 `disabled: true` 原行再以新 id `insert`。
4. **返回 schema 含哈希字段违约率极高**：子代理会把算好的哈希值当回复发回来。schema 只留 status/verdict 等简单字段。
5. **口径类规则必须带版本号落进产物**：否则同一规则两种口径并存，头行互相匹配 ≠ 整体正确。
6. **子代理可能中途失败且无回传**：失败后必须查磁盘，0 字节/半成品不标成功。

## 适用版本

- DeepSeek Harness 0.2.1-rc.5（rc.3 上亦验证过）
- Windows（预设中 bash/pwsh 按平台自动切换，macOS/Linux 理论可用未测）
- 插件零 npm 依赖，Node 18+

## License

MIT
