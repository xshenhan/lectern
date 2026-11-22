// Renderer-only SSH contract test. All history/discovery/session IPC uses local
// synthetic records. No SSH process, remote input, or model request is allowed.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(path.join(tmpdir(), 'lectern-ssh-ui-'));
const resultDirectory = path.resolve('test-results', `ssh-ui-${Date.now()}`);
const diagnostics = path.join(resultDirectory, 'diagnostics');
await mkdir(resultDirectory, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: diagnostics };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const host = 'synthetic-ssh-alias';
const paths = ['/srv/projects/中文 team', '/srv/projects/service-b', '/srv/deleted-project'];
const ids = paths.map(() => randomUUID());
let app;
try {
  const executablePath = process.argv[2];
  app = await _electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath && {executablePath:path.resolve(executablePath)}), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByRole('button', { name: '添加 SSH 机器', exact: true }).waitFor();
  // Folders are added on a machine in the sidebar; the sidebar heading has no generic entry.
  assert.equal(await page.locator('.sidebar-heading-actions').getByRole('button', { name: '添加工作目录', exact: true }).count(), 0);
  await app.evaluate(({ ipcMain, BrowserWindow }, { paths, ids }) => {
    const fixture = globalThis.__sshUI = { paths, ids, scans: [], calls: [], scanFail: false, watchFail: false, failCwd: '', live: {}, current: undefined };
    const workspaces = event => event.sender.executeJavaScript('window.desktop.listWorkspaces()');
    const session = workspace => ({ id: fixture.ids[Math.max(0, fixture.paths.indexOf(workspace.cwd))], title: `远程历史 · ${workspace.name}`, path: `/home/remote/.claude/projects/synthetic/${workspace.id}.jsonl`,
      updatedAt: '2026-01-02T10:00:00Z', mapping: 'exact', status: fixture.live[workspace.id] ? 'idle' : 'history', paneId: fixture.live[workspace.id] ? '%42' : undefined });
    const snapshot = (workspace, sessionId) => ({ workspaceId: workspace.id, sessionId, paneId: fixture.live[workspace.id] ? '%42' : undefined,
      status: 'idle', navigationStatus: fixture.live[workspace.id] ? 'idle' : 'history', screen: 'Synthetic SSH Claude Code\n❯ ', viewport: 'Synthetic SSH Claude Code\n❯ ',
      messages: [{ id: `${sessionId}-assistant`, role: 'assistant', text: `远程历史正文：${workspace.cwd} · 中文 🧭`, tools: [], source: 'jsonl', status: 'complete' }] });
    const replace = (method, handler) => { ipcMain.removeHandler(`lectern:${method}`); ipcMain.handle(`lectern:${method}`, handler); };
    fixture.browses = [];
    replace('listWorkspaceDirectories', async (_event, target, requested, offset) => {
      fixture.browses.push({target, requested, offset});
      if (target.kind !== 'ssh' || target.host !== 'synthetic-ssh-alias') throw new Error('浏览目标错误');
      if (requested === '~') return {path:'/srv', directories:['projects']};
      if (requested === '/srv/projects') return offset ? {path:requested, directories:['service-b']} : {path:requested, directories:['中文 team'], nextOffset:1};
      if (fixture.paths.includes(requested)) return {path:requested, directories:[]};
      throw new Error('这个目录不可访问');
    });
    replace('resolveArtifactReferences', async () => []);
    // The startup connection check stays inside the fixture too.
    fixture.checks = [];
    replace('checkSshConnection', async (_event, target) => { fixture.checks.push(target); return { ok: true }; });
    // The machine's tmux / Claude Code check stays inside the fixture too: both are there.
    replace('checkHost', async () => ({ ok: true, tools: { system: 'Linux', distro: ['ubuntu'], managers: ['apt-get'], root: false,
      tmux: { path: '/usr/bin/tmux', version: 'tmux 3.4' }, claude: { path: '/home/dev/.local/bin/claude', version: '2.1.329 (Claude Code)' } } }));
    // New chats read the machine's model list; keep that inside the fixture too.
    replace('modelCatalog', async () => ({ status: 'failed', error: 'synthetic: no model list' }));
    // The activity card reads the folder's git changes; the synthetic folder is no repository.
    fixture.gitReads = 0;
    replace('gitChanges', async () => { fixture.gitReads++; return { kind: 'none' }; });
    // Showing a conversation indexes its folder for @ completion; record it instead of scanning.
    fixture.prefetches = [];
    replace('prefetchFileIndex', async (_event, workspaceId) => { fixture.prefetches.push(workspaceId); });
    replace('discoverHistoryProjects', async (_event, target) => {
      fixture.scans.push(target);
      if (fixture.scanFail) throw new Error('Synthetic SSH: Permission denied (publickey).');
      return { projects: target.kind === 'ssh' ? fixture.paths.map((cwd, index) => ({ cwd, sessionCount: index === 0 ? 2 : 1, exists: index < 2, latestAt: '2026-01-02T10:00:00Z' })) : [],
        scannedFiles: target.kind === 'ssh' ? 4 : 0, skippedFiles: 0, truncated: false, claudeDir: target.claudeDir || '/home/remote/.claude' };
    });
    replace('discover', async (event, workspaceId) => {
      const workspace = (await workspaces(event)).find(item => item.id === workspaceId);
      fixture.calls.push({ method: 'discover', workspaceId });
      if (workspace.cwd === fixture.failCwd) throw new Error('Synthetic SSH: Permission denied (publickey).');
      return { workspace, sessions: workspace.kind === 'ssh' ? [session(workspace)] : [], panes: [] };
    });
    replace('watchSession', async (event, workspaceId, sessionId) => {
      fixture.calls.push({ method: 'watch', workspaceId, sessionId });
      if (fixture.watchFail) throw new Error('Synthetic SSH: connection reset while reading history');
      const workspace = (await workspaces(event)).find(item => item.id === workspaceId);
      const next = snapshot(workspace, sessionId);
      fixture.current = next;
      return next;
    });
    fixture.resumeGates = new Map();
    replace('resumeSession', async (event, workspaceId, sessionId) => {
      fixture.calls.push({ method: 'resume', workspaceId });
      const gate = fixture.resumeGates.get(workspaceId);
      if (gate) {
        const error = await gate.promise;
        fixture.resumeGates.delete(workspaceId);
        if (error) throw new Error(error);
      }
      fixture.live[workspaceId] = true;
      const workspace = (await workspaces(event)).find(item => item.id === workspaceId);
      // Like the main process: the reader already showing it reads once more and pushes the live pane.
      fixture.current = snapshot(workspace, sessionId);
      event.sender.send('lectern:snapshot', fixture.current);
      return session(workspace);
    });
    for (const method of ['createSession', 'sendMessage', 'sendKey', 'getSessionSetting', 'setSessionSetting', 'respondDirectoryTrust'])
      replace(method, async () => { fixture.calls.push({ method }); throw new Error(`Unexpected synthetic test action: ${method}`); });
    fixture.disconnect = () => BrowserWindow.getAllWindows()[0].webContents.send('lectern:snapshot', { ...fixture.current, status: 'offline', navigationStatus: 'unknown', error: 'Synthetic SSH: connection lost' });
  }, { paths, ids });

  const composer = page.getByRole('textbox', { name: '发送给 Claude 的消息', exact: true });
  await page.getByRole('button', { name: '添加 SSH 机器', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByLabel('连接名称').fill('示例 SSH 机器');
  await settings.getByLabel('SSH 主机', { exact: true }).fill(host);
  await settings.getByLabel('端口', { exact: true }).fill('70000');
  await settings.getByRole('button', { name: '保存连接' }).click();
  assert.match(await settings.getByRole('alert').innerText(), /1–65535/);
  await settings.getByLabel('端口', { exact: true }).fill('');
  await settings.getByRole('button', { name: '保存连接' }).click();
  const machine = page.getByRole('region', { name: '示例 SSH 机器', exact: true });
  await page.reload();
  await machine.getByText('尚未添加项目文件夹').waitFor();
  await machine.getByRole('button', { name: '收起机器 示例 SSH 机器' }).click();
  await machine.getByRole('button', { name: '展开机器 示例 SSH 机器' }).click();
  assert.deepEqual(await page.evaluate(() => window.desktop.listWorkspaces()), []);
  assert.deepEqual(await app.evaluate(() => [globalThis.__sshUI.scans, globalThis.__sshUI.calls]), [[], []], 'Saving, restoring and expanding a machine performs no discovery');
  assert.deepEqual(await app.evaluate(() => globalThis.__sshUI.browses), []);
  const addFolder = async (cwd, browse = false) => {
    await machine.getByRole('button', { name: '在 示例 SSH 机器 添加项目文件夹' }).click();
    const folder = page.getByRole('dialog', { name: '添加项目文件夹' });
    assert.equal(await folder.getByRole('button', { name: '发现此主机的会话' }).count(), 0);
    const input = folder.getByLabel('工作目录', { exact: true });
    if (browse) {
      await folder.getByRole('button', {name:'选择文件夹'}).click();
      const picker = page.getByRole('dialog', {name:'选择工作目录', exact:true});
      const navigate = name => picker.getByRole('button', {name, exact:true}).click();
      await navigate('projects');
      await navigate('显示更多文件夹');
      await picker.getByRole('button', {name:'service-b', exact:true}).waitFor();
      await picker.screenshot({path:path.join(resultDirectory, 'ssh-project-picker.png')});
      await navigate('中文 team');
      await picker.getByText('此目录没有子文件夹').waitFor();
      await navigate('上一级目录');
      await picker.getByRole('button', {name:'中文 team'}).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await input.inputValue(), '', '取消选择保留原路径');
      await input.fill('/missing');
      await folder.getByRole('button', {name:'选择文件夹'}).click();
      await picker.getByRole('alert').waitFor();
      assert.equal(await picker.getByRole('button', {name:'选择此目录'}).isDisabled(), true);
      await navigate('主目录'); await navigate('projects'); await navigate('中文 team'); await navigate('选择此目录');
      assert.equal(await input.inputValue(), cwd);
      assert.equal(await folder.getByLabel('名称', {exact:true}).inputValue(), '');
    } else await input.fill(cwd);
    await folder.getByRole('button', { name: '添加目录', exact: true }).click();
    return folder;
  };
  for (const cwd of paths.slice(0, 2)) {
    const folder = await addFolder(cwd, cwd === paths[0]);
    await folder.waitFor({ state: 'detached' });
    await page.waitForFunction(cwd => document.querySelector('.message-assistant')?.textContent.includes(cwd), cwd);
  }
  let stored = await page.evaluate(() => window.desktop.listWorkspaces());
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map(w => w.name), paths.slice(0, 2).map(p => path.posix.basename(p)));
  assert.ok(stored.every(w => w.kind === 'ssh' && w.host === host && !w.port && !w.claudeDir));
  assert.equal(await machine.locator('.workspace-row').count(), 2);
  assert.equal(await page.getByRole('region', { name: '本地', exact: true }).locator('.workspace-row').count(), 0);
  assert.equal(await composer.isDisabled(), true);
  const folder = await addFolder(paths[0]);
  await folder.getByRole('alert').waitFor();
  await folder.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.__sshUI.scans), []);
  await page.screenshot({ path: path.join(resultDirectory, 'machine-tree.png') });
  await page.getByRole('button', { name: '发现本机会话', exact: true }).click();
  const localImporter = page.getByRole('dialog', { name: '发现本机会话', exact: true });
  await localImporter.locator('.history-scan-empty').waitFor();
  assert.equal((await app.evaluate(() => globalThis.__sshUI.scans.at(-1))).kind, 'local');
  assert.equal(await localImporter.locator('[data-history-host]').count(), 0, 'Closing remote discovery does not leak its target into local discovery');
  await localImporter.getByRole('button', { name: '关闭历史发现', exact: true }).click();

  await machine.locator(`.session-row[data-session-id="${ids[0]}"]`).click();
  await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('中文 team'));
  await app.evaluate(() => { globalThis.__sshUI.watchFail = true; });
  await page.locator(`.session-row[data-session-id="${ids[1]}"]`).click();
  await page.locator('.error-banner').waitFor();
  assert.match(await page.locator('.error-banner').innerText(), /connection reset/);
  assert.equal(await composer.isDisabled(), true);
  await app.evaluate(() => { globalThis.__sshUI.watchFail = false; });
  await page.locator('.error-banner').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('service-b'));

  // Control two slow resumes independently, including the older request finishing first.
  const [first, second] = stored;
  await app.evaluate((_electron, workspaceIds) => {
    const { resumeGates } = globalThis.__sshUI;
    for (const id of workspaceIds) {
      let finish;
      const promise = new Promise(resolve => { finish = resolve; });
      resumeGates.set(id, { promise, finish });
    }
  }, [first.id, second.id]);
  const resume = page.getByRole('button', { name: '续接会话', exact: true });
  const openConversation = async (index) => {
    await machine.locator(`.session-row[data-session-id="${ids[index]}"]`).click();
    await page.locator('.message-assistant').filter({ hasText: paths[index] }).waitFor();
  };
  await openConversation(0);
  await resume.click();
  await resume.locator('.rotating').waitFor();
  await openConversation(1);
  assert.equal(await resume.isEnabled(), true, 'Another history can be resumed while the first request is pending');
  assert.equal(await resume.locator('.rotating').count(), 0, 'Another history never inherits the first spinner');
  await resume.click();
  await resume.locator('.rotating').waitFor();
  await openConversation(0);
  await resume.locator('.rotating').waitFor();
  await openConversation(1);
  await app.evaluate((_electron, id) => { globalThis.__sshUI.resumeGates.get(id).finish(); }, first.id);
  await page.waitForFunction(id => document.querySelector(`.session-row[data-session-id="${id}"]`)?.dataset.sessionLive === 'true', ids[0]);
  assert.equal(await resume.isDisabled(), true, 'Finishing the first request leaves the second pending');
  assert.equal(await resume.locator('.rotating').count(), 1);
  await openConversation(0);
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  assert.equal(await resume.count(), 0, 'A live conversation stays usable during another resume');
  await openConversation(1);
  await resume.locator('.rotating').waitFor();
  await app.evaluate((_electron, id) => { globalThis.__sshUI.resumeGates.get(id).finish('Synthetic resume failure'); }, second.id);
  await page.locator('.error-banner').getByText('Synthetic resume failure', { exact: false }).waitFor();
  assert.equal(await resume.isEnabled(), true, 'The failed resume can be retried');

  // The machine's own folder dialog browses that machine.
  const browsed = await app.evaluate(() => globalThis.__sshUI.browses.at(-1).target);
  assert.ok(browsed.kind === 'ssh' && browsed.host === host && !browsed.port, JSON.stringify(browsed));
  await app.evaluate(() => { globalThis.__sshUI.failCwd = '/srv/inaccessible'; });
  await addFolder('/srv/inaccessible');
  await page.locator('.error-banner').waitFor();
  assert.match(await page.locator('.error-banner').innerText(), /Permission denied/);
  assert.equal(await composer.isDisabled(), true);
  await page.screenshot({ path: path.join(resultDirectory, 'ssh-connection-error.png') });
  await app.evaluate(() => { globalThis.__sshUI.failCwd = ''; });
  await page.locator('.error-banner').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('/srv/inaccessible'));
  assert.equal(await page.locator('.error-banner').count(), 0);
  const watchesBeforeResume = await app.evaluate(() => globalThis.__sshUI.calls.filter(call => call.method === 'watch').length);
  await page.getByRole('button', { name: '续接会话', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  assert.equal(await page.locator('.message-assistant').count(), 1);
  assert.equal(await app.evaluate(() => globalThis.__sshUI.calls.filter(call => call.method === 'watch').length), watchesBeforeResume,
    'Resume keeps the loaded history instead of opening the conversation again');
  await app.evaluate(() => globalThis.__sshUI.disconnect());
  await page.locator('.error-banner').waitFor();
  assert.equal(await composer.isDisabled(), true);
  await page.getByTitle('查看终端原屏').click();
  await page.locator('.terminal-panel[data-readonly="true"]').waitFor();
  assert.equal(await page.locator('.terminal-keybar').count(), 0);
  await page.locator('.error-banner').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);

  // A local folder is added on the local machine, like any other.
  if (process.platform !== 'win32') {
    await page.getByRole('button', { name: '在 本地 添加项目文件夹', exact: true }).click();
    const local = page.getByRole('dialog', { name: '添加项目文件夹' });
    await local.getByLabel('名称', { exact: true }).fill('Local form fixture');
    await local.getByLabel('工作目录', { exact: true }).fill(root);
    await local.getByRole('button', { name: '添加目录', exact: true }).click();
    await local.waitFor({ state: 'detached' });
    stored = await page.evaluate(() => window.desktop.listWorkspaces());
    assert.ok(stored.some(workspace => workspace.name === 'Local form fixture' && workspace.kind === 'local' && workspace.port === undefined));
  }
  const fixture = await app.evaluate(() => ({ calls: globalThis.__sshUI.calls, scans: globalThis.__sshUI.scans, prefetches: globalThis.__sshUI.prefetches }));
  assert.equal(fixture.calls.filter(call => call.method === 'resume').length, 3);
  const watched = new Set(fixture.calls.filter(call => call.method === 'watch').map(call => call.workspaceId));
  assert.ok([...watched].every(id => fixture.prefetches.includes(id)), 'every opened SSH conversation indexes its folder for @');
  assert.ok(fixture.calls.every(call => ['discover', 'watch', 'resume'].includes(call.method)));
  await app.close(); app = undefined;
  const events = (await Promise.all((await readdir(diagnostics)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(diagnostics, name), 'utf8'))))
    .join('\n').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(!events.some(event => event.event.startsWith('transport.command')), 'This UI test must never launch SSH or any native backend command');
  const report = { success: true, scope: 'renderer SSH workflow only; local synthetic IPC', manualFolderScope: true, noScanOnMachineRegistration: true, configInheritancePreserved: true, noDuplicateFolders: true,
 initialConnectionErrorsVisible: true, watchErrorsRetriable: true, readonlyTerminal: true, noNativeCommandsOrModelRequests: true, scans: fixture.scans.length };
  await writeFile(path.join(resultDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, resultDirectory }));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(resultDirectory, 'failure.png') }).catch(() => {});
  throw error;
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
