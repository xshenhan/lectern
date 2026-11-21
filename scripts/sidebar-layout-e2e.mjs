// Run after npm run build. An optional first argument selects a packaged Electron executable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-sidebar-')));
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

  // Deliver an unread reply to an older conversation so the two sort modes visibly disagree.
  const olderId = randomUUID();
  const olderLog = path.join(project, `${olderId}.jsonl`);
  const olderDate = (hours) => new Date(Date.parse(timestamp) - hours * 60 * 60 * 1000).toISOString();
  const olderRecords = (hours, user, assistant) => records.map((record, i) => JSON.stringify({
    ...record, uuid: randomUUID(), sessionId: olderId, timestamp: olderDate(hours - i),
    message: { ...record.message, content: i === 0 ? user : [{ type: 'text', text: assistant }] },
  })).join('\n') + '\n';
  await writeFile(olderLog, olderRecords(48, '较早的会话', '已经读过的回复'));
  const olderRow = page.locator(`.session-row[data-session-id="${olderId}"]`);
  await olderRow.waitFor();
  assert.equal(await olderRow.locator('.state-unread').count(), 0);
  await appendFile(olderLog, olderRecords(24, '较早会话的新问题', '一条未读的回复'));
  await olderRow.locator('.state-unread').waitFor();

  const selectedRow = page.locator(`.session-row[data-session-id="${sessionId}"]`);
  const sort = page.getByRole('button', { name: '对话排序', exact: true });
  const recent = '按更新时间', priority = '按对话优先级';
  const expectSort = async (label, first, second) => {
    await page.waitForFunction(([first, second]) => {
      const rows = document.querySelectorAll('.workspace-tree-group .session-row');
      return rows.length === 2 && rows[0].dataset.sessionId === first && rows[1].dataset.sessionId === second;
    }, [first, second]);
    assert.equal(await sort.getAttribute('aria-description'), label);
    assert.equal(await selectedRow.getAttribute('aria-current'), 'page', 'Sorting keeps the current chat selected');
  };
  await expectSort(recent, sessionId, olderId);
  await sort.press('Enter');
  const priorityItem = page.getByRole('menuitem', { name: priority, exact: true });
  await priorityItem.waitFor();
  await page.keyboard.press('ArrowDown');
  assert.equal(await priorityItem.evaluate(item => item === document.activeElement), true);
  await page.keyboard.press('Enter');
  await expectSort(priority, olderId, sessionId);
  await page.reload();
  await expectSort(priority, olderId, sessionId);
  await sort.click();
  await page.getByRole('menuitem', { name: recent, exact: true }).click();
  await expectSort(recent, sessionId, olderId);
  console.log(JSON.stringify({ success: true, defaultWidth: 304, persistedWidth: preferred, dockedChat, narrowMax: 350, rows, fonts, sidebarSort: 'recent and unread priority, keyboard, selection, reload', resultDirectory }));
} catch (error) {
  await page?.screenshot({ path: path.join(resultDirectory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
