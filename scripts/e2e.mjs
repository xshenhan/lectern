import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const userData = await mkdtemp(path.join(tmpdir(), 'lectern-e2e-profile-'));
const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const diagnosticsDirectory = await mkdtemp(path.join(results, 'diagnostics-e2e-'));
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: userData, LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: diagnosticsDirectory, LECTERN_DIAGNOSTIC_CONTENT: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
let app;
/** Watches the open transcript in the page: problems lists every moment it went empty,
 * was remounted (a new scroll container) or replaced a rendered bubble. */
function watchTranscript(page) {
  return page.evaluateHandle(() => {
    const scroll = document.querySelector('.conversation-scroll');
    const bubbles = [...scroll.querySelectorAll('.message')];
    const text = () => scroll.querySelector('.conversation')?.innerText ?? '';
    const initialText = text(), problems = new Set();
    let fewestReplies = Infinity;
    const sample = () => {
      const shown = document.querySelector('.conversation-scroll');
      if (shown !== scroll) problems.add('the transcript was remounted');
      const replies = shown?.querySelectorAll('.message-assistant').length ?? 0;
      fewestReplies = Math.min(fewestReplies, replies);
      if (!replies) problems.add('the transcript went empty');
      if (bubbles.some(node => !node.isConnected)) problems.add('a rendered bubble was replaced');
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true });
    sample();
    const read = () => ({ problems: [...problems], fewestReplies, bubbles: bubbles.length, text: text(), initialText });
    return { read, finish: () => { sample(); observer.disconnect(); return read(); } };
  });
}
try {
  app = await electron.launch({ args: ['.', '--demo'], env, timeout: 60000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.message-assistant').waitFor();
  const demoIsolation = await page.evaluate(async () => {
    const workspaces = await window.desktop.listWorkspaces();
    let denied = false;
    try { await window.desktop.saveWorkspace({ ...workspaces[0], id: 'should-be-rejected', cwd: '/tmp' }); }
    catch { denied = true; }
    return denied && (await window.desktop.listWorkspaces()).length === workspaces.length;
  });
  assert.equal(demoIsolation, true, 'Demo mode cannot redirect its mock backend to a real workspace');
  assert.equal(await page.getByRole('button', { name: '添加工作目录', exact: true }).count(), 0, 'folders are added on a machine in the sidebar');
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-live'), 'true');
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-persisted'), 'true');
  assert.equal(await page.locator('.message-assistant').count(), 1);
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle');
  const readyBackground = await page.locator('.session-row.active').evaluate(node => getComputedStyle(node).backgroundColor);
  const initialScreenshot = { path: path.join(results, 'desktop-initial.png') };
  try {
    await page.screenshot(initialScreenshot);
  } catch (error) {
    // Under Xvfb the first capture can arrive before Chromium has a frame to copy.
    if (process.platform !== 'linux' || !String(error).includes('Page.captureScreenshot): Unable to capture screenshot')) throw error;
    console.warn('Retrying the initial desktop screenshot after Chromium could not capture a frame');
    await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))), undefined, { timeout: 5000 });
    await page.screenshot(initialScreenshot);
  }
  const input = page.getByRole('textbox', { name: '发送给 Claude 的消息' });
  const sizing = () => input.evaluate(el => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight),
    max: parseFloat(getComputedStyle(el).maxHeight), scroll: el.scrollHeight }));
  const empty = await sizing();
  assert.ok(Math.abs(empty.height - empty.line) <= 1, '空输入框占一行');
  await input.fill('第一行\n第二行');
  assert.ok((await sizing()).height >= 2 * empty.line - 1, '换行后输入框随内容长高');
  await input.fill('宽度不足时自动折行'.repeat(140));
  const full = await sizing();
  assert.ok(full.height > empty.height && full.scroll > full.height, '长草稿折行并在最大高度内滚动');
  await input.fill(Array.from({ length: 15 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  const tall = await sizing(), viewport = await page.evaluate(() => innerHeight);
  assert.ok(Math.abs(tall.height - Math.min(10 * tall.line, 0.6 * viewport)) <= 2 && tall.scroll > tall.height,
    `默认最多长到 10 行再滚动（${tall.height}px，行高 ${tall.line}px）`);
  await input.fill('');
  assert.equal((await sizing()).height, empty.height, '清空后回到单行');
  const form = await page.locator('form.composer').boundingBox(), footer = await page.locator('.composer-context').boundingBox();
  assert.ok(footer.y >= form.y + form.height && Math.abs(footer.x + footer.width - form.x - form.width) < 6);
  await page.locator('.composer-area').screenshot({ path: path.join(results, 'composer-018.png') });
  // Buttons and figures around the input box explain themselves on hover; the input box itself does not.
  assert.equal(await input.getAttribute('title'), null);
  await input.fill('悬停');
  await page.getByRole('button', { name: '发送消息', exact: true }).hover();
  // The chat scrolling (as it does all through a reply) does not cancel the composer's card.
  await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = Math.max(0, el.scrollTop - 40); el.dispatchEvent(new Event('scroll')); });
  const card = page.locator('.hover-tip[role="tooltip"]');
  await card.waitFor();
  assert.match(await card.innerText(), /^发送消息\n[\s\S]*Shift \+ Enter 换行/);
  const sendBox = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox(), cardBox = await card.boundingBox();
  assert.ok(cardBox.y + cardBox.height <= sendBox.y + 1, 'the card sits above the button');
  await page.locator('.session-execution-mode').hover();
  await page.waitForFunction(() => document.querySelector('.hover-tip')?.textContent.startsWith('权限模式'));
  assert.match(await card.innerText(), /Shift \+ Tab/);
  await page.mouse.move(5, 5);
  await card.waitFor({ state: 'detached' });
  await input.fill('');
  await input.fill('你好');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const preview = page.locator('.message-assistant[data-source="preview"]').last();
  await preview.getByText('你好', { exact: false }).waitFor();
  const bubble = await preview.getAttribute('data-message-id');
  assert.equal(await page.locator('.session-row.active').getAttribute('data-status'), 'working');
  assert.notEqual(await page.locator('.session-row.active').evaluate(node => getComputedStyle(node).backgroundColor), readyBackground, 'Generating state changes the row background, not only its status dot');
  await page.screenshot({ path: path.join(results, 'desktop-streaming.png') });
  await page.waitForFunction(id => {
    const node = [...document.querySelectorAll('.message-assistant')].find(n => n.getAttribute('data-message-id') === id);
    return node?.getAttribute('data-source') === 'jsonl' && node.textContent.includes('继续这个会话');
  }, bubble);
  assert.equal(await page.locator('.message-assistant').count(), 2);
  assert.equal(await page.locator('.message-user').count(), 2);
  assert.equal(await page.locator('.message-assistant').last().getAttribute('data-message-id'), bubble);
  assert.match(await page.locator('.message-assistant').last().innerText(), /中文与 emoji 🧭 都会完整保留/);
  await page.screenshot({ path: path.join(results, 'desktop-final.png') });
  const previousClipboard = await app.evaluate(async ({ clipboard }) => await clipboard.readText());
  try {
    await page.getByRole('button', { name: '复制回复', exact: true }).last().click();
    await page.waitForTimeout(100);
    assert.match(await app.evaluate(async ({ clipboard }) => await clipboard.readText()), /中文与 emoji 🧭 都会完整保留/);
  } finally {
    await app.evaluate(async ({ clipboard }, text) => await clipboard.writeText(text), previousClipboard);
  }

  await page.getByTitle('查看终端原屏').click();
  await page.locator('.terminal-panel pre').waitFor();
  assert.match(await page.locator('.terminal-panel pre').innerText(), /offline fixture/);
  assert.equal(await page.locator('.terminal-panel').getAttribute('data-readonly'), 'true');
  assert.equal(await page.locator('.terminal-panel input, .terminal-panel textarea, .terminal-panel [contenteditable="true"]').count(), 0);
  assert.equal(await page.locator('.terminal-keybar').count(), 0);
  const observedScreen = await page.locator('.terminal-panel pre').innerText();
  await page.locator('.terminal-panel pre').focus();
  await page.keyboard.type('MUST_NOT_ENTER_TUI');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.terminal-panel pre').innerText(), observedScreen, 'Typing in the observed terminal never forwards to tmux');
  await page.screenshot({ path: path.join(results, 'desktop-terminal.png') });

  // The terminal panel opening and closing never moves the title bar's buttons.
  const closeButton = page.getByRole('button', { name: '关闭当前对话', exact: true });
  const closeAt = await closeButton.boundingBox();
  await page.getByTitle('查看终端原屏').click();
  await page.locator('.terminal-panel').waitFor({ state: 'detached' });
  assert.deepEqual(await closeButton.boundingBox(), closeAt, 'closing the terminal panel moved 关闭对话');
  await page.getByTitle('查看终端原屏').click();
  await page.locator('.terminal-panel pre').waitFor();
  assert.deepEqual(await closeButton.boundingBox(), closeAt, 'opening the terminal panel moved 关闭对话');
  // Closing asks first: focus starts on Cancel, and Esc or Cancel keeps Claude running.
  // From the first click until the chat is saved history, the transcript stays as it is.
  const transcriptProbe = await watchTranscript(page);
  const transcriptSeen = () => transcriptProbe.evaluate(probe => probe.read());
  const confirmDialog = page.locator('dialog.confirm-action[open]');
  await closeButton.click();
  await confirmDialog.waitFor();
  assert.match(await confirmDialog.innerText(), /Claude Code 将退出[\s\S]*可以续接/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
  await page.keyboard.press('Escape');
  await confirmDialog.waitFor({ state: 'detached' });
  await closeButton.click();
  await confirmDialog.getByRole('button', { name: '取消', exact: true }).click();
  await confirmDialog.waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-live'), 'true', 'cancelling keeps the session running');
  assert.equal(await page.getByRole('button', { name: '续接会话', exact: true }).count(), 0);
  let seen = await transcriptSeen();
  assert.deepEqual(seen.problems, [], 'cancelling the confirmation leaves the transcript alone');
  assert.equal(seen.text, seen.initialText, 'cancelling the confirmation leaves the transcript alone');
  // A close that fails (the demo machine refuses the close command) changes nothing either.
  await app.evaluate(() => { process.env.LECTERN_DEMO_FAIL_TAG = 'tmux.close_session'; });
  try {
    await closeButton.click();
    await confirmDialog.getByRole('button', { name: '关闭对话', exact: true }).click();
    await page.locator('.error-banner', { hasText: 'Rehearsed failure: tmux.close_session' }).waitFor();
  } finally { await app.evaluate(() => { delete process.env.LECTERN_DEMO_FAIL_TAG; }); }
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-live'), 'true', 'a failed close keeps the session running');
  assert.equal(await page.getByRole('button', { name: '续接会话', exact: true }).count(), 0);
  seen = await transcriptSeen();
  assert.deepEqual(seen.problems, [], 'a failed close leaves the transcript alone');
  assert.equal(seen.text, seen.initialText, 'a failed close leaves the transcript alone');
  // On a slow machine (every command waits, as through an SSH relay) the close takes
  // seconds. All along, the chat shows its messages: never empty, never remounted,
  // until the resume bar replaces the input box.
  await app.evaluate(() => { process.env.LECTERN_DEMO_LATENCY_MS = '300'; });
  const resume = page.getByRole('button', { name: '续接会话', exact: true });
  try {
    await closeButton.click();
    await confirmDialog.getByRole('button', { name: '关闭对话', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.resume-bar button')].some(b => b.textContent.includes('续接会话') && !b.disabled),
      null, { timeout: 40000 });
  } finally { await app.evaluate(() => { delete process.env.LECTERN_DEMO_LATENCY_MS; }); }
  seen = await transcriptProbe.evaluate(probe => probe.finish());
  assert.deepEqual(seen.problems, [], 'closing keeps the transcript on screen (no blank frame, no remount)');
  assert.equal(seen.fewestReplies, 2);
  assert.equal(await page.locator('.message-assistant').count(), 2);
  assert.equal(await input.isDisabled(), true);
  assert.match(await input.getAttribute('placeholder'), /续接/, 'the disabled input box says why');
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-live'), 'false');
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-persisted'), 'true');
  // Resuming keeps the loaded transcript: the same bubbles stay mounted, never an empty pane.
  const shownBubble = await page.locator('.message-assistant').first().elementHandle();
  await page.evaluate(() => {
    window.__transcriptEmptied = false;
    new MutationObserver(() => { if (!document.querySelector('.message-assistant')) window.__transcriptEmptied = true; })
      .observe(document.body, { childList: true, subtree: true });
  });
  await resume.click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled && document.querySelectorAll('.message-assistant').length === 2);
  assert.equal(await page.evaluate(() => window.__transcriptEmptied), false, 'Resume never blanks the transcript');
  assert.equal(await shownBubble.evaluate(node => node.isConnected), true, 'Resume keeps the rendered history instead of reloading it');
  assert.equal(await page.locator('.message-assistant').count(), 2);
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-live'), 'true');

  // Renderer reload reconstructs history using only the remote JSONL + pane mapping.
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.message-assistant').length === 2);
  assert.equal(await page.locator('.message-assistant').last().getAttribute('data-message-id'), bubble);
  // "新建对话" opens a draft: no pane, no Claude until its first message. Model and
  // effort chosen there start that session only.
  await page.getByRole('button', { name: /^新建对话/ }).first().click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled && document.querySelector('.draft-settings'));
  assert.equal(await page.locator('.session-row').count(), 1, 'nothing starts before the first message');
  assert.equal(await page.locator('.session-row.active').count(), 0);
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /Fixture Beta/ }).click();
  await page.getByRole('button', { name: '选择推理强度' }).click();
  await page.getByRole('option', { name: /^high/ }).click();
  assert.equal(await page.getByRole('button', { name: '选择模型' }).innerText(), 'Fixture Beta');
  await input.fill('你好');
  await page.screenshot({ path: path.join(results, 'draft-new-chat.png') });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.message-user')].some(node => node.textContent.includes('你好')));
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'true');
  const newSessionId = await page.locator('.session-row.active').getAttribute('data-session-id');
  await page.waitForFunction(id => {
    const row = [...document.querySelectorAll('.session-row')].find(node => node.getAttribute('data-session-id') === id);
    return row?.getAttribute('data-session-persisted') === 'true' && document.querySelector('.message-assistant')?.getAttribute('data-source') === 'jsonl';
  }, newSessionId);
  assert.equal(await page.locator('.session-row').count(), 2);
  assert.equal(await page.locator('.message-assistant').count(), 1);
  const isolated = await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined');
  assert.equal(isolated, true);

  const fixtureWorkspace = await page.evaluate(async () => (await window.desktop.listWorkspaces())[0]);
  const launched = (await readFile(path.join(fixtureWorkspace.claudeDir, 'launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const flags = launched.find(row => row.id === newSessionId).args;
  assert.deepEqual(flags.slice(flags.indexOf('--model'), flags.indexOf('--model') + 4), ['--model', 'fixture-beta', '--effort', 'high'], 'the draft\'s choices start that session');
  assert.ok(launched.filter(row => row.id !== newSessionId).every(row => !row.args.includes('--model')), 'other sessions keep the defaults');
  await page.getByRole('button', { name: /^新建对话/ }).first().click();
  await page.waitForFunction(() => document.querySelector('.draft-settings [data-setting-kind="model"]')?.textContent.startsWith('默认'));
  // A first message waits while the new Claude shows a prompt; reopening that chat
  // keeps it waiting, and closing the chat brings text and model back to the draft.
  const stateFile = path.join(fixtureWorkspace.claudeDir, 'screen-state');
  await writeFile(stateFile, 'waiting');
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /Fixture Beta/ }).click();
  await input.fill('稍后再发');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.first-message-bar').waitFor();
  const waitingId = await page.locator('.session-row.active').getAttribute('data-session-id');
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'waiting');
  await page.getByRole('button', { name: '关闭当前对话', exact: true }).click();
  await page.locator('dialog.confirm-action[open]').getByRole('button', { name: '关闭对话', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.draft-settings [data-setting-kind="model"]')?.textContent === 'Fixture Beta'
    && document.querySelector('textarea')?.value === '稍后再发' && !document.querySelector('.first-message-bar'));
  assert.equal(await page.locator(`.session-row[data-session-id="${waitingId}"]`).count(), 0, 'the unwritten chat is gone');
  assert.equal(await page.locator('.message-user').count(), 0, 'no sending bubble is left behind');
  await input.fill('');
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /^默认/ }).click();
  await writeFile(stateFile, 'ready');
  await page.locator('.session-row').first().click();
  assert.equal(await page.locator('.session-row').count(), 2, 'leaving an unsent draft starts nothing');
  await writeFile(stateFile, 'waiting');
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'waiting');
  assert.equal(await input.isDisabled(), true, 'Permission prompts cannot receive manual text from the composer');
  if (!(await page.locator('.terminal-panel').count())) await page.getByTitle('查看终端原屏').click();
  await page.waitForFunction(() => document.querySelector('.terminal-panel pre')?.textContent.includes('Permission required'));
  assert.equal(await page.locator('.terminal-keybar').count(), 0);
  await page.screenshot({ path: path.join(results, 'desktop-terminal-waiting.png') });
  await writeFile(stateFile, 'error');
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'error');
  assert.notEqual(await page.locator('.session-row.active').evaluate(node => getComputedStyle(node).backgroundColor), readyBackground, 'Error state has a different row background from idle');
  assert.equal(await input.isEnabled(), true, 'The fixture error has a confirmed empty native composer for an explicit retry');
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-live'), 'true', 'A native API error does not imply that the pane disconnected');
  await page.screenshot({ path: path.join(results, 'desktop-terminal-error.png') });
  await writeFile(stateFile, 'ready');
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle' && !document.querySelector('textarea')?.disabled);
  await page.getByRole('button', { name: '关闭终端原屏', exact: true }).click();

  // Exercise the actual diagnostic controls. This run uses only the isolated
  // demo workspace; its persistent test-results log directory is never shared
  // with the user's normal app profile or native Claude integration tests.
  await page.getByRole('button', { name: /诊断日志/ }).click();
  const diagnosticsDialog = page.getByRole('dialog', { name: '诊断日志', exact: true });
  await diagnosticsDialog.waitFor();
  const contentToggle = diagnosticsDialog.getByRole('switch', { name: '记录原屏与 JSONL 内容' });
  await contentToggle.waitFor();
  assert.equal(await contentToggle.isChecked(), true);
  assert.equal(await diagnosticsDialog.locator('.diagnostics-path').innerText(), diagnosticsDirectory);
  const initialDiagnostics = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(initialDiagnostics.captureContent, true);
  assert.equal(initialDiagnostics.enabled, true);
  await contentToggle.click();
  await page.waitForFunction(async () => !(await window.desktop.diagnosticsInfo()).captureContent);
  await page.waitForFunction(() => document.querySelector('input[role="switch"]')?.checked === false);
  await diagnosticsDialog.getByRole('button', { name: '关闭诊断日志', exact: true }).click();

  // Capture is disabled for this complete UI round trip. Metadata should still
  // describe the turn, with no raw screen, JSONL, input or message capture.
  await input.fill('LECTERN_E2E_METADATA_ONLY');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => {
    const assistants = document.querySelectorAll('.message-assistant');
    return assistants.length === 2 && assistants[1].getAttribute('data-source') === 'jsonl' && !document.querySelector('textarea')?.disabled;
  });
  await page.getByRole('button', { name: /诊断日志/ }).click();
  await contentToggle.waitFor();
  assert.equal(await contentToggle.isChecked(), false);
  await contentToggle.click();
  await page.waitForFunction(async () => (await window.desktop.diagnosticsInfo()).captureContent);
  await page.waitForFunction(() => document.querySelector('input[role="switch"]')?.checked === true);

  const expectedRendererError = 'LECTERN_E2E_EXPECTED_RENDERER_ERROR';
  const expectedRejection = 'LECTERN_E2E_EXPECTED_REJECTION';
  await page.evaluate(({ expectedRendererError, expectedRejection }) => {
    // Synthetic events exercise the global handlers without crashing the UI
    // or leaving a genuinely rejected Promise in the test process.
    window.dispatchEvent(new ErrorEvent('error', {
      message: expectedRendererError, error: new Error(expectedRendererError), filename: 'e2e-diagnostics.mjs', lineno: 1, colno: 1,
    }));
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(), reason: new Error(expectedRejection),
    }));
  }, { expectedRendererError, expectedRejection });
  const incidentNote = 'E2E: verify preview-to-JSONL diagnostics and metadata-only controls';
  await diagnosticsDialog.getByLabel('标记刚刚发生的问题').fill(incidentNote);
  await diagnosticsDialog.getByRole('button', { name: '标记问题时间点', exact: true }).click();
  await diagnosticsDialog.locator('.incident-result code').waitFor();
  const incidentId = await diagnosticsDialog.locator('.incident-result code').innerText();
  assert.match(incidentId, /^incident-[0-9a-f-]{36}$/);
  const clipboardBeforeIncident = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await diagnosticsDialog.getByRole('button', { name: '复制问题编号', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.incident-result button .lucide-check'));
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), incidentId);
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBeforeIncident);
  }
  await page.screenshot({ path: path.join(results, 'desktop-diagnostics.png') });

  const diagnosticInfo = await page.evaluate(() => window.desktop.diagnosticsInfo());
  assert.equal(diagnosticInfo.directory, diagnosticsDirectory);
  assert.equal(diagnosticInfo.captureContent, true, 'Raw-content logging is restored after the test');
  assert.equal(diagnosticInfo.droppedEvents, 0, 'No diagnostic events were dropped');
  assert.equal(diagnosticInfo.lastError, undefined, 'Diagnostics writes did not fail');
  const logFiles = (await readdir(diagnosticsDirectory)).filter(file => /^events\.\d+\.jsonl$/.test(file));
  const records = (await Promise.all(logFiles.map(file => readFile(path.join(diagnosticsDirectory, file), 'utf8'))))
    .flatMap(content => content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    .filter(record => record.runId === diagnosticInfo.runId)
    .sort((a, b) => a.seq - b.seq);
  assert.ok(records.some(record => record.event === 'app.start' && record.data.demo === true));
  assert.ok(records.some(record => record.event === 'ipc.saveWorkspace.error'), 'Main-process action errors are recorded');
  assert.ok(records.some(record => record.event === 'renderer.error' && record.data.message === expectedRendererError));
  assert.ok(records.some(record => record.event === 'renderer.unhandledrejection' && record.data.message === expectedRejection));
  assert.ok(records.some(record => record.event === 'renderer.render'), 'Applied renderer snapshots are recorded');
  assert.ok(records.some(record => record.event === 'incident.mark' && record.data.incidentId === incidentId && record.data.note === incidentNote));
  assert.ok(records.some(record => record.event === 'capture.screen'), 'Raw screen capture is present while enabled');
  assert.ok(records.some(record => record.event === 'capture.jsonl'), 'Raw JSONL capture is present while enabled');
  const disabledAt = records.find(record => record.event === 'diagnostics.content_changed' && record.data.captureContent === false)?.seq;
  const enabledAt = records.find(record => record.event === 'diagnostics.content_changed' && record.data.captureContent === true && record.seq > disabledAt)?.seq;
  assert.ok(disabledAt && enabledAt && enabledAt > disabledAt);
  const metadataOnly = records.filter(record => record.seq > disabledAt && record.seq < enabledAt);
  assert.ok(metadataOnly.some(record => record.event === 'renderer.render'));
  assert.equal(metadataOnly.some(record => record.event.startsWith('capture.')), false, 'Metadata-only mode contains no raw captures');
  // The model list is read once from the machine's home directory with the folder's configuration,
  // and the machine's tmux / Claude Code check runs once for the machine as a whole.
  const machine = [fixtureWorkspace.kind, fixtureWorkspace.host, fixtureWorkspace.port, fixtureWorkspace.claudeDir];
  const demoScopes = new Set([fixtureWorkspace.id, 'models-' + createHash('sha256').update(JSON.stringify(machine)).digest('hex'), 'host-check']);
  const strays = records.filter(record => record.context.workspaceId && !demoScopes.has(record.context.workspaceId)).map(record => [record.event, record.context.workspaceId]);
  assert.deepEqual(strays, [], 'Only the isolated demo workspace and its model list were accessed');
  assert.ok(records.some(record => record.event === 'backend.model_probe.result'), 'the model list came from the SDK probe');
  const summary = { runId: diagnosticInfo.runId, incidentId, logDirectory: diagnosticsDirectory, recordCount: records.length, captureContentRestored: diagnosticInfo.captureContent, droppedEvents: diagnosticInfo.droppedEvents, checkedEvents: ['app.start', 'ipc.saveWorkspace.error', 'renderer.error', 'renderer.unhandledrejection', 'renderer.render', 'incident.mark', 'capture.screen', 'capture.jsonl'] };
  await writeFile(path.join(diagnosticsDirectory, 'e2e-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await diagnosticsDialog.getByRole('button', { name: '关闭诊断日志', exact: true }).click();

  // 模拟器在输入框上方显示中断提示。通过 UI 中断，再核对同一原生会话接收下一轮。
  const slowPrompt = '测试停止生成 ' + '继续输出'.repeat(180);
  const afterStop = '中断之后继续聊天';
  await input.fill(slowPrompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '停止生成' }).click({ timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.dataset.status === 'idle' && !document.querySelector('textarea')?.disabled);
  assert.equal(await page.locator('.session-row.active').getAttribute('data-session-id'), newSessionId);
  await input.fill(afterStop);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.message-assistant[data-source="jsonl"]').getByText('已收到你的消息：' + afterStop, { exact: true }).waitFor();
  const discovery = await page.evaluate(id => window.desktop.discover(id), fixtureWorkspace.id);
  const transcript = discovery.sessions.find(session => session.id === newSessionId).path;
  const turns = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    .filter(row => row.type === 'user' || row.type === 'assistant');
  assert.deepEqual(turns.slice(-3).map(row => [row.type, row.message.content[0].text.split('\n')[0]]),
    [['user', slowPrompt], ['user', afterStop], ['assistant', '已收到你的消息：' + afterStop]]);
  assert.deepEqual(errors, []);
  console.log('PASS: Electron + tmux preview, JSONL, stop and continue in the same session, history reload, resume and local diagnostics.');
  console.log(`Screenshots: ${results}`);
  console.log(`Persistent diagnostics: ${diagnosticsDirectory}`);
} catch (error) {
  if (app) {
    const pages = app.windows();
    if (pages[0]) {
      await pages[0].screenshot({ path: path.join(results, 'failure.png') }).catch(() => {});
      console.error(await pages[0].locator('body').innerText().catch(() => 'No renderer'));
    }
  }
  throw error;
} finally {
  if (app) await app.close();
  await rm(userData, { recursive: true, force: true });
}
