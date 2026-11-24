import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { SessionViews } from '../src/main/session-views';
import type { Controller } from '../src/main/controller';
import type { SessionSnapshot, SidebarStatusUpdate } from '../src/shared/types';

class Reader extends EventEmitter {
  currentSnapshot?: SessionSnapshot;
  terminalVisible = false;
  background = false;
  detached = false;
  readonly created: Reader[];
  constructor(created: Reader[] = []) { super(); this.created = created; }
  sibling() { const next = new Reader(this.created); this.created.push(next); return next; }
  async watchSession(workspaceId: string, sessionId: string) {
    this.currentSnapshot = { workspaceId, sessionId, messages: [], screen: '', status: 'idle' };
    return this.currentSnapshot;
  }
  setBackground(value: boolean) { this.background = value; }
  refreshed = 0;
  async refresh() { this.refreshed++; return this.currentSnapshot; }
  async resumeSession(_workspace: string, id: string) { return { id }; }
  async detach() { this.detached = true; this.currentSnapshot = undefined; }
  releaseHandoffHistory() {}
  releaseSubagents() {}
  releaseTaskOutputs() {}
  setTerminalVisible(_workspace: string, _session: string, visible: boolean) { this.terminalVisible = visible; }
}
const opened = (primary: Reader) => primary.created.map(r => r.currentSnapshot?.sessionId ?? 'detached');

test('concurrent views of one conversation share a reader, and release only their own terminal', async () => {
  const primary = new Reader();
  const views = new SessionViews(primary as unknown as Controller, () => {});
  const snapshots = await Promise.all([views.watch('w', 'a', 'primary'), views.watch('w', 'a', 'secondary')]);
  assert.equal(snapshots[0], snapshots[1]);
  assert.deepEqual(opened(primary), ['a']);
  const [reader] = primary.created;
  views.setTerminalVisible('w', 'a', true, 'primary');
  views.setTerminalVisible('w', 'a', true, 'secondary');
  views.setTerminalVisible('w', 'a', false, 'secondary');
  assert.equal(reader.terminalVisible, true);
  views.setTerminalVisible('w', 'a', true, 'secondary');
  views.release('primary');
  assert.equal(reader.terminalVisible, true);
  assert.equal(reader.background, false);
  views.release('secondary');
  assert.equal(reader.terminalVisible, false);
  // Out of both panes, the conversation stays cached for a later reopen.
  assert.equal(reader.background, true);
  assert.equal(reader.currentSnapshot?.sessionId, 'a');
  assert.throws(() => views.forSession('w', 'a'));
});

test('pane switches and late releases leave the other conversation reachable', async () => {
  const primary = new Reader();
  const views = new SessionViews(primary as unknown as Controller, () => {});
  await views.watch('w', 'a', 'primary');
  await views.watch('w', 'b', 'secondary');
  const other = views.forSession('w', 'b');
  await views.watch('w', 'b', 'primary');
  views.release('secondary');
  assert.equal(views.forSession('w', 'b'), other);
  assert.throws(() => views.forSession('w', 'a'));
  views.setTerminalVisible('w', 'a', false, 'secondary');
  assert.equal(other.currentSnapshot?.sessionId, 'b');
  views.close();
  assert.throws(() => views.forSession('w', 'b'));
  assert.ok(primary.created.every(r => r.detached), 'closing the window stops every cached reader');
});

test('switching back reuses the cached conversation; reopening it in place reloads', async () => {
  const primary = new Reader(), emitted: string[] = [];
  const views = new SessionViews(primary as unknown as Controller, s => emitted.push(s.sessionId));
  await views.watch('w', 'a', 'primary');
  await views.watch('w', 'b', 'primary');
  const [a] = primary.created;
  assert.equal(a.background, true);
  a.emit('snapshot', a.currentSnapshot);
  assert.deepEqual(emitted, [], 'a cached conversation does not publish');
  const again = await views.watch('w', 'a', 'primary');
  assert.equal(again, a.currentSnapshot);
  assert.equal(a.background, false);
  assert.deepEqual(opened(primary), ['a', 'b'], 'no second read of the first conversation');
  await views.watch('w', 'a', 'primary');
  assert.equal(a.detached, true);
  assert.deepEqual(opened(primary), ['detached', 'b', 'a']);
  views.prefetch('w', 'c');
  const c = primary.created.at(-1)!;
  assert.equal(c.background, true);
  assert.equal(c.currentSnapshot?.sessionId, 'c');
  views.releaseWorkspace('w');
  assert.ok(primary.created.every(r => r.detached));
});

test('sidebar observations survive navigation, stay isolated, and clear when the reader can no longer report', async () => {
  const primary = new Reader(), updates: SidebarStatusUpdate[] = [], transcripts: SessionSnapshot[] = [];
  const views = new SessionViews(primary as unknown as Controller, snapshot => transcripts.push(snapshot), undefined,
    update => updates.push(update));
  const publish = (reader: Reader, status: SessionSnapshot['status']) => {
    reader.currentSnapshot = { ...reader.currentSnapshot!, paneId: '%1', status, screen: 'transcript fixture' };
    reader.emit('sidebar-status', reader.currentSnapshot);
  };
  const statuses = () => updates.map(({ workspaceId, sessionId, observation }) =>
    [workspaceId, sessionId, observation?.paneId, observation?.status]);

  await views.watch('first', 'same-id', 'primary');
  const first = primary.created[0];
  publish(first, 'working');
  publish(first, 'working');
  await views.watch('second', 'same-id', 'primary');
  const second = primary.created[1];
  publish(second, 'waiting');
  publish(first, 'idle');
  assert.deepEqual(statuses(), [
    ['first', 'same-id', '%1', 'working'],
    ['second', 'same-id', '%1', 'waiting'],
    ['first', 'same-id', '%1', 'idle'],
  ]);
  assert.ok(!JSON.stringify(updates).includes('transcript fixture'));
  assert.deepEqual(transcripts, []);

  const work = { agents: 1, shells: 1, monitors: 0, workflows: 0 };
  first.currentSnapshot = { ...first.currentSnapshot!, background: 'still running', backgroundWork: work };
  publish(first, 'idle');
  assert.deepEqual(updates.at(-1)?.observation?.backgroundWork, work);
  const withWork = updates.length;
  publish(first, 'idle');
  assert.equal(updates.length, withWork);
  first.currentSnapshot.backgroundWork = { ...work, shells: 0 };
  publish(first, 'idle');
  assert.equal(updates.at(-1)?.observation?.backgroundWork?.shells, 0);

  views.replaySidebarStatus();
  assert.deepEqual(statuses().slice(-2), [
    ['first', 'same-id', '%1', 'idle'],
    ['second', 'same-id', '%1', 'waiting'],
  ]);
  publish(second, 'offline');
  assert.deepEqual(statuses().at(-1), ['second', 'same-id', undefined, undefined]);
  views.releaseWorkspace('first');
  assert.deepEqual(statuses().at(-1), ['first', 'same-id', undefined, undefined]);
  const count = updates.length;
  first.emit('sidebar-status', { workspaceId: 'first', sessionId: 'same-id', paneId: '%1', status: 'working' });
  views.replaySidebarStatus();
  assert.equal(updates.length, count);
});

test('resuming refreshes the reader that already holds the conversation instead of reloading it', async () => {
  const primary = new Reader();
  const views = new SessionViews(primary as unknown as Controller, () => {});
  await views.watch('w', 'a', 'primary');
  const [a] = primary.created;
  assert.deepEqual(await views.resumeSession('w', 'a'), { id: 'a' });
  assert.equal(a.refreshed, 1);
  assert.equal(a.detached, false);
  assert.equal(views.forSession('w', 'a'), a);
  assert.deepEqual(opened(primary), ['a'], 'no second reader and no fresh read');
  // A conversation no pane holds still resumes; the next open reads it.
  assert.deepEqual(await views.resumeSession('w', 'b'), { id: 'b' });
  assert.equal(primary.created.length, 1);
});

test('pointing at many rows reads ahead a few, never evicting opened conversations, and a click reuses the read', async () => {
  const primary = new Reader();
  const views = new SessionViews(primary as unknown as Controller, () => {});
  await views.watch('w', 'opened');
  views.release('primary');
  for (let i = 0; i < 10; i++) views.prefetch('w', `hover-${i}`, true);
  await Promise.resolve();
  const live = () => primary.created.filter(r => !r.detached).map(r => r.currentSnapshot!.sessionId);
  assert.deepEqual(live(), ['opened', 'hover-4', 'hover-5', 'hover-6', 'hover-7', 'hover-8', 'hover-9'], 'only the latest six read-aheads stay');
  assert.ok(primary.created.filter(r => !r.detached && r.currentSnapshot!.sessionId.startsWith('hover')).every(r => r.background));
  const before = primary.created.length;
  await views.watch('w', 'hover-9');
  assert.equal(primary.created.length, before, 'opening reuses the read-ahead');
  views.release('primary');
  // Once shown it is a regular cached conversation, not a read-ahead.
  for (let i = 10; i < 20; i++) views.prefetch('w', `hover-${i}`, true);
  await Promise.resolve();
  assert.ok(live().includes('opened') && live().includes('hover-9'));
  assert.equal(live().filter(id => id.startsWith('hover-1')).length, 6);
});

test('a closed conversation keeps its one reader, and once out of the pane it is evicted first of the 48 cached', async () => {
  const primary = new Reader();
  const views = new SessionViews(primary as unknown as Controller, () => {});
  await views.watch('w', 'closed');
  const [closed] = primary.created;
  // Closing turns the same reader's snapshot into history (no pane); nothing reopens it.
  closed.currentSnapshot = { ...closed.currentSnapshot!, paneId: undefined };
  assert.equal(views.forSession('w', 'closed'), closed, 'later actions still reach the closed chat');
  for (let i = 0; i < 48; i++) {
    await views.watch('w', `live-${i}`);
    primary.created.at(-1)!.currentSnapshot!.paneId = `%${i}`;
  }
  views.release('primary');
  assert.equal(primary.created.length, 49, 'one reader per conversation');
  assert.equal(closed.detached, true, 'saved history goes before running conversations');
  assert.ok(primary.created.slice(1).every(reader => !reader.detached));
});
