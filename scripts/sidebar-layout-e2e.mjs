// Run after npm run build. An optional first argument selects a packaged Electron executable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { waitUntil } from './fixtures/loopback-ssh.mjs';

// Keep the demo's Unix-domain tmux socket within macOS's path limit.
const root = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'lectern-sidebar-')));
const profile = path.join(root, 'profile');
const claudeDir = path.join(root, 'config');
const cwd = path.join(root, 'workspace');
const reply = '侧栏宽度已保存。重新打开窗口后，可以继续处理这段会话。';
const resultDirectory = path.resolve('test-results', `sidebar-layout-${Date.now()}`);
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', CLAUDE_CONFIG_DIR: claudeDir, TMUX_TMPDIR: root, LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: path.join(root, 'logs') };
delete env.TMUX;
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;

let app, page;
const separator = () => page.getByRole('separator', { name: '调整侧栏宽度', exact: true });
const sidebar = () => page.locator('.sidebar');
const main = () => page.getByRole('main');
const width = async (locator) => (await locator.boundingBox()).width;
const sessionRow = id => page.locator(`.session-row[data-session-id="${id}"]`);
const sortControl = () => page.getByRole('button', { name: '对话排序', exact: true });
const sortLabels = { project: '按项目', recent: '最近更新', priority: '进行中优先' };

async function selectSort(mode) {
  await sortControl().click();
  await page.getByRole('menuitem', { name: sortLabels[mode], exact: true }).click();
}

async function expectGlobalOrder(mode, ...ids) {
  await page.waitForFunction(([mode, ids]) => {
    const list = document.querySelector(`.sidebar-tree[data-sidebar-sort="${mode}"] .sidebar-global`);
    const rows = list ? [...list.querySelectorAll('.session-row')] : [];
    return rows.length === ids.length && rows.every((row, index) => row.dataset.sessionId === ids[index]);
  }, [mode, ids]);
  assert.equal(await sortControl().getAttribute('aria-description'), sortLabels[mode]);
}

async function launch() {
  const executablePath = process.argv[2];
  app = await _electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByText(reply, { exact: true }).waitFor();
}

async function resizeWindow(target) {
  await app.evaluate(({ BrowserWindow }, requestedWidth) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(requestedWidth, window.getContentSize()[1]);
  }, target);
  await page.waitForFunction(target => window.innerWidth === target, target);
}

async function expectSidebarWidth(target) {
  await page.waitForFunction(target => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - target) <= 1, target);
  assert.ok(Math.abs(Number(await separator().getAttribute('aria-valuenow')) - target) <= 1, `Separator should announce its displayed width of ${target}px`);
}

async function dragBy(delta) {
  const rect = await separator().boundingBox();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + delta, y, { steps: 5 });
  } finally {
    await page.mouse.up();
  }
}

async function checkRows() {
  const rows = await page.locator('.workspace-row, .session-row').evaluateAll(elements => elements.map(row => {
    const label = row.querySelector('.workspace-name, .session-title');
    const range = document.createRange();
    range.selectNodeContents(label);
    const rect = row.getBoundingClientRect();
    return {
      height: rect.height,
      font: parseFloat(getComputedStyle(label).fontSize),
      lines: new Set([...range.getClientRects()].filter(rect => rect.height > 0).map(rect => Math.round(rect.top))).size,
      ellipsis: getComputedStyle(label).textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth,
    };
  }));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.height <= 30 && row.height >= row.font, `Expected a compact row with legible text, got ${JSON.stringify(row)}`);
    assert.ok(row.font >= 14, 'Directory and session text should be at least 14px by default');
    assert.equal(row.lines, 1, 'The long title should occupy one line');
    assert.equal(row.ellipsis, true, 'The long title should truncate inside its available width');
  }
  return rows;
}

async function checkBackgroundReplyStatus() {
  const executablePath = process.argv[2];
  app = await _electron.launch({
    executablePath, args: executablePath ? ['--demo'] : ['.', '--demo'],
    env: { ...env, TMPDIR: root, LECTERN_USER_DATA: path.join(root, 'demo-profile'), LECTERN_NODE_BINARY: process.execPath },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const active = page.locator('.session-row.active[data-session-live="true"]');
  await active.locator('.state-idle').waitFor();
  const liveId = await active.getAttribute('data-session-id');
  const liveRow = sessionRow(liveId);
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  assert.equal(workspace.id, 'demo-local');
  const historyId = randomUUID();
  const project = path.join(workspace.claudeDir, 'projects', workspace.cwd.replace(/[^a-z0-9-]/gi, '-'));
  const history = (...messages) => messages.map(message => JSON.stringify({
    type: message.role, uuid: randomUUID(), sessionId: historyId, cwd: workspace.cwd,
    timestamp: new Date().toISOString(), message,
  })).join('\n') + '\n';
  const archivedReply = '这段历史已经结束。';
  await writeFile(path.join(project, `${historyId}.jsonl`), history(
    { role: 'user', content: '打开另一段历史' },
    { role: 'assistant', content: [{ type: 'text', text: archivedReply }], stop_reason: 'end_turn' },
  ));
  const otherRow = sessionRow(historyId);
  await otherRow.waitFor();
  const idleDiscovery = await page.evaluate(id => window.desktop.discover(id), workspace.id);
  assert.equal(idleDiscovery.sessions.find(chat => chat.id === liveId)?.status, 'idle');
  // Reproduce a slow directory scan while the real reader continues polling tmux.
  await app.evaluate(({ ipcMain }, discovery) => {
    globalThis.sidebarLayoutDiscoveryCount = 0;
    ipcMain.removeHandler('lectern:discover');
    ipcMain.handle('lectern:discover', () => {
      globalThis.sidebarLayoutDiscoveryCount++;
      return discovery;
    });
  }, idleDiscovery);
  await selectSort('recent');
  await expectGlobalOrder('recent', historyId, liveId);
  const stateFile = path.join(workspace.claudeDir, 'screen-state');
  await writeFile(stateFile, 'progress');
  const replying = liveRow.locator('.session-state-label', { hasText: '回复中' });
  await replying.waitFor();
  await expectGlobalOrder('recent', historyId, liveId);
  await selectSort('priority');
  await expectGlobalOrder('priority', liveId, historyId);
  await otherRow.click();
  await page.getByText(archivedReply, { exact: true }).waitFor();
  assert.equal(await replying.isVisible(), true, 'Switching does not drop a live reply label');
  const scans = await app.evaluate(() => globalThis.sidebarLayoutDiscoveryCount);
  await waitUntil(() => app.evaluate(() => globalThis.sidebarLayoutDiscoveryCount).then(count => count > scans),
    'The sidebar did not request another directory scan after switching');
  await expectGlobalOrder('priority', liveId, historyId);
  assert.equal(await replying.isVisible(), true, 'An idle directory scan does not replace a known live reply');
  await page.reload();
  await page.getByText(archivedReply, { exact: true }).waitFor();
  await expectGlobalOrder('priority', liveId, historyId);
  await writeFile(stateFile, 'ready');
  await liveRow.locator('.session-status-dot.state-idle').waitFor();
  await expectGlobalOrder('priority', historyId, liveId);
  assert.equal(await otherRow.getAttribute('aria-current'), 'page', 'The original reply settles without switching back');
}

async function checkGlobalSorting(sessionId, olderId, remoteUpdatedAt) {
  const local = await page.evaluate(() => window.desktop.discover('layout'));
  // The global view spans machines. Exercise the normal local project alongside
  // an offline SSH fixture without connecting to a remote host.
  const remoteWorkspace = {
    id: 'layout-remote', kind: 'ssh', name: '跨机器归档项目', host: 'sidebar-fixture.invalid', cwd: '/srv/fixture',
  };
  const remoteChat = { id: randomUUID(), title: '远程发布记录', updatedAt: remoteUpdatedAt,
    paneId: '%93', mapping: 'exact', status: 'working', path: '/srv/fixture/chat.jsonl' };
  const remote = { workspace: remoteWorkspace, sessions: [remoteChat], panes: [] };
  const remoteReply = '远程工作目录里的回复。';
  await app.evaluate(({ ipcMain }, { local, remote, remoteReply, reply }) => {
    const replace = (name, handler) => {
      ipcMain.removeHandler(`lectern:${name}`);
      ipcMain.handle(`lectern:${name}`, handler);
    };
    replace('listWorkspaces', () => [local.workspace, remote.workspace]);
    replace('checkSshConnection', () => ({ ok: true }));
    replace('checkHost', () => ({ ok: true, tools: {
      system: 'Linux', distro: ['ubuntu'], managers: ['apt-get'], root: false,
      tmux: { path: '/usr/bin/tmux', version: 'tmux 3.4' },
      claude: { path: '/usr/bin/claude', version: '2.1.329 (Claude Code)' },
    } }));
    replace('discover', (_event, workspaceId) => workspaceId === remote.workspace.id ? remote : local);
    replace('watchSession', (_event, workspaceId, sessionId) => {
      const isRemote = workspaceId === remote.workspace.id;
      const discovery = isRemote ? remote : local;
      const chat = discovery.sessions.find(item => item.id === sessionId);
      if (!chat) throw new Error('Session was opened through the wrong project');
      return { workspaceId, sessionId, status: isRemote ? 'working' : 'idle', paneId: chat.paneId, screen: '',
        messages: [{ id: `${sessionId}-reply`, role: 'assistant', source: 'jsonl', status: 'complete',
          text: isRemote ? remoteReply : reply, tools: [] }] };
    });
  }, { local, remote, remoteReply, reply });
  await page.reload();
  await sessionRow(sessionId).waitFor();
  assert.equal(await sortControl().getAttribute('aria-description'), sortLabels.project);
  assert.equal(await page.locator('.sidebar-global').count(), 0, 'A new profile opens the project tree');

  await selectSort('recent');
  await expectGlobalOrder('recent', sessionId, remoteChat.id, olderId);
  assert.equal(await sessionRow(remoteChat.id).locator('.session-origin').innerText(), `${remoteWorkspace.name} · ${remoteWorkspace.host}`);
  assert.equal(await sessionRow(sessionId).locator('.session-origin').innerText(), `${local.workspace.name} · 本地`);
  assert.equal(await sessionRow(sessionId).getAttribute('aria-current'), 'page');

  await sortControl().press('Enter');
  const priorityItem = page.getByRole('menuitem', { name: sortLabels.priority, exact: true });
  await priorityItem.waitFor();
  await page.keyboard.press('End');
  assert.equal(await priorityItem.evaluate(item => item === document.activeElement), true);
  await page.keyboard.press('Enter');
  await expectGlobalOrder('priority', remoteChat.id, sessionId, olderId);
  const global = page.locator('.sidebar-global');
  await global.getByRole('heading', { name: '进行中', exact: true }).waitFor();
  await global.getByRole('heading', { name: '其他会话', exact: true }).waitFor();
  assert.deepEqual(await global.locator(':scope > *').evaluateAll(children => children.map(item => (
    item.querySelector('.session-row')?.dataset.sessionId ?? item.textContent
  ))), ['进行中', remoteChat.id, '其他会话', sessionId, olderId]);
  assert.equal(await sessionRow(sessionId).getAttribute('aria-current'), 'page', 'Sorting keeps the current chat selected');
  await page.reload();
  await expectGlobalOrder('priority', remoteChat.id, sessionId, olderId);
  assert.equal(await sessionRow(sessionId).getAttribute('aria-current'), 'page');

  const filter = page.getByRole('textbox', { name: '筛选项目和对话', exact: true });
  await filter.fill(remoteWorkspace.name);
  await expectGlobalOrder('priority', remoteChat.id);
  await filter.clear();
  await sessionRow(remoteChat.id).click();
  await page.getByText(remoteReply, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(resultDirectory, 'global-priority.png') });
  await selectSort('project');
  await page.locator('.workspace-tree-group').filter({ hasText: remoteWorkspace.name }).waitFor();
  assert.equal(await sessionRow(remoteChat.id).getAttribute('aria-current'), 'page');
  await checkSupersededDiscovery(local, remote, remoteChat);
}

async function checkSupersededDiscovery(local, remote, chat) {
  const newTitle = '远程发布记录已刷新';
  const updated = { ...remote, sessions: [{ ...chat, title: newTitle }] };
  const refresh = async () => {
    await page.locator(`.workspace-row[data-workspace-id="${remote.workspace.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '刷新会话列表', exact: true }).click();
  };
  const waitForScan = (count, message, timeout) => waitUntil(
    () => app.evaluate(() => globalThis.sidebarLayoutScans.started).then(started => started >= count), message, timeout,
  );

  await app.evaluate(({ ipcMain }, { local, updated }) => {
    const gates = Array.from({ length: 3 }, () => {
      let finish, fail;
      const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      return { result, finish, fail };
    });
    const scans = globalThis.sidebarLayoutScans = { started: 0, gates, updated };
    ipcMain.removeHandler('lectern:discover');
    ipcMain.handle('lectern:discover', (_event, id) => id === updated.workspace.id
      ? scans.gates[scans.started++]?.result ?? updated
      : local);
  }, { local, updated });
  const row = sessionRow(chat.id);
  try {
    await refresh();
    await waitForScan(1, 'The sidebar did not start the requested scan');
    // Electron resolves an obsolete backend scan without a discovery payload.
    await app.evaluate(() => { globalThis.sidebarLayoutScans.gates[0].finish(); });
    await waitForScan(2, 'An obsolete scan did not trigger an immediate retry', 3000);
    assert.equal(await row.locator('.session-title').innerText(), chat.title, 'The existing row stays visible during the retry');
    assert.equal(await page.locator('.error-banner, .tree-note-error').count(), 0, 'An obsolete scan does not show an error');
    await app.evaluate(() => {
      const { gates, updated } = globalThis.sidebarLayoutScans;
      gates[1].finish(updated);
    });
    await row.getByText(newTitle, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(resultDirectory, 'recovered-discovery.png') });

    await refresh();
    await waitForScan(3, 'The sidebar did not start the next scan');
    await app.evaluate(() => { globalThis.sidebarLayoutScans.gates[2].fail(new Error('Synthetic discovery failure')); });
    await page.locator('.error-banner').getByText('Synthetic discovery failure', { exact: false }).waitFor();
    assert.equal(await row.getByText(newTitle, { exact: true }).isVisible(), true, 'A real failure preserves the last successful scan');
  } finally {
    await app.evaluate(() => {
      const { gates, updated } = globalThis.sidebarLayoutScans;
      for (const gate of gates) gate.finish(updated);
    });
  }
}

try {
  // Normal app startup with one historical transcript. No Claude process or SSH connection is needed.
  const project = path.join(claudeDir, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
  await Promise.all([profile, cwd, project, resultDirectory].map(dir => mkdir(dir, { recursive: true })));
  const workspaceName = '桌面客户端 · 多项目协作与本地历史会话管理体验改进';
  const question = '检查桌面客户端重新打开后是否保留侧栏宽度，并确认较长的历史会话标题仍然保持单行。';
  const sessionId = randomUUID(), timestamp = new Date().toISOString();
  const records = [
    { type: 'user', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'user', content: question } },
    { type: 'assistant', uuid: randomUUID(), sessionId, cwd, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } },
  ];
  await Promise.all([
    writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'layout', name: workspaceName, kind: 'local', cwd, claudeDir }])),
    writeFile(path.join(project, `${sessionId}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n'),
  ]);

  await launch();
  await resizeWindow(1280);
  await expectSidebarWidth(304);
  assert.equal(await separator().getAttribute('aria-orientation'), 'vertical');
  const rows = await checkRows();
  const fonts = await page.evaluate(() => Object.fromEntries(['.markdown p', '.user-text', '.composer textarea'].map(selector =>
    [selector, parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)])));
  assert.ok(Object.values(fonts).every(size => size >= 16), `Chat and composer text should be at least 16px by default: ${JSON.stringify(fonts)}`);
  await page.screenshot({ path: path.join(resultDirectory, 'default.png') });

  await dragBy(104);
  const preferred = 408;
  await expectSidebarWidth(preferred);
  await separator().press('ArrowRight');
  await expectSidebarWidth(preferred + 16);
  await separator().press('ArrowLeft');
  await expectSidebarWidth(preferred);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await sidebar().waitFor({ state: 'hidden' });
  assert.equal(await separator().isVisible(), false);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expectSidebarWidth(preferred);
  await app.close();
  app = undefined;
  await launch();
  await resizeWindow(1280);
  await expectSidebarWidth(preferred);

  await separator().press('Home');
  await expectSidebarWidth(208);
  await dragBy(-150);
  await expectSidebarWidth(208);
  await separator().press('End');
  await expectSidebarWidth(480);
  await dragBy(250);
  await expectSidebarWidth(480);

  const openDrawer = () => page.getByRole('button', { name: '浏览工作目录', exact: true }).click();
  const closeDrawer = () => page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  const drawer = page.locator('.artifact-drawer');
  // The preview belongs to the chat pane: it docks while the pane leaves the
  // chat 500px and shows over the chat otherwise, never resizing the sidebar.
  const drawerPosition = () => drawer.evaluate(el => getComputedStyle(el).position);
  await separator().press('Home');
  await expectSidebarWidth(208);
  await openDrawer();
  await drawer.getByText('此文件夹为空。', { exact: true }).waitFor();
  await expectSidebarWidth(208);
  assert.equal(await drawerPosition(), 'relative', 'A wide pane docks the preview');
  const dockedChat = await width(main());
  assert.ok(dockedChat >= 499, 'Docked preview must leave room for the conversation');
  assert.ok((await main().boundingBox()).x + dockedChat <= (await drawer.boundingBox()).x + 1, 'The docked preview sits beside the chat');
  await separator().press('End');
  await expectSidebarWidth(480);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.artifact-drawer')).position === 'absolute');
  assert.ok(await width(main()) >= 499, 'An overlaid preview leaves the conversation its width');
  const header = await page.locator('.topbar').evaluate(bar => {
    const title = bar.querySelector('.topbar-title'), actions = bar.querySelector('.topbar-actions');
    return { right: title.getBoundingClientRect().right, startOfActions: actions.getBoundingClientRect().left, overflow: getComputedStyle(title).overflowX };
  });
  assert.ok(header.right <= header.startOfActions + 1 && header.overflow !== 'visible', 'A long workspace title must truncate before the toolbar buttons');
  await page.screenshot({ path: path.join(resultDirectory, 'docked-preview.png') });
  await closeDrawer();
  await expectSidebarWidth(480);

  await resizeWindow(850);
  await expectSidebarWidth(350);
  await checkRows();
  await openDrawer();
  await drawer.getByText('此文件夹为空。', { exact: true }).waitFor();
  await expectSidebarWidth(350);
  await page.screenshot({ path: path.join(resultDirectory, 'narrow-preview.png') });
  await closeDrawer();
  await resizeWindow(1280);
  await expectSidebarWidth(480);
  await resizeWindow(850);
  await dragBy(400);
  await expectSidebarWidth(350);
  assert.ok(await width(main()) >= 499, 'Dragging at minimum window width must keep the conversation usable');
  await resizeWindow(1280);
  await separator().dblclick();
  await expectSidebarWidth(304);

  // A new reply in another chat still raises its unread indicator in the project tree.
  const olderId = randomUUID();
  const olderLog = path.join(project, `${olderId}.jsonl`);
  const olderDate = (hours) => new Date(Date.parse(timestamp) - hours * 60 * 60 * 1000).toISOString();
  const olderRecords = (hours, user, assistant) => records.map((record, i) => JSON.stringify({
    ...record, uuid: randomUUID(), sessionId: olderId, timestamp: olderDate(hours - i),
    message: { ...record.message, content: i === 0 ? user : [{ type: 'text', text: assistant }] },
  })).join('\n') + '\n';
  await writeFile(olderLog, olderRecords(48, '较早的会话', '已经读过的回复'));
  const olderRow = sessionRow(olderId);
  await olderRow.waitFor();
  assert.equal(await olderRow.locator('.state-unread').count(), 0);
  await appendFile(olderLog, olderRecords(24, '较早会话的新问题', '一条未读的回复'));
  await olderRow.locator('.state-unread').waitFor();

  await checkGlobalSorting(sessionId, olderId, olderDate(12));
  await app.close();
  app = undefined;
  await checkBackgroundReplyStatus();
  console.log(JSON.stringify({ success: true, defaultWidth: 304, persistedWidth: preferred, dockedChat, narrowMax: 350, rows, fonts, sidebarSort: 'global recent and active priority across local and SSH, search, keyboard, selection, reload', backgroundReplyStatus: true, supersededDiscoveryRetried: true, resultDirectory }));
} catch (error) {
  await page?.screenshot({ path: path.join(resultDirectory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
