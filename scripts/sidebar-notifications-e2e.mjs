import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { refreshFolderUntil } from './fixtures/sidebar-refresh.mjs';

// Isolated demo, real tmux and JSONL. No normal user profile, SSH or model requests.
const profile = await mkdtemp(path.join(tmpdir(), 'lectern-sidebar-receipts-'));
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app, page;
try {
  app = await electron.launch({ args: ['.', '--demo'], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(25000);
  const nativeWindow = await app.browserWindow(page);
  const focusWindow = async () => {
    await app.evaluate(({app}) => app.focus({steal:true}));
    await nativeWindow.evaluate(w => { w.show(); w.focus(); });
    assert.ok(await nativeWindow.evaluate(w => w.isVisible() && !w.isMinimized() && w.isFocused()), 'fixture owns native focus');
  };
  await focusWindow();
  // The chevron collapses the list; the folder name itself opens a new chat.
  const live = page.locator('.session-row.active'), folder = page.locator('.workspace-select').first(), folderToggle = page.locator('.workspace-toggle').first();
  const folderDot = folder.locator('.session-status-dot');
  const inspect = async (row, state, name) => {
    const dot = row.locator(`.session-status-dot.state-${state}`); await dot.waitFor();
    const [marker, title] = await Promise.all([dot.boundingBox(), row.locator(name).boundingBox()]);
    assert.ok(marker && marker.width > 0 && title && marker.x >= title.x + title.width - 1, `${state} dot must follow the name`);
    const style = await dot.evaluate(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.animationName]; });
    const rgb = style[0].match(/\d+/g)?.slice(0,3).map(Number); assert.equal(rgb?.length, 3);
    return { rgb, animation: style[1], x: marker.x };
  };
  const idle = await inspect(live, 'idle', '.session-title'); assert.ok(idle.rgb[1] > idle.rgb[0] && idle.rgb[1] > idle.rgb[2]);
  assert.equal(await folderDot.count(), 0);
  const ws = await page.evaluate(async () => (await window.desktop.listWorkspaces())[0]);
  assert.equal(ws.id, 'demo-local');
  const id = randomUUID(), log = path.join(ws.claudeDir, 'projects', ws.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${id}.jsonl`);
  const line = (type, message, timestamp = new Date().toISOString()) => JSON.stringify({ type, uuid: randomUUID(), sessionId: id, cwd: ws.cwd, timestamp, message }) + '\n';
  const archived = page.locator(`.session-row[data-session-id="${id}"]`);
  await writeFile(log, line('user', {content:'已经存在的历史'}, '2026-01-01T00:00:00Z') + line('assistant', {content:'旧回复', stop_reason:'end_turn'}, '2026-01-01T00:00:01Z'));
  await refreshFolderUntil(page, ws.id, archived); assert.equal(await archived.locator('.session-status-dot').count(), 0);
  await page.getByRole('textbox', {name:'发送给 Claude 的消息'}).fill('你好');
  await page.getByRole('button', {name:'发送消息', exact:true}).click();
  const busy = await inspect(live, 'working', '.session-title'); assert.deepEqual(busy.rgb, idle.rgb); assert.notEqual(busy.animation, 'none');
  assert.equal(await folderDot.count(), 0);
  await focusWindow(); await live.locator('.state-idle').waitFor();
  const stateFile = path.join(ws.claudeDir, 'screen-state');
  for (const state of ['waiting','error']) {
    await writeFile(stateFile, state);
    const chat = await inspect(live, state, '.session-title'), project = await inspect(folder, state, '.workspace-name');
    assert.deepEqual(chat.rgb, project.rgb); assert.ok(Math.abs(chat.x - project.x) < 4, 'folder and chat share trailing column');
    const [r,g,b] = chat.rgb; assert.ok(state === 'waiting' ? r > g && g > b : r > g && r > b);
  }
  await writeFile(stateFile, 'ready'); await focusWindow(); await live.locator('.state-idle').waitFor();
  await folderToggle.click(); await archived.waitFor({state:'detached'});
  await appendFile(log, line('user', {content:'新问题'}) + line('assistant', {content:'新的完整回复', stop_reason:'end_turn'}));
  await folder.locator('.state-unread').waitFor();
  const blue = await inspect(folder, 'unread', '.workspace-name'); assert.ok(blue.rgb[2] > blue.rgb[1] && blue.rgb[2] > blue.rgb[0]);
  await folderToggle.click(); assert.deepEqual((await inspect(archived, 'unread', '.session-title')).rgb, blue.rgb);
  await page.reload(); await archived.locator('.state-unread').waitFor();
  await focusWindow(); await archived.click(); await page.getByText('新的完整回复', { exact:true }).last().waitFor();
  await archived.locator('.session-status-dot').waitFor({state:'detached'}); await folderDot.waitFor({state:'detached'});
  // Keep an explicit reminder even when the selected conversation is already at its latest reply.
  const mark = async label => {
    await archived.click({button:'right'});
    await page.getByRole('menuitem', {name:label, exact:true}).click();
  };
  const unread = archived.locator('.state-unread');
  await mark('标记为未读');
  await unread.waitFor();
  assert.equal(await nativeWindow.evaluate(w => { w.hide(); return w.isVisible(); }), false);
  await focusWindow();
  await page.reload();
  await unread.waitFor();
  await folder.locator('.state-unread').waitFor();

  const sortBy = async label => {
    await page.getByRole('button', {name:'对话排序', exact:true}).click();
    await page.getByRole('menuitem', {name:label, exact:true}).click();
  };
  await sortBy('最近更新');
  await page.locator('.sidebar-global').locator(unread).waitFor();
  await mark('标记为已读');
  await unread.waitFor({state:'detached'});
  await mark('标记为未读');
  await unread.waitFor();
  await sortBy('按项目');
  await folder.locator('.state-unread').waitFor();
  await archived.click();
  await unread.waitFor({state:'detached'});
  await folderDot.waitFor({state:'detached'});

  // The active conversation must not acknowledge a reply delivered to a
  // hidden window. Focusing it again reads the already-rendered snapshot.
  assert.equal(await nativeWindow.evaluate(w => { w.hide(); return w.isVisible(); }), false);
  await appendFile(log, line('user', {content:'窗口隐藏时的问题'}) + line('assistant', {content:'窗口隐藏时完成', stop_reason:'end_turn'}));
  await page.waitForFunction(id => document.querySelector(`.session-row[data-session-id="${id}"] .state-unread`), id, { timeout:45000, polling:200 });
  await focusWindow();
  await archived.locator('.session-status-dot').waitFor({state:'detached'});
  // A visible but unfocused window must behave the same way, even when the
  // foreground window belongs to this same Electron application.
  const other = await app.evaluateHandle(({BrowserWindow}) => { const w = new BrowserWindow({width:240,height:160}); w.focus(); return w; });
  try {
    assert.deepEqual(await nativeWindow.evaluate(w => [w.isVisible(),w.isFocused()]), [true,false]);
    await appendFile(log, line('user',{content:'窗口失焦时的问题'}) + line('assistant',{content:'窗口失焦时完成',stop_reason:'end_turn'}));
    await page.waitForFunction(id => document.querySelector(`.session-row[data-session-id="${id}"] .state-unread`), id, { timeout:45000,polling:200 });
  } finally { await other.evaluate(w => w.destroy()); }
  await focusWindow(); await archived.locator('.session-status-dot').waitFor({state:'detached'});
  const long = Array.from({ length:36 }, (_, n) => line('user', {content:`长历史问题 ${n}`}) + line('assistant', {content:`长历史回答 ${n}`, stop_reason:'end_turn'})).join('');
  await appendFile(log, long);
  await page.getByText('长历史回答 35',{exact:true}).last().waitFor();
  const scroll = page.locator('.conversation-scroll').first();
  await page.waitForFunction(() => { const v = document.querySelector('.conversation-scroll'); return v && v.scrollTop > 900 && v.scrollHeight - v.scrollTop - v.clientHeight <= 3; });
  await scroll.evaluate(v => { v.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 0 })); v.scrollTop -= 750; });
  const latest = page.getByRole('button', {name:'滚动到最新消息'}); await latest.waitFor();
  await appendFile(log, line('user', {content:'翻阅期间的问题'}) + line('assistant', {content:'翻阅期间完成的回复', stop_reason:'end_turn'}));
  await archived.locator('.state-unread').waitFor(); await folder.locator('.state-unread').waitFor();
  await page.getByText('翻阅期间完成的回复', {exact:true}).last().waitFor({state:'attached'});
  assert.ok(await scroll.evaluate(v => v.scrollHeight - v.scrollTop - v.clientHeight > 300), 'new reply did not take over the viewport');
  await focusWindow(); await latest.click(); await archived.locator('.session-status-dot').waitFor({state:'detached'}); await folderDot.waitFor({state:'detached'});
  console.log('Sidebar dots: baseline, colors, placement, collapsed unread, manual read and unread, reload, background window, reading earlier and read acknowledgement passed.');
} catch (error) {
  if (page) console.error('Sidebar fixture at failure:', await page.evaluate(() => ({ selected:document.querySelector('.session-row.active')?.textContent,
    lastReply:document.querySelector('.message-assistant:last-of-type')?.textContent?.slice(-160), readingEarlier:!!document.querySelector('.scroll-latest'),
    scroll:Array.from(document.querySelectorAll('.conversation-scroll'), v => [v.scrollHeight,v.scrollTop,v.clientHeight]), errors:document.querySelector('.error-banner')?.textContent })),
    await (await app.browserWindow(page)).evaluate(w => ({ visible:w.isVisible(), focused:w.isFocused() })));
  throw error;
} finally { await app?.close(); await rm(profile, { recursive:true, force:true }); }
