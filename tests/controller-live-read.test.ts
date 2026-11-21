import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Backend, projectSlug } from '../src/backend/index';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import { pendingQuestionId } from '../src/main/session-question';
import type { Workspace } from '../src/shared/types';

const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

// Answering a card, queueing or steering asks for an immediate read in its `finally`.
// That read must wait for one already in flight: two reads from the same cursor give the
// display the same bytes twice, and when the first stopped inside a record Claude Code was
// still writing, the second copy of that record was dropped and never read again.
test('an immediate read requested during a read waits for it, so a record being written is not lost', { skip: process.platform === 'win32' ? 'local POSIX reads' : false }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-live-overlap-')));
  const sessionId = randomUUID(), cwd = join(root, 'work'), claudeDir = join(root, 'claude');
  const project = join(claudeDir, 'projects', projectSlug(cwd)), file = join(project, `${sessionId}.jsonl`);
  const base = { sessionId, cwd, isSidechain: false };
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  await mkdir(cwd, { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(file, line({ ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), promptSource: 'typed', message: { role: 'user', content: 'Ask me something.' } })
    + line({ ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'One question.' }] } }));
  const ask = line({ ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: at(2), message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ header: 'Pick', question: 'Which one?', multiSelect: false, options: [] }] } }] } });
  const workspace: Workspace = { id: 'overlap', name: 'Overlap', kind: 'local', cwd, claudeDir };
  const store = new WorkspaceStore(join(root, 'store'));
  await store.save(workspace);
  const backend = new Backend({ tmuxSocket: `lectern-live-overlap-${randomUUID().slice(0, 8)}` });
  const controller = new Controller(store, backend);
  // Hold each transcript read after it ran on the target, until the test lets it return.
  const transport = (backend as any).transport, run = transport.run.bind(transport);
  const held: { release: () => void }[] = [];
  let active = 0, overlapped = 0, holding = true;
  transport.run = async (...args: any[]) => {
    if (args[2]?.tag !== 'session.poll') return run(...args);
    active++; if (active > 1) overlapped++;
    try {
      const result = await run(...args);
      if (holding) await new Promise<void>(release => held.push({ release }));
      return result;
    } finally { active--; }
  };
  const nextHeld = async () => { for (let i = 0; i < 200 && !held.length; i++) await settle(10); assert.ok(held.length, 'a read is waiting'); return held.shift()!; };
  try {
    const opening = controller.watchSession(workspace.id, sessionId);
    (await nextHeld()).release();
    await opening;
    // Claude Code has written half of the question's record when the next read runs.
    const cut = Math.floor(ask.length / 2);
    await appendFile(file, ask.slice(0, cut));
    const first = controller.refresh(workspace.id, sessionId);
    const a = await nextHeld();
    // The rest arrives; meanwhile an answer or a queued message asks for a read now.
    await appendFile(file, ask.slice(cut));
    const watch = (controller as any).watch;
    (controller as any).schedulePoll(watch, 0, true);
    await settle(80);
    a.release();
    await first;
    // From here reads return at once: the coalesced read, then two more, complete the record.
    holding = false;
    while (held.length) held.shift()!.release();
    await settle(100);
    for (let i = 0; i < 2; i++) await controller.refresh(workspace.id, sessionId);
    assert.equal(pendingQuestionId(controller.currentSnapshot!.messages), 'toolu_ask', 'the question record was lost');
    assert.equal(overlapped, 0, 'two reads of the conversation ran at once');
  } finally {
    holding = false;
    while (held.length) held.shift()!.release();
    // Wait for the controller's background model probe to release the fixture.
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
