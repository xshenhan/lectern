<p align="center">
  <img src="build/icons/256x256.png" width="128" height="128" alt="Lectern 图标">
</p>

<h1 align="center">Lectern</h1>

<p align="center">
  在桌面上，用聊天窗口操作本机和 SSH 机器上的 Claude Code 会话。
</p>

<p align="center">
  <a href="https://github.com/sharinka0715/lectern/releases/latest"><img src="https://img.shields.io/github/v/release/sharinka0715/lectern?label=release" alt="最新版本"></a>
  <a href="https://github.com/sharinka0715/lectern/actions/workflows/release.yml"><img src="https://github.com/sharinka0715/lectern/actions/workflows/release.yml/badge.svg" alt="发行工作流"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/sharinka0715/lectern" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="macOS、Windows 和 Linux">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

![Lectern 中的 Claude Code 对话](docs/images/chat-zh-CN.png)

Lectern 在本机或通过 SSH 连接的机器上，用 tmux 运行原版 Claude Code 终端程序，再把每个会话显示成可以阅读、可以输入的聊天窗口。退出 Lectern 后会话继续运行，之后随时回来接着用。

远端机器不需要额外安装任何东西。那里的 Claude Code 照旧负责登录、模型请求、权限确认和会话记录；Lectern 只通过本机 shell 或系统自带的 OpenSSH 操作它。

## 功能

- **本机和 SSH 机器。** 侧栏按机器和项目文件夹归类对话。SSH 沿用你的 `~/.ssh/config`、密钥、agent 和跳板机，在 macOS 和 Linux 上，需要密码或动态验证码时可以直接在应用里输入。
- **原版 Claude Code 的聊天视图。** 回复边写边显示，支持 Markdown、代码、表格、编辑差异，连续的工具调用汇总成一行。原始终端画面随时可看，需要时还可以接管终端直接操作。
- **分屏。** 把对话拖到窗口边缘，即可左右或上下并排处理两个对话，各有自己的输入框、文件预览和活动卡片。
- **历史与续接。** 浏览历史对话，向上翻阅很长的记录，在原来的机器上续接任意对话。改名、归档、回退到之前的消息、`/compact` 和 `/fork` 都与 Claude Code 中一致。
- **后台任务。** 活动卡片汇总仓库变更、子代理、终端和监控；它们都能在聊天旁边的「后台任务」栏里按类别打开查看：子代理显示它自己的对话，终端和监控显示完整命令和实时输出（输出重定向到文件时显示那个文件）。
- **文件预览。** 回复里的文件名会变成链接。可以预览带语法高亮的代码、Markdown、图片、PDF、音视频和 Office 文档，也可以浏览文件夹，本机和 SSH 都可以。
- **顺手的输入框。** 输入 `@` 引用项目文件，输入 `/` 查找命令和技能；拖入、粘贴或选择的文件和截图在输入框和发出的消息里显示为附件卡片，SSH 机器上会自动上传；回复进行中也可以把消息加入队列，或立即引导。
- **权限卡与问答卡。** 不离开聊天就能允许或拒绝工具调用、信任目录、回答 Claude 的提问。
- **默认 auto mode。** 新建和续接的对话默认以 Claude Code 的 auto mode 启动，不修改你的设置文件。用 `permissions.disableAutoMode` 关闭 auto mode 后，工具调用改由权限卡确认。
- **模型、推理强度与用量一目了然。** 在输入框里切换模型和推理强度，下方显示权限模式、上下文占用、提示缓存剩余时间和订阅额度。
- **主机检查。** Lectern 会检查每台机器上的 tmux 和 Claude Code，缺少时按该机器的系统给出安装命令。
- **更新检查。** Lectern 会检查 GitHub 上的新版本，下载前先询问。下载的安装包按 `SHA256SUMS` 校验，绝不自动安装。
- **简体中文和英文。** 默认跟随系统语言，可随时在「设置 → 外观」切换。
- **注重隐私。** 没有遥测。除了到 GitHub 检查更新，Lectern 只与你自己的机器通信。Lectern 不读取 Claude 的登录凭据，也不加载 Markdown 中的远程图片。

## 截图

**分屏**：两个对话并排显示。

![分屏中的两个对话](docs/images/split-zh-CN.png)

**后台任务**：活动卡片，以及显示终端命令和输出的「后台任务」栏。

![活动卡片和后台任务栏](docs/images/tasks-zh-CN.png)

**文件预览**：打开回复中提到的文件。

![聊天旁边的文件预览](docs/images/preview-zh-CN.png)

## 系统要求

- **Lectern 本身**可运行在 macOS（Apple 芯片或 Intel）、Windows 10 及以上（x64）和 Linux（x64）。
- **运行会话的机器**（本机或 SSH 机器）需要是 macOS 或 Linux，带 POSIX shell，并已安装 [tmux](https://github.com/tmux/tmux/wiki/Installing) 和 [Claude Code](https://code.claude.com/docs/en/setup)。请先在那台机器的普通终端里运行一次 `claude`，完成登录和首次设置。建议使用 Claude Code 2.1.300 或更新版本，这是测试过的最早版本。
- **SSH** 使用系统自带的 OpenSSH 客户端和你现有的配置，远端无需安装其他东西。
- **Windows：** Windows 版只能通过 SSH 连接 macOS 或 Linux 机器，没有本机会话，也不使用 WSL。Windows 版暂不支持在应用内登录 SSH，请使用密钥认证，并先在终端里连接一次以确认新主机的指纹。

## 下载安装

从 [最新发行版](https://github.com/sharinka0715/lectern/releases/latest) 下载对应系统的安装包：

| 系统 | 文件 |
| --- | --- |
| macOS（Apple 芯片） | `lectern-<版本>-mac-arm64.dmg` |
| macOS（Intel） | `lectern-<版本>-mac-x64.dmg` |
| Windows | `lectern-<版本>-win-x64.exe` |
| Linux | `lectern-<版本>-linux-x86_64.AppImage` 或 `lectern-<版本>-linux-amd64.deb` |

安装包暂未使用开发者证书签名，第一次打开时系统会询问：

- **macOS：** 打开 DMG，把 Lectern 拖进「应用程序」。如果提示无法验证该应用，打开「系统设置 → 隐私与安全性」，点「仍要打开」；也可以执行一次 `xattr -dr com.apple.quarantine /Applications/Lectern.app`。
- **Windows：** 如果 SmartScreen 提示「Windows 已保护你的电脑」，点「更多信息」，再点「仍要运行」。
- **Linux：** 给 AppImage 加上执行权限（`chmod +x lectern-*.AppImage`）后直接运行，或用 `sudo apt install ./lectern-<版本>-linux-amd64.deb` 安装 DEB。

校验下载的文件：把它和同一发行版中的 `SHA256SUMS` 放在同一个文件夹，然后运行：

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum -c SHA256SUMS --ignore-missing       # Linux
```

Windows 上可以把 `Get-FileHash .\lectern-<版本>-win-x64.exe` 的输出与 `SHA256SUMS` 中对应的一行比对。

Lectern 启动后和之后每隔几小时检查一次新版本（可在「设置 → 更新」关闭）。下载前会先询问，新版本由你自己安装。

## 快速上手

1. 在要运行会话的每台机器上安装 tmux 和 Claude Code，并在终端里运行一次 `claude` 完成登录。
2. 打开 Lectern。首次启动的主界面提供「扫描本机目录」「添加本机文件夹」「添加SSH远程连接」三个入口。
3. 添加 SSH 机器：点侧栏「机器」旁的「+ SSH」，填写 `~/.ssh/config` 里的主机别名或 `user@hostname`，也可以用「从 ~/.ssh/config 导入」。机器需要密码、动态验证码或确认新主机指纹时，点机器旁的「登录」。
4. 点机器右侧的文件夹图标，添加这台机器上的项目文件夹。
5. 点「新建对话」（⌘N 或 Ctrl+N）开始对话，或打开历史对话后点「续接会话」。

点侧栏的「对话排序」，可按更新时间或对话优先级排列。优先级排序会把需要处理或正在运行的对话放在历史对话前面。

在 macOS 或 Linux 上，安装 [Codex CLI](https://developers.openai.com/codex/cli/) 并运行 `codex login` 登录。选中本机文件夹，点击对话工具栏里的 **Codex**，即可新建或继续在 Lectern 中创建的 Codex 会话。面板支持流式回复、停止回复，以及允许或拒绝命令和文件修改。关闭面板后回复继续运行，退出 Lectern 会中断正在进行的 Codex 回复。

SSH 主机别名就是普通的 OpenSSH 配置，例如：

```sshconfig
Host devbox
  HostName devbox.example.com
  User dev
  IdentityFile ~/.ssh/id_ed25519
```

退出 Lectern 后，对话仍在 tmux 中运行。「关闭对话」会结束 Claude Code 进程；关闭分屏只是关掉这个视图。

Lectern 只管理名称以 `lectern-` 开头的 tmux 会话，不会碰你自己开的其他 tmux 窗口。想把自己启动的 Claude Code 交给 Lectern，可以在 `tmux new -s lectern-<名称>` 里运行它。

侧栏对话右侧的圆点表示状态：

| 圆点 | 含义 |
| --- | --- |
| 无 | 只有历史记录，没有需要处理的事 |
| 绿色 | 这个对话的 Claude Code 正在运行 |
| 闪烁的绿色 | Claude 正在回复（系统要求减少动态效果时不闪烁） |
| 橙色 | 等待你输入、授权或处理提示 |
| 红色 | 连接或会话出了问题 |
| 蓝色 | 有尚未阅读的新回复 |

## 从源码构建

需要 Node.js 22.12 或更新版本和 npm。演示模式和测试还需要 tmux（macOS 或 Linux）。

```bash
git clone https://github.com/sharinka0715/lectern.git
cd lectern
npm ci
npm run dev     # 开发窗口，改动后自动重新加载
npm run demo    # 离线演示：真实 tmux 加模拟的 Claude，不发模型请求
npm run build   # 类型检查并构建生产版本，之后用 `npm start` 运行
npm run dist    # 打包当前平台的安装包，输出到 test-results/package/
```

演示模式使用独立的临时目录和 tmux 服务器，碰不到你真实的对话。要添加真实的文件夹，请用 `npm start` 或安装好的应用启动。

## 参与贡献

欢迎报告问题、提出想法和提交 Pull Request。动手前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（英文），其中说明了开发环境、测试方式和 PR 要求。内部实现见 [docs/architecture.md](docs/architecture.md)；报告问题时可以参考 [docs/diagnostics.md](docs/diagnostics.md) 使用诊断日志。

## 致谢

tmux 控制、JSONL 历史和会话绑定的思路参考了 [edemko/claude-chat](https://github.com/edemko/claude-chat)。Lectern 是独立实现，没有引入它的 hub、PWA、Codex 支持、账户系统或远程安装流程。启动参数以 [Claude Code CLI 文档](https://code.claude.com/docs/en/cli-reference) 为依据。

Lectern 是独立项目，与 Anthropic 没有隶属或背书关系。Claude 和 Claude Code 是 Anthropic 的商标。

## 许可证

[MIT](LICENSE)
