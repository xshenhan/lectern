import type { SessionSnapshot, ChatView, SidebarStatusUpdate, TerminalFrameEvent } from '../shared/types';
import { Controller } from './controller';
import { t } from '../shared/i18n';

interface Reader {
  key: string;
  controller: Controller;
  views: Set<ChatView>;
  terminals: Set<ChatView>;
  opening?: Promise<SessionSnapshot>;
  shownAt: number;
  sidebarStatus?: SidebarStatusUpdate;
  /** Read ahead because the user pointed at it; not shown yet. */
  speculative?: boolean;
}

// Conversations stay parsed after leaving a pane, until the app quits or the
// cache is full. Reopening one shows the cached history at once and only reads
// what is new; a running pane keeps being read in the background meanwhile.
const cachedLimit = 48;
// Pointing at many sidebar rows must not evict conversations that were open.
const speculativeLimit = 6;
const key = (workspace: string, session: string) => JSON.stringify([workspace, session]);

// One native reader per conversation. If two panes show the same session,
// they share its JSONL cursor, input lock and terminal-control token.
export class SessionViews {
  private readonly readers = new Map<string, Reader>();
  private clock = 0;

  constructor(private readonly primary: Controller, private readonly emit: (snapshot: SessionSnapshot) => void,
    private readonly emitFrame: (event: TerminalFrameEvent) => void = () => {},
    private readonly emitSidebarStatus: (update: SidebarStatusUpdate) => void = () => {}) {}

  private view(value: ChatView): ChatView {
    if (value !== 'primary' && value !== 'secondary') throw new Error(t('main.unknownSplit'));
    return value;
  }
  private find(workspace: string, session: string) {
    const reader = this.readers.get(key(workspace, session));
    const snapshot = reader?.controller.currentSnapshot;
    return snapshot?.workspaceId === workspace && snapshot.sessionId === session ? reader : undefined;
  }
  private shown(workspace: string, session: string) {
    const reader = this.find(workspace, session);
    return reader?.views.size ? reader : undefined;
  }
  forSession(workspace: string, session: string) {
    const reader = this.shown(workspace, session);
    if (!reader) throw new Error(t('main.conversationLeftPane'));
    return reader.controller;
  }
  /** A pane closed its subagent column; nothing to do once the chat left the pane. */
  releaseSubagents(workspace: string, session: string, view: ChatView = 'primary') {
    this.find(workspace, session)?.controller.releaseSubagents(this.view(view));
  }
  /** The same for the task column's background shells and monitors. */
  releaseTaskOutputs(workspace: string, session: string, view: ChatView = 'primary') {
    this.find(workspace, session)?.controller.releaseTaskOutputs(this.view(view));
  }
  /** The reader that already shows or caches this conversation keeps its
   * history; one immediate read binds it to the resumed pane. */
  async resumeSession(workspace: string, session: string) {
    const resumed = await this.primary.resumeSession(workspace, session);
    await this.find(workspace, session)?.controller.refresh(workspace, session);
    return resumed;
  }
  renameSession(workspace: string, session: string, title: string) {
    // A sidebar action can target a session outside both visible panes.
    return (this.shown(workspace, session)?.controller ?? this.primary).renameSession(workspace, session, title);
  }
  setTerminalVisible(workspace: string, session: string, visible: boolean, view: ChatView = 'primary') {
    this.view(view);
    const reader = this.find(workspace, session);
    if (!reader?.views.has(view)) return;
    if (visible) reader.terminals.add(view);
    else reader.terminals.delete(view);
    reader.controller.setTerminalVisible(workspace, session, reader.terminals.size > 0);
  }
  private updateSidebarStatus(reader: Reader, snapshot: SessionSnapshot) {
    if (this.readers.get(reader.key) !== reader) return;
    const { workspaceId, sessionId, paneId, status, navigationStatus, navigationStatusDetail, background, error } = snapshot;
    if (reader.key !== key(workspaceId, sessionId)) return;
    const observation = paneId && status !== 'connecting' && status !== 'offline'
      ? { paneId, status, navigationStatus, navigationStatusDetail, background, error } : undefined;
    const previous = reader.sidebarStatus?.observation;
    if (previous?.paneId === observation?.paneId && previous?.status === observation?.status &&
        previous?.navigationStatus === observation?.navigationStatus &&
        previous?.navigationStatusDetail === observation?.navigationStatusDetail &&
        previous?.background === observation?.background && previous?.error === observation?.error) return;
    const update = { workspaceId, sessionId, observation };
    reader.sidebarStatus = observation ? update : undefined;
    this.emitSidebarStatus(update);
  }
  /** Renderer reloads can subscribe after a reader's last status change. */
  replaySidebarStatus() {
    for (const reader of this.readers.values()) if (reader.sidebarStatus) this.emitSidebarStatus(reader.sidebarStatus);
  }
  private create(workspace: string, session: string, background: boolean) {
    const controller = this.primary.sibling();
    const reader: Reader = { key: key(workspace, session), controller, views: new Set(), terminals: new Set(), shownAt: ++this.clock };
    controller.on('snapshot', (snapshot: SessionSnapshot) => { if (reader.views.size) this.emit(snapshot); });
    controller.on('sidebar-status', (snapshot: SessionSnapshot) => this.updateSidebarStatus(reader, snapshot));
    controller.on('terminal-frame', (event: TerminalFrameEvent) => { if (reader.views.size) this.emitFrame(event); });
    controller.setBackground(background);
    this.readers.set(reader.key, reader);
    const opening = controller.watchSession(workspace, session);
    reader.opening = opening;
    const clear = () => { if (reader.opening === opening) reader.opening = undefined; };
    opening.then(clear, () => { clear(); if (!reader.views.size) this.forget(reader); });
    return reader;
  }
  watch(workspace: string, session: string, view: ChatView = 'primary') {
    this.view(view);
    const existing = this.readers.get(key(workspace, session));
    // Opening the conversation that is already alone in this pane is an
    // explicit reload (retry, bind): start a fresh read. Resume refreshes instead.
    if (existing && existing.views.has(view) && existing.views.size === 1) {
      this.release(view);
      this.forget(existing);
    } else if (existing) {
      if (!existing.views.has(view)) this.release(view);
      existing.views.add(view);
      existing.speculative = false;
      existing.shownAt = ++this.clock;
      existing.controller.setBackground(false);
      return existing.opening ?? Promise.resolve(existing.controller.currentSnapshot!);
    } else this.release(view);
    const reader = this.create(workspace, session, false);
    reader.views.add(view);
    return reader.opening!;
  }
  /** Start reading a conversation that no pane shows yet: a running one, or
   * one the user points at (`speculative`), so opening it shows at once. */
  prefetch(workspace: string, session: string, speculative = false) {
    if (this.readers.has(key(workspace, session))) return;
    if (speculative) {
      const pending = [...this.readers.values()].filter(r => r.speculative && !r.views.size).sort((a, b) => a.shownAt - b.shownAt);
      for (let excess = pending.length - speculativeLimit + 1; excess > 0; excess--) this.forget(pending.shift()!);
    }
    this.create(workspace, session, true).speculative = speculative;
    this.trim();
  }
  release(view: ChatView = 'primary') {
    this.view(view);
    for (const reader of this.readers.values()) {
      if (!reader.views.delete(view)) continue;
      reader.controller.releaseHandoffHistory(view);
      reader.controller.releaseSubagents(view);
      reader.controller.releaseTaskOutputs(view);
      const snapshot = reader.controller.currentSnapshot;
      if (reader.terminals.delete(view) && snapshot)
        reader.controller.setTerminalVisible(snapshot.workspaceId, snapshot.sessionId, reader.terminals.size > 0);
      if (!reader.views.size) {
        reader.shownAt = ++this.clock;
        reader.controller.setBackground(true);
      }
    }
    this.trim();
  }
  private forget(reader: Reader) {
    if (this.readers.get(reader.key) !== reader) return;
    this.readers.delete(reader.key);
    if (reader.sidebarStatus) {
      const { workspaceId, sessionId } = reader.sidebarStatus;
      this.emitSidebarStatus({ workspaceId, sessionId });
    }
    void reader.controller.detach();
  }
  // Evict the least recently shown cached conversations, saved history first.
  private trim() {
    const idle = [...this.readers.values()].filter(r => !r.views.size)
      .sort((a, b) => Number(!!a.controller.currentSnapshot?.paneId) - Number(!!b.controller.currentSnapshot?.paneId) || a.shownAt - b.shownAt);
    for (let excess = this.readers.size - cachedLimit; excess > 0 && idle.length; excess--) this.forget(idle.shift()!);
  }
  /** Snapshots of the conversations read now that run in a pane: what quitting would stop. */
  liveSnapshots(): SessionSnapshot[] {
    return [...this.readers.values()].map(reader => reader.controller.currentSnapshot).filter((snapshot): snapshot is SessionSnapshot => !!snapshot?.paneId);
  }
  /** Language switched: shown conversations republish their texts. */
  relocalize() {
    for (const reader of this.readers.values()) if (reader.views.size) reader.controller.relocalize();
  }
  releaseWorkspace(workspace: string) {
    for (const reader of [...this.readers.values()]) {
      if (reader.controller.currentSnapshot?.workspaceId !== workspace) continue;
      for (const view of [...reader.views]) this.release(view);
      this.forget(reader);
    }
  }
  close() {
    this.release('primary'); this.release('secondary');
    // A closed window keeps no cached conversation reading in the background.
    for (const reader of [...this.readers.values()]) this.forget(reader);
  }
  async dispose() {
    this.close();
    await this.primary.dispose();
  }
}
