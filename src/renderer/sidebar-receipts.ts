import type { ReplyBaselines, SessionInfo, TranscriptPosition, Workspace } from '../shared/types';

type Receipt = TranscriptPosition & { seen: number; unread?: number };
type SavedEntry = [id: string, receipt: Receipt | null, manuallyUnread?: true];
const validOffset = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const missing: NonNullable<SessionInfo['replyProgress']> = { inode: 'missing', offset: 0 };

/** One workspace's durable, content-free positions. Absence from a scan does not
 * delete a receipt: an SSH mount or a limited listing may reappear later. */
export class ReplyReceipts {
  private entries = new Map<string, Receipt>();
  private manuallyUnread = new Set<string>();
  constructor(saved?: string) {
    if (saved) try {
      for (const [id, r, manual] of JSON.parse(saved)) {
        if (typeof id !== 'string') continue;
        if (r && typeof r.inode === 'string' && validOffset(r.offset) && validOffset(r.seen) &&
            (r.unread === undefined || validOffset(r.unread) && r.unread > r.seen)) this.entries.set(id, r);
        if (manual === true) this.manuallyUnread.add(id);
      }
    } catch { /* Invalid preferences are not evidence of a reply. */ }
  }
  serialize() {
    // Keep the existing pair for transcript positions. A manual flag can
    // stand on its own before this chat has a scanned position.
    const rows = Array.from(this.entries, ([id, r]): SavedEntry => this.manuallyUnread.has(id) ? [id, r, true] : [id, r]);
    for (const id of this.manuallyUnread) if (!this.entries.has(id)) rows.push([id, null, true]);
    return JSON.stringify(rows);
  }
  baselines(): ReplyBaselines {
    return Object.fromEntries(Array.from(this.entries, ([id, r]) => [id, { inode: r.inode, offset: Math.max(r.offset, r.seen) }]));
  }
  unread(id: string) { return this.manuallyUnread.has(id) || this.entries.get(id)?.unread !== undefined; }

  setUnread(id: string, unread: boolean): boolean {
    if (unread) {
      if (this.manuallyUnread.has(id)) return false;
      this.manuallyUnread.add(id);
      return true;
    }
    const manual = this.revisit(id);
    const r = this.entries.get(id);
    if (r?.unread === undefined) return manual;
    this.entries.set(id, { ...r, seen: Math.max(r.seen, r.offset, r.unread), unread: undefined });
    return true;
  }

  /** An explicit open clears the marker. Automatic reads only advance receipts. */
  revisit(id: string) { return this.manuallyUnread.delete(id); }

  observe(session: SessionInfo): boolean {
    const p = session.replyProgress ?? (!session.path && session.paneId ? missing : undefined);
    if (!p) return false;
    const old = this.entries.get(session.id);
    // An empty pre-JSONL pane can acquire a real file. A temporarily missing
    // file on a previously seen pane is not a new conversation or a read.
    if (p.inode === 'missing' && old) return false;
    const freshFile = !old || old.inode !== p.inode || p.reset;
    const r: Receipt = freshFile ? { inode: p.inode, offset: p.offset, seen: p.completedThrough === undefined ? p.offset : 0 } : { ...old };
    r.offset = Math.max(r.offset, p.offset);
    if (p.completedThrough !== undefined && p.completedThrough > r.seen) r.unread = Math.max(r.unread ?? 0, p.completedThrough);
    if (old?.inode === r.inode && old.offset === r.offset && old.unread === r.unread && old.seen === r.seen) return false;
    this.entries.set(session.id, { inode: r.inode, offset: r.offset, unread: r.unread, seen: r.seen });
    return true;
  }
  read(id: string, p: TranscriptPosition): boolean {
    if (!validOffset(p.offset)) return false;
    const old = this.entries.get(id);
    if (old && p.inode === 'missing') return false;
    const r: Receipt = old?.inode === p.inode ? { ...old } : { ...p, seen: 0 };
    if (old?.inode === p.inode && p.offset <= r.seen) return false;
    r.seen = Math.max(r.seen, p.offset);
    if (r.unread !== undefined && r.unread <= r.seen) delete r.unread;
    this.entries.set(id, r);
    return true;
  }
}

// Both split views share receipts, but only the primary view polls the tree.
const ledgers = new Map<string, { scope: string; receipts: ReplyReceipts }>();
const listeners = new Set<() => void>();
export function onReceiptChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function storageKey(scope: string) { return `lectern.sidebar-receipts.v1:${scope}`; }
function store(scope: string, receipts: ReplyReceipts) {
  try { localStorage.setItem(storageKey(scope), receipts.serialize()); } catch { /* Read-only profile. */ }
}
export function workspaceReceipts(ws: Workspace) {
  const scope = JSON.stringify([ws.id, ws.kind, ws.host, ws.port, ws.cwd, ws.claudeDir]);
  let entry = ledgers.get(ws.id);
  if (entry?.scope !== scope) {
    let saved: string | undefined;
    try { saved = localStorage.getItem(storageKey(scope)) ?? undefined; } catch { /* No persistent storage. */ }
    entry = { scope, receipts: new ReplyReceipts(saved) };
    ledgers.set(ws.id, entry);
  }
  return entry;
}
export function observeTreeSessions(ws: Workspace, sessions: SessionInfo[]) {
  const { scope, receipts } = workspaceReceipts(ws);
  let changed = false, repaint = false;
  for (const session of sessions) {
    const unread = receipts.unread(session.id);
    if (receipts.observe(session)) changed = true;
    if (unread !== receipts.unread(session.id)) repaint = true;
  }
  if (changed) store(scope, receipts);
  if (repaint) listeners.forEach(fn => fn());
}
export function readTreeSession(ws: Workspace, id: string, position: TranscriptPosition) {
  const { scope, receipts } = workspaceReceipts(ws), unread = receipts.unread(id);
  if (!receipts.read(id, position)) return;
  store(scope, receipts);
  if (unread !== receipts.unread(id)) listeners.forEach(fn => fn());
}
export function setTreeSessionUnread(ws: Workspace, id: string, unread: boolean) {
  const { scope, receipts } = workspaceReceipts(ws);
  if (!receipts.setUnread(id, unread)) return;
  store(scope, receipts);
  listeners.forEach(fn => fn());
}
export function revisitTreeSession(ws: Workspace, id: string) {
  const { scope, receipts } = workspaceReceipts(ws);
  if (!receipts.revisit(id)) return;
  store(scope, receipts);
  listeners.forEach(fn => fn());
}
export function forgetTreeReceipts(id: string) {
  const entry = ledgers.get(id);
  if (entry) try { localStorage.removeItem(storageKey(entry.scope)); } catch { /* Read-only profile. */ }
  ledgers.delete(id);
}
