import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMenu, type MenuAction, type MenuEntry } from '../src/renderer/ContextMenu';
import { folderMenu, machineMenu, revealLabel, sessionMenu, type SidebarMenuActions } from '../src/renderer/sidebar-menus';
import { fileEntries, toolCommand, toolMenu } from '../src/renderer/message-menus';
import { editMenuItems } from '../src/main/edit-menu';
import { archiveKey, archiveSession, desktopState, forgetProject, loadDesktopState, restoreSessions } from '../src/renderer/desktop-state';
import type { SessionInfo, Workspace } from '../src/shared/types';
import type { WorkspaceMachine } from '../src/renderer/workspace-machines';

const labels = (entries: MenuEntry[]) => normalizeMenu(entries).map(entry => entry === 'separator' ? '—' : entry.label);
const item = (entries: MenuEntry[], label: string) => entries.find((entry): entry is MenuAction => entry !== 'separator' && entry.label === label)!;
const noop = () => {};
const actions = (patch: Partial<SidebarMenuActions> = {}): SidebarMenuActions => ({
  platform: 'darwin', demo: false, busy: false, connections: [], addFolder: noop, login: noop, editConnections: noop, importHistory: noop,
  newSession: noop, refresh: noop, scanHistory: noop, editWorkspace: noop, saveWorkspace: async () => {}, removeWorkspace: async () => {},
  open: noop, openBeside: noop, archiveSession: noop, ...patch,
});

test('menus drop empty entries and leading, doubled or trailing separators', () => {
  const a = { label: 'A', onSelect: noop }, b = { label: 'B', onSelect: noop };
  assert.deepEqual(normalizeMenu(['separator', a, false, 'separator', null, 'separator', b, undefined, 'separator']), [a, 'separator', b]);
  assert.deepEqual(normalizeMenu(['separator', false]), []);
});

test('machine menus: SSH machines can be logged in, renamed, copied and removed; this computer cannot be removed', () => {
  const ssh: WorkspaceMachine = { key: 'k', name: 'gpu-box', endpoint: { kind: 'ssh', host: 'gpu-box' }, folders: [] };
  assert.deepEqual(labels(machineMenu(ssh, actions())), ['添加项目文件夹', '登录这台机器', '—', '重命名…', '复制主机地址', '编辑 SSH 连接…', '—', '移除这台机器…']);
  const local: WorkspaceMachine = { key: 'local', name: '本地', endpoint: { kind: 'local' }, folders: [] };
  assert.deepEqual(labels(machineMenu(local, actions())), ['添加项目文件夹', '发现本机会话']);
  assert.equal(item(machineMenu(ssh, actions({ demo: true })), '移除这台机器…').disabled, true);
});

test('folder menus offer scanning only for unscanned folders and reveal only local folders', () => {
  const local: Workspace = { id: 'w', name: 'proj', kind: 'local', cwd: '/Users/me/proj' };
  const remote: Workspace = { id: 'r', name: 'remote', kind: 'ssh', host: 'box', cwd: '/srv/x', historyScan: false };
  const localLabels = labels(folderMenu(local, true, { ...actions(), toggle: noop }));
  assert.ok(localLabels.includes('在访达中显示') && !localLabels.includes('扫描所有对话') && localLabels.includes('收起'));
  const remoteLabels = labels(folderMenu(remote, false, { ...actions({ platform: 'linux' }), toggle: noop }));
  assert.ok(remoteLabels.includes('扫描所有对话') && remoteLabels.includes('复制主机与路径') && remoteLabels.includes('展开'));
  assert.ok(!remoteLabels.some(label => label.includes('显示')));
  assert.equal(revealLabel('win32'), '在资源管理器中显示');
  assert.equal(item(folderMenu(local, true, { ...actions({ busy: true }), toggle: noop }), '新建对话').disabled, true);
});

test('session menus: a stopped conversation can be archived; a running one cannot', async () => {
  const workspace: Workspace = { id: 'w', name: 'proj', kind: 'ssh', host: 'box', cwd: "/srv/my proj's" };
  const saved: SessionInfo = { id: '11111111-2222-4333-8444-555555555555', title: '修复登录', path: '/h/.claude/projects/x/1.jsonl', mapping: 'exact' };
  let renamed = false;
  const menu = sessionMenu(workspace, saved, { ...actions(), rename: () => { renamed = true; } });
  assert.deepEqual(labels(menu), ['打开', '在旁边分屏打开', '标记为未读', '—', '重命名…', '复制标题', '复制会话 ID', '复制续接命令', '—', '归档对话']);
  item(menu, '重命名…').onSelect();
  assert.equal(renamed, true);
  let archived = '';
  const archiving = sessionMenu(workspace, saved, { ...actions({ archiveSession: (_w, chat) => { archived = chat.id; } }), rename: noop });
  assert.equal(item(archiving, '归档对话').disabled, false);
  item(archiving, '归档对话').onSelect();
  assert.equal(archived, saved.id, 'archiving needs no confirmation: it is restorable');
  const running = sessionMenu(workspace, { ...saved, paneId: '%3' }, { ...actions(), rename: noop }, true);
  assert.ok(labels(running).includes('标记为已读'));
  assert.equal(item(running, '归档对话').disabled, true);
  assert.equal(item(running, '归档对话').hint, '运行中');
});

test('tool menus copy the Bash command separately from the full input and output', () => {
  const tool = { id: 't', name: 'Bash', input: JSON.stringify({ command: 'ls -la', description: 'list' }), result: 'total 0' };
  assert.equal(toolCommand(tool), 'ls -la');
  assert.equal(toolCommand({ ...tool, input: 'not json' }), undefined);
  const element = { contains: () => false } as unknown as Element;
  const entries = toolMenu({ currentTarget: element, target: null }, tool, { open: false, toggle: noop, onOpenPath: noop });
  assert.deepEqual(labels(entries), ['展开详情', '—', '复制命令', '复制完整输入', '复制输出']);
  assert.deepEqual(labels(fileEntries('/a/b.ts', noop, 'w')), ['预览文件', '复制文件路径', '下载文件']);
  assert.deepEqual(labels(fileEntries(undefined, noop)), []);
});

test('text fields get the native edit menu; selected text gets copy; elsewhere nothing', () => {
  const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: false };
  const roles = (items: ReturnType<typeof editMenuItems>) => items.map(entry => entry.type === 'separator' ? '—' : entry.role);
  assert.deepEqual(roles(editMenuItems({ isEditable: true, selectionText: '', editFlags: flags })), ['undo', 'redo', '—', 'cut', 'copy', 'paste', '—', 'selectAll']);
  assert.equal(editMenuItems({ isEditable: true, selectionText: '', editFlags: flags })[1].enabled, false);
  assert.deepEqual(roles(editMenuItems({ isEditable: false, selectionText: ' hi ', editFlags: flags })), ['copy', '—', 'selectAll']);
  assert.deepEqual(editMenuItems({ isEditable: false, selectionText: '  ', editFlags: flags }), []);
});

test('archiving keeps one entry per conversation, restores by key and is dropped with its folder', () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const state = () => desktopState().archivedSessions.map(a => `${a.workspaceId}/${a.sessionId}/${a.title}`);
  archiveSession({ workspaceId: 'w1', sessionId: 's1', title: 'A' });
  archiveSession({ workspaceId: 'w1', sessionId: 's1', title: 'A renamed' });
  archiveSession({ workspaceId: 'w2', sessionId: 's2', title: 'B' });
  assert.deepEqual(state(), ['w1/s1/A renamed', 'w2/s2/B']);
  assert.deepEqual(loadDesktopState({ getItem: key => store.get(key) ?? null }).archivedSessions.map(a => a.sessionId), ['s1', 's2'], 'persisted');
  restoreSessions([archiveKey('w1', 's1')]);
  assert.deepEqual(state(), ['w2/s2/B']);
  forgetProject('w2');
  assert.deepEqual(state(), []);
  assert.deepEqual(loadDesktopState({ getItem: () => JSON.stringify({ archivedSessions: [{ workspaceId: 1 }, null, { workspaceId: 'w', sessionId: 's', title: 't', archivedAt: 'x' }] }) }).archivedSessions.length, 1);
});
