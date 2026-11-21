// Feature scenarios for the compatibility matrix. Each scenario drives the
// desktop app against the real CLI and scripts the fake model through
// `api.script(name, fn)`; prompts carry `ccm:<name>` so the model knows which
// script answers. Rows (features) are what the coverage table reports.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { sel } from './app.mjs';
import { API_KEY, descendants, readJsonl, reap } from './sandbox.mjs';
import { textOf } from './fake-api.mjs';
import { compareVersions } from './versions.mjs';

export const FEATURES = [
  { id: 'model-catalog', title: 'Model/effort lists from the stream-json control-request probe' },
  { id: 'launch-flags', title: 'New chat launches with the chosen --model/--effort' },
  { id: 'first-prompt', title: 'First prompt delivered once the native composer is ready' },
  { id: 'final-transcript', title: 'Final reply from the JSONL transcript' },
  { id: 'auto-mode-new', title: 'A new chat starts in auto mode (status bar)' },
  { id: 'auto-mode-user-manual', title: 'Auto mode even when the user\'s own default is manual, no blocking prompt' },
  { id: 'manual-fallback', title: 'Auto mode turned off (disableAutoMode): manual mode, permission cards' },
  { id: 'auto-mode-confirm', title: 'Auto mode asks after blocked actions: permission card with its reason' },
  { id: 'auto-mode-billing', title: 'Classifier billing notice (server check not passed through, before 2.1.321): card, cancel stops the turn, continue runs the action' },
  { id: 'auto-mode-unavailable', title: "Auto mode can't check actions (server check not passed through, 2.1.321+): card, stay, then the tool's own permission card" },
  { id: 'auto-mode-unavailable-leave', title: "Auto mode can't check actions: leave for accept edits mode from the card, the session goes on" },
  { id: 'trust-card', title: 'Directory trust prompt answered from the trust card' },
  { id: 'onboarding', title: 'Fresh config: first message waits for API-key approval and trust' },
  { id: 'streaming-preview', title: 'Streaming preview from the screen, then the JSONL reply' },
  { id: 'running-state', title: 'Running state detected (stop button, busy row)' },
  { id: 'tool-bash', title: 'Bash tool row with result' },
  { id: 'tool-read', title: 'Read tool row' },
  { id: 'tool-write', title: 'Write tool row (file created)' },
  { id: 'tool-edit', title: 'Edit tool row (file changed)' },
  { id: 'tool-error', title: 'Failed tool shown as an error' },
  { id: 'permission-allow', title: 'Permission card: allow' },
  { id: 'permission-deny', title: 'Permission card: deny (reply marked interrupted)' },
  { id: 'question-single', title: 'AskUserQuestion: single question' },
  { id: 'question-multi', title: 'AskUserQuestion: multi-question form with review' },
  { id: 'question-single-long', title: 'AskUserQuestion: one long wrapped CJK question after a long preamble, wrapped option descriptions, named session' },
  { id: 'question-review-long', title: 'AskUserQuestion: review of long wrapped CJK questions in a named session (submit, cancel)' },
  { id: 'thinking', title: 'Thinking folded into a thought row' },
  { id: 'tasks', title: 'Task list tool (TodoWrite / TaskCreate)' },
  { id: 'queue', title: 'Queue a message during a reply' },
  { id: 'steer', title: 'Steer (send now) during a reply' },
  { id: 'interrupt', title: 'Interrupt a reply (stop button)' },
  { id: 'compact', title: '/compact with a message queued during compaction' },
  { id: 'rename', title: 'Rename a running session (/rename)' },
  { id: 'session-settings', title: 'Switch model and effort in a running session' },
  { id: 'statusline', title: 'Status line: model, context usage, billing route' },
  { id: 'background', title: 'Background shell and subagent ("running in background")' },
  { id: 'background-settings', title: 'Model and effort switched from the pickers after the reply while a background subagent still runs' },
  { id: 'subagent-column', title: "Subagent column: the subagent's own JSONL found, its turns shown live" },
  { id: 'subagent-resume', title: 'Subagent column: a SendMessage resume runs again with its new messages' },
  { id: 'subagent-listed', title: 'Subagents listed from their meta files on opening, their launches on a page not loaded (2.1.310+)' },
  { id: 'subagent-process-gone', title: 'A running subagent is no longer shown running once its conversation\'s process is gone (2.1.310+)' },
  { id: 'subagent-elsewhere', title: 'A subagent of the session resumed outside Lectern\'s panes shows running while that process lives (2.1.310+)' },
  { id: 'task-shell-output', title: "Task column: a background shell's command and its output file, appended while it runs" },
  { id: 'task-redirect-output', title: 'Task column: a background shell that redirected into a file shows that file' },
  { id: 'task-monitor-output', title: "Task column: a monitor's output file (where Monitor is offered)" },
  { id: 'close-in-place', title: 'Close conversation: the transcript stays mounted and turns into history' },
  { id: 'history-paging', title: 'Reopen a closed session: first page, then older history' },
  { id: 'resume', title: 'Resume a closed session (--resume) and continue' },
  { id: 'auto-mode-resume', title: 'A resumed session starts in auto mode (status bar)' },
  { id: 'rename-inactive', title: 'Rename a closed session (temporary resume)' },
  { id: 'attachment', title: 'Image attachment (@path) sent and shown' },
  { id: 'isolation', title: 'No request left the sandbox' },
  { id: 'cleanup', title: 'Nothing left running after the run' },
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settingTrigger = kind => `.session-settings:not(.draft-settings) [data-setting-kind="${kind}"]`;

/** Pick an option of the composer's model or effort picker that matches `wanted` (patterns in order
 * of preference) and is not current. */
async function pickSetting({ page, note }, kind, wanted) {
  await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, settingTrigger(kind), { timeout: 30_000 });
  await page.locator(settingTrigger(kind)).click();
  const menu = page.locator(`.session-settings:not(.draft-settings) [data-setting-menu="${kind}"]`);
  await menu.locator('.setting-option').first().waitFor({ timeout: 30_000 });
  const options = await menu.locator('.setting-option').evaluateAll(els => els.map(el => ({ id: el.dataset.optionId, text: el.textContent, current: el.dataset.current === 'true', disabled: el.disabled })));
  note(`${kind}-options`, options.map(o => o.text.slice(0, 40)));
  const option = [wanted].flat().map(pattern => options.find(o => !o.current && !o.disabled && pattern.test(o.text))).find(Boolean);
  assert.ok(option, `no ${wanted} option among ${JSON.stringify(options)}`);
  await menu.locator(`.setting-option[data-option-id="${option.id}"]`).click();
  await menu.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
  return option;
}
/** The status in the native record (`<config>/sessions/<pid>.json`) of the process running `sessionId`. */
async function nativeStatus(sandbox, sessionId) {
  const dir = path.join(sandbox.config, 'sessions');
  for (const name of await readdir(dir).catch(() => [])) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (record?.sessionId === sessionId) return record.status ?? null;
    } catch {}
  }
}
/** `read()` again every `every` ms until `done(value)` or `ms` pass; the last value read. For files
 * Claude Code writes on its own schedule: a request reaching the fake API does not mean the
 * transcript (or a subagent's file) on disk has caught up with it. */
async function poll(read, done, ms = 20_000, every = 200) {
  for (const end = Date.now() + ms; ; await delay(every)) {
    const value = await read();
    if (done(value) || Date.now() >= end) return value;
  }
}
/** Close a tmux session the harness opened and wait until every process it ran has exited (exact
 * PIDs, as sandbox.close does); the ones that had to be stopped are returned. */
async function closeOwnSession(sandbox, name) {
  const root = Number(sandbox.tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_pid}').trim());
  const tracked = root > 1 ? descendants(root) : [];
  sandbox.tmux('kill-session', '-t', `=${name}`);
  return reap(tracked);
}
/** Whether the global config is whole JSON that still approves the sandbox's API key. */
async function apiKeyApproval(sandbox) {
  const text = await readFile(path.join(sandbox.config, '.claude.json'), 'utf8').catch(error => `unreadable: ${error.code}`);
  try {
    const approved = JSON.parse(text).customApiKeyResponses?.approved ?? [];
    return { ok: approved.includes(API_KEY.slice(-20)), approved };
  } catch (error) { return { ok: false, error: `not JSON (${error.message})`, bytes: text.length }; }
}

/** A new chat in `folder` whose first message is `prompt`; resolves once Claude
 * Code has the message (it is in the transcript). */
async function startChat({ ui }, folder, prompt) {
  await ui.openDraft(folder.name);
  await ui.send(prompt);
  await ui.waitUser(prompt, 90_000);
}
/** The permission mode the status bar reports for the active chat. */
async function waitMode(page, mode, timeout = 30_000) {
  await page.waitForFunction(wanted => document.querySelector('.session-execution-mode')?.getAttribute('data-execution-mode') === wanted, mode, { timeout })
    .catch(async error => { throw new Error(`status bar mode ${await page.locator('.session-execution-mode').getAttribute('data-execution-mode').catch(() => '?')}, wanted ${mode}: ${error.message}`); });
}
const paragraph = 'The compatibility matrix streams this reply slowly so the desktop app can show it from the terminal before Claude Code writes the transcript. ';

/** Folders the app starts with. `main` pre-approves the file tools; `perm` turns
 * auto mode off and asks for every tool; `fresh` is not trusted yet; `onboard` uses
 * its own, barely used Claude configuration whose user prefers manual mode.
 * Lectern leaves auto mode's check on the server, which the fake API (a gateway to
 * Claude Code) never runs. The sandbox's configuration therefore sets
 * CLAUDE_CODE_AUTO_MODE_SERVER=0, so Claude Code checks actions itself and the
 * scenarios test what they are about (`onboard`, with a configuration of its own, only
 * gets plain replies). `server` has its own configuration without the variable: the
 * product's default path, which ends in a dialog (scenario server-check). */
export async function prepareFolders(sandbox) {
  const main = sandbox.work;
  const perm = path.join(sandbox.root, 'perm-work');
  const fresh = path.join(sandbox.root, 'fresh-work');
  // Background tasks run without permission questions: auto mode off, the tools allowed.
  const tasks = path.join(sandbox.root, 'tasks-work');
  const onboard = path.join(sandbox.root, 'onboard-work'), onboardConfig = path.join(sandbox.root, 'onboard-config');
  const server = path.join(sandbox.root, 'server-work'), serverConfig = path.join(sandbox.root, 'server-config');
  for (const dir of [perm, fresh, onboard, onboardConfig, server, serverConfig, path.join(tasks, '.claude')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(tasks, '.claude', 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable', allow: ['Bash', 'Monitor', 'ToolSearch', 'TaskStop'] } }));
  // Onboarding itself (theme, connectivity check against api.anthropic.com) cannot run
  // offline; this configuration has finished it and nothing else: the API key is not
  // approved yet and no folder is trusted.
  await writeFile(path.join(onboardConfig, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: sandbox.version, theme: 'dark' }));
  // ... and its user has chosen manual mode as the default (which makes Claude Code
  // offer "Make auto mode your default permission mode?" at startup).
  await writeFile(path.join(onboardConfig, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
  // The permission folder turns auto mode off, Claude Code's documented opt-out
  // (permissions.disableAutoMode): sessions there start in manual mode and ask.
  await mkdir(path.join(perm, '.claude'), { recursive: true });
  await writeFile(path.join(perm, '.claude', 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' } }));
  await mkdir(path.join(main, '.claude'), { recursive: true });
  await writeFile(path.join(main, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'] } }, null, 2));
  // Trust the permission folder too (the sandbox only seeded `main`).
  const configFile = path.join(sandbox.config, '.claude.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.projects[perm] = { ...config.projects[main] };
  config.projects[tasks] = { ...config.projects[main] };
  await writeFile(configFile, JSON.stringify(config, null, 2));
  // The same first-run state for `server` (onboarded, API key approved, folder trusted) and
  // the same settings, but not the variable that moves auto mode's check off the server.
  const settingsFile = path.join(sandbox.config, 'settings.json'), settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(path.join(serverConfig, '.claude.json'), JSON.stringify({ ...config, projects: { [server]: { ...config.projects[main] } } }, null, 2));
  await writeFile(path.join(serverConfig, 'settings.json'), JSON.stringify(settings, null, 2));
  await writeFile(settingsFile, JSON.stringify({ ...settings, env: { CLAUDE_CODE_AUTO_MODE_SERVER: '0' } }, null, 2));
  return {
    main: { id: 'ccm-main', name: 'ccm-main', cwd: main },
    perm: { id: 'ccm-perm', name: 'ccm-perm', cwd: perm },
    fresh: { id: 'ccm-fresh', name: 'ccm-fresh', cwd: fresh },
    tasks: { id: 'ccm-tasks', name: 'ccm-tasks', cwd: tasks },
    onboard: { id: 'ccm-onboard', name: 'ccm-onboard', cwd: onboard, claudeDir: onboardConfig },
    server: { id: 'ccm-server', name: 'ccm-server', cwd: server, claudeDir: serverConfig },
  };
}

export const SCENARIOS = [
  {
    id: 'new-chat',
    features: ['model-catalog', 'launch-flags', 'first-prompt', 'final-transcript', 'auto-mode-new'],
    timeoutMs: 150_000,
    async run({ ui, page, api, sandbox, folders, check, note }) {
      api.script('hello', () => ({ text: 'Hello from the fake model (ccm-hello-reply).' }));
      await ui.openDraft(folders.main.name);
      let chosen = {};
      await check('model-catalog', async () => {
        await page.waitForFunction(() => document.querySelector('[data-draft-settings]')?.getAttribute('data-draft-settings') !== 'loading', null, { timeout: 90_000 });
        const state = await page.locator('[data-draft-settings]').getAttribute('data-draft-settings');
        assert.equal(state, 'ready', 'the model list probe failed');
        await page.locator('[data-setting-kind="model"]').click();
        const options = await page.locator('[data-setting-menu="model"] .setting-option').evaluateAll(els => els.map(el => el.dataset.optionValue));
        note('models', options);
        assert.ok(options.filter(Boolean).length >= 2, `model list: ${JSON.stringify(options)}`);
        chosen.model = options.find(value => /haiku/i.test(value)) ?? options.find(value => /sonnet/i.test(value)) ?? options.filter(Boolean).at(-1);
        await page.locator(`[data-setting-menu="model"] .setting-option[data-option-value="${chosen.model}"]`).click();
        await page.locator('[data-setting-kind="effort"]').click();
        const efforts = await page.locator('[data-setting-menu="effort"] .setting-option').evaluateAll(els => els.map(el => el.dataset.optionValue));
        note('efforts', efforts);
        chosen.effort = efforts.find(value => value === 'high') ?? efforts.filter(Boolean)[0];
        if (chosen.effort) await page.locator(`[data-setting-menu="effort"] .setting-option[data-option-value="${chosen.effort}"]`).click();
        else await page.keyboard.press('Escape');
      });
      await ui.send('Say hello ccm:hello');
      await check('first-prompt', async () => {
        await ui.waitUser('Say hello ccm:hello', 90_000);
        assert.equal(api.requests.filter(r => r.script === 'hello').length >= 1, true);
      });
      await check('final-transcript', async () => {
        await ui.waitReply('ccm-hello-reply');
        const users = (await ui.transcript()).filter(m => m.role === 'user');
        assert.equal(users.filter(m => m.text.includes('ccm:hello')).length, 1, 'the first prompt is shown once');
      });
      await check('auto-mode-new', async () => {
        await waitMode(page, 'auto');
        // From the per-process settings, not --permission-mode (ps splits argv on spaces on macOS).
        const command = (await ui.claudeArgv()).join(' ');
        assert.match(command, /"permissions":\{"defaultMode":"auto"\}/, 'auto mode comes from the per-process settings');
        assert.doesNotMatch(command, /--permission-mode/);
      });
      await check('launch-flags', async () => {
        if (!chosen.model) return { skip: 'no model list' };
        const argv = await ui.claudeArgv();
        note('launch', argv.filter(arg => !arg.startsWith('{')).join(' '));
        assert.equal(argv[argv.indexOf('--model') + 1], chosen.model, 'the --model value');
        if (chosen.effort) assert.equal(argv[argv.indexOf('--effort') + 1], chosen.effort, 'the --effort value');
        const request = api.requests.find(r => r.script === 'hello');
        note('request-model', request.model);
        assert.ok(request.model && (request.model.includes(chosen.model) || chosen.model.length < 12 && request.model.includes(chosen.model.replace(/\[.*\]$/, ''))), `request model ${request.model} vs ${chosen.model}`);
      });
    },
  },
  {
    id: 'trust',
    features: ['trust-card'],
    timeoutMs: 120_000,
    async run({ ui, page, api, sandbox, folders, check }) {
      api.script('trust', () => ({ text: 'Answered in a newly trusted folder (ccm-trust-reply).' }));
      await check('trust-card', async () => {
        await ui.openDraft(folders.fresh.name);
        await ui.send('Hello from a new folder ccm:trust');
        const card = page.locator(sel.trust);
        await card.waitFor({ timeout: 60_000 });
        assert.equal(await card.getAttribute('data-directory-trust-cwd'), folders.fresh.cwd);
        await card.locator('[data-trust-decision="trust"]').click();
        await ui.waitReply('ccm-trust-reply', { timeout: 60_000 });
        const config = JSON.parse(await readFile(path.join(sandbox.config, '.claude.json'), 'utf8'));
        assert.equal(config.projects?.[folders.fresh.cwd]?.hasTrustDialogAccepted, true, 'Claude Code saved the trust decision');
      });
    },
  },
  {
    id: 'onboarding',
    features: ['onboarding', 'auto-mode-user-manual'],
    timeoutMs: 180_000,
    async run({ ui, page, api, sandbox, folders, check, note }) {
      api.script('onboard', () => ({ text: 'First run complete (ccm-onboard-done).' }));
      await check('onboarding', async () => {
        await ui.openDraft(folders.onboard.name);
        await ui.send('Hello on first run ccm:onboard');
        // Answer each native first-run screen in the terminal, as a user would;
        // the directory trust prompt is answered from the app's own card.
        const seen = [];
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          if (await page.locator(sel.assistant).filter({ hasText: 'ccm-onboard-done' }).count()) break;
          if (await page.locator(sel.trust).count() && !seen.includes('trust-card')) {
            seen.push('trust-card');
            await page.locator(`${sel.trust} [data-trust-decision="trust"]`).click();
          }
          const pane = await ui.pane();
          const screen = sandbox.capture(pane);
          const answer = firstRunAnswer(screen);
          if (answer) {
            if (seen.at(-1) !== answer.name) seen.push(answer.name);
            for (const key of answer.keys) { sandbox.tmux('send-keys', '-t', pane, key); await delay(250); }
            await delay(700);
          } else await delay(400);
        }
        note('screens', seen);
        await ui.waitReply('ccm-onboard-done', { timeout: 5_000 });
        const users = (await ui.transcript()).filter(m => m.role === 'user' && m.text.includes('ccm:onboard'));
        assert.equal(users.length, 1, 'the first message is sent exactly once');
        assert.equal(api.requests.filter(r => r.script === 'onboard').length, 1);
      });
      await check('auto-mode-user-manual', async () => {
        await waitMode(page, 'auto');
        const screen = await ui.screen();
        assert.doesNotMatch(screen, /Make auto mode your default permission mode\?/);
        const settings = JSON.parse(await readFile(path.join(folders.onboard.claudeDir, 'settings.json'), 'utf8'));
        assert.deepEqual(settings.permissions, { defaultMode: 'default' }, "the user's own settings stay as they were");
      });
    },
  },
  {
    id: 'streaming',
    features: ['streaming-preview', 'running-state'],
    timeoutMs: 120_000,
    async run({ ui, page, api, folders, check, note }) {
      const text = paragraph.repeat(4) + 'ccm-stream-end';
      api.script('stream', () => ({ text, chunk: 12, delayMs: 160 }));
      await ui.openDraft(folders.main.name);
      await ui.send('Stream a long answer ccm:stream');
      await check('running-state', async () => {
        await page.locator(sel.stop).waitFor({ timeout: 60_000 });
        await ui.waitStatus('working', 30_000);
      });
      await check('streaming-preview', async () => {
        // Part of the reply shows (from the screen) before the transcript has it.
        await page.waitForFunction(([selector]) => [...document.querySelectorAll(selector)].some(el => el.dataset.source === 'preview' && el.textContent.includes('compatibility matrix streams')),
          [sel.assistant], { timeout: 40_000 });
        note('preview-seen-while-streaming', true);
        await ui.waitReply('ccm-stream-end', { timeout: 60_000 });
        const replies = (await ui.transcript()).filter(m => m.role === 'assistant');
        assert.equal(replies.filter(m => m.text.includes('compatibility matrix streams')).length, 1, 'one reply bubble, updated in place');
        await ui.waitStatus('idle', 30_000);
        assert.equal(await page.locator(sel.stop).count(), 0, 'the stop button goes away');
      });
    },
  },
  {
    id: 'tools',
    features: ['tool-bash', 'tool-read', 'tool-write', 'tool-edit', 'tool-error'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      const cwd = folders.main.cwd, notes = path.join(cwd, 'notes.txt'), fresh = path.join(cwd, 'fresh.md');
      const steps = [
        { name: 'Bash', input: { command: "printf 'alpha\\nbeta\\n' > notes.txt && echo ccm-bash-output", description: 'Create notes' } },
        { name: 'Read', input: { file_path: notes } },
        { name: 'Edit', input: { file_path: notes, old_string: 'beta', new_string: 'gamma' } },
        { name: 'Write', input: { file_path: fresh, content: '# Fresh\n\nWritten by the fake model.\n' } },
        { name: 'Read', input: { file_path: path.join(cwd, 'missing-file.txt') } },
      ];
      api.script('tools', ({ step }) => step < steps.length ? { blocks: [{ type: 'text', text: `Step ${step + 1}.` }, { type: 'tool_use', ...steps[step] }] } : { text: 'All tools ran (ccm-tools-reply).' });
      await startChat(ctx, folders.main, 'Run the tool tour ccm:tools');
      await ui.waitReply('ccm-tools-reply', { timeout: 90_000 });
      await page.waitForTimeout(500);
      const tools = await ui.tools();
      ctx.note('tools', tools.map(tool => `${tool.name}:${tool.state}`));
      const row = (name, index = 0) => tools.filter(tool => tool.name === name)[index];
      await check('tool-bash', async () => {
        assert.equal(row('Bash')?.state, 'completed', JSON.stringify(tools));
        // Expanding the row shows the command's output.
        assert.match(await ui.expandTool('Bash'), /ccm-bash-output/);
      });
      await check('tool-read', async () => assert.equal(row('Read')?.state, 'completed', JSON.stringify(tools)));
      await check('tool-edit', async () => {
        assert.equal(row('Edit')?.state, 'completed', JSON.stringify(tools));
        assert.equal(await readFile(notes, 'utf8'), 'alpha\ngamma\n');
      });
      await check('tool-write', async () => {
        assert.equal(row('Write')?.state, 'completed', JSON.stringify(tools));
        assert.ok(existsSync(fresh));
      });
      await check('tool-error', async () => assert.equal(row('Read', 1)?.state, 'error', JSON.stringify(tools)));
    },
  },
  {
    id: 'permission',
    features: ['manual-fallback', 'permission-allow', 'permission-deny'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      const cwd = folders.perm.cwd;
      const once = (block, done) => ({ step }) => step === 0 ? { blocks: [{ type: 'tool_use', ...block }] } : { text: done };
      api.script('perm-allow', once({ name: 'Bash', input: { command: 'echo allowed > allowed.txt', description: 'Write a marker file' } }, 'Allowed (ccm-perm-allow-done).'));
      api.script('perm-deny', once({ name: 'Write', input: { file_path: path.join(cwd, 'denied.md'), content: '# Denied\n' } }, 'Should not happen (ccm-perm-deny-done).'));
      const card = page.locator(sel.permission);
      await check('manual-fallback', async () => {
        await startChat(ctx, folders.perm, 'Write a marker ccm:perm-allow');
        // The folder turns auto mode off: Claude Code falls back to manual mode.
        await waitMode(page, 'default');
      });
      await check('permission-allow', async () => {
        await card.waitFor({ timeout: 60_000 });
        assert.match(await card.innerText(), /echo allowed > allowed\.txt/);
        const labels = await card.locator('[data-permission-option] strong').allInnerTexts();
        ctx.note('bash-options', labels);
        assert.match(labels[0], /^Yes/);
        await card.locator('[data-permission-option="1"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-perm-allow-done');
        assert.equal((await readFile(path.join(cwd, 'allowed.txt'), 'utf8')).trim(), 'allowed');
      });
      await check('permission-deny', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Create a file ccm:perm-deny');
        await card.waitFor({ timeout: 60_000 });
        const labels = await card.locator('[data-permission-option] strong').allInnerTexts();
        ctx.note('write-options', labels);
        assert.match(labels.at(-1), /^No\b/);
        await card.locator(`[data-permission-option="${labels.length}"]`).click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitStatus('idle', 30_000);
        assert.equal(existsSync(path.join(cwd, 'denied.md')), false);
        await page.waitForFunction(() => document.querySelectorAll('article.message-assistant .message-interrupted').length >= 1, null, { timeout: 20_000 });
        const users = (await ui.transcript()).filter(m => m.role === 'user');
        assert.ok(!users.some(m => m.text.includes('[Request interrupted')), 'interruption markers are not user messages');
        assert.equal(api.requests.filter(r => r.script === 'perm-deny').length, 1, 'no follow-up request after the denial');
      });
    },
  },
  {
    id: 'auto-confirm',
    features: ['auto-mode-confirm'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      // The fake safety check cannot grade actions marked ccm-blocked: Claude Code blocks
      // two in a row and asks about the third, with the reason quoted above the question.
      api.script('auto-confirm', ({ step }) => step < 3
        // A pipeline: simple commands inside the project skip the safety check.
        ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 3 | sed 's/$/ ccm-blocked-${step}/' | tee blocked-${step}.txt`, description: `Blocked step ${step + 1}` } }] }
        : { text: 'Ran it after the confirmation (ccm-auto-confirm-done).' });
      await check('auto-mode-confirm', async () => {
        await startChat(ctx, folders.main, 'Try the commands auto mode cannot grade ccm:auto-confirm');
        const card = page.locator(sel.permission);
        await card.waitFor({ timeout: 90_000 });
        assert.match(await card.innerText(), /Auto mode (?:needs your confirmation|classifier requires confirmation)/);
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        // The fake model answers at once: the dialog can be on screen before Claude Code has
        // written the third call (and the second one's result), so the card first belongs to
        // the second call and a click then is refused by the transcript guard. Answer once the
        // chat shows the third call, as a reader would.
        await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 3, sel.tool('Bash'), { timeout: 30_000 });
        await card.locator('[data-permission-option="1"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-auto-confirm-done', { timeout: 60_000 });
        assert.ok(existsSync(path.join(folders.main.cwd, 'blocked-2.txt')), 'the confirmed command ran');
        assert.ok(!existsSync(path.join(folders.main.cwd, 'blocked-0.txt')), 'the blocked ones did not');
      });
    },
  },
  {
    id: 'server-check',
    features: ['auto-mode-billing', 'auto-mode-unavailable', 'auto-mode-unavailable-leave'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check, note } = ctx;
      // Lectern's default: auto mode's check stays on the server, and the fake API, a gateway to
      // Claude Code, never runs it. Before the first action that needs the check Claude Code
      // 2.1.300 and 2.1.310 show their classifier billing notice, 2.1.321+ "Auto mode can't check
      // actions in this session"; each is a card in chats the app starts in `server`, whose
      // configuration does not set CLAUDE_CODE_AUTO_MODE_SERVER.
      const expected = compareVersions(ctx.version, '2.1.321') < 0 ? 'billing' : 'unavailable';
      const cwd = folders.server.cwd;
      const command = name => ({ blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 3 | sed 's/$/ ccm-server/' | tee ${name}.txt`, description: `Checked ${name}` } }] });
      api.script('server-cancel', ({ step }) => step < 1 ? command('billing-cancel') : { text: 'Should not run (ccm-server-cancel-done).' });
      api.script('server-continue', ({ step }) => step < 1 ? command('billing-continue') : { text: 'Ran it after the notice (ccm-server-continue-done).' });
      api.script('auto-unavailable', ({ step }) => step < 1 ? command('unavailable-stay') : { text: 'Ran it after approval (ccm-unavailable-stay-done).' });
      api.script('auto-unavailable-leave', ({ step }) => step < 1 ? command('unavailable-leave') : { text: 'Should not run (ccm-unavailable-leave-done).' });
      api.script('auto-unavailable-after', () => ({ text: 'Still here in accept edits mode (ccm-unavailable-after).' }));
      const billing = page.locator(`${sel.permission}[data-permission-kind="auto-mode-billing"]`);
      const card = page.locator(`${sel.permission}[data-permission-kind="auto-mode-unavailable"]`);
      const toolCard = page.locator(`${sel.permission}:not([data-permission-kind])`);
      // The native dialog, kept per release for parser samples.
      const record = async name => {
        const screen = (await ui.screen()).replaceAll(sandbox.root, '<sandbox>');
        await writeFile(path.join(ctx.dir, `server-check.${name}.txt`), screen);
        return screen;
      };
      /** The chat's first checked action brings this release's own card, nothing else. */
      const offered = async () => {
        const seen = await Promise.race([billing.waitFor({ timeout: 90_000 }).then(() => 'billing'), card.waitFor({ timeout: 90_000 }).then(() => 'unavailable'),
          toolCard.waitFor({ timeout: 90_000 }).then(() => 'tool'), ui.waitReply('(ccm-', { timeout: 90_000 }).then(() => 'reply')]).catch(error => `none: ${error.message.split('\n')[0]}`);
        if (seen === expected) return;
        const screen = await record('unexpected');
        note('unexpected', { seen, screen: screen.split('\n').slice(-30) });
        throw new Error(`expected the ${expected} card, saw ${seen}; screen:\n${screen.split('\n').filter(line => line.trim()).slice(-12).join('\n')}`);
      };
      const skip = `Claude Code ${ctx.version} shows ${expected === 'billing' ? 'the classifier billing notice' : '"Auto mode can\'t check actions"'} instead`;
      if (expected === 'unavailable') await check('auto-mode-billing', async () => ({ skip }));
      else for (const feature of ['auto-mode-unavailable', 'auto-mode-unavailable-leave']) await check(feature, async () => ({ skip }));
      if (expected === 'billing') await check('auto-mode-billing', async () => {
        await startChat(ctx, folders.server, 'Run the command auto mode checks on the server ccm:server-cancel');
        await offered();
        note('notice', (await record('billing-notice')).split('\n').slice(-16));
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        const text = await billing.innerText();
        assert.match(text, /auto mode 计费说明/);
        assert.match(text, /Claude Code 自己的计费变更说明/);
        assert.match(text, /We're changing auto mode to no longer charge for classifier requests in Claude Code\./);
        assert.match(text, /classifier requests are billed as before/);
        assert.deepEqual(await billing.locator('.question-option strong').allInnerTexts(), ['继续', '取消']);
        assert.deepEqual(await billing.locator('.question-mark').allInnerTexts(), ['Enter', 'Esc']);
        assert.equal(await billing.locator('.question-option[aria-pressed="true"]').count(), 0, 'nothing is preselected');
        await billing.screenshot({ path: path.join(ctx.dir, 'server-check.billing-card.png') });
        // Cancel (Esc): the turn stops, the action does not run, nothing is remembered.
        await billing.locator('[data-permission-cancel]').click();
        await billing.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitStatus('idle', 30_000);
        assert.ok(!existsSync(path.join(cwd, 'billing-cancel.txt')), 'the cancelled action did not run');
        assert.equal(api.requests.filter(r => r.script === 'server-cancel').length, 1, 'the stopped turn sent nothing more');
        // The next checked action brings the notice again; continue (Enter) runs it after Claude Code's own check.
        const checks = api.requests.filter(r => r.kind === 'classifier').length;
        await ui.send('Run another one ccm:server-continue');
        await offered();
        await billing.locator('[data-permission-option="1"]').click();
        await billing.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-server-continue-done', { timeout: 60_000 });
        assert.ok(existsSync(path.join(cwd, 'billing-continue.txt')), 'the action ran');
        assert.ok(api.requests.filter(r => r.kind === 'classifier').length > checks, 'checked by Claude Code with a request of its own');
        const config = JSON.parse(await readFile(path.join(folders.server.claudeDir, '.claude.json'), 'utf8'));
        assert.equal(typeof config.autoModeClassifierBillingNoticeAcknowledgedAt, 'number', 'Claude Code remembers the answer');
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
      });
      if (expected === 'unavailable') await check('auto-mode-unavailable', async () => {
        await startChat(ctx, folders.server, 'Run the command auto mode cannot check ccm:auto-unavailable');
        await offered();
        note('dialog', (await record('dialog')).split('\n').slice(-24));
        assert.match(await card.innerText(), /Auto mode can't check actions in this session/);
        assert.deepEqual(await card.locator('[data-permission-option]').evaluateAll(rows => rows.map(row => row.dataset.permissionKey)), ['Enter', 'BTab']);
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        await card.locator('[data-permission-option="1"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        // Staying in auto mode: this action now asks like any tool, and runs once approved.
        await toolCard.waitFor({ timeout: 30_000 });
        note('after-stay', (await record('after-stay')).split('\n').slice(-20));
        assert.match(await toolCard.innerText(), /ccm-server/);
        // Claude Code asks with unnumbered choices and "No" first; approve with "Yes".
        const choices = await toolCard.locator('[data-permission-option] strong').allInnerTexts();
        note('after-stay-options', choices);
        await toolCard.locator('[data-permission-option]', { has: page.locator('strong', { hasText: /^Yes$/ }) }).click();
        await toolCard.waitFor({ state: 'detached', timeout: 30_000 });
        await ui.waitReply('ccm-unavailable-stay-done', { timeout: 60_000 });
        assert.ok(existsSync(path.join(cwd, 'unavailable-stay.txt')), 'the approved command ran');
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
      });
      if (expected === 'unavailable') await ui.closeChat();
      // A new chat (a new Claude Code process) asks again.
      if (expected === 'unavailable') await check('auto-mode-unavailable-leave', async () => {
        await startChat(ctx, folders.server, 'Run the command again ccm:auto-unavailable-leave');
        await offered();
        await card.locator('[data-permission-option="2"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        // The turn stops in accept edits mode; the waiting action never ran.
        await waitMode(page, 'acceptEdits');
        note('after-leave', (await record('after-leave')).split('\n').slice(-12));
        await ui.waitStatus('idle', 30_000);
        assert.ok(!existsSync(path.join(cwd, 'unavailable-leave.txt')), 'the waiting action did not run');
        await ui.send('Go on ccm:auto-unavailable-after');
        await ui.waitReply('ccm-unavailable-after', { timeout: 60_000 });
        assert.equal(api.requests.filter(r => r.script === 'auto-unavailable-leave').length, 1, 'the stopped turn sent nothing more');
      });
    },
  },
  {
    id: 'question',
    features: ['question-single', 'question-multi', 'question-single-long', 'question-review-long'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      const drink = { header: 'Drink', question: 'Which drink should we serve?', multiSelect: false, options: [
        { label: 'Tea', description: 'A warm infusion.' }, { label: 'Juice', description: 'A cold drink.' }] };
      const snacks = { header: 'Snacks', question: 'Which snacks should we pack?', multiSelect: true, options: [
        { label: 'Fruit', description: 'Fresh fruit.' }, { label: 'Bread', description: 'Fresh bread.' }] };
      const answers = {};
      const ask = (name, questions, preamble = 'One question first.') => api.script(name, ({ step, toolResults }) => {
        if (step === 0) return { blocks: [{ type: 'text', text: preamble }, { type: 'tool_use', name: 'AskUserQuestion', input: { questions } }] };
        answers[name] = toolResults.map(result => result.text).join('\n');
        return { text: `Thanks (ccm-${name}-done).` };
      });
      ask('ask-single', [drink]);
      ask('ask-multi', [drink, snacks]);
      // Long CJK questions wrap in the 120-column pane: the review page then quotes
      // every question with a bar (2.1.300 to 2.1.330).
      const cleanup = { header: '旧脚本', multiSelect: false,
        question: '示例相册服务在上午维护时重启了一次，我已经重新提交了缩略图任务。两台测试机（192.0.2.10、192.0.2.11，任务 demo-20260101-abcd）上还在运行的旧版同步脚本 sync_demo.sh（只包括我启动的那些，不包括你自己开的压测进程），能不能由我登录上去停掉？停掉之后我会把没跑完的批次重新排队，等新服务就绪再继续。',
        options: [{ label: '可以停', description: '停掉旧脚本并重新排队。' }, { label: '先别停', description: '保留现状，稍后再说。' }] };
      const extras = { header: '收尾', multiSelect: true,
        question: '处理完成之后还需要顺手做哪些收尾工作？这些都可以在同一批任务里完成，但每多选一项整体时间大约会增加半小时左右，请按实际需要勾选。',
        options: [{ label: '生成索引页', description: '列出全部相册。' }, { label: '清理临时文件', description: '删除中间产物。' }] };
      ask('ask-long', [cleanup, extras]);
      ask('ask-long-cancel', [cleanup, extras]);
      // One question under a long reply: a wrapped CJK title, wrapped option descriptions.
      const album = { header: '方案', multiSelect: false,
        question: '相册页（示例应用用 ImageGrid 组件显示的缩略图墙）在后台补齐元数据时会立刻重新生成缩略图，如果恰好这时滚动就会闪一下、需要等半秒才稳定（不会丢图）。详情页今天已经改成「同一张图还在屏幕上时缩略图不变，只在尺寸变化时重新生成」。相册页要不要也改成这种做法？',
        options: [{ label: '统一成详情页做法 (Recommended)', description: '改动小：同一张图在屏幕上时缩略图不变，滚动时不会因为补齐元数据而闪烁；尺寸或内容变化时仍然重新生成，画质检查不放松。和 CI 修复一起做，再跑一轮完整 CI。' },
          { label: '保持现状', description: '偶尔会闪一下，但逻辑最保守，不再改动。' }] };
      ask('ask-single-long', [album], '好，我把这个问题说清楚，再问你一次。\n\n背景：示例应用的相册页用 ImageGrid 组件显示缩略图。每张缩略图都记着它是根据哪一份元数据生成的，元数据一变就重新生成。\n\n两个页面现在的做法不一样：\n\n- 详情页（今天刚改过）：只要屏幕上还是同一张图，缩略图就保持不变。\n- 相册页（没改）：元数据只要一变就立刻重新生成，恰好在滚动时会闪一下。\n\n影响：不会丢图，也不会卡住，最坏的情况是偶尔闪一下。');
      const squash = text => text.replace(/\s+/g, '');
      const card = page.locator(sel.question);
      const option = number => card.locator(`button.question-option[data-question-number="${number}"]`);
      const heading = text => page.waitForFunction(([selector, wanted]) => document.querySelector(selector)?.textContent.replace(/\s+/g, '') === wanted,
        [`${sel.question} h3`, squash(text)], { timeout: 20_000 });
      // A named session closes the native dialog with a rule carrying its name.
      const rename = async name => {
        const id = await ui.activeSessionId();
        await page.locator(sel.row(id)).hover();
        await page.locator(`.session-row-wrap:has(${sel.row(id)}) .session-rename`).click();
        const dialog = page.locator('dialog.session-rename-dialog');
        await dialog.locator('input').fill(name);
        await dialog.locator('button[type="submit"]').click();
        await dialog.waitFor({ state: 'hidden', timeout: 40_000 });
        return id;
      };
      await check('question-single', async () => {
        await startChat(ctx, folders.main, 'Ask me one question ccm:ask-single');
        await card.waitFor({ timeout: 60_000 });
        assert.match(await card.innerText(), /Which drink should we serve\?/);
        await option(2).click();
        await ui.waitReply('ccm-ask-single-done');
        assert.match(answers['ask-single'], /Juice/);
      });
      await check('question-multi', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me two questions ccm:ask-multi');
        await card.waitFor({ timeout: 60_000 });
        await option(1).click();
        await card.getByText(snacks.question, { exact: true }).waitFor({ timeout: 20_000 });
        await option(1).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="1"]`, { timeout: 15_000 });
        await option(2).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="2"]`, { timeout: 15_000 });
        await card.locator('nav.question-nav button').last().click();
        // The review page: submit.
        await card.locator('dl.question-review').waitFor({ timeout: 20_000 });
        await card.locator('footer.question-actions button.primary-button').first().click();
        await ui.waitReply('ccm-ask-multi-done');
        assert.match(answers['ask-multi'], /Tea/);
        assert.match(answers['ask-multi'], /Fruit, Bread/);
      });
      await check('question-single-long', async () => {
        await ui.waitStatus('idle', 30_000);
        await rename('Demo 示例开发');
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me one long question ccm:ask-single-long');
        await card.waitFor({ timeout: 60_000 });
        await heading(album.question);
        // Wrapped descriptions come back whole, in order; Type something and Chat stay as designed.
        assert.deepEqual((await card.locator('button.question-option small').allInnerTexts()).map(squash), album.options.map(o => squash(o.description)));
        assert.equal(await card.locator('button.question-option').count(), 3);
        const screen = await ui.screen();
        ctx.note('single-layout', { quoteBar: /^│ /mu.test(screen), nameRule: /─ Demo 示例开发 ─+\s*$/u.test(screen.trimEnd()) });
        await writeFile(path.join(ctx.dir, 'question-single-long.txt'), screen);
        await page.screenshot({ path: path.join(ctx.dir, 'question-single-long.png') });
        await option(1).click();
        await ui.waitReply('ccm-ask-single-long-done');
        assert.match(answers['ask-single-long'], /统一成详情页做法/);
      });
      await check('question-review-long', async () => {
        await ui.waitStatus('idle', 30_000);
        const id = await rename('示例问答');
        const reviewed = async () => {
          await card.locator('dl.question-review').waitFor({ timeout: 20_000 });
          return card.locator('dl.question-review dt').allInnerTexts();
        };
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me two long questions ccm:ask-long');
        await card.waitFor({ timeout: 60_000 });
        await heading(cleanup.question);
        await option(1).click();
        await heading(extras.question);
        await option(1).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="1"]`, { timeout: 15_000 });
        await option(2).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', `${sel.question} button.question-option[data-question-number="2"]`, { timeout: 15_000 });
        await card.locator('nav.question-nav button').last().click();
        assert.deepEqual((await reviewed()).map(squash), [cleanup.question, extras.question].map(squash));
        const screen = await ui.screen();
        ctx.note('review-layout', { quoteBars: /^ │ [●⏺] /mu.test(screen), nameRule: /─ 示例问答 ─+\s*$/u.test(screen.trimEnd()) });
        await card.locator('footer.question-actions button.primary-button').first().click();
        await ui.waitReply('ccm-ask-long-done');
        assert.match(answers['ask-long'], /可以停/);
        assert.match(answers['ask-long'], /生成索引页, 清理临时文件/);
        // Answer one question, skip the other, then cancel on the review page.
        await ui.waitStatus('idle', 30_000);
        await ui.send('Ask me again, I will cancel ccm:ask-long-cancel');
        await card.waitFor({ timeout: 60_000 });
        await heading(cleanup.question);
        await option(2).click();
        await heading(extras.question);
        await card.locator('nav.question-nav button').last().click();
        assert.deepEqual((await reviewed()).map(squash), [squash(cleanup.question)]);
        await card.locator('footer.question-actions button[data-question-number="2"]').click();
        await card.waitFor({ state: 'detached', timeout: 30_000 });
        let result;
        for (let i = 0; i < 50 && !result; i++, await delay(200)) {
          const records = await readJsonl((await sandbox.projectFiles()).find(file => file.includes(id)));
          const asked = records.flatMap(r => Array.isArray(r.message?.content) ? r.message.content : []).filter(b => b.type === 'tool_use' && b.name === 'AskUserQuestion').at(-1);
          result = records.find(r => Array.isArray(r.message?.content) && r.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === asked?.id));
        }
        assert.equal(result?.toolUseResult, 'User rejected tool use', 'the cancelled review rejected the question');
      });
    },
  },
  {
    id: 'thinking-tasks',
    features: ['thinking', 'tasks'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      api.script('think', () => ({ blocks: [
        { type: 'thinking', thinking: 'The user wants a short answer. I will reply with the marker and nothing else.' },
        { type: 'text', text: 'Thought it over (ccm-think-reply).' }] }));
      await check('thinking', async () => {
        await startChat(ctx, folders.main, 'Think before answering ccm:think');
        await ui.waitReply('ccm-think-reply');
        await page.locator(sel.thought).first().waitFor({ state: 'attached', timeout: 20_000 });
        const replies = (await ui.transcript()).filter(m => m.role === 'assistant');
        assert.ok(!replies.some(m => m.text.includes('I will reply with the marker')), 'folded thinking is not reply text');
      });
      await check('tasks', async () => {
        await ui.waitStatus('idle', 30_000);
        const offered = api.requests.find(r => r.kind === 'main')?.tools ?? [];
        const tool = ['TodoWrite', 'TaskCreate'].find(name => offered.includes(name));
        ctx.note('task-tool', tool ?? `none of TodoWrite/TaskCreate among ${offered.join(',')}`);
        if (!tool) return { skip: `this release offers no TodoWrite or TaskCreate tool to the main loop (deferred or disabled)` };
        const input = tool === 'TodoWrite'
          ? { todos: [{ content: 'Check the matrix', status: 'in_progress', activeForm: 'Checking the matrix' }, { content: 'Write the report', status: 'pending', activeForm: 'Writing the report' }] }
          : { subject: 'Check the matrix', description: 'Run every scenario', activeForm: 'Checking the matrix' };
        api.script('tasks', ({ step }) => step === 0 ? { blocks: [{ type: 'tool_use', name: tool, input }] } : { text: 'Planned (ccm-tasks-done).' });
        await ui.send('Plan the work ccm:tasks');
        await ui.waitReply('ccm-tasks-done');
        await page.waitForFunction(() => /Check the matrix/.test(document.querySelector('.conversation-tasks, .task-list, [data-task-list]')?.textContent ?? document.body.textContent), null, { timeout: 20_000 });
      });
    },
  },
  {
    id: 'turn-controls',
    features: ['queue', 'steer', 'interrupt'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      const slow = () => ({ text: paragraph.repeat(6) + 'ccm-slow-end', chunk: 10, delayMs: 200 });
      for (const name of ['slow-a', 'slow-b', 'slow-c']) api.script(name, slow);
      api.script('queued', () => ({ text: 'Queued message answered (ccm-queued-done).' }));
      api.script('steered', () => ({ text: 'Steered reply (ccm-steered-done).' }));
      const streaming = () => page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(el => el.dataset.source === 'preview' && el.textContent.includes('compatibility matrix streams')), sel.assistant, { timeout: 40_000 });
      await check('queue', async () => {
        await startChat(ctx, folders.main, 'Slow reply ccm:slow-a');
        await page.locator(sel.stop).waitFor({ timeout: 40_000 });
        await streaming();
        await ui.type('Queued follow-up ccm:queued');
        await page.locator(sel.turnAction).first().click();
        await page.locator(sel.queue).waitFor({ timeout: 20_000 });
        await ui.waitReply('ccm-slow-end', { timeout: 90_000 });
        await ui.waitReply('ccm-queued-done', { timeout: 60_000 });
        const slowA = api.requests.find(r => r.script === 'slow-a'), queued = api.requests.find(r => r.script === 'queued');
        assert.ok(queued.at >= slowA.done, 'the queued message waited for the reply');
      });
      await check('steer', async () => {
        await ui.waitStatus('idle', 30_000);
        await ui.send('Another slow reply ccm:slow-b');
        await page.locator(sel.stop).waitFor({ timeout: 40_000 });
        await streaming();
        await ui.type('Change course ccm:steered');
        await page.locator(sel.turnAction).nth(1).click();
        await ui.waitReply('ccm-steered-done', { timeout: 60_000 });
        const slowB = api.requests.find(r => r.script === 'slow-b'), steered = api.requests.find(r => r.script === 'steered');
        assert.ok(slowB?.stream && steered, 'the API received both the streaming and steering requests');
        // The steered reply can arrive while the fake API is still settling the old stream.
        assert.ok(slowB.done === undefined || slowB.aborted || steered.at < slowB.done, 'the steering message went out before the reply finished');
      });
      await check('interrupt', async () => {
        await ui.waitStatus('idle', 60_000);
        const before = await page.locator(`${sel.assistant} .message-interrupted`).count();
        await ui.send('Third slow reply ccm:slow-c');
        await page.locator(sel.stop).waitFor({ timeout: 40_000 });
        await streaming();
        await page.locator(sel.stop).click();
        await ui.waitStatus('idle', 30_000);
        await page.waitForFunction(([selector, count]) => document.querySelectorAll(selector).length > count, [`${sel.assistant} .message-interrupted`, before], { timeout: 20_000 });
        const slowC = api.requests.find(r => r.script === 'slow-c');
        assert.ok(slowC.aborted || !slowC.done, 'the model request was cancelled');
      });
    },
  },
  {
    id: 'compact',
    features: ['compact'],
    timeoutMs: 200_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      api.script('compact-seed', () => ({ text: 'Some context worth compacting (ccm-compact-seed).' }));
      api.script('after-compact', () => ({ text: 'Answered after compaction (ccm-after-compact-done).' }));
      api.script('@compact', () => ({ gate: 'compact', text: '<summary>\n1. Primary Request and Intent: exercise /compact in the matrix.\n2. Pending Tasks: none.\n</summary>' }));
      await check('compact', async () => {
        await startChat(ctx, folders.main, 'Seed the context ccm:compact-seed');
        await ui.waitReply('ccm-compact-seed');
        await ui.waitStatus('idle', 30_000);
        await ui.send('/compact');
        // While the summary request is held, the app shows the compaction and only queues.
        await page.locator('.turn-progress[data-turn-progress="compacting"]').waitFor({ timeout: 60_000 });
        assert.ok(api.waiting('compact') >= 1, 'the compaction request reached the fake API');
        await ui.type('After compaction ccm:after-compact');
        await page.locator(sel.turnAction).first().waitFor({ timeout: 20_000 });
        assert.equal(await page.locator(sel.turnAction).count(), 1, 'only "queue" is offered while compacting');
        await page.locator(sel.turnAction).first().click();
        await page.locator(sel.queue).waitFor({ timeout: 20_000 });
        api.release('compact');
        await ui.waitReply('ccm-after-compact-done', { timeout: 90_000 });
        const after = api.requests.find(r => r.script === 'after-compact'), summary = api.requests.find(r => r.kind === 'compact');
        assert.ok(after.at > summary.done, 'the queued message went out after the summary');
        await ui.waitStatus('idle', 30_000);
        assert.equal(await page.locator(`${sel.assistant} .markdown:text-is("正在等待 Claude…")`).count(), 0, 'no reply left waiting');
      });
    },
  },
  {
    id: 'session',
    features: ['statusline', 'session-settings', 'rename'],
    timeoutMs: 200_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      api.script('session', () => ({ text: 'Ready for settings (ccm-session-reply).' }));
      api.script('after-settings', () => ({ text: 'Using the new settings (ccm-after-settings).' }));
      await startChat(ctx, folders.main, 'Session settings check ccm:session');
      await ui.waitReply('ccm-session-reply');
      await ui.waitStatus('idle', 30_000);
      await check('statusline', async () => {
        // The statusLine callback reports model and context; a custom base URL is a gateway route.
        await page.waitForFunction(() => document.querySelector('.session-context-usage')?.getAttribute('data-context-input-tokens'), null, { timeout: 30_000 });
        await page.waitForFunction(selector => /Opus|Sonnet|Haiku/i.test(document.querySelector(selector)?.textContent ?? ''), '.session-settings:not(.draft-settings) [data-setting-kind="model"]', { timeout: 30_000 });
        ctx.note('statusline', await page.locator('.session-telemetry').innerText());
        assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
        assert.ok(await page.locator('.telemetry-billing').count() === 0 || /自定义|custom/i.test(await page.locator('.telemetry-billing').innerText()), 'a custom endpoint is not billed as a subscription');
      });
      await check('session-settings', async () => {
        const pick = (kind, wanted) => pickSetting(ctx, kind, wanted);
        await pick('model', /Sonnet/i);
        await page.waitForFunction(selector => /Sonnet/i.test(document.querySelector(selector)?.textContent ?? ''), '.session-settings:not(.draft-settings) [data-setting-kind="model"]', { timeout: 30_000 });
        await pick('effort', /^\s*low/i);
        await page.waitForFunction(selector => /low/i.test(document.querySelector(selector)?.textContent ?? ''), '.session-settings:not(.draft-settings) [data-setting-kind="effort"]', { timeout: 30_000 });
        await ui.send('Next turn ccm:after-settings');
        await ui.waitReply('ccm-after-settings');
        const request = api.requests.find(r => r.script === 'after-settings');
        ctx.note('after-settings-request', { model: request.model, effort: request.effort });
        assert.match(request.model, /sonnet/i);
      });
      await check('rename', async () => {
        await ui.waitStatus('idle', 30_000);
        const id = await ui.activeSessionId();
        const row = page.locator(sel.row(id));
        await row.hover();
        await page.locator(`.session-row-wrap:has(${sel.row(id)}) .session-rename`).click();
        const dialog = page.locator('dialog.session-rename-dialog');
        await dialog.locator('input').fill('Matrix renamed session');
        await dialog.locator('button[type="submit"]').click();
        await dialog.waitFor({ state: 'hidden', timeout: 40_000 });
        await page.waitForFunction(([selector]) => document.querySelector(selector)?.textContent.includes('Matrix renamed session'), [`${sel.row(id)} .session-title`], { timeout: 30_000 });
        const jsonl = (await sandbox.projectFiles()).find(file => file.includes(id));
        const records = await readJsonl(jsonl);
        assert.ok(records.some(r => r.type === 'custom-title' && r.customTitle === 'Matrix renamed session'), 'Claude Code saved the name');
      });
    },
  },
  {
    id: 'background',
    features: ['background', 'background-settings'],
    timeoutMs: 200_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check } = ctx;
      // The main loop starts a background shell and a background subagent; the
      // subagent's own request carries `ccm:bg-agent` and is held until released.
      api.script('bg', ({ step, toolResults }) => {
        if (step === 0) return { blocks: [
          { type: 'tool_use', name: 'Bash', input: { command: 'sleep 4; echo ccm-bg-shell-done', description: 'Wait in the background', run_in_background: true } },
          { type: 'tool_use', name: 'Agent', input: { description: 'Background helper', prompt: 'Wait for the signal ccm:bg-agent', subagent_type: 'general-purpose', run_in_background: true } }] };
        if (toolResults.length) return { text: 'Started in the background (ccm-bg-started).' };
        return { text: 'Background result received (ccm-bg-notified).' };
      });
      api.script('bg-agent', () => ({ gate: 'bg-agent', text: 'Helper finished.' }));
      await check('background', async () => {
        await startChat(ctx, folders.main, 'Start background work ccm:bg');
        await ui.waitReply('ccm-bg-started', { timeout: 60_000 });
        const id = await ui.activeSessionId();
        const row = page.locator(`${sel.row(id)}[data-background]`);
        await row.waitFor({ timeout: 40_000 });
        ctx.note('row', await page.locator(sel.row(id)).getAttribute('aria-label'));
        // The reply is over: the composer sends rather than stops.
        await page.locator(sel.send).waitFor({ timeout: 20_000 });
        assert.equal(await page.locator(sel.stop).count(), 0);
      });
      // Claude Code reports busy while the subagent runs, its screen back at the empty prompt.
      // The pickers switch model and effort there; a reply in progress would not allow it.
      try {
        await check('background-settings', async () => {
          await ui.waitReply('ccm-bg-notified', { timeout: 60_000 });
          const id = await ui.activeSessionId();
          await page.locator(`${sel.row(id)}[data-background][data-status="idle"]`).waitFor({ timeout: 30_000 });
          ctx.note('native-status', await nativeStatus(sandbox, id));
          const word = (option, pattern) => pattern.exec(option.text)[0].toLowerCase();
          const shows = (kind, text) => page.waitForFunction(([selector, wanted]) => document.querySelector(selector)?.textContent.toLowerCase().includes(wanted),
            [settingTrigger(kind), text], { timeout: 30_000 });
          // Effort first, on the model the chat started with (which has effort levels).
          const effort = word(await pickSetting(ctx, 'effort', [/^\s*low\b/i, /^\s*high\b/i]), /low|high/i);
          await shows('effort', effort);
          await shows('model', word(await pickSetting(ctx, 'model', [/Sonnet/i, /Haiku/i]), /Sonnet|Haiku/i));
          const screen = await ui.screen();
          ctx.note('screen', screen.split('\n').filter(line => line.trim()).slice(-12));
          assert.match(screen, /Set model to /, 'the native receipt of the model switch');
          assert.match(screen, new RegExp(`Set effort level to ${effort}`, 'i'), 'the native receipt of the effort switch');
          assert.ok(api.waiting('bg-agent') >= 1 && await page.locator(`${sel.row(id)}[data-background]`).count() === 1, 'the subagent still runs');
          ctx.note('native-status-after', await nativeStatus(sandbox, id));
        });
      } finally { api.release('bg-agent'); }
      await check('background', async () => {
        const id = await ui.activeSessionId();
        await page.waitForFunction(selector => !document.querySelector(selector), `${sel.row(id)}[data-background]`, { timeout: 90_000 });
      });
    },
  },
  {
    id: 'history',
    features: ['close-in-place', 'history-paging', 'rename-inactive', 'resume', 'auto-mode-resume'],
    timeoutMs: 300_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      // Two turns with large tool output push the first one out of the first page (128 KiB).
      // Outputs stay under Claude Code's persisted-output threshold so the transcript keeps them.
      const big = ({ step }) => step < 6 ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 1000 | sed 's/$/ ccm-history-line-${step}/'`, description: `Print a long list ${step + 1}` } }] }
        : { text: 'Printed (ccm-big-done).' };
      api.script('big-one', big); api.script('big-two', big);
      api.script('small', () => ({ text: 'Small reply (ccm-small-done).' }));
      api.script('resumed', () => ({ text: 'Back again (ccm-resumed-done).' }));
      await startChat(ctx, folders.main, 'First long turn ccm:big-one');
      await ui.waitReply('ccm-big-done', { timeout: 90_000 });
      await ui.waitStatus('idle', 30_000);
      await ui.send('Second long turn ccm:big-two');
      await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 2, `${sel.assistant}[data-source="jsonl"]`, { timeout: 90_000 });
      await ui.waitStatus('idle', 60_000);
      await ui.send('A short turn ccm:small');
      await ui.waitReply('ccm-small-done', { timeout: 60_000 });
      await ui.waitStatus('idle', 30_000);
      const id = await ui.activeSessionId();
      await check('close-in-place', async () => {
        // The same bubbles stay while the chat turns into resumable history: never blank, no reload.
        const shown = await page.locator(sel.assistant).last().elementHandle();
        await page.evaluate(() => {
          window.ccmTranscriptEmptied = false;
          new MutationObserver(() => { if (!document.querySelector('.conversation-scroll .message-assistant')) window.ccmTranscriptEmptied = true; })
            .observe(document.body, { childList: true, subtree: true });
        });
        await ui.closeChat();
        await page.locator('.resume-bar').waitFor({ timeout: 30_000 });
        assert.equal(await shown.evaluate(node => node.isConnected), true, 'closing reloaded the transcript');
        assert.equal(await page.evaluate(() => window.ccmTranscriptEmptied), false, 'closing blanked the transcript');
      });
      await check('history-paging', async () => {
        // A fresh read starts from the newest page. Leaving and coming back would show the
        // cached reader with every page it holds; reloading the window reopens it in place.
        await page.reload();
        await ui.waitReply('ccm-small-done', { timeout: 30_000 });
        await page.locator('.history-page-control button').waitFor({ timeout: 30_000 });
        assert.equal(await page.locator(`${sel.user}:has-text("First long turn")`).count(), 0, 'the oldest turn is not on the first page');
        await page.locator('.history-page-control button').click();
        await page.locator(`${sel.user}:has-text("First long turn")`).waitFor({ timeout: 30_000 });
      });
      await check('rename-inactive', async () => {
        await page.locator(sel.row(id)).hover();
        await page.locator(`.session-row-wrap:has(${sel.row(id)}) .session-rename`).click();
        const dialog = page.locator('dialog.session-rename-dialog');
        await dialog.locator('input').fill('Matrix closed session');
        await dialog.locator('button[type="submit"]').click();
        await dialog.waitFor({ state: 'hidden', timeout: 60_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Matrix closed session'), `${sel.row(id)} .session-title`, { timeout: 30_000 });
      });
      await check('resume', async () => {
        await page.locator('.resume-bar button').first().click();
        await ui.ready(60_000);
        const argv = await ui.claudeArgv();
        assert.equal(argv[argv.indexOf('--resume') + 1], id, 'claude --resume <session>');
        await ui.send('Continue the session ccm:resumed');
        await ui.waitReply('ccm-resumed-done', { timeout: 60_000 });
        assert.ok(api.requests.find(r => r.script === 'resumed'));
      });
      await check('auto-mode-resume', async () => waitMode(page, 'auto'));
    },
  },
  {
    id: 'attachment',
    features: ['attachment'],
    timeoutMs: 150_000,
    async run(ctx) {
      const { ui, page, api, folders, check } = ctx;
      api.script('image', () => ({ text: 'I can see the picture (ccm-image-done).' }));
      await check('attachment', async () => {
        const file = path.join(folders.main.cwd, 'swatch.png');
        await writeFile(file, pngSwatch());
        await ui.openDraft(folders.main.name);
        await page.locator('form.composer input.composer-file-input').setInputFiles(file);
        // The file shows as a card above the text; the text box keeps only the user's words.
        await page.waitForFunction(() => {
          const cards = [...document.querySelectorAll('.composer-attachments [data-attachment-card]')];
          return cards.some(card => card.textContent.includes('swatch.png') || card.dataset.tip?.includes('swatch.png'))
            && !document.querySelector('.composer-attachments [data-state="uploading"]');
        }, null, { timeout: 20_000 });
        assert.ok(!(await page.locator(sel.composer).inputValue()).includes('swatch.png'), 'the path stays out of the text box');
        await page.locator(sel.composer).fill('What is in this picture? ccm:image');
        await page.locator(sel.send).click();
        await ui.waitReply('ccm-image-done', { timeout: 90_000 });
        const request = api.requests.find(r => r.script === 'image');
        ctx.note('images-in-request', request.images);
        assert.ok(request.images >= 1, 'Claude Code sent the image to the model');
        await page.locator(`${sel.user} .attachment-cards [data-attachment-card], ${sel.user} [data-attachment-chip]`).first().waitFor({ state: 'attached', timeout: 30_000 });
      });
    },
  },
  {
    id: 'subagents',
    features: ['subagent-column', 'subagent-resume', 'subagent-listed', 'subagent-process-gone', 'subagent-elsewhere'],
    timeoutMs: 360_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check, note } = ctx;
      // The main loop launches one subagent; the subagent's own turns are scripted
      // too (its prompt carries `ccm:sa-child`) and held at gates, so the column is
      // checked while it runs. Then SendMessage resumes it (`ccm:sa-child2`).
      let agentId;
      api.script('sa-main', ({ step }) => step === 0
        ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Matrix helper', prompt: 'Inspect the folder ccm:sa-child', subagent_type: 'general-purpose', run_in_background: true } }] }
        : { text: `Main step ${step} (ccm-sa-main-${step}).` });
      api.script('sa-child', ({ step }) => step === 0
        ? { gate: 'sa-child', blocks: [{ type: 'thinking', thinking: 'The helper plans before it looks.' }, { type: 'text', text: 'Child looks around (ccm-sa-child-text).' },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo ccm-sa-child-tool', description: 'Echo once' } }] }
        : { gate: 'sa-child-end', text: 'Child report (ccm-sa-child-report).' });
      api.script('sa-resume', ({ step, messages, body }) => {
        const offered = (body.tools ?? []).map(tool => tool.name);
        agentId ??= [...messages.map(m => textOf(m.content)).join('\n').matchAll(/agentId: ([A-Za-z0-9_-]+)/g)].map(m => m[1]).at(-1);
        if (step === 0 && !offered.includes('SendMessage') && offered.includes('ToolSearch')) return { blocks: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:SendMessage', max_results: 1 } }] };
        if (step <= 1 && offered.includes('SendMessage') && !messages.some(m => JSON.stringify(m.content).includes('ccm:sa-child2')))
          return { blocks: [{ type: 'tool_use', name: 'SendMessage', input: { to: agentId, summary: 'More', message: 'Continue please ccm:sa-child2' } }] };
        return { text: 'Resume handled (ccm-sa-resume-done).' };
      });
      api.script('sa-child2', () => ({ gate: 'sa-child2', text: 'Resumed report (ccm-sa-child2-report).' }));
      const transcriptFile = async id => {
        const projects = path.join(sandbox.config, 'projects');
        for (const dir of await readdir(projects).catch(() => [])) {
          const file = path.join(projects, dir, id, 'subagents', `agent-${agentId}.jsonl`);
          if (existsSync(file)) return file;
        }
      };
      await check('subagent-column', async () => {
        await startChat(ctx, folders.main, 'Launch a helper ccm:sa-main');
        await ui.waitReply('ccm-sa-main-1', { timeout: 60_000 });
        for (let i = 0; i < 100 && !api.waiting('sa-child'); i++) await delay(300);
        assert.ok(api.waiting('sa-child') >= 1, 'the subagent asked the model');
        const id = await ui.activeSessionId();
        // The subagent's own transcript, from the result of its launch in the main JSONL.
        const main = (await sandbox.projectFiles()).find(file => file.includes(id));
        const launched = (await readJsonl(main)).find(r => r.toolUseResult?.agentId);
        agentId = launched?.toolUseResult?.agentId;
        assert.ok(agentId, 'the Agent result names the subagent');
        // Only the model has its request so far: its files may not be on disk yet.
        const file = await poll(() => transcriptFile(id), Boolean);
        assert.ok(file, `its transcript is at <project>/${id}/subagents/agent-${agentId}.jsonl`);
        const meta = await poll(() => readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8').then(JSON.parse).catch(() => null), Boolean, 5_000);
        note('layout', { transcript: `<project>/<session>/subagents/agent-<agentId>.jsonl`, meta: meta && Object.keys(meta).sort(),
          launch: { status: launched.toolUseResult.status, async: launched.toolUseResult.isAsync } });
        // The activity card opens the column on it.
        if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
        const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: '子代理' }) });
        await section.locator('.activity-float-toggle').click();
        await section.locator(sel.openSubagent).first().click();
        await page.locator(sel.subagentColumn).waitFor();
        const row = page.locator(sel.subagentRow(agentId)), detail = page.locator(sel.subagentDetail(agentId));
        assert.equal(await row.getAttribute('data-state'), 'running');
        await detail.locator(`${sel.user}:has-text("Inspect the folder")`).waitFor({ timeout: 20_000 });
        api.release('sa-child');
        // Its turns appear while it runs: text, the folded thinking and the tool with its result.
        await detail.locator(`${sel.assistant}:has-text("ccm-sa-child-text")`).waitFor({ timeout: 40_000 });
        await detail.locator(sel.tool('Bash')).waitFor({ state: 'attached', timeout: 40_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.toolState === 'completed', `${sel.subagentDetail(agentId)} ${sel.tool('Bash')}`, { timeout: 40_000 });
        await detail.locator(sel.thought).first().waitFor({ state: 'attached', timeout: 20_000 });
        assert.equal(await row.getAttribute('data-state'), 'running', 'still running until its notification');
        api.release('sa-child-end');
        await detail.locator(`${sel.assistant}:has-text("ccm-sa-child-report")`).waitFor({ timeout: 40_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'completed', sel.subagentRow(agentId), { timeout: 60_000 });
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.column.png') }).catch(() => {});
      });
      await check('subagent-resume', async () => {
        await ui.waitStatus('idle', 60_000);
        await ui.send('Resume the helper ccm:sa-resume');
        const detail = page.locator(sel.subagentDetail(agentId));
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'running', sel.subagentRow(agentId), { timeout: 60_000 });
        // The message from the main agent (an isMeta "coordinator" record) shows while the
        // resumed run waits for the model, without the native wrapper; then the new reply.
        await detail.locator(`${sel.user}:has-text("Continue please ccm:sa-child2")`).waitFor({ timeout: 40_000 });
        assert.equal(await detail.locator(`${sel.user}:has-text("The coordinator sent")`).count(), 0);
        for (let i = 0; i < 100 && !api.waiting('sa-child2'); i++) await delay(300);
        api.release('sa-child2');
        await detail.locator(`${sel.assistant}:has-text("ccm-sa-child2-report")`).waitFor({ timeout: 40_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'completed', sel.subagentRow(agentId), { timeout: 60_000 });
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.resumed.png') }).catch(() => {});
        await page.locator(`${sel.subagentColumn} .task-column-bar button`).click();
      });
      // Claude Code 2.1.310+ keeps each subagent's state in its meta file: two more subagents
      // (one ends at once, one is held running), then a turn longer than the first page. Opened
      // again, all three are listed with their states though their launches are not loaded; once
      // the conversation is closed (its process gone), the held one is not shown running.
      const metaPath = async agent => (await transcriptFile(await ui.activeSessionId()))?.replace(`agent-${agentId}.jsonl`, `agent-${agent}.meta.json`);
      const older = compareVersions(ctx.version, '2.1.310') < 0 && `Claude Code ${ctx.version} writes no finished: its subagents keep the transcript's state (earlier rows)`;
      const more = {};
      api.script('sa-more', ({ step }) => step === 0
        ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Matrix quick helper', prompt: 'Report at once ccm:sa-quick', subagent_type: 'general-purpose', run_in_background: true } },
          { type: 'tool_use', name: 'Agent', input: { description: 'Matrix held helper', prompt: 'Work until released ccm:sa-hold', subagent_type: 'general-purpose', run_in_background: true } }] }
        : { text: `More step ${step} (ccm-sa-more-${step}).` });
      api.script('sa-quick', () => ({ text: 'Quick report (ccm-sa-quick-report).' }));
      api.script('sa-hold', () => ({ gate: 'sa-hold', gateTimeoutMs: 200_000, text: 'Held report (ccm-sa-hold-report).' }));
      api.script('sa-filler', () => ({ text: 'Filler (ccm-sa-filler-done). ' + 'lorem ipsum dolor sit amet '.repeat(6000) }));
      await check('subagent-listed', async () => {
        if (older) return { skip: older };
        await ui.waitStatus('idle', 60_000);
        await ui.send('Launch two more helpers ccm:sa-more');
        await ui.waitReply('ccm-sa-more-1', { timeout: 60_000 });
        const id = await ui.activeSessionId();
        const records = await readJsonl((await sandbox.projectFiles()).find(file => file.includes(id)));
        // The launching calls by description, then their results (one record each, or several in one without toolUseResult).
        const calls = new Map(records.flatMap(r => r.type === 'assistant' && Array.isArray(r.message?.content) ? r.message.content : [])
          .filter(b => b.type === 'tool_use' && b.name === 'Agent' && /^Matrix (quick|held) helper$/.test(b.input?.description)).map(b => [b.id, b.input.description.split(' ')[1]]));
        for (const r of records) for (const b of r.type === 'user' && Array.isArray(r.message?.content) ? r.message.content : []) {
          if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue;
          more[calls.get(b.tool_use_id)] = (r.message.content.length === 1 && r.toolUseResult?.agentId) || /agentId: ([A-Za-z0-9_-]+)/.exec(textOf(b.content))?.[1];
        }
        assert.ok(more.quick && more.held, `both launched: ${JSON.stringify(more)}`);
        for (let i = 0; i < 100 && !api.waiting('sa-hold'); i++) await delay(300);
        assert.ok(api.waiting('sa-hold') >= 1, 'the held subagent asked the model');
        // The quick one's notification gets its own reply before the long turn.
        await ui.waitReply('ccm-sa-more-2', { timeout: 60_000 });
        await ui.waitStatus('idle', 60_000);
        await ui.send('Write a long note ccm:sa-filler');
        await ui.waitReply('ccm-sa-filler-done', { timeout: 90_000 });
        const metas = {};
        for (const [name, agent] of Object.entries({ first: agentId, ...more })) metas[name] = JSON.parse(await readFile(await metaPath(agent), 'utf8'));
        note('meta', Object.fromEntries(Object.entries(metas).map(([name, meta]) => [name, { keys: Object.keys(meta).sort(), finished: meta.finished ?? null }])));
        // A fresh read: the newest page only.
        await page.reload();
        await ui.waitReply('ccm-sa-filler-done', { timeout: 30_000 });
        await page.locator('.history-page-control button').waitFor({ timeout: 30_000 });
        // The old live snapshot can render before the fresh page arrives after reload.
        const launch = page.locator(`.conversation-scroll ${sel.user}:has-text("Launch two more helpers")`);
        await launch.waitFor({ state: 'detached', timeout: 30_000 });
        if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
        const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: '子代理' }) });
        await section.waitFor({ timeout: 20_000 });
        await section.locator('.activity-float-toggle').click();
        await section.locator(sel.openSubagent).first().click();
        await page.locator(sel.subagentColumn).waitFor();
        const rows = () => page.locator(`${sel.subagentColumn} .task-column-list button[data-kind="agent"]`).evaluateAll(buttons => buttons.map(row => [row.dataset.agentId, row.dataset.state, row.querySelector('.task-state')?.textContent]));
        await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 3, `${sel.subagentColumn} .task-column-list button[data-kind="agent"]`, { timeout: 20_000 });
        const listed = await rows();
        note('listed', listed);
        assert.deepEqual(listed.map(([agent, state]) => [agent, state]), [[more.held, 'running'], [more.quick, 'completed'], [agentId, 'completed']], 'all three, running first, newest first');
        assert.ok(listed.every(([, , label]) => label !== '较早'), 'none is "earlier"');
        assert.equal(await launch.count(), 0, 'their launch is still not loaded');
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.listed.png') }).catch(() => {});
      });
      await check('subagent-process-gone', async () => {
        if (older) return { skip: older };
        assert.ok(more.held, 'the held subagent runs');
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'running', sel.subagentRow(more.held), { timeout: 20_000 });
        await ui.closeChat();
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-session-live') === 'false', sel.activeRow, { timeout: 30_000 });
        if (!await page.locator(sel.subagentRow(more.held)).count()) {
          if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
          const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: '子代理' }) });
          if (!await section.locator(sel.openSubagent).count()) await section.locator('.activity-float-toggle').click();
          await section.locator(sel.openSubagent).first().click();
        }
        await page.waitForFunction(selector => { const state = document.querySelector(selector)?.dataset.state; return !!state && state !== 'running'; }, sel.subagentRow(more.held), { timeout: 30_000 });
        const meta = JSON.parse(await readFile(await metaPath(more.held), 'utf8'));
        const state = await page.locator(sel.subagentRow(more.held)).getAttribute('data-state');
        note('after-close', { state, finished: meta.finished ?? null });
        assert.equal(state, meta.finished ? 'completed' : 'interrupted', 'ended by the process exit: interrupted unless Claude Code wrote finished');
        assert.equal(await page.locator(`${sel.subagentColumn} .task-column-list button[data-state="running"]`).count(), 0, 'nothing runs');
        await page.screenshot({ path: path.join(ctx.dir, 'subagents.process-gone.png') }).catch(() => {});
      });
      api.release('sa-hold');
      // The user resumes the session in a terminal of their own (a tmux session the app never reads),
      // which launches one more subagent: running while that process lives, not once it is gone.
      api.script('sa-out', ({ step }) => step === 0
        ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Matrix outside helper', prompt: 'Work until released ccm:sa-out-child', subagent_type: 'general-purpose', run_in_background: true } }] }
        : { text: `Outside step ${step} (ccm-sa-out-${step}).` });
      api.script('sa-out-child', () => ({ gate: 'sa-out-child', gateTimeoutMs: 200_000, text: 'Outside report (ccm-sa-out-report).' }));
      await check('subagent-elsewhere', async () => {
        if (older) return { skip: older };
        const id = await ui.activeSessionId(), own = 'ccm-own-terminal', known = new Set([agentId, ...Object.values(more)]);
        const before = await sandbox.projectFiles();
        // Its terminal is closed once (in the check, or else in `finally`), its processes awaited by PID.
        let closing, passed = false;
        const closeOwn = () => closing ??= closeOwnSession(sandbox, own);
        try {
          sandbox.tmux('new-session', '-d', '-s', own, '-x', '120', '-y', '40', '-c', folders.main.cwd,
            'env', '-i', ...Object.entries(sandbox.env).map(([key, value]) => `${key}=${value}`), 'claude', '--resume', id);
          for (let i = 0; i < 100 && !/^\s*❯/m.test(sandbox.capture(own)); i++) await delay(300);
          sandbox.tmux('send-keys', '-t', own, '-l', 'Launch one more helper ccm:sa-out');
          await delay(500);
          sandbox.tmux('send-keys', '-t', own, 'Enter');
          for (let i = 0; i < 100 && !api.waiting('sa-out-child'); i++) await delay(300);
          assert.ok(api.waiting('sa-out-child') >= 1, `the outside helper asked the model: ${sandbox.capture(own).slice(-600)}`);
          // The launch's result reaches the transcript when Claude Code writes it, which can be after
          // the subagent's own request: read until a launch not seen before is there. Read too: any
          // transcript made since (a resume that copied the session to a new UUID), for the message.
          const launches = async () => Promise.all((await sandbox.projectFiles()).filter(file => file.includes(id) || !before.includes(file)).map(async file =>
            ({ file: path.basename(file), agents: (await readJsonl(file).catch(() => [])).flatMap(r => r.toolUseResult?.agentId ? [r.toolUseResult.agentId] : []) })));
          const fresh = files => files.find(entry => entry.file === `${id}.jsonl`)?.agents.filter(agent => !known.has(agent)) ?? [];
          const t0 = Date.now(), read = await poll(launches, files => fresh(files).length > 0, 30_000);
          const out = fresh(read).at(-1), launchSeenMs = Date.now() - t0;
          assert.ok(out, `its launch is in the same transcript: agent IDs by file ${JSON.stringify(read)}, known ${JSON.stringify([...known])}`);
          await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'running', sel.subagentRow(out), { timeout: 40_000 });
          assert.equal(await page.locator(sel.activeRow).getAttribute('data-session-live'), 'false', 'no Lectern pane runs it');
          await page.screenshot({ path: path.join(ctx.dir, 'subagents.elsewhere.png') }).catch(() => {});
          await closeOwn();
          await page.waitForFunction(selector => { const state = document.querySelector(selector)?.dataset.state; return !!state && state !== 'running'; }, sel.subagentRow(out), { timeout: 40_000 });
          note('elsewhere', { state: await page.locator(sel.subagentRow(out)).getAttribute('data-state'), held: await page.locator(sel.subagentRow(more.held)).getAttribute('data-state'), launchSeenMs });
          passed = true;
        } finally {
          // Pass or fail, the outside Claude Code is gone before its subagent's gate opens: nothing
          // outside the app goes on with that turn (or writes the configuration) while the next
          // scenario runs, and the tmux server its session started (sandbox.mjs) exits with it.
          const stopped = await closeOwn();
          api.release('sa-out-child');
          const config = await apiKeyApproval(sandbox);
          note('elsewhere-cleanup', { stopped, config });
          // Not to hide the first failure: checked only when the rest passed (the note has them anyway).
          if (passed) {
            assert.deepEqual(stopped, [], 'the outside Claude Code exited once its terminal was closed');
            assert.ok(config.ok, `once it exited, the configuration is still JSON approving the API key: ${JSON.stringify(config)}`);
          }
        }
      });
    },
  },
  {
    id: 'task-column',
    features: ['task-shell-output', 'task-redirect-output', 'task-monitor-output'],
    timeoutMs: 200_000,
    async run(ctx) {
      const { ui, page, api, sandbox, folders, check, note } = ctx;
      // The main loop starts a background shell that prints, one that redirects into a file
      // and (where offered; a deferred tool from 2.1.310, not offered by 2.1.300) a monitor.
      let monitor = false, searched = false, launched = false;
      api.script('task-main', ({ body }) => {
        const offered = (body.tools ?? []).map(tool => tool.name);
        if (!launched && !searched && !offered.includes('Monitor') && offered.includes('ToolSearch')) {
          searched = true;
          return { blocks: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:Monitor', max_results: 1 } }] };
        }
        if (!launched) {
          launched = true; monitor = offered.includes('Monitor');
          return { blocks: [
            { type: 'tool_use', name: 'Bash', input: { command: 'echo ccm-task-plain-1; sleep 4; echo ccm-task-plain-2', description: 'Matrix plain task', run_in_background: true } },
            { type: 'tool_use', name: 'Bash', input: { command: 'sleep 1; echo ccm-task-redirected > ccm-task.log 2>&1', description: 'Matrix redirected task', run_in_background: true } },
            ...(monitor ? [{ type: 'tool_use', name: 'Monitor', input: { command: 'echo ccm-monitor-1; sleep 1; echo ccm-monitor-2', description: 'Matrix monitor', timeout_ms: 60000 } }] : [])] };
        }
        return { text: 'Background tasks noted (ccm-task-started).' };
      });
      await startChat(ctx, folders.tasks, 'Start background tasks ccm:task-main');
      await ui.waitReply('ccm-task-started', { timeout: 60_000 });
      const id = await ui.activeSessionId();
      const main = (await sandbox.projectFiles()).find(file => file.includes(id));
      const calls = new Map();
      for (const r of await readJsonl(main)) for (const block of Array.isArray(r.message?.content) ? r.message.content : [])
        if (block.type === 'tool_use' && /^Matrix /.test(block.input?.description ?? '')) calls.set(block.input.description, block.id);
      const plain = calls.get('Matrix plain task'), redirected = calls.get('Matrix redirected task'), watch = calls.get('Matrix monitor');
      assert.ok(plain && redirected, `the tool calls are in the transcript: ${JSON.stringify([...calls])}`);
      const results = (await readJsonl(main)).filter(r => r.toolUseResult && typeof r.toolUseResult === 'object');
      note('results', results.filter(r => r.toolUseResult.backgroundTaskId || r.toolUseResult.taskId).map(r => Object.keys(r.toolUseResult).sort().join(',')));
      if (!await page.locator('.activity-float').isVisible()) await page.locator(sel.activityPill).click();
      const section = page.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: /^终端$/ }) });
      await section.locator('.activity-float-toggle').click();
      await page.locator(`article.activity-card[data-activity-id="${plain}"] ${sel.openSubagent}`).click();
      await page.locator(sel.taskColumn).waitFor();
      const detail = page.locator(sel.taskDetail(plain));
      await check('task-shell-output', async () => {
        await detail.locator('.task-output', { hasText: 'ccm-task-plain-1' }).waitFor({ timeout: 30_000 });
        assert.match(await detail.locator('.task-command').innerText(), /echo ccm-task-plain-1; sleep 4/);
        // Appended while it runs, then the exit code from the end of the native file.
        await detail.locator('.task-output', { hasText: 'ccm-task-plain-2' }).waitFor({ timeout: 30_000 });
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'completed', sel.taskDetail(plain), { timeout: 60_000 });
        await detail.locator('[data-exit-code="0"]').waitFor({ timeout: 20_000 });
        assert.ok(!(await detail.locator('.task-output').innerText()).includes('[exited'), 'the native trailer is not shown as output');
        await page.screenshot({ path: path.join(ctx.dir, 'task-column.shell.png') }).catch(() => {});
      });
      await check('task-redirect-output', async () => {
        await page.locator(sel.taskRow(redirected)).click();
        const file = page.locator(sel.taskDetail(redirected));
        await file.locator('.task-output', { hasText: 'ccm-task-redirected' }).waitFor({ timeout: 40_000 });
        assert.equal(await file.getAttribute('data-source'), 'file:0');
        assert.equal(await file.locator('[data-redirect-path]').getAttribute('data-redirect-path'), path.join(folders.tasks.cwd, 'ccm-task.log'));
        await page.screenshot({ path: path.join(ctx.dir, 'task-column.redirect.png') }).catch(() => {});
      });
      await check('task-monitor-output', async () => {
        note('monitor', monitor ? 'offered' : 'not offered');
        if (!monitor) return { skip: 'Claude Code does not offer the Monitor tool' };
        assert.ok(watch, 'the Monitor call is in the transcript');
        await page.locator(sel.taskRow(watch)).click();
        await page.locator(sel.taskDetail(watch)).locator('.task-output', { hasText: 'ccm-monitor-2' }).waitFor({ timeout: 40_000 });
      });
      await page.locator(`${sel.taskColumn} .task-column-bar button`).click();
    },
  },
  // end of SCENARIOS
];

/** The keys a user presses on a native first-run screen (none for other screens).
 * The auto-mode nudge is left to the run-wide watcher (dismissNativeNudges). */
export function firstRunAnswer(screen) {
  if (/Choose the text style that looks best/.test(screen)) return { name: 'theme', keys: ['Enter'] };
  if (/Do you want to use this API key\?/.test(screen)) return { name: 'api-key', keys: ['Up', 'Enter'] };
  if (/Security notes:?/i.test(screen) && /Press Enter to continue/i.test(screen)) return { name: 'security-notes', keys: ['Enter'] };
  if (/Use Claude Code's terminal setup\?/.test(screen)) return { name: 'terminal-setup', keys: ['Escape'] };
  if (/Press Enter to continue/i.test(screen) && !/❯\s*$/m.test(screen)) return { name: 'continue', keys: ['Enter'] };
  return undefined;
}

/** A 16×16 PNG, built here so the repository carries no binary fixture. */
function pngSwatch() {
  const { deflateSync, crc32 } = zlib;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 16 }, (_, y) => Buffer.concat([Buffer.from([0]), ...Array.from({ length: 16 }, (_, x) => Buffer.from([x * 16, y * 16, 160]))])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
