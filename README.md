<p align="center">
  <img src="build/icons/256x256.png" width="128" height="128" alt="Lectern icon">
</p>

<h1 align="center">Lectern</h1>

<p align="center">
  A desktop chat window for the Claude Code sessions on your computer and on your SSH machines.
</p>

<p align="center">
  <a href="https://github.com/sharinka0715/lectern/releases/latest"><img src="https://img.shields.io/github/v/release/sharinka0715/lectern?label=release" alt="Latest release"></a>
  <a href="https://github.com/sharinka0715/lectern/actions/workflows/release.yml"><img src="https://github.com/sharinka0715/lectern/actions/workflows/release.yml/badge.svg" alt="Release workflow"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/sharinka0715/lectern" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="macOS, Windows and Linux">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

![Lectern showing a Claude Code conversation](docs/images/chat-en.png)

Lectern runs the original Claude Code terminal app in tmux, on this computer or on a machine you reach over SSH, and shows each session as a chat you can read and type into. Sessions keep running after you quit Lectern, so you can pick them up again later.

Nothing extra is installed on the remote machine. Claude Code there keeps its own sign-in, model requests, permissions and conversation history; Lectern drives it through your local shell or the system's OpenSSH.

## Features

- **This computer and SSH machines.** The sidebar groups conversations by machine and project folder. SSH uses your `~/.ssh/config`, keys, agent and jump hosts, and on macOS and Linux you can enter passwords or one-time codes right in the app.
- **A chat view of the real Claude Code.** Replies appear while Claude writes them, with Markdown, code, tables, edit diffs and a one-line summary of each run of tool calls. The raw terminal is one click away, and you can take it over when you need to.
- **Split view.** Drag a conversation to an edge of the window to work on two side by side, each with its own input box, file preview and activity card.
- **History and resume.** Browse past conversations, scroll back through long ones and resume any of them on the machine where it ran. Rename, archive, rewind to an earlier message, `/compact` and `/fork` work as they do in Claude Code.
- **Background tasks.** An activity card shows repository changes, subagents, background shells and monitors. Any of them opens in the background tasks column beside the chat, grouped by kind: a subagent shows its own conversation, a shell or monitor its full command and live output (or the file it redirected its output to).
- **File preview.** File names in replies become links. Preview code with syntax highlighting, Markdown, images, PDFs, audio, video and Office documents, or browse folders, locally or over SSH.
- **Comfortable input.** Type `@` to mention project files and `/` for commands and skills. Drag in, paste or pick files and screenshots; they show as cards in the input box and in the sent message, and are uploaded to the SSH machine when needed. Queue a message or steer a reply that is still running.
- **Permission and question cards.** Allow or deny tool calls, trust a folder and answer Claude's questions without leaving the chat.
- **Auto mode by default.** New and resumed conversations start in Claude Code's auto mode, without changing your settings files. If you turn auto mode off with `permissions.disableAutoMode`, tools are confirmed on permission cards instead.
- **Model, effort and usage at a glance.** Switch model and effort from the input box. Below it you see the permission mode, context use, prompt cache time and subscription usage.
- **Host check.** Lectern checks each machine for tmux and Claude Code and, when one is missing, shows install commands for that system.
- **Update check.** Lectern looks for new releases on GitHub and asks before downloading. Downloads are verified against `SHA256SUMS` and never installed automatically.
- **English and Simplified Chinese.** Lectern follows the system language; switch it any time in Settings › Appearance.
- **Private.** No telemetry. Apart from the update check on GitHub, Lectern only talks to your own machines. Lectern does not read Claude credentials, and remote images in Markdown are not loaded.
- **Conversation sorting.** Browse chats by project, or sort chats across all local and SSH projects by last update. The active-first view puts replies, confirmations, and background work ahead of other chats.

## Screenshots

**Split view**: two conversations side by side.

![Two conversations in a split view](docs/images/split-en.png)

**Background tasks**: the activity card, and the background tasks column with a shell's command and output.

![The activity card and the background tasks column](docs/images/tasks-en.png)

**File preview**: open a file named in a reply.

![A file preview beside the chat](docs/images/preview-en.png)

## Requirements

- **Lectern** runs on macOS (Apple silicon or Intel), Windows 10 or later (x64) and Linux (x64).
- **Each machine that runs sessions**, whether this computer or an SSH machine, needs macOS or Linux with a POSIX shell, [tmux](https://github.com/tmux/tmux/wiki/Installing) and [Claude Code](https://code.claude.com/docs/en/setup). Run `claude` once in an ordinary terminal there to sign in and finish the first-run setup. Claude Code 2.1.300 or later is recommended; it is the oldest version tested.
- **SSH** uses the system's OpenSSH client and your existing configuration. Nothing else is installed on the remote side.
- **Windows:** Lectern for Windows connects only to macOS or Linux machines over SSH; it has no local sessions and does not use WSL. It has no in-app SSH sign-in either, so use key-based authentication and connect once in a terminal to accept a new host key.

## Install

Download the installer for your system from the [latest release](https://github.com/sharinka0715/lectern/releases/latest):

| System | File |
| --- | --- |
| macOS, Apple silicon | `lectern-<version>-mac-arm64.dmg` |
| macOS, Intel | `lectern-<version>-mac-x64.dmg` |
| Windows | `lectern-<version>-win-x64.exe` |
| Linux | `lectern-<version>-linux-x86_64.AppImage` or `lectern-<version>-linux-amd64.deb` |

The installers are not signed with a developer certificate yet, so your system asks before opening Lectern the first time:

- **macOS:** open the DMG and drag Lectern to Applications. If macOS says it cannot verify the app, open **System Settings › Privacy & Security** and click **Open Anyway**. Alternatively run `xattr -dr com.apple.quarantine /Applications/Lectern.app` once.
- **Windows:** if SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux:** make the AppImage executable (`chmod +x lectern-*.AppImage`) and run it, or install the DEB with `sudo apt install ./lectern-<version>-linux-amd64.deb`.

To verify a download, put it in the same folder as `SHA256SUMS` from the release and run:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum -c SHA256SUMS --ignore-missing       # Linux
```

On Windows, compare the output of `Get-FileHash .\lectern-<version>-win-x64.exe` with the line for that file in `SHA256SUMS`.

Lectern checks for new versions after it starts and every few hours (Settings › Updates turns this off). It asks before downloading, and you install the new version yourself.

## Getting started

1. On each machine where you want to run sessions, install tmux and Claude Code, then run `claude` once in a terminal to sign in.
2. Open Lectern. The first screen offers **Scan local folders**, **Add a local folder** and **Add an SSH connection**.
3. For an SSH machine, click **+ SSH** next to **Machines** and enter a host alias from `~/.ssh/config` or `user@hostname`, or use **Import from ~/.ssh/config**. If the machine asks for a password, a one-time code or a new host key, click **Sign in** next to it.
4. Click the folder icon next to a machine to add a project folder on it.
5. Start a conversation with **New conversation** (⌘N or Ctrl+N), or open a past one and click **Resume**.

An SSH host alias is the usual OpenSSH configuration, for example:

```sshconfig
Host devbox
  HostName devbox.example.com
  User dev
  IdentityFile ~/.ssh/id_ed25519
```

Conversations keep running in tmux after you quit Lectern. **Close conversation** ends the Claude Code process; closing a split pane only closes the view.

Lectern manages tmux sessions whose names start with `lectern-` and leaves your other tmux windows alone. To hand a Claude Code session you start yourself over to Lectern, run it inside `tmux new -s lectern-<name>`.

The dot after a conversation in the sidebar shows its state:

| Dot | Meaning |
| --- | --- |
| None | History only, nothing to do |
| Green | Claude Code is running for this conversation |
| Blinking green | Claude is replying (steady when the system asks for reduced motion) |
| Orange | Waiting for your input, a permission or a prompt |
| Red | A connection or session problem |
| Blue | A new reply you have not read yet |

## Build from source

You need Node.js 22.12 or later and npm. The demo and the tests also need tmux (macOS or Linux).

```bash
git clone https://github.com/sharinka0715/lectern.git
cd lectern
npm ci
npm run dev     # development window that reloads on changes
npm run demo    # offline demo: real tmux and a simulated Claude, no model requests
npm run build   # type check and production build; then `npm start`
npm run dist    # installer for this platform, written to test-results/package/
```

The demo uses its own temporary folder and tmux server and cannot touch your real conversations. Start the app with `npm start` (or the installed app) to add real folders.

## Contributing

Bug reports, ideas and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; it covers the development setup, tests and what a pull request needs. How Lectern works inside is described in [docs/architecture.md](docs/architecture.md), and [docs/diagnostics.md](docs/diagnostics.md) explains the diagnostics log that helps with bug reports (both in Chinese).

## Acknowledgements

The tmux control, JSONL history and session binding ideas were inspired by [edemko/claude-chat](https://github.com/edemko/claude-chat). Lectern is a separate implementation and does not include its hub, PWA, Codex support, account system or remote installer. Launch options follow the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

Lectern is an independent project and is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

[MIT](LICENSE)
