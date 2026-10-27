# Branch Canvas

在原版 Codex 的右侧插件标签页中，用树形画布组织问答和分支追问。

项目所有者与维护者：**[Rui Li (@shwhwhwh)](https://github.com/shwhwhwh)**。
Copyright © 2026 Rui Li. **保留全部权利。此项目未授予开源使用许可。**
第三方依赖沿用各自许可证；参见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 功能

- 默认跟随当前本机聊天，自动导入已完成问答，并增量同步。
- 同一回答可创建多个子分支；连续追问复用 thread，真正分叉时才 fork。
- 支持父节点、子节点分别折叠；搜索、定位当前、回到顶部。
- 普通滚轮移动画布，Ctrl/⌘＋滚轮缩放；适应画布可容纳长路径。
- 默认通过树导航打开 Codex 原生聊天；也可选择插件内 Markdown 预览。
- 本机 SQLite 保存树、草稿与回合锚点；支持 JSON 导出。
- 提供明确标注的本地演示模式；真实模型请求使用本机已登录的 Codex CLI。

## 开发与运行

需要 Node.js 24+；真实对话还需要已登录且支持相应 App Server 协议的 Codex CLI。
以下命令说明技术运行流程；代码使用权限以 LICENSE 为准。

~~~powershell
npm ci
npm run build
npm test
npm start
~~~

Windows 也可在构建后运行 start.cmd。默认本地工作区地址为 http://127.0.0.1:47832/ 。

在支持插件的 Codex 客户端中，将项目目录注册为本地插件市场并添加插件：

~~~powershell
codex plugin marketplace add .
codex plugin add codex-branch-canvas@branch-canvas-local
~~~

然后在聊天右侧“＋”菜单打开“对话树”。客户端版本及入口可用性以实际安装为准。
首次更新后台后可能需要在设置中关闭再开启插件；仅更新界面时，关闭再打开标签页即可。

## 使用边界

- 自动跟随依赖宿主随工具请求传入当前聊天标识；缺失时会明确提示，不按最近活跃聊天猜测。
- 切换聊天后面板是否保持打开由 Codex 控制；如面板关闭，请在目标聊天重新打开。
- 导航使用聊天深链接，不保证定位到某条旧回答的精确滚动位置。
- 原生聊天与插件预览是不同显示方式，预览不复刻 Codex 的全部原生操作。
- 仅导入公开可见的用户消息与最终回答；不会输出模型内部私有推理。
- 真实模型讨论采用只读文件权限，不自动批准文件修改或额外权限；发起请求会消耗账号额度。
- 分支隔离聊天上下文，不回滚工作目录文件。

## 项目结构

src/ 后台与持久化；web/ 画布与插件界面；tests/ 合成回归用例；scripts/ 通用构建与启动工具。
desktop-patch/ 保留早期实验副本方案的源代码，不参与普通插件构建、安装或运行。
不分发 Codex 客户端二进制；该实验代码仅针对固定旧版本，不能作为当前安装步骤。

本仓库不包含用户聊天、SQLite 数据库、登录凭证、安装备份或现场截图。
环境变量 BRANCH_CANVAS_DB、BRANCH_CANVAS_CWD 可分别指定数据库与默认工作目录。

本项目独立开发，使用了 AI 辅助，不属于 OpenAI 官方产品。
