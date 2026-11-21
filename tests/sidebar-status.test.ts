import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSidebarState, compareSidebarSessions, sessionSidebarState } from '../src/renderer/sidebar-status';
import { loadDesktopState } from '../src/renderer/desktop-state';
import { ReplyReceipts } from '../src/renderer/sidebar-receipts';
import { completedReplyOffset } from '../src/core/reply-completion';
import type { NavigationSessionStatus, SessionInfo, SessionSnapshot } from '../src/shared/types';

const session: SessionInfo = { id: 'session', title: 'Conversation', path: '/history/session.jsonl', mapping: 'exact' };
const snapshot: SessionSnapshot = { workspaceId: 'work', sessionId: session.id, messages: [], screen: '', status: 'idle' };

test('all observed session states have explicit text labels as well as distinct status values', () => {
  for (const kind of ['history', 'idle', 'working', 'waiting', 'error', 'unknown'] as NavigationSessionStatus[]) {
    const state = sessionSidebarState({ ...session, status: kind, paneId: kind === 'history' ? undefined : '%1' });
    assert.equal(state.kind, kind); assert.ok(state.label); assert.ok(state.detail);
  }
  assert.equal(sessionSidebarState(session).live, false);
});

test('scan failures preserve unknown connection state instead of repainting cached history inactive', () => {
  const cached = { ...session, paneId: '%1', status: 'idle' as const };
  const state = sessionSidebarState(cached, { scanError: 'SSH disconnected' });
  assert.equal(state.kind, 'unknown'); assert.equal(state.live, 'unknown');
  assert.equal(sessionSidebarState(cached, { snapshot: { ...snapshot, paneId: '%1', status: 'working' }, scanError: 'stale scan failure' }).kind, 'working');
});

test('the current snapshot overrides stale running discovery when the selected session exits', () => {
  const cached = { ...session, paneId: '%1', status: 'working' as const };
  const state = sessionSidebarState(cached, { snapshot });
  assert.equal(state.kind, 'history'); assert.equal(state.live, false);
  assert.equal(sessionSidebarState(cached, { snapshot: { ...snapshot, status: 'offline', paneId: '%1' } }).kind, 'unknown');
});

test('selected dead-pane errors and foreground ownership uncertainty remain distinct from ordinary history', () => {
  assert.equal(sessionSidebarState(session, { snapshot: { ...snapshot, navigationStatus: 'error', navigationStatusDetail: 'Exited unsuccessfully' } }).kind, 'error');
  assert.equal(sessionSidebarState(session, { snapshot: { ...snapshot, navigationStatus: 'unknown', navigationStatusDetail: 'Foreground process changed' } }).kind, 'unknown');
  assert.equal(sessionSidebarState(session, { snapshot: { ...snapshot, status: 'error', error: 'Ambiguous pane binding' } }).kind, 'error');
  assert.equal(sessionSidebarState(session, { snapshot: { ...snapshot, status: 'offline', navigationStatus: 'error' } }).kind, 'unknown');
});

test('optimistic work and permission waiting override an older idle navigation observation', () => {
  for (const status of ['working', 'waiting'] as const) {
    assert.equal(sessionSidebarState(session, { snapshot: { ...snapshot, status, paneId: '%1', navigationStatus: 'idle' } }).kind, status);
  }
});

test('sidebar sorting keeps recency by default and can bring actionable or active chats forward', () => {
  const updatedAt = (day: string) => `2026-01-${day}T00:00:00.000Z`;
  const chats: SessionInfo[] = [
    { ...session, id: 'new', paneId: '%1', status: 'idle' },
    { ...session, id: 'history', updatedAt: updatedAt('08') },
    { ...session, id: 'unread', updatedAt: updatedAt('07') },
    { ...session, id: 'background', updatedAt: updatedAt('06'), paneId: '%2', status: 'idle', background: 'Running shell' },
    { ...session, id: 'working', updatedAt: updatedAt('05'), paneId: '%3', status: 'working' },
    { ...session, id: 'error', updatedAt: updatedAt('04'), status: 'error' },
    { ...session, id: 'waiting', updatedAt: updatedAt('03'), paneId: '%4', status: 'waiting' },
  ];
  const states = new Map(chats.map(chat => [chat.id, sessionSidebarState(chat, { unread: chat.id === 'unread' })]));
  assert.deepEqual([...chats].reverse().sort(compareSidebarSessions).map(chat => chat.id),
    ['new', 'history', 'unread', 'background', 'working', 'error', 'waiting']);
  assert.deepEqual([...chats].reverse().sort((a, b) => compareSidebarSessions(a, b, states)).map(chat => chat.id),
    ['error', 'waiting', 'unread', 'background', 'working', 'new', 'history']);
});

test('sidebar sort preference supports existing profiles and remembers priority', () => {
  const read = (value: object) => loadDesktopState({ getItem: () => JSON.stringify(value) }).sidebarSort;
  assert.equal(read({}), 'recent');
  assert.equal(read({ sidebarSort: 'invalid' }), 'recent');
  assert.equal(read({ sidebarSort: 'priority' }), 'priority');
});

test('sidebar sorting preserves discovery order when recency and priority tie', () => {
  const updatedAt = '2026-01-01T00:00:00.000Z';
  const chats: SessionInfo[] = [
    { ...session, id: 'z-history', updatedAt },
    { ...session, id: 'a-history', updatedAt },
    { ...session, id: 'active', updatedAt, paneId: '%1', status: 'idle' },
  ];
  const states = new Map(chats.map(chat => [chat.id, sessionSidebarState(chat)]));
  assert.deepEqual([...chats].sort(compareSidebarSessions).map(chat => chat.id), ['z-history', 'a-history', 'active']);
  assert.deepEqual([...chats].sort((a, b) => compareSidebarSessions(a, b, states)).map(chat => chat.id), ['active', 'z-history', 'a-history']);
});

test('folder aggregation prioritizes actionable failures and waiting over idle or saved history', () => {
  const states = ['history', 'idle', 'working', 'waiting', 'error'].map(status => sessionSidebarState({ ...session, status: status as NavigationSessionStatus }));
  assert.equal(aggregateSidebarState(states), 'error');
  assert.equal(aggregateSidebarState(states.slice(0, -1)), 'waiting');
  assert.equal(aggregateSidebarState(states.slice(0, 3)), undefined);
});

test('session and folder dots have independent rules; unknown is not an error or a confirmed process', () => {
  assert.equal(sessionSidebarState(session).dot, undefined);
  assert.equal(sessionSidebarState({ ...session, status: 'unknown', paneId: '%1' }).dot, 'idle');
  assert.equal(sessionSidebarState({ ...session, status: 'unknown' }).dot, undefined);
  assert.equal(sessionSidebarState(session, { scanError: 'SSH down' }).dot, 'error');
  assert.equal(sessionSidebarState(session, { snapshot: { ...snapshot, status: 'connecting' } }).dot, undefined);
  const unread = sessionSidebarState(session, { unread:true });
  assert.equal(unread.dot, 'unread'); assert.equal(aggregateSidebarState([unread]), 'unread');
  assert.equal(sessionSidebarState({ ...session, status:'waiting' }, {unread:true}).dot, 'waiting');
  assert.equal(sessionSidebarState({ ...session, status:'error' }, {unread:true}).dot, 'error');
});

test('history baselines, out-of-order reads, disappearing files, first writes and restarts', () => {
  let ledger = new ReplyReceipts();
  const info = (offset:number, completedThrough?:number, inode='1') => ({...session,replyProgress:{inode,offset,completedThrough}});
  ledger.observe(info(100)); assert.equal(ledger.unread(session.id), false);
  ledger.observe(info(110)); assert.equal(ledger.unread(session.id), false, 'metadata updates are not replies');
  ledger.observe(info(125,120)); assert.equal(ledger.unread(session.id), true);
  ledger = new ReplyReceipts(ledger.serialize()); assert.equal(ledger.unread(session.id), true);
  ledger.read(session.id, { inode:'1', offset:119 }); assert.equal(ledger.unread(session.id), true, 'stale displayed page');
  ledger.observe({...session, path:undefined, paneId:'%1'}); assert.equal(ledger.unread(session.id), true, 'temporary disappearance');
  ledger.read(session.id, { inode:'1', offset:125 }); ledger.observe(info(125,120)); assert.equal(ledger.unread(session.id), false);
  ledger.read(session.id, { inode:'1', offset:180 }); ledger.observe(info(160,150)); assert.equal(ledger.unread(session.id), false, 'late scan after switching away');
  ledger.observe(info(240,235)); ledger.observe(info(100,undefined,'2')); assert.equal(ledger.unread(session.id), false, 'replacement history is baseline');
  ledger = new ReplyReceipts(); ledger.observe({...session,path:undefined,paneId:'%0'});
  assert.deepEqual(ledger.baselines()[session.id],{ inode:'missing',offset:0 });
  ledger.observe(info(300,250)); assert.equal(ledger.unread(session.id), true, 'first completed reply in known new pane');
});

test('only complete durable reply evidence, not tools, previews, errors or unrelated timing rows', () => {
  const line = (value:unknown) => JSON.stringify(value)+'\n';
  const a = (stop:string|null, extra={}, content:unknown='answer') => ({type:'assistant',uuid:'a',message:{content,stop_reason:stop},...extra});
  const duration = {type:'system',subtype:'turn_duration',parentUuid:'a'};
  const complete = (...rows:unknown[]) => completedReplyOffset(Buffer.from(rows.map(line).join('')),0,0,'s');
  for (const stop of ['end_turn','stop_sequence']) assert.ok(complete(a(stop)));
  for (const stop of ['max_tokens','tool_use','pause_turn','refusal']) assert.equal(complete(a(stop),duration), undefined);
  for (const extra of [{isMeta:true},{isApiErrorMessage:true},{isSidechain:true},{sessionId:'other'}]) assert.equal(complete(a('end_turn',extra)),undefined);
  assert.equal(complete(a('end_turn',{},[{type:'tool_use'}])),undefined); assert.equal(complete(duration),undefined);
  assert.equal(complete(a(null)),undefined); assert.ok(complete(a(null),duration));
  assert.equal(complete(a(null),{...duration,parentUuid:'other'}),undefined);
  assert.equal(complete(a(null),{type:'user',message:{content:'interrupted'}},duration),undefined);
  assert.equal(complete(a('end_turn'),{type:'last-prompt',rewound:true}),undefined);
  assert.equal(completedReplyOffset(Buffer.from(JSON.stringify(a('end_turn'))),0,0,'s'),undefined);
  const body=line(a('end_turn')); assert.equal(completedReplyOffset(Buffer.from(body+line(duration)),0,Buffer.byteLength(body),'s'),undefined,'duration cannot duplicate a previously read reply');
});

test('a reply that left background work running shows as running in the background, not finished', () => {
  const live = { ...session, paneId: '%1', status: 'idle' as const };
  const discovered = sessionSidebarState({ ...live, background: '终端仍在运行' }, { unread: true });
  assert.equal(discovered.label, '后台运行中'); assert.equal(discovered.dot, 'background'); assert.equal(discovered.background, true);
  assert.match(discovered.detail, /终端仍在运行/); assert.match(discovered.detail, /尚未阅读/);
  // An open chat's snapshot is the fresher source either way.
  const open = { ...snapshot, paneId: '%1', status: 'idle' as const, navigationStatus: 'idle' as const };
  assert.equal(sessionSidebarState({ ...live, background: '终端仍在运行' }, { snapshot: open }).dot, 'idle');
  assert.equal(sessionSidebarState(live, { snapshot: { ...open, background: '1 个子代理仍在运行' } }).label, '后台运行中');
  // A reply still being written, or a session with no live pane, is not "background".
  assert.equal(sessionSidebarState(live, { snapshot: { ...open, status: 'working', background: '1 个子代理仍在运行' } }).kind, 'working');
  assert.equal(sessionSidebarState({ ...session, background: '终端仍在运行' }).background, undefined);
});

test('while a chat is being read the state stays on show and only a loading flag is added', () => {
  const working = { ...session, paneId: '%1', status: 'working' as const };
  // Just clicked: no snapshot yet.
  const opening = sessionSidebarState(working, { selected: true });
  assert.equal(opening.loading, true); assert.equal(opening.label, '回复中'); assert.equal(opening.dot, 'working');
  // Reading more of it: what the folder scan saw (here background work) still shows.
  const reading = sessionSidebarState({ ...session, paneId: '%1', status: 'idle', background: '终端仍在运行' },
    { snapshot: { ...snapshot, status: 'connecting' } });
  assert.equal(reading.loading, true); assert.equal(reading.label, '后台运行中');
  // Read: no flag.
  assert.equal(sessionSidebarState(working, { selected: true, snapshot: { ...snapshot, paneId: '%1', status: 'working' } }).loading, undefined);
  assert.equal(sessionSidebarState(session, { selected: true }).label, '历史');
});
