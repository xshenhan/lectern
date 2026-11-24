// npm run build && node scripts/background-work-e2e.mjs [packaged-executable]
// Installed Claude Code (isolated CLAUDE_CONFIG_DIR, private tmux) and a loopback
// mock model: the reply starts a background shell and a background subagent and
// ends. The sidebar then says "回复完成" and shows both kinds of running work,
// including when another chat is selected. "关闭对话" asks first and names that
// work; cancelling keeps it running. Then the finished subagent is resumed with
// SendMessage: it runs again (activity card, "后台运行中") until it notifies
// again. No real model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { answerAutoModeCheck, isAutoModeCheck, LOCAL_AUTO_MODE_CHECK } from './fixtures/auto-mode-check.mjs';

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? (typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? ''))).join('\n') : '';
const requests = [];
let localChecks = 0;
let releaseAgent, releaseResumed, agentId, sendMessageTool, toolSearch, mainTools;
const agentHeld = new Promise(resolve => { releaseAgent = resolve; });
const resumedHeld = new Promise(resolve => { releaseResumed = resolve; });
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch {}
  if (req.method === 'POST' && isAutoModeCheck(body)) { localChecks++; return answerAutoModeCheck(res, body); }
  if (req.method !== 'POST' || !body?.stream) return res.writeHead(500).end('{}');
  const messages = body.messages ?? [], last = messages.at(-1);
  const all = messages.map(message => textOf(message.content)).join('\n');
  const subagent = all.includes('子代理任务');
  const main = !subagent && body.tools?.some(tool => tool.name === 'Agent');
  let blocks;
  if (main) {
    mainTools ??= body.tools.map(tool => tool.name);
    // SendMessage may be a deferred tool, loaded through ToolSearch first.
    sendMessageTool ||= body.tools.some(tool => tool.name === 'SendMessage');
    toolSearch ??= body.tools.some(tool => tool.name === 'ToolSearch');
    agentId ??= /agentId: ([A-Za-z0-9_-]+)/.exec(all)?.[1];
  }
  const results = Array.isArray(last?.content) ? last.content.filter(part => part.type === 'tool_result') : [];
  if (subagent) {
    const again = all.includes('子代理续接任务');
    requests.push(again ? 'subagent-resumed' : 'subagent');
    // The subagent keeps running in the background until the test lets it finish.
    await (again ? resumedHeld : agentHeld);
    blocks = [{ type: 'text', text: again ? '子代理再次完成。' : '子代理完成。' }];
  } else if (!main) blocks = [{ type: 'text', text: '后台任务' }];
  else if (textOf(last?.content).includes('<task-notification>')) { requests.push('notification'); blocks = [{ type: 'text', text: '收到后台结果。' }]; }
  else if (results.some(part => part.tool_use_id === 'toolu_resume')) { requests.push('resumed'); blocks = [{ type: 'text', text: '已续接子代理。' }]; }
  else if (results.some(part => part.tool_use_id === 'toolu_search')) {
    requests.push('searched');
    const found = sendMessageTool || textOf(results).includes('SendMessage');
    blocks = found && agentId
      ? [{ type: 'tool_use', id: 'toolu_resume', name: 'SendMessage', input: { to: agentId, summary: '再做一次', message: '子代理续接任务：再做一次。' } }]
      : [{ type: 'text', text: '无法续接。' }];
  }
  else if (results.length) { requests.push('results'); blocks = [{ type: 'text', text: '已在后台启动。' }]; }
  else if (textOf(last?.content).includes('请续接子代理')) {
    requests.push('resume');
    blocks = sendMessageTool && agentId
      ? [{ type: 'tool_use', id: 'toolu_resume', name: 'SendMessage', input: { to: agentId, summary: '再做一次', message: '子代理续接任务：再做一次。' } }]
      : toolSearch && agentId ? [{ type: 'tool_use', id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:SendMessage', max_results: 1 } }]
      : [{ type: 'text', text: '无法续接。' }];
  } else {
    requests.push('start');
    blocks = [
      { type: 'tool_use', id: 'toolu_bg_shell', name: 'Bash', input: { command: 'for ((i=0; i<60; i++)); do test -f .release-background-shell && break; sleep 1; done; echo bg-shell-done', description: '后台等待', run_in_background: true } },
      { type: 'tool_use', id: 'toolu_bg_agent', name: 'Agent', input: { description: '后台子代理', prompt: '子代理任务：稍等片刻再回复。', subagent_type: 'general-purpose', run_in_background: true } },
    ];
  }
  const send = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: `msg_bg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    send('content_block_start', { index, content_block: block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: {} } : { type: 'text', text: '' } });
    send('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
  send('message_stop'); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const root = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'lectern-bg-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const output = path.resolve('test-results', 'background-work-' + Date.now());
const tmux = (...a) => { try { return execFileSync('tmux', a, { env: { ...process.env, TMUX_TMPDIR: root }, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
const paneId = () => tmux('list-panes', '-a', '-F', '#{pane_id} #{session_name}').split('\n').find(line => / lectern-/.test(line))?.split(' ')[0];
const report = {};
let app, page;
try {
  await Promise.all([profile, config, cwd, output].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ['bg-e2e'] } }));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'ToolSearch', 'SendMessage'], defaultMode: 'acceptEdits' },
    env: { ANTHROPIC_API_KEY: 'bg-e2e', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } }));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'bg', name: '后台任务', kind: 'local', cwd, claudeDir: config }]));
  // Auto mode's check runs locally (answered by the loopback model), not on the server, which
  // this loopback "gateway" cannot run; the variable reaches Claude Code through the app and tmux.
  const env = { ...process.env, ...LOCAL_AUTO_MODE_CHECK, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_LOG_DIR: path.join(output, 'diagnostics') };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await (await app.browserWindow(page)).evaluate(window => window.focus());
  await page.evaluate(() => window.desktop.onSnapshot(snapshot => { window.__bgSnapshot = snapshot; }));
  await page.getByRole('button', { name: '在 后台任务 新建对话' }).click();
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  await input.fill('启动后台任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  // The app starts the session in auto mode and gets past any auto-mode prompt itself.
  for (let i = 0; i < 80 && !requests.includes('start'); i++) await new Promise(r => setTimeout(r, 250));
  await page.locator('.message-assistant').getByText('已在后台启动。').waitFor();
  // The reply is done; the fixture holds the shell and the subagent until released.
  const activeBackground = page.locator('.session-row.active[data-background]');
  await activeBackground.waitFor();
  const sessionId = await activeBackground.getAttribute('data-session-id');
  assert.ok(sessionId, 'a running conversation has a stable session ID');
  const row = page.locator(`.session-row[data-session-id="${sessionId}"]`);
  const replyComplete = row.locator('.session-state-label', { hasText: /^回复完成$/ });
  const bothRunning = row.locator('.session-background-label', { hasText: /^子代理 1 · 后台任务 1$/ });
  await replyComplete.waitFor();
  await bothRunning.waitFor();
  report.row = { label: await replyComplete.innerText(), title: await row.getAttribute('title') };
  assert.match(report.row.title, /终端|子代理/);
  assert.match(await row.getAttribute('aria-label'), /回复完成.*子代理 1 · 后台任务 1/);
  assert.equal(await row.locator('.session-status-dot.state-background').count(), 1);

  await page.getByRole('button', { name: '在 后台任务 新建对话' }).click();
  await activeBackground.waitFor({ state: 'detached' });
  await replyComplete.waitFor();
  await bothRunning.waitFor();
  assert.doesNotMatch(await row.getAttribute('class'), /\bactive\b/);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '标记为未读', exact: true }).click();
  const unread = row.locator('.state-unread');
  await unread.waitFor();
  assert.equal(await row.locator('.state-background').count(), 1);
  assert.equal(await row.getAttribute('data-background'), 'true');
  assert.match(await row.getAttribute('aria-label'), /回复完成.*子代理 1 · 后台任务 1.*未读/);
  await row.click();
  await activeBackground.waitFor();
  await unread.waitFor({ state: 'detached' });
  const topbar = page.locator('.connection-status', { hasText: /后台运行中/ });
  await topbar.waitFor();
  report.topbar = await topbar.innerText();
  // The app started this session in auto mode.
  assert.equal(await page.locator('.session-execution-mode').getAttribute('data-execution-mode'), 'auto');
  assert.match(report.topbar, /后台运行中/);
  // Closing asks first and names the work it would stop; cancelling keeps it all running.
  const closeButton = page.getByRole('button', { name: '关闭当前对话', exact: true });
  const closeAt = await closeButton.boundingBox();
  const confirmDialog = page.locator('dialog.confirm-action[open]');
  await closeButton.click();
  await confirmDialog.waitFor();
  report.closeDetail = await confirmDialog.locator('.confirm-action-detail').innerText();
  assert.match(report.closeDetail, /以下仍在运行，将被停止：.*(终端|子代理)/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
  await page.keyboard.press('Escape');
  await confirmDialog.waitFor({ state: 'detached' });
  await page.waitForTimeout(800);
  assert.equal(await row.getAttribute('data-session-live'), 'true', 'cancelling keeps Claude Code running');
  assert.equal(await page.locator('.session-row.active[data-background]').count(), 1, 'cancelling keeps the background work');
  assert.equal(requests.includes('subagent'), true);
  // The terminal panel never moves the title bar's buttons.
  await page.getByTitle('查看终端原屏').click();
  await page.locator('.terminal-panel').waitFor();
  assert.deepEqual(await closeButton.boundingBox(), closeAt, 'opening the terminal moved 关闭对话');
  await page.getByTitle('查看终端原屏').click();
  await page.locator('.terminal-panel').waitFor({ state: 'detached' });
  // Nothing to stop: the input box sends as usual while the background work runs.
  await page.locator('.send-button').waitFor();
  assert.equal(await page.locator('.interrupt-button').count(), 0);
  // Evidence for the record: what Claude Code itself reports meanwhile.
  report.screen = tmux('capture-pane', '-p', '-t', paneId()).split('\n').filter(line => line.trim()).slice(-8);
  const registry = path.join(config, 'sessions');
  report.native = await Promise.all((await readdir(registry)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(path.join(registry, name), 'utf8')).status));
  await page.screenshot({ path: path.join(output, 'background.png') });

  // Release only the shell and wait for the sidebar to show the remaining work.
  await writeFile(path.join(cwd, '.release-background-shell'), '');
  await page.locator('.message-assistant').getByText('收到后台结果。').first().waitFor({ timeout: 45000 });
  const agentRunning = row.locator('.session-background-label', { hasText: /^子代理 1$/ });
  await agentRunning.waitFor();
  report.afterShell = { background: await activeBackground.count(), title: await row.getAttribute('title') };
  assert.equal(report.afterShell.background, 1, 'the subagent still runs');
  releaseAgent();
  // Replies to task notifications join the same reply bubble.
  await page.waitForFunction(() => [...document.querySelectorAll('.message-assistant')].map(el => el.textContent).join('').split('收到后台结果。').length >= 3 &&
    !document.querySelector('.session-row.active[data-background]'), null, { timeout: 45000 });
  report.after = { label: await row.locator('.session-state-label').innerText().catch(() => ''), topbar: await page.locator('.connection-status').innerText() };
  assert.doesNotMatch(report.after.topbar, /后台运行中/);
  assert.equal(await row.locator('.session-background-label').count(), 0);
  // A status change ("后台运行中" → idle) does not move the buttons either.
  assert.deepEqual(await closeButton.boundingBox(), closeAt, 'a status change moved 关闭对话');
  const agentCard = async () => (await page.evaluate(() => window.__bgSnapshot?.activity ?? [])).find(item => item.kind === 'agent');
  report.agentDone = await agentCard();
  assert.equal(report.agentDone?.status, 'completed');

  // Resume the finished subagent with SendMessage: it runs again until it notifies again.
  await input.fill('请续接子代理');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => window.__bgSnapshot?.messages?.length && document.body.textContent.match(/已续接子代理。|无法续接。/), null, { timeout: 45000 });
  Object.assign(report, { sendMessageTool, toolSearch, mainTools });
  if (await page.locator('.message-assistant').getByText('无法续接。').count()) {
    report.resumeSkipped = 'the installed Claude Code offered no SendMessage tool';
  } else {
    await page.waitForFunction(() => window.__bgSnapshot?.activity?.some(item => item.kind === 'agent' && item.status === 'running' && item.resumes === 1), null, { timeout: 30000 });
    report.agentResumed = await agentCard();
    assert.equal(report.agentResumed.taskId, report.agentDone.taskId);
    // The reply is done; the resumed subagent keeps the chat in "后台运行中".
    await activeBackground.waitFor();
    await replyComplete.waitFor();
    await agentRunning.waitFor();
    assert.match(await page.locator('.connection-status').innerText(), /后台运行中/);
    assert.equal(await page.locator('.activity-toolbar-count').innerText(), '1');
    await page.screenshot({ path: path.join(output, 'resumed.png') });
    releaseResumed();
    await page.waitForFunction(() => window.__bgSnapshot?.activity?.some(item => item.kind === 'agent' && item.status === 'completed' && item.resumes === 1)
      && !document.querySelector('.session-row.active[data-background]'), null, { timeout: 45000 });
    report.agentFinishedAgain = await agentCard();
    assert.ok(Date.parse(report.agentFinishedAgain.endedAt) > Date.parse(report.agentDone.endedAt));
  }
  report.requests = requests;
  console.log(JSON.stringify({ ok: true, report, localChecks }));
} catch (error) {
  report.requests = requests;
  report.failureRow = await page?.evaluate(() => { const row = document.querySelector('.session-row.active'); return { title: row?.title, background: row?.dataset.background,
    assistants: [...document.querySelectorAll('.message-assistant')].map(el => el.textContent.slice(0, 60)) }; }).catch(() => undefined);
  try {
    const projects = path.join(config, 'projects');
    for (const dir of await readdir(projects)) for (const name of (await readdir(path.join(projects, dir))).filter(name => name.endsWith('.jsonl'))) {
      report.jsonl = (await readFile(path.join(projects, dir, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).map(r => [r.type, r.subtype, r.origin?.kind,
        r.pendingBackgroundAgentCount, r.pendingWorkflowCount, JSON.stringify(r.message?.content ?? r.content ?? r.toolUseResult ?? '').slice(0, 260)].filter(v => v !== undefined));
    }
  } catch (error) { report.jsonlError = String(error); }
  const pane = paneId();
  if (pane) report.failureScreen = tmux('capture-pane', '-p', '-t', pane).split('\n').filter(line => line.trim()).slice(-14);
  console.error(JSON.stringify(report, null, 1));
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  releaseAgent();
  releaseResumed();
  await writeFile(path.join(cwd, '.release-background-shell'), '').catch(() => {});
  await app?.close().catch(() => {});
  try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root } }); } catch {}
  server.close();
  for (let i = 0; i < 5; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
}
