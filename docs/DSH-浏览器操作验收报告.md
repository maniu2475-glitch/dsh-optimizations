# 验收报告 · 第二阶段之 3：浏览器操作

日期：2026-10-29 21:15–21:40（新加坡时间）。本轮先重新核对三项已有功能仍在位（bundle、透明化 patch、记忆文件均未被回退），然后实施目标文档第二阶段第 3 项。

## 改动文件

| 文件 | 改动 |
|---|---|
| `~/.dsh/profiles/desktop/package.json` | 新增依赖 `@deepseek-ai/dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`（均精确 0.2.1-rc.3，与本机 DSH 同版本） |
| `~/.dsh/profiles/headless/package.json` | 同上 |
| `~/.dsh/profiles/headless/cordis.patch.yml` | 挂载两包（insert），provider 配置：launch / headless / executablePath=本机 Edge |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 追加同款挂载块（热加载生效，运行中会话不受影响） |

选型依据：官方 browser-use 文档三选一（Playwright MCP / Chrome DevTools MCP / Stagehand）选 Playwright MCP——工具面最全（快照/表单/点击/网络/截图），npm 存在与本机完全匹配的 0.2.1-rc.3 版本；浏览器引擎用本机 Edge（Chromium 内核），零下载。

## 验收（三批真实任务，全部 headless 全新会话）

**第一批（导航+读取）**：打开 example.com。11 次真实工具调用（navigate/evaluate×3/snapshot/network_requests×2/network_request/take_screenshot 等），抓到服务器原始 HTML，确认页面已改版（无 h1，"Example Domain" 仅存于 title），截图 `example-home.png`（49,703 字节，已独立核对存在）。

**第二批（填写+点击+落盘）**：httpbin.org 表单填 `custname=DSH-验收` + 选 Medium 单选 + 点击提交。回显证实表单数据完整往返（含中文无乱码）；robots.txt 全文经浏览器读取后落盘 `browser-qa-download.txt`，独立核对与源站逐字一致。

**第三批（浏览器原生下载）**：带 Content-Disposition 附件头的 URL 触发真实下载。工具事件记录 `Downloading file dsh-qa-download.txt ... → Downloaded ... to ".playwright-mcp\dsh-qa-download.txt"`，Edge 下载中心出现条目；文件落盘且内容独立核对一致。

浏览器挂载证据：桌面运行时插件清单出现 `dsh-browser-use` 与 playwright-mcp 两行 `enabled: true, active`（热加载，未重启 DSH）。

## 使用方法

- **桌面**：新建 DSH 会话即含浏览器工具（`mcp__playwright-mcp__*`，如 browser_navigate / browser_snapshot / browser_click / browser_fill_form / browser_take_screenshot）。说"打开某网页做 X"即会调用。headless 模式（无头）下浏览器不可见；要可视化时把桌面 patch 中 `headless: true` 改为 `false`（改前备份）。
- **无头批处理**：`dsh --profile headless --patch model-transparency.patch.yml "用浏览器打开…并…"`。
- 已知限制（官方文档）：仅 Chromium；会话结束浏览器资源随之释放，登录态不跨会话恢复；需要登录态时用 `mode: attach` 连已开调试端口的浏览器（后续按需配）。

## 产物位置

- 截图：`workspace/example-home.png`；下载：`workspace/.playwright-mcp/dsh-qa-download.txt`、`workspace/browser-qa-download.txt`
- QA 事件流：`workspace/browser-qa{,2,3}.jsonl`（含全部工具调用记录，可追溯）

## 回滚

备份在 `~/.dsh/backups/round4-browser-20261029-211933/`（desktop/headless 两 profile 的 package.json 与 patch 全套）。恢复：复制回原位 + `dsh plugin --profile desktop remove @deepseek-ai/dsh-browser-use @deepseek-ai/dsh-experimental-browser-use-playwright-mcp`（headless 同理）。

## 如实说明

- 首次验收曾超时转后台（浏览器冷启动约 2-4 分钟），后续任务正常速度。
- example.com 现由 `/s.js` 注入本地化文案（中文优先），属页面自身行为，已在验收中如实记录。
- 目标验收项"记录失败原因"：本轮三批任务无失败步骤；第一批中"页面无 h1 标题"是页面改版事实而非工具失败，已如实记录。
