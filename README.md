# Branch Canvas

在原版 Codex 右侧插件标签页中，用树形画布组织问答、从同一回答探索不同分支。

**[下载 Windows v0.1.0](https://github.com/shwhwhwh/codex-branch-canvas/releases/tag/v0.1.0)** · [Prototype Plan](https://github.com/shwhwhwh/prototype-plan) · [更新记录](CHANGELOG.md)

项目所有者与维护者：**[Rui Li (@shwhwhwh)](https://github.com/shwhwhwh)**。
Copyright © 2026 Rui Li. **保留全部权利；当前源码按 [LICENSE](LICENSE) 允许个人学习、非商业试验及协作改进免费使用，商业化需[单独书面授权](COMMERCIAL_LICENSE.md)。**
第三方依赖沿用各自许可证；参见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
欢迎提交 Issue 和 PR；贡献者保留署名，按[贡献条款](CONTRIBUTOR_AGREEMENT.md)授权项目维护与商业发布。[许可沿革](LICENSE_HISTORY.md)区分旧 v0.1.0 发行包与本次许可切换后的源码：旧 ZIP 和标签不被替换，不能把新许可说明误当成旧 ZIP 自带的许可。

## 安装前准备

当前发行目标为 **Windows 10/11**。需要：

1. **Node.js 24+**，已加入 PATH。新开 PowerShell，运行 `node --version` 确认。
2. **Codex 桌面端**，支持本地插件和右侧独立插件标签页。
3. **Codex CLI**，已安装、登录，并能在新开 PowerShell 中运行 `codex --version`。

真实请求沿用本机 Codex 登录并消耗账号额度，无需向插件另外填写 API Key。
终端找不到 `codex` 时，先按 [Codex CLI 官方说明](https://developers.openai.com/codex/cli/)安装、登录。
发行包已包含构建后的后台和界面，**不需要 npm install 或 npm build**；不包含 Node.js、Codex 或客户端补丁。

## 安装：Releases 预构建包（推荐）

### 1. 下载并解压

从 [v0.1.0 Releases](https://github.com/shwhwhwh/codex-branch-canvas/releases/tag/v0.1.0) 下载 `codex-branch-canvas-v0.1.0-windows.zip`，可同时下载 `SHA256SUMS.txt` 校验完整性。

解压到准备长期保留、你有写权限的目录。例如将 ZIP 放在“下载”后运行：

```powershell
Expand-Archive -LiteralPath "$HOME\Downloads\codex-branch-canvas-v0.1.0-windows.zip" -DestinationPath "$HOME\Apps"
Set-Location "$HOME\Apps\codex-branch-canvas"
```

解压目录应同时包含 `plugin.json`、`mcp.json`、`dist/`、`scripts/` 和 `.agents/`。
不要在 ZIP 内直接启动；安装后不要移动或删除解压目录，本地市场指向这里。

需要校验时，将下列结果与 `SHA256SUMS.txt` 对比：

```powershell
Get-FileHash "$HOME\Downloads\codex-branch-canvas-v0.1.0-windows.zip" -Algorithm SHA256
```

### 2. 注册并安装插件

在解压目录运行：

```powershell
codex plugin marketplace add .
codex plugin add codex-branch-canvas@branch-canvas-local
```

也可以使用包内安装助手，它会先检查 Node.js 和 Codex 命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

这是用户级本地插件安装，无需管理员权限，不代表加入 OpenAI 公共插件目录。
市场机制参见 [OpenAI 插件官方文档](https://developers.openai.com/plugins/build/plugins)。

### 3. 在原版 Codex 中打开

1. 重新打开 Codex，在“设置 → 插件”确认 **Branch Canvas** 已启用。
2. 打开一个**本机聊天**，点击右侧标签页 **“＋” → “对话树”**。
3. 保持 **“跟随当前聊天”** 勾选。看到 **“已同步当前聊天”** 后，即显示已完成问答。

旧面板需要关闭再打开；若仍连接失败，在设置中关闭再开启插件后重开面板。
首次导入只读聊天，不发起模型请求；尚未完成的回答在完成后同步。

## 使用：从一个回答继续探索

### 创建分支

1. 选中希望继续讨论的**已完成回答节点**。
2. 点击 **“＋ 追问”**，或直接在画布下方输入框填写问题。
3. 点击 **“发送”**，新回答保存为该节点的子节点。
4. 回到同一父节点再次追问，即可探索另一个方向。

同一路径末尾连续追问通常复用原生 thread；从旧回答分叉时才新建 thread。
如果存在并发、待确认任务或原生历史已前进，会先核实历史，必要时 fork，不盲目追加。
兄弟分支继承各自路径的聊天上下文，但共享工作目录；分叉不回滚文件。

### 查看回答

- **Codex 原生聊天**：选中节点可打开对应聊天，使用客户端的原生回答和消息操作。
- **插件内预览**：在树下阅读 Markdown、代码、表格，复制回答或代码。
- 关闭“选中节点后跳转”后，可先在树内选节点，再手动打开原生聊天。

导航定位到聊天，不保证精确滚动到某条旧回答。切换聊天时 Codex 可能关闭面板，在目标聊天重开即可。
插件预览不复刻所有原生组件，也不会输出模型内部私有推理。

### 浏览长树

| 操作 | 效果 |
| --- | --- |
| 普通滚轮 / 触控板双指移动 | 平移画布，查看上游与下游 |
| Ctrl/⌘＋滚轮 | 缩放 |
| 拖动空白处 | 自由平移 |
| 回到顶部 | 展示当前路径的根节点，保留选中分支和输入内容 |
| 定位当前 | 回到选中节点 |
| 适应画布 | 完整容纳可见树 |
| 收起父节点 / 子节点 | 减少上游 / 下游显示内容 |
| 树状列表 | 切换窄栏列表，使用正常滚动 |

画布聚焦后可用方向键平移、Home 回顶部、End 定位当前。搜索会暂时展示匹配路径；“展开全部”恢复折叠区域。

### 切换树和备份

默认约每 5 秒增量同步当前聊天，面板可见时才轮询。手动从下拉框选另一棵树会暂停跟随；重新勾选即可恢复。
草稿和问答保存在本机。使用 **“导出”** 下载 JSON 备份；它可能包含完整聊天，勿上传公开仓库。

## 数据与升级

- 桌面插件默认数据在 Codex 管理的插件安装目录内 `data/canvas.sqlite`；路径随客户端和安装方式变化。
- 独立本地工作区默认数据在解压目录 `data/`。双击 `start.cmd` 打开 `http://127.0.0.1:47832/`；`stop.cmd` 停止该本地工作区服务。
- 两种模式只有指向**同一数据库路径**时才共享数据，不要假设默认路径相同。
- 进程环境变量 `BRANCH_CANVAS_DB`、`BRANCH_CANVAS_CWD` 可指定数据库和新树默认目录。
- 升级 / 卸载前先导出 JSON；要原样备份数据库，先停止对应后台，再备份 SQLite 及相关 WAL 文件。不要把正在写入的单个数据库文件当成一致性备份。
- 当前不提供跨版本自动迁移；避免多窗口同时编辑同一草稿。

## 常见问题

| 情况 | 处理 |
| --- | --- |
| Node.js 太旧 | 新终端运行 `node --version`，确认 24+ |
| 找不到 codex | 检查 CLI 安装、登录和 PATH；仅安装桌面端不保证终端命令可用 |
| 右侧“＋”没有入口 | 确认插件已安装启用、客户端支持该面板，重开 Codex |
| “未能显示对话树” / 连接失败 | 设置中关闭再开启插件，关闭再打开标签页 |
| “宿主未提供聊天标识” | 当前宿主没传聊天 ID，可手动选已有树；不会按最近活跃聊天猜测 |
| 看不到正在生成的回答 | 等待回答完成并同步 |
| “待确认”节点 | 先检查运行状态，避免重复发送；必要时从已确认父回答重新分支 |

真实讨论使用只读文件权限，不自动批准文件修改或额外权限请求；宿主接口兼容性取决于客户端版本。

## 源码开发

技术步骤同样受 LICENSE 约束：

```powershell
git clone https://github.com/shwhwhwh/codex-branch-canvas.git
cd codex-branch-canvas
npm ci
npm run build
npm run check
npm test
npm run package
```

Windows 打包结果位于 `artifacts/releases/v0.1.0/`，包含预构建 ZIP 和校验文件；已存在的输出目录会拒绝覆盖。
源码安装必须先构建，再注册市场；直接注册 GitHub 源码快照不会自动构建。

`src/` 为后台，`web/` 为界面，`tests/` 使用合成数据。`desktop-patch/` 只保留早期固定旧构建的实验副本源码，不参与普通插件构建、安装或运行；发行包不分发 Codex 二进制。

本项目是 [Prototype Plan](https://github.com/shwhwhwh/prototype-plan) 的首批原型之一，独立仓库及版权声明保持不变。
本项目独立开发，使用了 AI 辅助，不属于 OpenAI 官方产品。
