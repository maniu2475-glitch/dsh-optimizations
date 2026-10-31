# Agent 自我优化报告 · 第二轮（2026-10-29 晚）

目标：补充调研第一轮未覆盖的主流 agent 实践与真实源码实现，提炼新改进并落地。
结论：已完成。本轮新增约 40 条核验要点（含 12 篇全文亲读/子代理核验的官方文档 + Claude Code 真实源码研读），落地 4 处改动，全部验证通过。

## 一、本轮调研范围（与第一轮互补）

1. **Codex 官方文档正文攻坚**：上轮 403 的 developers.openai.com 经中文镜像全部读到（agents-md / prompting / auto-review / memories / subagents / skills / workflows 7 页），上轮 5 个未核实项全部闭环。社区流传的 CTA-4 模板判定为非官方；官方四要素是 Goal/Context/Output/Boundaries。
2. **生态补漏**：Cognition《Don't Build Multi-Agents》、Devin（AGENTS.md/Memory/Skills/Subagents）、OpenHands（Persistent Memory/Path-Triggered Rules）、SWE-agent ACI、mini-SWE-agent、Cline（Plan&Act/Memory Bank）、GitHub Copilot custom instructions。Roo Code 扩展已于 2026-05 关停，其压缩经验经其文档镜像核实。
3. **方法论与论文**：Anthropic《Building effective agents》《Effective context engineering》《Multi-agent research system》全文；OpenAI《A practical guide to building agents》（34 页，经 GitHub 公开镜像）与 GPT-5 prompting guide；ReAct/Reflexion/Voyager 摘要；Amp《How to Build an Agent》。出处更正：多代理研究系统一文是 Anthropic 的，网传"Google DeepMind"系误标。
4. **Claude Code 泄露源码研读**（用户提供的 AI资源.zip，解压至 workspace/claude-code-src-study，约 1884 个 TS/TSX 文件）：系统提示 914 行组装逻辑、分节缓存架构、压缩 9 段提示词、TodoWrite 纪律、Explore 只读子代理实现、记忆"不存什么"清单。源码仅作学习参考，未复制其代码。

## 二、落地改动（已验证）

### 1. AGENTS.md v3（37 行，v2 为 34 行）
新增 4 条规则（每条均有多方印证）：
- **子代理派发三要素**：怎么拆/要不要等/回什么（Codex subagents 官方文档 + Anthropic 多代理系统委派五要素简化版）。
- **修 Bug 闭环**：先复现→修复→重跑复现与最小验证并报告命令与输出（Codex prompting 官方文档）。
- **忠实报告**：失败就说失败附输出、没验证就说没验证、确认通过就直接说通过不加对冲（Claude Code 源码 prompts.ts 的 Report outcomes faithfully 条款精简）。
- **计划获批后先转 todo 再动手**（Cline Plan&Act 官方文档）；**并行子代理仅限只读宽搜索**，改码/共享上下文串行（Cognition 两原则 + Anthropic 多代理适用判据 + Codex subagents 读密集并行/写密集谨慎，三方一致）。

### 2. agent-self-improve 技能升级
- 新增第 8 步"复用"：调研前先读 references/reading-list.md，已核验来源直接引用。
- 新增 `references/reading-list.md`（62 行，36 条来源链接）：按主题分类的全部核验来源，标 ★（全文亲读）/○（子代理核验正文）/无标（未复核），含 Claude Code 源码研读摘要与出处更正记录。下次优化不必重查。

### 3. dsh-handoff 技能微调
吸收压缩提示词 9 段结构的两个防漂移设计：用户关键约束记原话（防转述失真）；下一步注明当时原文依据（防任务漂移）。

### 4. 验证证据
- AGENTS.md 37 行（≤200）、5 处新规则落点命中、UTF-8 无乱码、harness 热加载确认生效。
- reading-list.md 62 行 36 链接；技能文件行数与关键条款均程序核验。
- 备份两份：`agents-md-pre-upgrade-20261029-190956`（第一轮前原版）、`round2-pre-upgrade-20261029-194230`（第二轮前 v2 版）。回滚：复制备份文件回原位。

## 三、识别但需 harness 代码/插件层支持的事项（本轮未动，与第一轮清单合并管理）

- Devin 16KiB 注入截断与"关键指令置顶"约定 → 已在配置层预防（AGENTS.md 现仅 37 行远低于阈值）；如未来加长需监控。
- 记忆条目带 [source; added] 元数据 + 定期整理仪式（Devin/OpenHands）。
- 路径触发规则 paths: glob（OpenHands/Claude Code rules）。
- 工具层四改进（SWE-agent ACI）：编辑后语法校验、read 限量分窗、搜索只回文件名、空输出明确提示。
- 子代理 explore/general 分档绑定模型与工具白名单、大产物落盘只回引用（Devin/Anthropic）。
- auto-review 式审批代理 + 拒绝断路器（Codex）。

## 四、诚实声明

- web_search 全程不可用（缺 API key），所有调研经 web_fetch 直抓官方站点/镜像完成；Wayback Machine 被本机网络策略拦截；OpenAI 英文原站全程 403，Codex 文档经官方中文镜像核验（正文为翻译，个别术语以中文转述）。
- 所有引用来源均标注核验等级；未读正文的对象未引用。Claude Code 源码为用户提供的学习材料，本次仅作设计参考。
