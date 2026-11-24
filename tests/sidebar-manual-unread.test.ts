import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyReceipts } from '../src/renderer/sidebar-receipts';
import type { SessionInfo } from '../src/shared/types';

const id = 'chat';
const observed = (offset: number, completedThrough?: number, inode = 'file'): SessionInfo => ({
  id, title: 'Conversation', mapping: 'unbound', path: '/history/chat.jsonl',
  replyProgress: { inode, offset, completedThrough },
});

test('a manual unread marker survives subsequent reads, scans and reloads until an explicit revisit', () => {
  let receipts = new ReplyReceipts();
  receipts.observe(observed(100));
  assert.equal(receipts.setUnread(id, true), true);
  receipts.read(id, { inode: 'file', offset: 120 });
  receipts.observe(observed(120, 120));
  receipts = new ReplyReceipts(receipts.serialize());
  assert.equal(receipts.unread(id), true);
  assert.deepEqual(receipts.baselines()[id], { inode: 'file', offset: 120 });
  assert.equal(receipts.revisit(id), true);
  assert.equal(receipts.unread(id), false);
});

test('a manual marker is independent of the transcript position or whether the history has been scanned', () => {
  let receipts = new ReplyReceipts();
  receipts.setUnread(id, true);
  receipts = new ReplyReceipts(receipts.serialize());
  assert.equal(receipts.unread(id), true);
  assert.deepEqual(receipts.baselines(), {});
  receipts.observe(observed(100));
  receipts.observe(observed(50, undefined, 'replacement'));
  assert.equal(receipts.unread(id), true);
  receipts.observe(observed(80, 78, 'replacement'));
  receipts.revisit(id);
  assert.equal(receipts.unread(id), true, 'revisiting acknowledges only the manual marker');
});

test('mark read acknowledges known replies and a later scan can still raise a new one', () => {
  const receipts = new ReplyReceipts();
  receipts.observe(observed(100));
  receipts.observe(observed(130, 117));
  receipts.setUnread(id, true);
  assert.equal(receipts.setUnread(id, false), true);
  assert.equal(receipts.unread(id), false);
  receipts.observe(observed(125, 117));
  assert.equal(receipts.unread(id), false);
  receipts.observe(observed(150, 148));
  assert.equal(receipts.unread(id), true);
});

test('saved transcript receipts from before manual marking remain readable', () => {
  const receipts = new ReplyReceipts(JSON.stringify([[id, { inode: 'file', offset: 120, seen: 100, unread: 117 }]]));
  assert.equal(receipts.unread(id), true);
  receipts.read(id, { inode: 'file', offset: 120 });
  assert.equal(receipts.unread(id), false);
});
