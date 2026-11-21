# Contributing to Lectern

Thanks for helping. Bug reports, ideas and pull requests are all welcome. This page explains how to set up a development environment, how to test a change and what a pull request needs.

## Principles

Lectern is a desktop client for the original Claude Code terminal app. The machine that runs a session keeps everything it already owns: sign-in, model requests, permissions and the conversation files. Lectern only reaches it through a local shell or the system's OpenSSH. Changes must keep that boundary:

- no API proxies, Agent SDK sessions or hidden model requests;
- no reading of Claude credentials or OAuth files;
- nothing installed or started on the remote machine besides tmux and Claude Code, and no listening ports;
- no telemetry and no uploads.

[docs/architecture.md](docs/architecture.md) (in Chinese) describes the design in more detail.

## Development setup

- Node.js 22.12 or later and npm (CI uses Node.js 24).
- macOS or Linux with tmux for the demo, the integration tests and the desktop end-to-end tests. On Windows you can type check, run the unit tests that do not need tmux, and build.
- Linux without a display: `xvfb-run` (package `xvfb`). The scripts use it automatically.
- Optional: python3 with Pillow on Linux for image thumbnails in the workspace; without it, a few end-to-end tests check placeholders instead. An installed `claude` for the three end-to-end tests that drive the real CLI against a local fake model (`foreground-shell-e2e`, `permission-ui-e2e`, `background-work-e2e`).

```bash
npm ci
npm run dev     # development window; renderer, main and preload reload on changes
npm run demo    # offline demo: real tmux, a simulated Claude (scripts/mock-claude.mjs), no model requests
```

## Common commands

| Task | Command |
| --- | --- |
| Type check | `npm run typecheck` |
| Unit and integration tests | `npm test` |
| One test file | `npx tsx --test tests/transcript-store.test.ts` |
| One test case | `npx tsx --test --test-name-pattern='rewind' tests/transcript-store.test.ts` |
| Production build | `npm run build`, then `npm start` |
| One desktop end-to-end test | `npm run build`, then `node scripts/<name>.mjs`, or `npm run test:all -- --only build,<name>` |
| Everything CI runs on Linux | `npm run test:all` (`--list` shows the steps) |
| Claude Code compatibility matrix | `npm run build`, then `npm run test:cc-matrix -- --versions latest` |
| Installer for this platform | `npm run dist` (written to `test-results/package/`) |
| README screenshots | `npm run build`, then `node scripts/readme-screenshots.mjs` |

## Testing

- **Run the tests related to your change locally.** That is usually the unit tests for the module you touched and the end-to-end test of the feature. The full suite (`npm run test:all` on Linux, plus type check and unit tests on macOS and Windows, and the compatibility matrix) runs on GitHub Actions before every release; maintainers can also start it by hand.
- **Unit tests** live in `tests/*.test.ts` and run with `node:test` through `tsx`. Some use a real tmux server or a loopback OpenSSH server. Recorded Claude Code screens and JSONL samples for parser tests are in `tests/fixtures/`.
- **Desktop end-to-end tests** are the scripts in `scripts/` that `npm run test:all -- --list` shows after `build`. They start the built app with Playwright, mostly in demo mode, and use a private tmux socket and temporary profiles, so your own tmux sessions and Claude Code history are never touched. Windows started by Playwright are transparent and do not take focus; set `LECTERN_SHOW_TEST_WINDOWS=1` to see them while debugging. Screenshots and logs go to `test-results/`.
- **No real model requests.** Tests use the simulated Claude of the demo or a loopback fake Anthropic API (the compatibility matrix in `scripts/cc-matrix/` runs real Claude Code releases against one). The only exceptions are the `npm run test:native*` scripts, which use your own Claude Code sign-in and send small real requests; run them only when you mean to.
- **The interface must stay correct in both languages.** End-to-end tests run in Chinese by default (`LECTERN_LOCALE=zh-CN`); `npm run test:i18n` checks the English interface.

## Making a change

- **One branch per change**, with tests for it: a unit test for logic, an end-to-end test for user-visible behavior. A bug fix should come with a test that fails without it.
- **Every interface string is written in Chinese and English.** Add it to the right file in `src/shared/locales/` as `['中文', 'English']` and show it with `t('namespace.key')` from `src/shared/i18n.ts`. `tsc` fails when the English text is missing, and `tests/i18n.test.ts` checks placeholders and that no Chinese text is left in UI code. Text that Lectern parses from Claude Code's own screens stays in English.
- **User-visible changes go in the release notes.** Add one sentence per change to the pending entry at the top of `src/shared/release-notes.ts` (create the entry above the current version if there is none), under `features` or `fixes`, as a `['中文', 'English']` pair. The in-app "What's new" dialog and the GitHub Release text are generated from it.
- **Keep the version as it is.** Maintainers bump the version and publish releases.
- Follow the style of the surrounding code; there is no separate lint step, `npm run typecheck` must pass.

## Privacy

The repository is public. Code, tests, fixtures, documentation and screenshots must not contain real names, companies, host names, IP addresses, e-mail addresses, personal paths or real conversation content. Use placeholders such as `example.com`, `192.0.2.x`, `dev` and `/home/dev`, and record test samples from throwaway sessions.

Before you commit, run:

```bash
node scripts/check-private-info.mjs
```

It checks tracked and new files (including readable text in images) for common patterns. Terms specific to you, such as your name or machine names, can go in a git-ignored `.private-info-denylist` file (one regular expression per line); they are then checked too but never committed.

## Screenshots

The pictures in the README come from `scripts/readme-screenshots.mjs`. It drives the offline demo with generic sample content and writes `docs/images/<name>-<locale>.png` in English and Chinese at 1440×900:

```bash
npm run build
node scripts/readme-screenshots.mjs                 # both languages
node scripts/readme-screenshots.mjs --locale en     # one language
```

Regenerate them when the interface changes noticeably, look at every picture before committing it, and keep each file at a few hundred KB.

## Commits and pull requests

- Keep each pull request to one topic and rebase it on the current `main`.
- Write commit messages that say what changed and why, in English, with a short first line.
- In the pull request, describe the change, list the tests you ran, and add before/after screenshots for interface changes.
- Make sure `Full PR validation` passes before merging. It covers the full offline test suite, the Claude Code compatibility matrix, and release installer builds and smoke tests for Linux, Windows and both Mac architectures.
- Download the Apple Silicon or Intel DMG from the Actions run summary. PR builds use an ad hoc signature without Apple notarization. Installers and checksums are retained for 30 days.
- Do not change the version number, the release workflow or signing settings in a feature pull request.

## Reporting bugs

Open an issue with the Lectern version (shown at the bottom of the sidebar), your operating system, the Claude Code version on the target machine, whether the machine is local or reached over SSH, and the steps to reproduce.

The diagnostics log (bottom left of the window) records what Lectern read and did, and can be replayed offline; [docs/diagnostics.md](docs/diagnostics.md) (in Chinese) explains how. By default it also stores the terminal screens and conversation text it read, so check it for private content before you share any of it.

## Project layout

| Path | Contents |
| --- | --- |
| `src/backend` | Local and SSH command execution, tmux, session discovery, history reading |
| `src/core` | JSONL decoding, terminal screen parsing, turning records into chat messages |
| `src/main` | Electron main process: preload bridge, settings storage, polling, updates |
| `src/renderer` | React interface: sidebar, chat, input box, file preview, terminal |
| `src/shared` | Types and helpers used on both sides, translations (`locales/`), release notes |
| `src/diagnostics` | Structured diagnostics log, raw capture and redaction |
| `scripts/` | Build and packaging scripts, end-to-end tests, the demo's simulated Claude, the compatibility matrix |
| `tests/` | Unit and integration tests and their recorded fixtures |
| `build/` | App icons and their source artwork |
| `docs/` | Architecture and diagnostics notes, README screenshots |

## Releases

Maintainers publish a release by updating the version in `package.json` and `package-lock.json`, turning the pending release notes entry into that version, and pushing a `vX.Y.Z` tag. The Release workflow then runs all tests and the compatibility matrix, builds the installers for macOS, Windows and Linux, writes `SHA256SUMS` and publishes the GitHub Release.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
