import assert from 'node:assert/strict';
import test from 'node:test';
import { plannedReads, WorkspaceDiscoveryCache, type WorkspaceDiscoveryState } from '../src/renderer/workspace-discovery-cache';
import type { Workspace, WorkspaceDiscovery } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function result(id: string, title = id): WorkspaceDiscovery {
  return { workspace: { id, name: id, cwd: `/work/${id}`, kind: 'local' }, sessions: [{ id: `${id}-session`, title, mapping: 'unbound' }], panes: [] };
}

test('expanded directory reads are coalesced by ID and limited to two independent operations', async () => {
  const reads = new Map(['a', 'b', 'c'].map(id => [id, deferred<WorkspaceDiscovery>()]));
  const started: string[] = [];
  const cache = new WorkspaceDiscoveryCache(id => { started.push(id); return reads.get(id)!.promise; }, () => {});
  const a = cache.refresh('a');
  assert.equal(cache.refresh('a'), a);
  const b = cache.refresh('b');
  const c = cache.refresh('c');
  assert.deepEqual(started, ['a', 'b']);
  reads.get('a')!.resolve(result('a')); await a;
  assert.deepEqual(started, ['a', 'b', 'c']);
  reads.get('b')!.resolve(result('b')); reads.get('c')!.resolve(result('c'));
  await Promise.all([b, c]);
  assert.equal(cache.get('c')?.loading, false);
  cache.dispose();
});

test('invalidating a directory queues its fresh read behind the old one without accepting the old response', async () => {
  const old = deferred<WorkspaceDiscovery>(), fresh = deferred<WorkspaceDiscovery>();
  let started = 0;
  const cache = new WorkspaceDiscoveryCache(() => (++started === 1 ? old.promise : fresh.promise), () => {});
  const first = cache.refresh('a');
  cache.invalidate('a');
  const second = cache.refresh('a');
  assert.equal(started, 1, 'same directory never executes concurrently');
  old.resolve(result('a', 'old configuration'));
  assert.equal(await first, undefined);
  assert.equal(started, 2);
  assert.equal(cache.get('a')?.data, undefined);
  fresh.resolve(result('a', 'new configuration')); await second;
  assert.equal(cache.get('a')?.data?.sessions[0].title, 'new configuration');
  cache.dispose();
});

test('an older directory scan cannot overwrite a locally created or resumed session', async () => {
  const read = deferred<WorkspaceDiscovery>();
  const cache = new WorkspaceDiscoveryCache(() => read.promise, () => {});
  const pending = cache.refresh('a');
  cache.patch('a', () => result('a', 'just created'));
  read.resolve(result('a', 'stale scan')); await pending;
  assert.equal(cache.get('a')?.data?.sessions[0].title, 'just created');
  assert.equal(cache.get('a')?.loading, false);
  cache.dispose();
});

test('a superseded scan keeps the visible sessions while one fresh scan runs', async () => {
  const fresh = deferred<WorkspaceDiscovery>();
  const previous = result('a', 'visible history'), updated = result('a', 'resumed chat');
  const errors: unknown[] = [], published: WorkspaceDiscovery[] = [];
  let started = 0;
  const cache = new WorkspaceDiscoveryCache(async () => (++started === 1 ? undefined : fresh.promise), () => {},
    { onError: error => errors.push(error), onResult: value => published.push(value) });
  cache.patch('a', () => previous);
  const pending = cache.refresh('a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2);
  assert.equal(cache.refresh('a'), pending, 'the retry belongs to the same request');
  assert.equal(cache.get('a')?.data, previous);
  assert.equal(cache.get('a')?.loading, true);
  assert.deepEqual(published, []);
  fresh.resolve(updated);
  assert.equal(await pending, updated);
  assert.equal(cache.get('a')?.error, undefined);
  assert.deepEqual(published, [updated]);
  assert.deepEqual(errors, []);
  cache.dispose();
});

test('repeated supersession stops after one immediate retry without reporting a connection error', async () => {
  let started = 0;
  const previous = result('a'), errors: unknown[] = [];
  const cache = new WorkspaceDiscoveryCache(async () => { started++; return undefined; }, () => {},
    { onError: error => errors.push(error) });
  cache.patch('a', () => previous);
  assert.equal(await cache.refresh('a'), undefined);
  assert.equal(started, 2);
  assert.equal(cache.get('a')?.data, previous);
  assert.equal(cache.get('a')?.loading, false);
  assert.equal(cache.get('a')?.error, undefined);
  assert.deepEqual(errors, []);
  cache.dispose();
});

test('forgetting a directory prevents a superseded scan from retrying', async () => {
  let started = 0;
  const delayed = deferred<WorkspaceDiscovery | undefined>();
  const cache = new WorkspaceDiscoveryCache(() => { started++; return delayed.promise; }, () => {});
  const pending = cache.refresh('a');
  cache.forget('a');
  delayed.resolve(undefined);
  await pending;
  assert.equal(started, 1);
  assert.equal(cache.get('a'), undefined);
  cache.dispose();
});

test('a published native name supersedes an in-flight scan in every populated view', async () => {
  const read = deferred<WorkspaceDiscovery>();
  const cache = new WorkspaceDiscoveryCache(() => read.promise, () => {});
  const initial = result('a', 'first question');
  initial.sessions[0].status = 'working';
  initial.sessions.push({ id: 'sibling', title: 'other conversation', mapping: 'unbound' });
  cache.patch('a', () => initial);
  const pending = cache.refresh('a');
  cache.applyRenamedSession('a', { ...initial.sessions[0], title: 'native name-2', titleSource: 'custom', status: 'idle' });
  read.resolve(initial);
  await pending;
  assert.deepEqual(cache.get('a')?.data?.sessions.map(chat => chat.title), ['native name-2', 'other conversation']);
  assert.equal(cache.get('a')?.data?.sessions[0].status, 'working');
  cache.dispose();
});

test('a failed refresh retains history with an unknown connection until a successful retry', async () => {
  let fail = false;
  const cache = new WorkspaceDiscoveryCache(async id => { if (fail) throw new Error('SSH unavailable'); return result(id); }, () => {});
  await cache.refresh('a'); fail = true;
  assert.equal(await cache.refresh('a'), undefined);
  assert.equal(cache.get('a')?.data?.sessions.length, 1);
  assert.equal(cache.get('a')?.error, 'SSH unavailable');
  fail = false; await cache.refresh('a');
  assert.equal(cache.get('a')?.error, undefined);
  cache.dispose();
});

test('removing a directory or disposing the sidebar prevents late requests from resurrecting it', async () => {
  const a = deferred<WorkspaceDiscovery>(), b = deferred<WorkspaceDiscovery>(), c = deferred<WorkspaceDiscovery>();
  let notifications = 0;
  const cache = new WorkspaceDiscoveryCache(id => ({ a, b, c })[id as 'a' | 'b' | 'c'].promise, () => { notifications++; });
  const first = cache.refresh('a'); cache.forget('a'); a.resolve(result('a')); await first;
  assert.equal(cache.get('a'), undefined);
  const second = cache.refresh('b'), third = cache.refresh('c');
  cache.dispose(); const before = notifications;
  assert.equal(await second, undefined); assert.equal(await third, undefined);
  b.resolve(result('b')); c.reject(new Error('late connection error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications, before);
});

test('reads run per machine: a slow folder on one machine does not hold up another', async () => {
  const reads = new Map(['local-a', 'local-b', 'local-c', 'ssh-a'].map(id => [id, deferred<WorkspaceDiscovery>()]));
  const started: string[] = [];
  const cache = new WorkspaceDiscoveryCache(id => { started.push(id); return reads.get(id)!.promise; }, () => {},
    { lane: id => id.startsWith('ssh') ? 'ssh:host:' : 'local' });
  const pending = ['local-a', 'local-b', 'local-c', 'ssh-a'].map(id => cache.refresh(id));
  // Two local reads are busy; the SSH folder starts anyway, the third local one waits.
  assert.deepEqual(started, ['local-a', 'local-b', 'ssh-a']);
  reads.get('ssh-a')!.resolve(result('ssh-a')); await pending[3];
  assert.deepEqual(started, ['local-a', 'local-b', 'ssh-a']);
  reads.get('local-a')!.resolve(result('local-a')); await pending[0];
  assert.deepEqual(started, ['local-a', 'local-b', 'ssh-a', 'local-c']);
  reads.get('local-b')!.resolve(result('local-b')); reads.get('local-c')!.resolve(result('local-c'));
  await Promise.all(pending);
  cache.dispose();
});

test('after launch, the folders on screen are read first, each machine with its own two slots', () => {
  const folder = (id: string, kind: 'local' | 'ssh' = 'local', host?: string): Workspace => ({ id, name: id, cwd: '/' + id, kind, host });
  const workspaces = [folder('l1'), folder('l2'), folder('l3'), folder('s1', 'ssh', 'gpu-a'), folder('s2', 'ssh', 'gpu-a'), folder('s3', 'ssh', 'gpu-a'), folder('o1', 'ssh', 'gpu-b')];
  const plan = (states: Record<string, WorkspaceDiscoveryState>, expanded: string[] = [], focus: string[] = [], now = 100_000) =>
    plannedReads(workspaces, id => states[id], { now, slots: 2, expanded: new Set(expanded), visible: true, focus });
  // Nothing read yet: sidebar order per machine, on-screen folders first.
  assert.deepEqual(plan({}), ['l1', 'l2', 's1', 's2', 'o1']);
  assert.deepEqual(plan({}, ['s3'], ['l3']), ['l3', 's3', 'l1', 's1', 'o1']);
  // A busy local lane leaves the SSH lanes alone.
  assert.deepEqual(plan({ l1: { loading: true }, l2: { loading: true } }), ['s1', 's2', 'o1']);
  // Never-read folders come before refreshes; then the longest overdue.
  const read = (updatedAt: number): WorkspaceDiscoveryState => ({ loading: false, updatedAt, data: result('x') });
  // l1 due at 30.5 s, l2 (expanded) at 65 s, s1 at 40 s, s2 at 31 s, o1 not yet.
  assert.deepEqual(plan({ l1: read(500), l2: read(60_000), s1: read(10_000), s2: read(1_000), o1: read(99_000) }, ['l2']),
    ['l3', 's3', 'l1', 's2']);
});
