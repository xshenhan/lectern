import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { TurnAction } from '../shared/turn-controls';
import { checkpointPosition, type RewindTarget } from '../backend/native-turn-controls';
import { canInterruptTurn, readRewind, turnComposer } from '../core/turn-controls';
import { Backend, validateWorkspace, type HistoryCursor } from '../backend';
import { repairSlices } from '../backend/transcript-pages';
import { observedSessionStatus } from '../core/observed-status';
import { backgroundCounts, backgroundSummary } from '../core/background-work';
import { runStart } from '../shared/activity';
import { MessageDisplay } from '../core/message-display';
import { HandoffReader } from './handoff-reader';
import { SubagentReader, type SubagentRequest } from './subagent-reader';
import { TaskOutputReader } from './task-output-reader';
import type { TaskOutputRequest } from '../shared/types';
import { activityTaskId } from '../core/session-activity';
import { listsSubagents, mergeSubagents, metaTracked, runningSubagents, versionAtLeast, type SessionLiveness } from '../core/subagent-status';
import type { ChatMessage, ChatView, SessionStatus } from '../shared/types';
import { classifySessionScreen } from '../core/screen';
import { focusedSettingCommandHistory, isIdleEmptyComposer, observeUltracode } from '../core/settings-screen';
import { parseExecutionMode } from '../core/session-telemetry';
import { CompactSamples, parseTurnProgress, showsCompactCompletion } from '../core/turn-progress';
import { parseQuestionScreen } from '../core/question-screen';
import { parsePermissionScreen } from '../core/permission-screen';
import { observePermission, pendingToolId, type WatchedPermission } from './session-permission';
import { PermissionInputUnconfirmed } from '../backend/native-permission-actions';
import type { PermissionAction } from '../shared/native-permission';
import type { QuestionAction } from '../shared/question-action';
import { QuestionInputUnconfirmed } from '../backend/native-question-actions';
import { observeQuestion, pendingQuestionId, type WatchedQuestion } from './session-question';
import { SessionSettingsCache, type SessionSettingsHandle } from './session-settings-cache';
import { ModelCatalogs } from './model-catalogs';
import { effortsFor, isEffortLevel, isModelValue, type LaunchChoices, type ModelCatalogState } from '../shared/model-catalog';
import { sessionSettingsTarget } from '../shared/session-setting-ticket';
import type { DirectoryTrustDecision, ReplyBaselines, SessionSettingKind, SessionSettingSnapshot, SettingSwitchMode, SessionSnapshot, SubagentListing, TerminalControl, TerminalInput, TerminalKey, Workspace } from '../shared/types';
import { WorkspaceStore } from './store';
import { commandPolicy } from '../shared/native-commands';
import type { TerminalLink } from '../backend/terminal-link';
import { diagnostic, errorDetails, getDiagnosticsInfo, summarize } from '../diagnostics';
import { t } from '../shared/i18n';

type Watch = { id: string; polls: number; workspace: Workspace; sessionId: string; display: MessageDisplay; snapshot: SessionSnapshot; failures: number;
  /** A read of this watch is in flight (poll()). */
  reading?: boolean;
  settingsHandle?: SessionSettingsHandle;
  compactSamples: CompactSamples;
  question?: WatchedQuestion;
  permission?: WatchedPermission;
  terminalVisible?: boolean;
  nativeTasks?: SessionSnapshot['tasks'];
  terminalEpoch?: number;
  manualRecovery?: boolean;
  inactiveHistory?: boolean;
  /** The fast path while the user controls the terminal; absent or closed means per-command input. */
  terminalLink?: TerminalLink;
  older?: { cursor: HistoryCursor; ticket: string; extending?: boolean; reading?: Promise<SessionSnapshot> };
  /** The session's subagent folder as the poll last listed it, and when (core/subagent-status.ts). */
  subagents?: SubagentListing; subagentsAt?: number;
  /** Whether the latest read found the process that runs the session, and when that process started:
   * from a Lectern pane (`paneLive`), else from the native record of a process elsewhere. */
  live?: SessionLiveness; nativeStartedAt?: number; paneLive?: boolean;
  screenHash?: string; screenCaptureId?: string; viewportHash?: string; viewportCaptureId?: string; messagesHash?: string; messagesCaptureId?: string };

interface TurnMemory {
  pane: string; pid: number;
  pickerOpen?: boolean; checkpointUuid?: string;
  restoredDraft?: string; restoredUuid?: string;
}

/** The conversation's activity for its snapshot. Claude Code 2.1.310+ (`listed`): every
 * subagent of the session's folder, each with the state its meta file and the process give
 * (core/subagent-status.ts); otherwise what the loaded transcript says. */
function activityOf(watch: Watch, cliVersion: string | undefined) {
  const live = watch.live ?? 'unknown', base = watch.display.activity.snapshot(live === 'alive');
  const files = watch.subagents?.files ?? [];
  const listed = listsSubagents(cliVersion, files);
  return { activity: listed ? mergeSubagents(base, files, { live, since: watch.nativeStartedAt }) : base, listed };
}
/** The poll lists the subagent folder (at most once a second) unless the session's version predates meta states. */
const listsFolder = (watch: Watch, now: number) =>
  versionAtLeast(watch.snapshot.cliVersion, [2, 1, 310]) !== false && (watch.subagentsAt === undefined || now - watch.subagentsAt >= 900);
/** With the listing, look for a process of the session outside Lectern's panes (a terminal of its own) when
 * no pane ran it at the last read and a subagent's state depends on it (one not finished, or none listed yet). */
const looksElsewhere = (watch: Watch, listing: boolean) =>
  listing && watch.paneLive !== true && (!watch.subagents || watch.subagents.files.some(file => metaTracked(file) && !file.finished));

function historyPage(watch: Watch) {
  return { hasOlder: !!watch.older, cursor: watch.older?.ticket ?? '' };
}

/** JSON.stringify({ messages, status, paneId, notice, error }) given the serialized messages. */
export function fullStateJson(messages: string, state: Pick<SessionSnapshot, 'status' | 'paneId' | 'notice' | 'error'>): string {
  const rest = JSON.stringify({ status: state.status, paneId: state.paneId, notice: state.notice, error: state.error });
  return rest === '{}' ? `{"messages":${messages}}` : `{"messages":${messages},${rest.slice(1)}`;
}
function presentedMessages(watch: Watch) {
  const messages = watch.display.getMessages();
  if (!watch.inactiveHistory) return messages;
  // An archived unanswered turn has no live generation.
  return messages.filter(message => message.role !== 'assistant' || message.text || message.tools.length || message.peerMessages?.length || message.taskNotifications?.length || message.attachments?.length)
    .map(message => message.status === 'streaming' ? { ...message, status: 'complete' as const } : message);
}

export class Controller extends EventEmitter {
  private watch?: Watch;
  private readonly handoffs = new Map<ChatView, HandoffReader>();
  private readonly subagents = new Map<ChatView, Map<string, SubagentReader>>();
  private readonly taskOutputs = new Map<ChatView, Map<string, TaskOutputReader>>();
  private subagentClock = 0;
  private timer?: ReturnType<typeof setTimeout>;
  // A cached conversation outside both panes. It keeps its parsed history and
  // read cursor; a running pane keeps being read so reopening is immediate.
  private background = false;
  private polling = false;
  private inFlight?: Promise<void>;
  private pollSoon = false;
  // A read asked for during another one wants a fresh viewport too (see poll()).
  private pollSoonFresh = false;
  private sending = false;
  private turnBusy = false;
  private settingOperation?: { workspaceId: string; sessionId: string; finished: Promise<void> };
  private trustOperation?: { workspaceId: string; sessionId: string };
  private settingRevision = 0;
  private readonly manualRecoveries = new Set<string>();
  private executionModes = new WeakMap<SessionSettingsHandle, SessionSnapshot['executionMode']>();
  private readonly statusLines = new WeakMap<SessionSettingsHandle, NonNullable<SessionSnapshot['statusLine']>>();
  private readonly statusLineManaged = new WeakSet<SessionSettingsHandle>();
  constructor(readonly store: WorkspaceStore, readonly backend: Backend, private readonly settingsCache = new SessionSettingsCache(),
    private readonly turnMemory = new Map<string,TurnMemory>(), private readonly catalogs = new ModelCatalogs(backend)) {
    super();
    this.catalogs.on('change', this.onCatalogChange);
  }
  private readonly onCatalogChange = (changed: object) => {
    const watch = this.watch;
    if (watch && this.catalogs.isChangeFor(watch.workspace, changed)) this.hydrateSettings(watch);
  };
  /** Local folders need no connection: read their model lists at startup.
   * An SSH machine's list is read after its first successful discovery. */
  warmModelCatalogs() { for (const workspace of this.store.list()) if (workspace.kind !== 'ssh') this.catalogs.warm(workspace); }
  /** The model and effort lists for a folder's machine, for a new chat's pickers. */
  async modelCatalog(workspaceId: string, retry = false): Promise<ModelCatalogState> {
    const workspace = this.store.get(workspaceId);
    const entry = this.catalogs.get(workspace);
    // Wait for a read in flight too (a retry started elsewhere), so the picker
    // always gets a settled list or error.
    if (retry || !entry?.error || entry.loading) await this.catalogs.read(workspace).catch(() => {});
    return this.catalogs.state(workspace);
  }
  /** Dynamic workflows decide Ultracode's availability: read the lists again. */
  refreshModelCatalogs() { this.catalogs.refreshAll(); }
  get currentSnapshot() { return this.watch?.snapshot; }
  get isBackground() { return this.background; }
  /** Background reads never publish. Foreground publishes the cached state at
   * once and reads again immediately, without discarding loaded history. */
  setBackground(value: boolean) {
    if (this.background === value) return;
    this.background = value;
    const watch = this.watch;
    if (!watch) return;
    if (value) {
      watch.terminalVisible = false;
      if (watch.snapshot.terminalControl) this.revokeTerminalControl(watch, 'background');
      if (!this.readsInBackground(watch)) { clearTimeout(this.timer); this.timer = undefined; }
      return;
    }
    this.publish(watch, 'foreground', watch.inactiveHistory);
    if (this.polling) this.pollSoon = true;
    else this.schedulePoll(watch, 0);
  }
  /** After a language switch: show the texts this reader composed in the new
   * language now; the next read rebuilds the rest. */
  relocalize() {
    const watch = this.watch;
    if (!watch || this.background) return;
    watch.snapshot = { ...watch.snapshot, notice: watch.display.notice };
    this.publish(watch, 'locale');
    if (this.polling) this.pollSoon = true;
    else this.schedulePoll(watch, 0);
  }
  private readsInBackground(watch: Watch) { return !!watch.snapshot.paneId && !watch.failures; }
  sibling() { return new Controller(this.store, this.backend, this.settingsCache, this.turnMemory, this.catalogs); }
  async saveWorkspace(workspace: Workspace) {
    validateWorkspace(workspace);
    const previous = this.store.list().find(item => item.id === workspace.id);
    if (previous && sessionSettingsTarget(previous) !== sessionSettingsTarget(workspace)) this.settingsCache.invalidateTarget(sessionSettingsTarget(previous));
    if (this.watch?.workspace.id === workspace.id) this.unwatchSession();
    this.backend.invalidateWorkspace(workspace.id);
    // Whitelist persisted fields; do not retain caller supplied extra properties.
    const { id, name, kind, cwd, host, port, claudeDir, historyScan } = workspace;
    return this.store.save({ id, name, kind, cwd, host, port, claudeDir, ...(historyScan === false && { historyScan }) });
  }
  /** Only the scan flag changes: open conversations and cached locations stay as they are. */
  async enableHistoryScan(id: string) {
    const { historyScan: _, ...workspace } = this.store.get(id);
    return this.store.save(workspace);
  }
  async removeWorkspace(id: string) {
    this.settingsCache.invalidateTarget(sessionSettingsTarget(this.store.get(id)));
    if (this.watch?.workspace.id === id) this.unwatchSession();
    this.backend.invalidateWorkspace(id);
    await this.store.remove(id);
  }
  async discover(id: string, baselines?: ReplyBaselines) {
    const workspace = this.store.get(id);
    const discovery = await this.backend.discover(workspace, baselines);
    // Connected: read this machine's model list once, in the background.
    this.catalogs.warm(workspace);
    return discovery;
  }
  /** A new conversation. Model and effort apply to this launch only and must be
   * rows of the machine's model list; the first message, when given, is checked
   * before anything starts so a refused message leaves no running Claude behind. */
  async createSession(id: string, options: { model?: string; effort?: string; validateMessage?: string } = {}) {
    const workspace = this.store.get(id);
    if (!options || typeof options !== 'object') throw new Error(t('controller.invalidNewChatOptions'));
    if (options.validateMessage !== undefined) {
      if (typeof options.validateMessage !== 'string') throw new Error(t('controller.invalidMessage'));
      await this.assertSendable(id, options.validateMessage);
    }
    const choices: LaunchChoices = {};
    if (options.model !== undefined || options.effort !== undefined) {
      if (options.model !== undefined && !isModelValue(options.model)) throw new Error(t('controller.invalidModel'));
      if (options.effort !== undefined && !isEffortLevel(options.effort)) throw new Error(t('controller.invalidEffort'));
      const catalog = this.catalogs.get(workspace)?.catalog;
      if (!catalog) throw new Error(t('controller.catalogPending'));
      // "default" is what a new session starts with anyway: no --model.
      const model = options.model === 'default' && !catalog.models.some(row => row.value === 'default') ? undefined : options.model;
      if (model !== undefined && !catalog.models.some(row => row.value === model)) throw new Error(t('controller.modelGone'));
      if (options.effort !== undefined && !effortsFor(catalog, model).includes(options.effort)) throw new Error(t('controller.effortUnsupported'));
      if (options.model !== undefined && options.model !== 'default') choices.model = options.model;
      if (options.effort !== undefined) choices.effort = options.effort;
    }
    return this.backend.createSession(workspace, choices);
  }
  async renameSession(workspaceId: string, sessionId: string, title: string) {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId)
      return this.backend.renameSession(this.store.get(workspaceId), sessionId, title);
    if (this.sending || this.turnBusy || this.settingOperation || this.trustOperation || watch.snapshot.terminalControl)
      throw new Error(t('controller.renameWhileTerminal'));
    this.sending = true;
    try {
      return await this.backend.renameSession(watch.workspace, sessionId, title);
    } finally {
      this.sending = false;
      if (this.watch === watch) this.schedulePoll(watch, 0, true);
    }
  }
  async resumeSession(id: string, sessionId: string) {
    const workspace = this.store.get(id);
    const session = await this.backend.resumeSession(workspace, sessionId);
    this.catalogs.warm(workspace);
    return session;
  }
  async forkSession(workspaceId: string, sessionId: string, paneId: string, panePid: number) {
    const watch = this.watch;
    const pending = watch && this.backend.pendingFork(watch.workspace, sessionId);
    const recovery = pending?.paneId === paneId && pending.panePid === panePid;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || watch.snapshot.terminalControl ||
        !recovery && (watch.failures || watch.snapshot.paneId !== paneId || watch.snapshot.panePid !== panePid || !watch.snapshot.nativeInputReady || watch.snapshot.directoryTrust))
      throw new Error(t('controller.needIdleEmptySession'));
    if (this.sending || this.turnBusy || this.settingOperation || this.trustOperation) throw new Error(t('controller.nativeInputBusyWait'));
    this.sending = this.turnBusy = true;
    this.settingRevision++;
    const target = sessionSettingsTarget(watch.workspace);
    const invalidate = () => {
      this.settingsCache.observe(target, sessionId, undefined, false);
      this.turnMemory.delete(this.recoveryKey(watch.workspace, sessionId));
      watch.settingsHandle = undefined;
      watch.snapshot = { ...watch.snapshot, settings: undefined, statusLine: undefined, statusLineManaged: undefined, executionMode: undefined, nativeInputReady: false, settingsInputReady: false };
    };
    invalidate();
    try { return await this.backend.forkSession(watch.workspace, sessionId, paneId, panePid); }
    finally {
      invalidate();
      watch.snapshot.pendingFork = this.backend.pendingFork(watch.workspace, sessionId);
      if (this.watch === watch) this.publish(watch, 'fork-finished');
      this.settingRevision++;
      this.sending = this.turnBusy = false;
      if (this.watch === watch) this.schedulePoll(watch, 0, true);
    }
  }
  async closeSession(workspaceId: string, sessionId: string, paneId: string, panePid: number) {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId
      || watch.snapshot.paneId !== paneId || watch.snapshot.panePid !== panePid || watch.failures) {
      throw new Error(t('controller.terminalChangedRefresh'));
    }
    if (this.sending || this.settingOperation || this.trustOperation) throw new Error(t('controller.typingWaitToClose'));
    this.sending = true;
    let history: Awaited<ReturnType<Backend['closeSession']>>;
    try {
      history = await this.backend.closeSession(watch.workspace, sessionId, paneId, panePid);
      this.manualRecoveries.delete(this.recoveryKey(watch.workspace, sessionId));
      this.settingsCache.observe(sessionSettingsTarget(watch.workspace), sessionId, undefined, false);
    } finally { this.sending = false; }
    if (this.watch !== watch) return history;
    // Nothing was saved: the conversation is gone and its pane returns to a new chat.
    if (!history) { this.unwatchSession(); return history; }
    // Saved history stays in this watch, like after a resume: one read now finds the
    // pane gone and publishes the same transcript as history, so the open chat never
    // blanks or reloads. Its JSONL cursor continues with what Claude wrote on exit.
    watch.manualRecovery = false;
    // The close itself succeeded; a failed read shows on the chat and retries like any poll.
    await this.refresh(workspaceId, sessionId).catch(error => diagnostic.event('controller.close.refresh_failed', { error: errorDetails(error) }, 'warn'));
    return history;
  }
  async bindSession(id: string, sessionId: string, paneId: string) {
    const workspace = this.store.get(id);
    await this.backend.bindSession(workspace, sessionId, paneId);
    this.catalogs.warm(workspace);
  }
  async watchSession(workspaceId: string, sessionId: string): Promise<SessionSnapshot> {
    this.unwatchSession();
    const workspace = this.store.get(workspaceId);
    this.backend.resetRead(workspaceId, sessionId);
    const watchId = randomUUID();
    return diagnostic.operation('controller.watch.open', { workspaceId, sessionId, watchId }, async () => {
      const watch: Watch = {
        id: watchId, polls: 0, workspace, sessionId, display: new MessageDisplay(sessionId), compactSamples: new CompactSamples(), failures: 0,
        manualRecovery: this.manualRecoveries.has(this.recoveryKey(workspace, sessionId)),
        snapshot: { workspaceId, sessionId, messages: [], screen: '', status: 'connecting' },
      };
      this.watch = watch;
      diagnostic.event('controller.watch.start', { watchId, workspaceId, sessionId });
      await this.poll(watch);
      return watch.snapshot;
    });
  }
  readHandoffHistory(workspaceId: string, tipId: string, sourceId: string, cursor?: string, sizeMiB?: number, view: ChatView = 'primary') {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== tipId || !['primary', 'secondary'].includes(view)) throw new Error(t('controller.conversationSwitched'));
    let reader = this.handoffs.get(view);
    if (cursor === undefined) {
      reader = new HandoffReader(sourceId);
      this.handoffs.set(view, reader);
    }
    if (!reader || reader.sourceId !== sourceId) throw new Error(t('controller.handoffSwitched'));
    return reader.read(this.backend, watch.workspace, tipId, cursor, sizeMiB, () => this.watch === watch && this.handoffs.get(view) === reader);
  }
  releaseHandoffHistory(view: ChatView = 'primary') { this.handoffs.delete(view); }
  private shownWatch(workspaceId: string, sessionId: string, view: ChatView = 'primary') {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || !['primary', 'secondary'].includes(view)) throw new Error(t('controller.conversationSwitched'));
    return watch;
  }
  listSubagents(workspaceId: string, sessionId: string) {
    const watch = this.shownWatch(workspaceId, sessionId);
    return this.backend.listSubagents(watch.workspace, sessionId);
  }
  /** A pane's subagent column: one reader per subagent it showed recently. */
  readSubagent(workspaceId: string, sessionId: string, agentId: string, request: SubagentRequest = {}, view: ChatView = 'primary') {
    const watch = this.shownWatch(workspaceId, sessionId, view);
    if (!activityTaskId(agentId) || !request || typeof request !== 'object') throw new Error(t('main.subagentSwitched'));
    const readers = this.subagents.get(view) ?? new Map<string, SubagentReader>();
    this.subagents.set(view, readers);
    let reader = readers.get(agentId);
    if (!reader) {
      reader = new SubagentReader(sessionId, agentId);
      readers.set(agentId, reader);
      const idle = [...readers.values()].sort((a, b) => a.usedAt - b.usedAt);
      for (let excess = readers.size - 6; excess > 0; excess--) readers.delete(idle.shift()!.agentId);
    }
    reader.usedAt = ++this.subagentClock;
    const current = reader;
    // The subagent's state is the one the activity card shows (session-activity.ts).
    // A launch without a reported agent ID yet is named by its Agent call (the meta file's toolUseId).
    const launch = typeof request.toolUseId === 'string' ? request.toolUseId : undefined;
    const status = watch.snapshot.activity?.find(item => item.kind === 'agent' && (item.taskId ? item.taskId === agentId : item.id === launch))?.status;
    const older = typeof request.older === 'string' ? request.older : undefined;
    const sizeMiB = typeof request.sizeMiB === 'number' ? request.sizeMiB : undefined;
    const revision = typeof request.revision === 'number' ? request.revision : undefined;
    return current.read(this.backend, watch.workspace, { older, sizeMiB, revision }, status,
      () => this.watch === watch && this.subagents.get(view)?.get(agentId) === current);
  }
  releaseSubagents(view: ChatView = 'primary') { this.subagents.delete(view); }
  /** A pane's task column: the output of a background shell or monitor, named by its tool call. The
   * command, working directory and task ID come from this conversation's activity, not the caller. */
  readTaskOutput(workspaceId: string, sessionId: string, toolId: string, request: TaskOutputRequest = {}, view: ChatView = 'primary') {
    const watch = this.shownWatch(workspaceId, sessionId, view);
    if (!activityTaskId(toolId) || !request || typeof request !== 'object') throw new Error(t('main.taskOutputSwitched'));
    const item = watch.snapshot.activity?.find(entry => entry.id === toolId && (entry.kind === 'shell' || entry.kind === 'monitor'));
    if (!item) throw new Error(t('main.taskNotFound'));
    const readers = this.taskOutputs.get(view) ?? new Map<string, TaskOutputReader>();
    this.taskOutputs.set(view, readers);
    let reader = readers.get(toolId);
    if (!reader) {
      reader = new TaskOutputReader(sessionId, toolId);
      readers.set(toolId, reader);
      const idle = [...readers.values()].sort((a, b) => a.usedAt - b.usedAt);
      for (let excess = readers.size - 6; excess > 0; excess--) readers.delete(idle.shift()!.toolId);
    }
    reader.usedAt = ++this.subagentClock;
    const current = reader;
    const clean: TaskOutputRequest = {
      revision: typeof request.revision === 'number' ? request.revision : undefined,
      source: typeof request.source === 'string' ? request.source.slice(0, 32) : undefined,
      older: request.older === true, explicit: request.explicit === true,
    };
    return current.read(this.backend, watch.workspace, item, watch.display.activity.transcriptOutput(toolId), clean,
      () => this.watch === watch && this.taskOutputs.get(view)?.get(toolId) === current);
  }
  releaseTaskOutputs(view: ChatView = 'primary') { this.taskOutputs.delete(view); }
  messageAttachment(workspaceId: string, sessionId: string, id: string) {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId) throw new Error(t('controller.attachmentSwitched'));
    for (const reader of this.handoffs.values()) {
      const attachment = reader.attachment(id);
      if (attachment) return attachment;
    }
    for (const readers of this.subagents.values()) for (const reader of readers.values()) {
      const attachment = reader.attachment(id);
      if (attachment) return attachment;
    }
    if (!watch.snapshot.messages.some(message => message.attachments?.some(ref => ref.id === id))) {
      throw new Error(t('controller.attachmentSwitched'));
    }
    return watch.display.getAttachment(id);
  }
  /** The path of an image this chat attached by path (an @ mention), as its transcript records it; undefined for embedded ones. */
  attachedImagePath(workspaceId: string, sessionId: string, id: string) {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId) throw new Error(t('controller.attachmentSwitched'));
    for (const message of watch.snapshot.messages) {
      const ref = message.attachments?.find(item => item.id === id);
      if (ref) return ref.path && ref.image ? ref.path : undefined;
    }
  }
  async loadEarlierMessages(workspaceId: string, sessionId: string, ticket: string, sizeMiB?: number): Promise<SessionSnapshot> {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId)
      throw new Error(t('controller.loadInOwnConversation'));
    const older = watch.older;
    if (!older || older.ticket !== ticket) return watch.snapshot;
    if (older.reading) return older.reading;

    older.reading = diagnostic.operation('controller.history.previous', { watchId: watch.id, workspaceId, sessionId }, async () => {
      if (!await this.readHistory(watch, older, true, sizeMiB)) return watch.snapshot;
      const { activity, listed } = activityOf(watch, watch.snapshot.cliVersion);
      watch.snapshot = {
        ...watch.snapshot, messages: presentedMessages(watch), tasks: watch.nativeTasks ?? watch.display.tasks.list, historyPage: historyPage(watch),
        contextUsage: watch.display.contextUsage, notice: watch.display.notice,
        lastCompact: watch.compactSamples.receipt(watch.display.activity.currentCompact),
        activity, subagentsListed: listed || undefined,
      };
      this.publish(watch, 'history-prepend', watch.inactiveHistory);
      return watch.snapshot;
    });
    try { return await older.reading; }
    finally { older.reading = undefined; }
  }
  private async readHistory(watch: Watch, older: NonNullable<Watch['older']>, requireNewTurn: boolean, sizeMiB?: number) {
    let repairStep = 0;
    for (;;) {
      // Completing the first page's leading turn needs only its prompt. Start
      // small and grow instead of transferring a full configured page (3 MiB
      // by default, seconds through a slow SSH relay) before the first paint.
      const size = requireNewTurn ? sizeMiB : Math.min(16, 0.25 * 4 ** repairStep++);
      const page = await this.backend.readOlderHistory(watch.workspace, watch.sessionId, older.cursor, size);
      if (this.watch !== watch) throw new Error(t('controller.conversationSwitched'));
      if (watch.older !== older) return false;
      // The explicit first batch is always the full configured range. Only
      // the extra reads needed to complete its leading turn may stop early.
      for (const part of (!requireNewTurn || older.extending) ? repairSlices(page, older.cursor, watch.sessionId) : [page]) {
        const next = part.olderCursor;
        if (next && (next.before <= 0 || next.before >= older.cursor.before)) throw new Error(t('controller.historyCursorStuck'));
        const jsonlCaptureId = diagnostic.capture('jsonl', part.jsonl, { direction: 'older', before: older.cursor.before });
        diagnostic.event('controller.history.prepend', { jsonlCaptureId, jsonl: summarize(part.jsonl),
          hasOlder: !!next, deferUntilPrompt: true, requireNewTurn, sourceSessionId: part.sourceSessionId, skippedHistoryRecords: part.skippedHistoryRecords });
        const complete = watch.display.prependJsonl(part.jsonl, !!next, true, requireNewTurn, part.sourceSessionId);
        if (part.skippedHistoryRecords) watch.display.noteSkippedHistoryRecords(part.skippedHistoryRecords);
        if (!next || complete) {
          watch.older = next && { cursor: next, ticket: randomUUID() };
          return true;
        }
        older.cursor = next;
        older.extending = true;
      }
    }
  }
  setTerminalVisible(workspaceId: string, sessionId: string, visible: boolean): void {
    if (typeof visible !== 'boolean') return;
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId) return;
    watch.terminalVisible = visible;
    if (!visible) {
      watch.terminalEpoch = (watch.terminalEpoch ?? 0) + 1;
      if (watch.snapshot.terminalControl) {
        this.revokeTerminalControl(watch, 'terminal-hidden');
        this.publish(watch, 'terminal-control-end');
      }
    }
  }
  unwatchSession(): void {
    this.handoffs.clear();
    this.subagents.clear();
    this.taskOutputs.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.watch) {
      this.revokeTerminalControl(this.watch, 'watch-stopped');
      diagnostic.event('controller.watch.stop', { watchId: this.watch.id, workspaceId: this.watch.workspace.id, sessionId: this.watch.sessionId });
      this.emit('sidebar-status', { ...this.watch.snapshot, paneId: undefined });
    }
    this.watch = undefined;
  }
  private publish(watch: Watch, reason: string, inactiveFilter = false): void {
    this.emit('sidebar-status', watch.snapshot);
    if (this.background) return;
    // The digests below exist only for the diagnostics log. Hashing a long
    // conversation costs ~15 ms of main-process time on every poll.
    if (getDiagnosticsInfo().enabled) this.recordSnapshot(watch, reason, inactiveFilter);
    this.emit('snapshot', watch.snapshot);
  }
  private readonly messageSummaries = new WeakMap<ChatMessage, { text: ReturnType<typeof summarize>; tools: ReturnType<typeof summarize> }>();
  private recordSnapshot(watch: Watch, reason: string, inactiveFilter: boolean): void {
    const serialized = JSON.stringify(watch.snapshot.messages);
    const messagesDigest = summarize(serialized);
    if (watch.messagesHash !== messagesDigest.sha256 || !watch.messagesCaptureId) {
      watch.messagesCaptureId = diagnostic.capture('messages', serialized, { watchId: watch.id, sessionId: watch.sessionId, reason });
      watch.messagesHash = messagesDigest.sha256;
    }
    diagnostic.event('controller.snapshot', { watchId: watch.id, sessionId: watch.sessionId, workspaceId: watch.workspace.id,
      reason, inactiveFilter, status: watch.snapshot.status, paneId: watch.snapshot.paneId, notice: watch.snapshot.notice,
      navigationStatus: watch.snapshot.navigationStatus, navigationStatusDetail: watch.snapshot.navigationStatusDetail,
      settingBusy: watch.snapshot.settingBusy, trustBusy: watch.snapshot.trustBusy, nativeInputReady: watch.snapshot.nativeInputReady, settingsInputReady: watch.snapshot.settingsInputReady, terminalControl: watch.snapshot.terminalControl, manualRecovery: watch.manualRecovery,
      settings: watch.snapshot.settings ? { initialization: watch.snapshot.settings.initialization, loading: watch.snapshot.settings.loading,
        error: watch.snapshot.settings.error, model: watch.snapshot.settings.menus.model?.options.find(option => option.current)?.label ?? watch.snapshot.settings.observed?.model?.label,
        effort: watch.snapshot.settings.menus.effort?.options.find(option => option.current)?.label ?? watch.snapshot.settings.observed?.effort?.label } : undefined,
      statusLineManaged: watch.snapshot.statusLineManaged, statusLine: watch.snapshot.statusLine,
      executionMode: watch.snapshot.executionMode, contextUsage: watch.snapshot.contextUsage,
      directoryTrust: watch.snapshot.directoryTrust ? { cwd: watch.snapshot.directoryTrust.cwd, scope: watch.snapshot.directoryTrust.scope,
        paneId: watch.snapshot.directoryTrust.paneId, token: watch.snapshot.directoryTrust.token } : undefined,
      error: watch.snapshot.error, messagesCaptureId: watch.messagesCaptureId, messagesDigest,
      // Same bytes as JSON.stringify({ messages, status, paneId, notice, error }), without serializing the messages twice.
      fullStateDigest: summarize(fullStateJson(serialized, watch.snapshot)),
      messageCount: watch.snapshot.messages.length, messageSummaryOffset: Math.max(0, watch.snapshot.messages.length - 100),
      messages: watch.snapshot.messages.slice(-100).map(message => {
        let summary = this.messageSummaries.get(message);
        if (!summary) this.messageSummaries.set(message, summary = { text: summarize(message.text), tools: summarize(JSON.stringify(message.tools)) });
        return { id: message.id, role: message.role, source: message.source, status: message.status, ...summary };
      }) });
  }
  private schedulePoll(watch: Watch, delay: number, freshViewport = false): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.poll(watch, freshViewport); }, delay);
    diagnostic.event('controller.poll.scheduled', { delayMs: delay, failures: watch.failures, freshViewport });
  }
  private async poll(watch: Watch, freshViewport = false): Promise<void> {
    this.timer = undefined;
    // One read of a conversation at a time. A second read from the same cursor hands the
    // display the same bytes twice, and when the first one stopped inside a record Claude
    // Code was still writing, the second copy of that record is dropped and never read
    // again (a question then has no card). The read in flight reads again when it ends.
    if (watch.reading) {
      this.pollSoon = true;
      this.pollSoonFresh ||= freshViewport;
      diagnostic.event('controller.poll.coalesced', { watchId: watch.id, freshViewport });
      return;
    }
    this.polling = watch.reading = true;
    const run = this.pollOnce(watch, freshViewport);
    this.inFlight = run;
    try { return await run; }
    finally { this.polling = watch.reading = false; }
  }
  /** Read once more now, keeping the parsed history and cursor. After a resume
   * the new pane is found by this read, so the open transcript never blanks. */
  async refresh(workspaceId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId) return;
    while ((this.polling || watch.reading) && this.watch === watch) await this.inFlight?.catch(() => {});
    if (this.watch !== watch) return;
    clearTimeout(this.timer);
    await this.poll(watch, true);
    return this.watch === watch ? watch.snapshot : undefined;
  }
  private async pollOnce(watch: Watch, freshViewport = false): Promise<void> {
    const pollId = `${watch.id}:${++watch.polls}`;
    return diagnostic.operation('controller.poll', { watchId: watch.id, pollId, workspaceId: watch.workspace.id, sessionId: watch.sessionId }, async () => {
    let inactiveFilter = false;
    const settingRevisionAtRead = this.settingRevision;
    const operationAtRead = (this.settingOperation?.workspaceId === watch.workspace.id && this.settingOperation.sessionId === watch.sessionId)
      || (this.trustOperation?.workspaceId === watch.workspace.id && this.trustOperation.sessionId === watch.sessionId)
      || !!watch.snapshot.terminalControl || this.turnBusy;
    const settingBusyAtRead = operationAtRead || !!watch.manualRecovery;
    try {
      const forceViewport = !!(freshViewport || watch.terminalVisible || watch.snapshot.terminalControl || settingBusyAtRead || watch.snapshot.status === 'working');
      const listing = listsFolder(watch, Date.now()), elsewhere = looksElsewhere(watch, listing);
      const result = await this.backend.readSession(watch.workspace, watch.sessionId, forceViewport, watch.display.activity.targets(), true, !!watch.terminalVisible, true, listing, elsewhere);
      const applied = this.watch === watch;
      // Incremental chunks must not be deduplicated by hash: two equal byte
      // windows may be separate portions of a large record. Empty reads can be.
      const jsonlCaptureId = result.jsonl.length || result.reset || watch.polls === 1
        ? diagnostic.capture('jsonl', result.jsonl, { reset: result.reset, hasMore: result.hasMore, applied }) : undefined;
      const compactRecordsBefore = watch.display.activity.compactRecords;
      let repair = false;
      if (applied) {
        if (result.reset) watch.older = result.olderCursor ? { cursor: result.olderCursor, ticket: randomUUID() } : undefined;
        watch.display.ingestJsonl(result.jsonl, result.reset, result.reset ? !!result.olderCursor : undefined);
        if (result.skippedHistoryRecords) watch.display.noteSkippedHistoryRecords(result.skippedHistoryRecords);
        if (result.reset && watch.older && !watch.display.answeredHistoryHead) {
          repair = true;
          diagnostic.event('controller.history.initial', { jsonlCaptureId, jsonl: summarize(result.jsonl), skippedHistoryRecords: result.skippedHistoryRecords });
          try { if (!await this.readHistory(watch, watch.older, false) || this.watch !== watch) return; }
          catch (error) {
            // The forward cursor already reached EOF. Retry a fresh guarded tail
            // rather than publishing an unpaired partial page on the next poll.
            if (this.watch === watch) this.backend.resetRead(watch.workspace.id, watch.sessionId);
            throw error;
          }
        }
      }
      // A previous selection may still be closing its native menu. The input
      // lock is global, so the new selection must also reflect that busy state.
      const settingBusy = !!this.settingOperation;
      const trustBusy = this.trustOperation?.workspaceId === watch.workspace.id && this.trustOperation.sessionId === watch.sessionId;
      // A tmux capture can be in flight while the settings transaction closes.
      // Never feed that delayed menu frame into the conversation reducer.
      const composerOverlap = operationAtRead || settingBusy || trustBusy || !!watch.snapshot.terminalControl || settingRevisionAtRead !== this.settingRevision;
      // After a terminal takeover the rest of the turn stays JSONL-only, but the
      // composer state below is read from the composer's own frame: queue and
      // steer must not stay disabled until the next regular chat send.
      const settingsOverlap = composerOverlap || !!watch.manualRecovery;
      const turnKey = this.recoveryKey(watch.workspace, watch.sessionId);
      let memory = this.turnMemory.get(turnKey);
      if (memory && (!result.active || memory.pane !== result.session.paneId || memory.pid !== result.panePid)) {
        this.turnMemory.delete(turnKey);
        memory = undefined;
      }
      const rewind = result.active && memory?.pickerOpen ? readRewind(result.viewport ?? '') : undefined;
      const editor = result.active ? turnComposer(result.viewport ?? '') : undefined;
      const questionScreen = result.active && result.viewport && !result.directoryTrust && !result.hasMore
        ? parseQuestionScreen(result.viewport) : undefined;
      const applyScreen = !questionScreen && !rewind && !result.hasMore && !settingsOverlap && result.nativeStatus !== 'waiting';
      const screenDigest = summarize(result.screen);
      if (watch.screenHash !== screenDigest.sha256 || !watch.screenCaptureId) {
        watch.screenCaptureId = diagnostic.capture('screen', result.screen, { applied: applied && applyScreen, hasMore: result.hasMore });
        watch.screenHash = screenDigest.sha256;
      }
      if (result.viewport !== undefined) {
        const viewportDigest = summarize(result.viewport);
        if (watch.viewportHash !== viewportDigest.sha256 || !watch.viewportCaptureId) {
          watch.viewportCaptureId = diagnostic.capture('viewport', result.viewport, { applied: applied && applyScreen });
          watch.viewportHash = viewportDigest.sha256;
        }
      }
      if (!applied) { diagnostic.event('controller.poll.discarded', { reason: 'stale-watch', jsonlCaptureId, screenCaptureId: watch.screenCaptureId }); return; }
      const subagentsChanged = !!result.subagents && result.subagents.revision !== watch.subagents?.revision;
      if (result.subagents) { watch.subagentsAt = Date.now(); watch.subagents = result.subagents; }
      if (subagentsChanged) diagnostic.event('controller.subagents.listed', { files: result.subagents!.files.length, revision: result.subagents!.revision });
      // No pane: a process found elsewhere is alive too; not looked for this time, the last finding stands
      // while no pane has run the session since.
      const found = result.sessionProcess, kept = !result.active && !found && watch.paneLive === false;
      const live: SessionLiveness = result.active || found?.alive ? 'alive' : found?.uncertain ? 'unknown' : kept && watch.live ? watch.live : 'gone';
      const since = result.active ? result.nativeStartedAt : found ? found.startedAt : kept ? watch.nativeStartedAt : undefined;
      if (found) diagnostic.event('controller.session_process', { alive: found.alive, uncertain: found.uncertain, startedAt: found.startedAt });
      const liveChanged = watch.live !== live || watch.nativeStartedAt !== since;
      watch.live = live;
      watch.nativeStartedAt = since;
      watch.paneLive = result.active;
      if (watch.inactiveHistory && !result.active && !result.reset && !result.hasMore && !result.jsonl.length && !subagentsChanged && !liveChanged &&
          !watch.failures && watch.snapshot.endpointBilling === result.endpointBilling && watch.snapshot.status === 'idle' && watch.snapshot.settingBusy === settingBusy &&
          watch.snapshot.trustBusy === trustBusy && watch.snapshot.navigationStatus === result.session.status &&
          watch.snapshot.navigationStatusDetail === result.session.statusDetail && watch.snapshot.screen === result.screen) {
        // Avoid reprojecting and sending every opened history page over IPC on idle polls.
        if (!this.background || this.pollSoon) this.schedulePoll(watch, this.pollSoon ? 0 : 5000, this.pollSoon && this.pollSoonFresh);
        this.pollSoon = this.pollSoonFresh = false;
        return;
      }
      const previousHandle = watch.settingsHandle;
      const handle = this.settingsCache.observe(sessionSettingsTarget(watch.workspace), watch.sessionId, result.session.paneId, result.active, result.panePid, result.runtimeInstanceId);
      if (watch.snapshot.terminalControl && (!result.active || result.session.paneId !== watch.snapshot.terminalControl.paneId
        || (previousHandle && previousHandle !== handle))) {
        this.revokeTerminalControl(watch, 'pane-changed-or-inactive');
      }
      watch.settingsHandle = handle;
      if (handle && result.statusLineManaged) this.statusLineManaged.add(handle);
      const statusLineManaged = !!handle && this.statusLineManaged.has(handle);
      let statusLine: SessionSnapshot['statusLine'];
      if (handle && statusLineManaged && result.statusLine?.sessionId === watch.sessionId) {
        if (settingRevisionAtRead === this.settingRevision && !settingBusy) {
          statusLine = result.statusLine;
          const previous = this.statusLines.get(handle);
          if (previous && previous.modelId !== statusLine.modelId) this.settingsCache.invalidateSelection(handle, 'model');
          else if (previous && previous.effort !== statusLine.effort) this.settingsCache.invalidateSelection(handle, 'effort');
          this.statusLines.set(handle, statusLine);
        } else statusLine = this.statusLines.get(handle);
      }
      const executionMode = result.active ? parseExecutionMode(result.viewport ?? result.screen) : undefined;
      if (executionMode && watch.settingsHandle) this.executionModes.set(watch.settingsHandle, executionMode);
      // The composer border shows Ultracode; a named session's title hides it (undefined).
      const ultracode = result.active && result.viewport && !result.directoryTrust ? observeUltracode(result.viewport) : undefined;
      if (ultracode !== undefined && watch.settingsHandle) this.settingsCache.rememberUltracode(watch.settingsHandle, ultracode);
      const observedStatus = questionScreen ? 'waiting' : watch.manualRecovery || watch.snapshot.terminalControl
        ? classifySessionScreen(result.viewport ?? result.screen).status : undefined;
      diagnostic.event('controller.poll.apply', { jsonlCaptureId, jsonl: summarize(result.jsonl), initialAlreadyApplied: !!repair, screenCaptureId: watch.screenCaptureId,
        manualRecovery: !!watch.manualRecovery, terminalControlActive: !!watch.snapshot.terminalControl, questionScreen: !!questionScreen,
        nativeStatus: result.nativeStatus, navigationError: result.session.status === 'error',
        observedStatus, observedStatusSource: observedStatus ? result.viewport !== undefined ? 'viewport' : 'screen' : undefined,
        viewportCaptureId: result.viewport !== undefined ? watch.viewportCaptureId : undefined,
        viewport: result.viewport !== undefined ? summarize(result.viewport) : undefined,
        viewportApplied: applyScreen && result.viewport !== undefined,
        screen: screenDigest, screenApplied: applyScreen, reset: result.reset, hasOlder: result.reset ? !!result.olderCursor : undefined,
        hasMore: result.hasMore, skippedHistoryRecords: result.skippedHistoryRecords,
        active: result.active, paneId: result.session.paneId, panePid: result.panePid });
      if (!applyScreen) diagnostic.event('controller.screen.skipped', { reason: settingsOverlap ? 'native-input-transaction' : 'history-draining', screenCaptureId: watch.screenCaptureId });
      watch.display.activity.samples(result.activitySamples ?? []);
      // A viewport belongs to the latest turn. Do not attach it to an older history page.
      if (applyScreen) watch.display.ingestScreen(result.screen, result.viewport);
      if (!result.active && watch.snapshot.paneId && (watch.snapshot.status === 'working' || watch.snapshot.status === 'waiting')) {
        // The pane may be closed from a normal terminal rather than our key bar.
        // Keep unsaved screen text visibly provisional, but stop its animation.
        // Initial history reads and not-yet-started panes have no prior activity.
        watch.display.markInterrupted();
        diagnostic.event('controller.interrupt', { reason: 'pane-inactive' });
      }
      watch.failures = 0;
      const restoredDraft = memory?.restoredDraft && editor?.text === memory.restoredDraft ? memory.restoredDraft : undefined;
      if (restoredDraft && !result.hasMore) watch.display.confirmNativeRewind(restoredDraft,memory?.restoredUuid);
      if (memory && !this.turnBusy && !settingsOverlap && !rewind && !restoredDraft && editor?.empty) this.turnMemory.delete(turnKey);
      watch.inactiveHistory = inactiveFilter = !result.active && !result.hasMore;
      watch.nativeTasks = result.active && !result.hasMore ? result.nativeTasks : undefined;
      const messages = presentedMessages(watch);
      // 接管后的 JSONL-only 模式仍可识别新问题。跨越一次输入的旧轮询不能恢复已消费的按钮。
      const questionReadCurrent = settingRevisionAtRead === this.settingRevision && !this.turnBusy && !watch.snapshot.terminalControl;
      if (previousHandle !== handle || result.reset || !result.active || watch.snapshot.terminalControl || result.directoryTrust) watch.question = undefined;
      if (questionReadCurrent) {
        const waiting = result.nativeStatus === 'waiting' && (!result.nativeWaitingFor || result.nativeWaitingFor === 'input needed');
        const owner = (questionScreen || waiting) && pendingQuestionId(messages);
        const screen = questionScreen || (owner && waiting && result.active && !result.directoryTrust && !result.hasMore && result.viewport
          ? parseQuestionScreen(result.viewport, {pendingToolUse:true}) : undefined);
        watch.question = screen && owner && handle?.panePid && !settingBusy && !trustBusy &&
          (!result.nativeStatus || waiting) && result.session.status !== 'error'
          ? observeQuestion(watch.question, screen, handle, owner, result.transcriptPosition) : undefined;
      }
      const question = watch.question?.snapshot;
      if (previousHandle !== handle || result.reset || !result.active || watch.snapshot.terminalControl || result.directoryTrust || question) watch.permission = undefined;
      if (questionReadCurrent && !question) {
        // A tool permission dialog replaces the input box. Only the current
        // turn's pending call can own it; menu-like text in the reply cannot.
        const screen = (!result.nativeStatus || result.nativeStatus === 'waiting') && result.active && !result.directoryTrust && !result.hasMore && result.viewport
          ? parsePermissionScreen(result.viewport) : undefined;
        const owner = screen && pendingToolId(messages);
        watch.permission = screen && owner && handle?.panePid && !settingBusy && !trustBusy && result.session.status !== 'error'
          ? observePermission(watch.permission, screen, handle, owner, result.transcriptPosition) : undefined;
      }
      const permission = watch.permission?.snapshot;
      // Progress never falls back to scrollback. Keep at most one live sample
      // for a newly appended boundary in this same watch, pane and turn.
      const progressFrame = result.active && !result.hasMore && !rewind && !settingBusy && !trustBusy && !this.turnBusy &&
        settingRevisionAtRead === this.settingRevision && !result.directoryTrust && result.nativeStatus !== 'waiting' &&
        result.session.status !== 'waiting' && result.session.status !== 'error' && result.nativeStatus !== 'shell' ? result.viewport : undefined;
      const turnProgress = progressFrame ? parseTurnProgress(progressFrame, editor, result.nativeStatus === 'busy') : undefined;
      if (result.reset) watch.compactSamples = new CompactSamples();
      else if (!progressFrame || previousHandle !== handle) watch.compactSamples.interrupt();
      if (progressFrame && (turnProgress?.compactPhase || watch.compactSamples.awaitingReceipt)) {
        let latestUser: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { latestUser = messages[i].id; break; }
        watch.compactSamples.observe(turnProgress, latestUser, result.reset ? 0 : watch.display.activity.compactRecords - compactRecordsBefore,
          watch.display.activity.lastCompact, !turnProgress && showsCompactCompletion(progressFrame, editor));
      }
      const paneCanAcceptInput = result.active && !result.hasMore && result.nativeStatus !== 'waiting' && result.nativeStatus !== 'busy';
      // Claude Code also reports busy after its reply while background subagents or workflows
      // run; the screen then shows the empty prompt again (session-status.ts makes that idle with
      // background). /model and /effort are typed into that box like into an idle one; a reply
      // still in progress (spinner or "esc to interrupt" at the box) never qualifies. Forking and
      // rewinding (nativeInputReady) still wait for the background work.
      const busyInBackground = result.nativeStatus === 'busy' && result.session.status === 'idle' && !!result.session.background;
      const settingsPaneReady = paneCanAcceptInput || (result.active && !result.hasMore && busyInBackground && !editor?.running);
      const settingsInputReady = settingsPaneReady && isIdleEmptyComposer(result.viewport ?? result.screen);
      const nativeInputReady = paneCanAcceptInput && settingsInputReady;
      // The machine answered: read its model list once (cached until the app quits).
      this.catalogs.warm(watch.workspace);
      const cliVersion = statusLine?.version ?? watch.display.cliVersion ?? watch.snapshot.cliVersion;
      const { activity, listed } = activityOf(watch, cliVersion);
      const pendingBackground = watch.display.pendingBackground;
      // Background subagents or workflows of this process keep Claude Code busy
      // after its reply; an earlier process's records do not.
      const current = (at?: string) => result.nativeStartedAt === undefined || !at || Date.parse(at) >= result.nativeStartedAt - 1000;
      const delegated = (!!pendingBackground && current(pendingBackground.at)) ||
        (listed ? runningSubagents(activity) > 0 : activity.some(item => item.kind === 'agent' && item.background === true && item.status === 'running' && current(runStart(item)))) ||
        // No transcript record, but busy with the empty prompt on screen (session-status.ts).
        busyInBackground;
      const status: SessionStatus = result.hasMore ? 'connecting' : result.active
        ? observedSessionStatus(observedStatus && observedStatus !== 'unknown' ? observedStatus : watch.display.status,
          result.nativeStatus, result.session.status === 'error', delegated) : 'idle';
      watch.snapshot = {
        workspaceId: watch.workspace.id, sessionId: watch.sessionId, paneId: result.session.paneId, panePid: result.panePid,
        transcriptPosition: result.transcriptPosition,
        pendingFork: this.backend.pendingFork?.(watch.workspace, watch.sessionId),
        activity, subagentsListed: listed || undefined,
        // The reply is done; background work Claude Code started still runs.
        background: status === 'idle' && result.active && !result.hasMore
          ? backgroundSummary(activity, pendingBackground, result.nativeStatus, result.nativeStartedAt, listed) ?? result.session.background : undefined,
        // What closing this conversation would stop, during or after a reply.
        backgroundWork: result.active && !result.hasMore ? backgroundCounts(activity, pendingBackground, result.nativeStatus, result.nativeStartedAt, listed) : undefined,
        lastCompact: result.hasMore ? undefined : watch.compactSamples.receipt(watch.display.activity.currentCompact), turnProgress,
        tasks: watch.nativeTasks ?? watch.display.tasks.list,
        messages, historyPage: historyPage(watch), screen: result.screen, viewport: result.viewport,
        // While the fast link runs, its captures are newer than this poll's.
        terminalFrame: watch.terminalLink && !watch.terminalLink.closed ? watch.snapshot.terminalFrame : result.terminalFrame, screenCapturedAt: result.screen ? result.screenCapturedAt ?? new Date().toISOString() : undefined,
        navigationStatus: result.session.status, navigationStatusDetail: result.session.statusDetail,
        nativeInputReady: !question && nativeInputReady, settingsInputReady: !question && settingsInputReady,
        question, questionBusy: !!watch.question?.consumed && !watch.question.unconfirmed, questionUnconfirmed: watch.question?.unconfirmed,
        permission, permissionBusy: !!watch.permission?.consumed && !watch.permission.unconfirmed, permissionUnconfirmed: watch.permission?.unconfirmed,
        turnControls: result.active && !result.directoryTrust && !question ? {
          running: !result.hasMore && !composerOverlap && result.nativeStatus !== 'waiting' && !!editor?.running && editor.empty,
          canStop: !settingBusy && !trustBusy && !watch.snapshot.terminalControl && !this.turnBusy && !rewind &&
            settingRevisionAtRead === this.settingRevision && canInterruptTurn(result.viewport ?? '', result.nativeStatus, editor),
          queued: result.hasMore ? [] : watch.display.nativeQueue(editor?.queued ?? []),
          rewind: result.hasMore ? undefined : rewind, restoredDraft: result.hasMore ? undefined : restoredDraft,
          draftOccupied: !result.hasMore && !composerOverlap && !!result.nativeStatus && !!editor && !editor.empty && !restoredDraft && !nativeInputReady && !editor.running,
          compacting: !!turnProgress?.compactPhase || undefined,
        } : undefined,
        // Registered Claude can report idle while its composer contains the slash draft.
        pendingSettingCommand: settingsPaneReady && !settingsInputReady && !settingsOverlap && !result.directoryTrust &&
          (result.session.status === 'unknown' || result.session.status === 'idle') && result.viewport ?
          (['model', 'effort'] as const).find(kind => focusedSettingCommandHistory(result.viewport!, `/${kind}`) !== undefined) : undefined,
        settingBusy,
        trustBusy, terminalControl: watch.snapshot.terminalControl,
        statusLineManaged, statusLine, endpointBilling: result.endpointBilling,
        settings: handle ? this.settingsCache.state(handle, this.catalogs.get(watch.workspace), statusLine) : undefined,
        executionMode: watch.settingsHandle ? this.executionModes.get(watch.settingsHandle) : undefined,
        executionModeLastObserved: !!watch.settingsHandle && !executionMode && this.executionModes.has(watch.settingsHandle),
        contextUsage: result.hasMore ? watch.snapshot.contextUsage : watch.display.contextUsage,
        cliVersion,
        directoryTrust: watch.manualRecovery || watch.snapshot.terminalControl ? result.directoryTrust : settingsOverlap ? watch.snapshot.directoryTrust : result.directoryTrust,
        status, notice: watch.display.notice,
      };
    } catch (error) {
      if (this.watch !== watch) { diagnostic.event('controller.poll.discarded', { reason: 'stale-watch-error', error: errorDetails(error) }); return; }
      if (this.trustOperation?.workspaceId === watch.workspace.id && this.trustOperation.sessionId === watch.sessionId) {
        // Selecting No can remove a startup pane before any JSONL exists. The
        // owning trust transaction verifies its exit; do not flash a disconnect.
        diagnostic.event('controller.poll.deferred', { reason: 'directory-trust-operation', error: errorDetails(error) }, 'warn');
      } else {
        watch.failures++;
        watch.question = undefined;
        watch.compactSamples.interrupt();
        this.revokeTerminalControl(watch, 'read-failed');
        const mapping = error instanceof Error && error.name === 'SessionMappingError';
        // SessionGoneError: no transcript and no live pane (Claude exited before
        // writing anything), so the pane binding goes too; a new chat waiting for
        // its first message then sees that Claude exited.
        if (mapping || (error instanceof Error && error.name === 'SessionGoneError')) {
          if (watch.settingsHandle) {
            this.settingsCache.invalidate(watch.settingsHandle);
            this.executionModes.delete(watch.settingsHandle);
            watch.settingsHandle = undefined;
          }
          watch.snapshot = { ...watch.snapshot, paneId: undefined, panePid: undefined,
            settings: undefined, executionMode: undefined, statusLine: undefined, statusLineManaged: undefined, nativeInputReady: false, settingsInputReady: false,
            directoryTrust: undefined, ...(mapping ? { navigationStatus: 'error' as const, navigationStatusDetail: (error as Error).message } : {}) };
        }
        watch.permission = undefined;
        // Unread, the process may still run: its subagents are not called interrupted.
        watch.live = error instanceof Error && error.name === 'SessionGoneError' ? 'gone' : 'unknown';
        const { activity, listed } = activityOf(watch, watch.snapshot.cliVersion);
        watch.snapshot = { ...watch.snapshot, question: undefined, questionBusy: undefined, questionUnconfirmed: undefined, permission: undefined, permissionBusy: undefined, permissionUnconfirmed: undefined, activity, subagentsListed: listed || undefined, turnProgress: undefined, turnControls: undefined, statusLine: undefined, endpointBilling: undefined, status: error instanceof Error && error.name === 'SessionMappingError' ? 'error' : 'offline', error: error instanceof Error ? error.message : String(error) };
        diagnostic.event('controller.poll.failed', { failures: watch.failures, error: errorDetails(error) }, 'warn');
      }
    }
    if (this.watch !== watch) return;
    this.publish(watch, 'poll', inactiveFilter);
    const soon = this.pollSoon, soonFresh = soon && this.pollSoonFresh;
    this.pollSoon = this.pollSoonFresh = false;
    if (this.background && !soon) {
      // Off screen: a running pane is read often enough to stay current; saved
      // history needs no reads until it is shown again.
      if (this.readsInBackground(watch)) this.schedulePoll(watch, watch.snapshot.status === 'working' ? 1500 : 5000);
      return;
    }
    const delay = soon ? 0 : watch.failures ? Math.min(15000, 1000 * 2 ** Math.min(watch.failures, 4))
      : watch.snapshot.status === 'connecting' ? 30 : watch.snapshot.paneId && watch.display.activity.active ? 180 : watch.snapshot.status === 'working' || watch.snapshot.terminalControl ? 250 : watch.snapshot.paneId ? 1000 : 5000;
    // A poll that started inside a picker can finish after the native menu closed.
    // Verify that waiting frame now so an actionable chooser needn't wait an idle interval.
    const stalePicker = settingRevisionAtRead !== this.settingRevision && !this.settingOperation && this.pickerMayStillBeVisible(watch);
    this.schedulePoll(watch, stalePicker ? 0 : delay, stalePicker || soonFresh);
    });
  }
  async answerQuestion(workspaceId: string, sessionId: string, paneId: string, panePid: number, token: string, action: QuestionAction) {
    const watch = this.watch;
    const current = watch?.question;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || !current || current.consumed ||
        current.snapshot.token !== token || current.handle.paneId !== paneId || current.handle.panePid !== panePid || watch.failures)
      throw new Error(t('controller.questionUpdated'));
    if (this.sending || watch.snapshot.terminalControl || this.trustOperation || this.settingOperation) throw new Error(t('controller.nativeInputBusy'));
    const assertCurrent = () => {
      if (this.watch !== watch || watch.failures || watch.settingsHandle !== current.handle || watch.question !== current || watch.snapshot.terminalControl)
        throw new Error(t('controller.questionOwnerChanged'));
    };
    assertCurrent();
    current.consumed = true;
    this.sending = this.turnBusy = true;
    this.settingRevision++;
    watch.snapshot = { ...watch.snapshot, questionBusy: true };
    this.publish(watch, 'question-start');
    try {
      await this.backend.answerQuestion(watch.workspace, sessionId, paneId, panePid, current.screen, action, current.handle, current.position, assertCurrent);
    } catch (error) {
      if (error instanceof QuestionInputUnconfirmed) current.unconfirmed = true;
      throw error;
    } finally {
      this.sending = this.turnBusy = false;
      this.settingRevision++;
      // 只有重新读取目标的原屏后，才为下一次点击签发 token。
      if (this.watch === watch) this.schedulePoll(watch, 0, true);
    }
  }
  async answerPermission(workspaceId: string, sessionId: string, paneId: string, panePid: number, token: string, action: PermissionAction) {
    const watch = this.watch;
    const current = watch?.permission;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || !current || current.consumed ||
        current.snapshot.token !== token || current.handle.paneId !== paneId || current.handle.panePid !== panePid || watch.failures)
      throw new Error(t('controller.permissionUpdated'));
    if (this.sending || watch.snapshot.terminalControl || this.trustOperation || this.settingOperation) throw new Error(t('controller.nativeInputBusy'));
    const assertCurrent = () => {
      if (this.watch !== watch || watch.failures || watch.settingsHandle !== current.handle || watch.permission !== current || watch.snapshot.terminalControl)
        throw new Error(t('controller.permissionOwnerChanged'));
    };
    assertCurrent();
    current.consumed = true;
    this.sending = this.turnBusy = true;
    this.settingRevision++;
    watch.snapshot = { ...watch.snapshot, permissionBusy: true };
    this.publish(watch, 'permission-start');
    try {
      await this.backend.answerPermission(watch.workspace, sessionId, paneId, panePid, current.screen, action, current.handle, current.position, assertCurrent);
    } catch (error) {
      if (error instanceof PermissionInputUnconfirmed) current.unconfirmed = true;
      throw error;
    } finally {
      this.sending = this.turnBusy = false;
      this.settingRevision++;
      // A new token is issued only after the target screen is read again.
      if (this.watch === watch) this.schedulePoll(watch, 0, true);
    }
  }
  async turnAction(workspaceId: string, sessionId: string, pane: string, pid: number, action: TurnAction) {
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || watch.failures ||
        watch.snapshot.paneId !== pane || watch.snapshot.panePid !== pid) throw new Error(t('controller.sessionOrTerminalChanged'));
    if (this.sending || this.trustOperation || this.settingOperation || watch.snapshot.terminalControl || watch.snapshot.directoryTrust || watch.question) throw new Error(t('controller.nativeInputBusyWait'));
    if (!action || typeof action !== 'object') throw new Error(t('controller.invalidTurnAction'));
    if ('text' in action) await this.assertSendable(workspaceId, action.text);
    const turnKey = this.recoveryKey(watch.workspace, sessionId);
    const currentMemory = this.turnMemory.get(turnKey);
    const memory: TurnMemory = currentMemory?.pane === pane && currentMemory.pid === pid ? currentMemory : {pane,pid};
    const menu = watch.snapshot.turnControls?.rewind;
    if ('signature' in action && (!memory.pickerOpen || menu?.signature !== action.signature)) throw new Error(t('controller.rewindMenuUpdated'));
    if (action.kind === 'sendRestored' && (!watch.snapshot.turnControls?.restoredDraft || watch.snapshot.turnControls.restoredDraft !== action.original)) throw new Error(t('controller.nativeDraftChanged'));
    this.sending = this.turnBusy = true;
    this.settingRevision++;
    try {
      let selectedUuid: string | undefined, target: RewindTarget | undefined, assertCurrent: (() => void) | undefined;
      if (action.kind === 'rewindTo' || action.kind === 'checkpoint' || action.kind === 'restore') {
        // The native index counts the whole active branch, never the current
        // JSONL page. Drain older pages before matching even a recent duplicate.
        while (watch.older) {
          if (this.watch !== watch) throw new Error(t('controller.rewindSwitched'));
          await this.loadEarlierMessages(workspaceId, sessionId, watch.older.ticket);
        }
        const users = () => watch.display.getMessages().filter(m => m.role === 'user' && m.rewindUuid);
        const branch = users();
        selectedUuid = action.kind === 'rewindTo' ? action.uuid : action.kind === 'restore' ? memory.checkpointUuid
          : menu && Number.isInteger(action.index) ? branch[(menu.before ?? 0) + action.index!]?.rewindUuid : undefined;
        const index = branch.findIndex(m => m.rewindUuid === selectedUuid);
        if (!selectedUuid || index < 0 || branch.filter(m => m.rewindUuid === selectedUuid).length !== 1 || watch.display.historyIncomplete)
          throw new Error(t('controller.rewindTargetUnverified'));
        target = { index, prompts: branch.map(m => m.text) };
        const position = watch.snapshot.transcriptPosition;
        assertCurrent = () => {
          if (this.watch !== watch || watch.failures || watch.snapshot.paneId !== pane || watch.snapshot.panePid !== pid ||
              (position && (position.inode !== watch.snapshot.transcriptPosition?.inode || position.offset !== watch.snapshot.transcriptPosition?.offset) &&
                JSON.stringify(users().map(m => [m.rewindUuid,m.text])) !== JSON.stringify(branch.map(m => [m.rewindUuid,m.text]))))
            throw new Error(t('controller.rewindBranchChanged'));
        };
        assertCurrent();
        if (action.kind === 'checkpoint' && menu) checkpointPosition(menu, target);
      }
      if (action.kind === 'openRewind' || action.kind === 'rewindTo') { memory.pickerOpen = true; memory.checkpointUuid = undefined; this.turnMemory.set(turnKey,memory); }
      const result = await this.backend.turnAction(watch.workspace,sessionId,pane,pid,action,target,assertCurrent,watch.snapshot.transcriptPosition);
      if (action.kind === 'checkpoint' || action.kind === 'rewindTo') memory.checkpointUuid = selectedUuid;
      if (action.kind === 'stop') {
        watch.compactSamples.interrupt();
        watch.display.markInterrupted();
        diagnostic.event('controller.interrupt', { watchId: watch.id, sessionId, reason: 'turn-stop', key: 'Escape' });
      }
      if (action.kind === 'restore' && (!result?.restoredDraft || !target || result.restoredDraft.replace(/\s+/gu,' ').trim() !== target.prompts[target.index].replace(/\s+/gu,' ').trim()))
        throw new Error(t('controller.restoreDraftUnchecked'));
      if (result?.restoredDraft) {
        const draft = result.restoredDraft;
        const uuid = watch.display.confirmNativeRewind(draft,action.kind === 'restore' ? memory.checkpointUuid : undefined);
        this.turnMemory.set(turnKey,{pane,pid,restoredDraft:draft,restoredUuid:uuid});
      }
      if (action.kind === 'sendRestored') this.turnMemory.delete(turnKey);
    } finally {
      this.sending = this.turnBusy = false;
      this.settingRevision++;
      if (this.watch === watch) this.schedulePoll(watch,0,true);
    }
  }
  /** Native slash commands by allow-list; installed skills and commands pass. */
  private async assertSendable(workspaceId: string, text: unknown) {
    if (typeof text !== 'string') return;
    const policy = commandPolicy(text);
    if (policy.kind === 'block') throw new Error(policy.message);
    if (policy.kind === 'route') throw new Error(t('controller.routedCommand', { name: policy.name, target: policy.target }));
    if (policy.kind !== 'installed') return;
    let installed = false;
    try { installed = await this.backend.completions.isInstalled(this.store.get(workspaceId), policy.name); }
    catch { throw new Error(t('controller.skillUnverified', { name: policy.name })); }
    if (!installed) throw new Error(t('controller.skillMissing', { name: policy.name }));
  }
  async sendMessage(workspaceId: string, sessionId: string, text: string): Promise<void> {
    if (this.watch?.snapshot.terminalControl) throw new Error(t('controller.endTakeoverFirst'));
    await this.assertSendable(workspaceId, text);
    if (this.watch?.question) throw new Error(t('controller.answerQuestionFirst'));
    if (this.sending) throw new Error(t('controller.previousInputSending'));
    const watch = this.watch;
    if (watch?.workspace.id === workspaceId && watch.sessionId === sessionId &&
        (watch.snapshot.turnControls?.rewind || watch.snapshot.turnControls?.restoredDraft || watch.snapshot.turnControls?.draftOccupied)) {
      throw new Error(t('controller.nativeComposerEditing'));
    }
    const recovering = watch?.workspace.id === workspaceId && watch.sessionId === sessionId && watch.snapshot.status === 'error';
    if (recovering && (!watch.snapshot.nativeInputReady || watch.snapshot.navigationStatus !== 'error' || !watch.snapshot.paneId)) {
      throw new Error(t('controller.errorPageNotReady'));
    }
    this.sending = true;
    const beforeUser = watch?.display.getMessages().filter(m => m.role === 'user').at(-1)?.id;
    const terminalResponse = watch?.snapshot.status === 'waiting';
    return diagnostic.operation('controller.send', { workspaceId, sessionId, watchId: watch?.id }, async () => {
    const inputCaptureId = diagnostic.capture('input', text, { terminalResponse });
    diagnostic.event('controller.input', { inputCaptureId, text: summarize(text), terminalResponse });
    try {
      const target = this.store.get(workspaceId);
      if (watch?.workspace.id === workspaceId && watch.sessionId === sessionId) watch.compactSamples.interrupt();
      // Typed native commands can change the selection outside the GUI pickers.
      // Evict before input so quitting between Enter and the next poll is safe.
      if (typeof text === 'string' && /^\/(?:model|effort|config|settings|resume|clear)(?:\s|$)/i.test(text.trimStart())) {
        this.settingsCache.observe(sessionSettingsTarget(target), sessionId, undefined, false);
        if (watch?.workspace.id === workspaceId && watch.sessionId === sessionId) {
          watch.settingsHandle = undefined;
          this.settingRevision++;
          watch.snapshot = { ...watch.snapshot, statusLine: undefined, settings: undefined };
        }
      }
      await this.backend.sendMessage(target, sessionId, text, recovering ? watch.snapshot.paneId : undefined);
      // Only reflect a successful transport. Failed SSH commands are never replayed automatically.
      if (!terminalResponse && watch && this.watch === watch && watch.workspace.id === workspaceId && watch.sessionId === sessionId) {
        const nativeCommand = /^\/(compact|rename)(?:\s|$)/.exec(text.trimStart());
        if (nativeCommand) {
          // Local command feedback cannot acknowledge an optimistic chat turn.
          diagnostic.event('controller.optimistic_user.skipped', { reason: 'native-' + nativeCommand[1], inputCaptureId });
          if (this.timer) this.schedulePoll(watch, 0, true);
          return;
        }
        if (watch.manualRecovery) {
          watch.manualRecovery = false; this.manualRecoveries.delete(this.recoveryKey(watch.workspace, watch.sessionId)); this.settingRevision++;
        }
        const afterUser = watch.display.getMessages().filter(m => m.role === 'user').at(-1);
        if (!(afterUser && afterUser.id !== beforeUser && afterUser.text.trim() === text.trim())) {
          watch.display.optimisticUser(text);
          diagnostic.event('controller.optimistic_user', { inputCaptureId, text: summarize(text) });
        } else diagnostic.event('controller.optimistic_user.skipped', { reason: 'canonical-user-already-arrived', userId: afterUser.id, inputCaptureId });
        watch.snapshot = { ...watch.snapshot, messages: watch.display.getMessages(), status: 'working', turnProgress: undefined, error: undefined };
        this.publish(watch, 'send');
        if (this.timer) this.schedulePoll(watch, 0);
      } else diagnostic.event('controller.optimistic_user.skipped', { reason: terminalResponse ? 'terminal-response' : 'watch-changed', inputCaptureId });
    } finally { this.sending = false; }
    });
  }
  async sendKey(workspaceId: string, sessionId: string, key: TerminalKey) {
    if (this.watch?.question) throw new Error(t('controller.useQuestionCard'));
    if (this.watch?.snapshot.terminalControl) throw new Error(t('controller.takeoverFocusTerminal'));
    if (this.settingOperation || this.trustOperation) throw new Error(t('controller.settingOrTrustBusy'));
    if (this.sending || this.turnBusy) throw new Error(t('controller.nativeInputOperating'));
    return diagnostic.operation('controller.key', { workspaceId, sessionId, watchId: this.watch?.id, key }, async () => {
    await this.backend.sendKey(this.store.get(workspaceId), sessionId, key);
    const watch = this.watch;
    if ((key === 'Escape' || key === 'C-c') && watch?.workspace.id === workspaceId && watch.sessionId === sessionId) {
      watch.display.markInterrupted();
      watch.compactSamples.interrupt();
      diagnostic.event('controller.interrupt', { watchId: watch.id, reason: 'explicit-key', key });
      watch.snapshot = { ...watch.snapshot, turnProgress: undefined, messages: watch.display.getMessages(), status: watch.display.status, notice: watch.display.notice };
      this.publish(watch, 'key');
    }
    });
  }
  private pickerMayStillBeVisible(watch: Watch): boolean {
    return !watch.failures && !!watch.snapshot.paneId && (watch.snapshot.status === 'waiting' || watch.snapshot.navigationStatus === 'waiting');
  }
  private async withSessionSetting<T>(workspaceId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
    const watch = this.watch;
    if (watch?.snapshot.terminalControl) throw new Error(t('controller.endTakeoverFirst'));
    if (this.sending) throw new Error(t('controller.previousInputOrSetting'));
    const canRecoverNativeError = watch?.snapshot.status === 'error' && watch.snapshot.navigationStatus === 'error';
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || !watch.snapshot.paneId || (watch.snapshot.status !== 'idle' && !canRecoverNativeError)) {
      throw new Error(t('controller.needIdleConnected'));
    }
    this.sending = true;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    this.settingOperation = { workspaceId, sessionId, finished };
    this.settingRevision++;
    watch.snapshot = { ...watch.snapshot, settingBusy: true };
    this.publish(watch, 'settings-start');
    return diagnostic.operation('controller.settings', { workspaceId, sessionId, watchId: watch.id }, async () => {
      try { return await action(); }
      finally {
        this.sending = false;
        this.settingOperation = undefined;
        finish();
        this.settingRevision++;
        if (this.watch === watch) {
          watch.snapshot = { ...watch.snapshot, settingBusy: false };
          this.publish(watch, 'settings-end');
          if (this.timer && this.pickerMayStillBeVisible(watch)) this.schedulePoll(watch, 0, true);
        } else if (this.watch?.snapshot.settingBusy) {
          this.watch.snapshot = { ...this.watch.snapshot, settingBusy: false };
          this.publish(this.watch, 'settings-end');
        }
      }
    });
  }
  private hydrateSettings(watch: Watch): void {
    if (this.watch !== watch || !watch.settingsHandle) return;
    watch.snapshot = { ...watch.snapshot, settings: this.settingsCache.state(watch.settingsHandle, this.catalogs.get(watch.workspace), watch.snapshot.statusLine) };
    this.publish(watch, 'settings-cache');
  }
  async getSessionSetting(workspaceId: string, sessionId: string, kind: SessionSettingKind): Promise<SessionSettingSnapshot> {
    const watch = this.watch, handle = watch?.settingsHandle;
    if (!watch || !handle || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId)
      throw new Error(t('controller.reopenMenu'));
    // An explicit open means this renderer still needs a snapshot. It may
    // have missed the original warmup publication while attaching its view.
    const alreadyPublished = watch.snapshot.settings?.menus[kind]?.token;
    await this.catalogs.read(watch.workspace);
    if (this.watch !== watch || watch.settingsHandle !== handle) throw new Error(t('controller.reopenMenu'));
    const settings = this.settingsCache.state(handle, this.catalogs.get(watch.workspace), watch.snapshot.statusLine);
    const menu = settings?.menus[kind];
    if (!menu) throw new Error(t('controller.reopenMenu'));
    if (alreadyPublished === menu.token || watch.snapshot.settings?.menus[kind]?.token !== menu.token) {
      watch.snapshot = { ...watch.snapshot, settings };
      this.publish(watch, 'settings-cache');
    }
    return menu;
  }
  setSessionSetting(workspaceId: string, sessionId: string, token: string, optionId: string, mode: SettingSwitchMode = 'inline') {
    const watch = this.watch, handle = watch?.settingsHandle;
    return this.withSessionSetting(workspaceId, sessionId, async () => {
      if (!watch || !handle || watch.failures || watch.snapshot.directoryTrust || !watch.snapshot.settingsInputReady)
        throw new Error(t('controller.confirmIdleEmpty'));
      const catalog = this.catalogs.get(watch.workspace);
      const menus = this.settingsCache.state(handle, catalog, watch.snapshot.statusLine)?.menus;
      const menu = Object.values(menus ?? {}).find(item => item.token === token);
      const index = menu?.options.findIndex(option => option.id === optionId && !option.disabled) ?? -1;
      const list = catalog?.catalog;
      if (!list || !menu || index < 0) throw new Error(t('controller.nativeMenuChanged'));

      // A GUI menu survives idle time. The short-lived native write ticket is
      // issued locally only when the user selects a choice, then consumed once.
      // The rows are this menu's rows in order, with the values Claude takes.
      const rows = menu.kind === 'model'
        ? list.models.map(row => ({ label: row.label, description: row.description, value: row.value }))
        : menu.options.map(option => ({ label: option.label, value: option.label }));
      const bound = this.backend.bindSettingChoices(watch.workspace, sessionId, handle.paneId, { kind: menu.kind, command: menu.command, complete: true, options: rows });
      const chosen = bound.options[index];
      if (!chosen || chosen.disabled || chosen.label !== menu.options[index].label) throw new Error(t('controller.choiceAmbiguous'));
      this.settingsCache.invalidateSelection(handle, menu.kind);
      try {
        const result = await this.backend.setSessionSetting(watch.workspace, sessionId, bound.token, chosen.id,
          { panePid: handle.panePid, instanceId: handle.instanceId }, mode);
        if (result.kind !== menu.kind || !this.settingsCache.rememberApplied(handle, result)) throw new Error(t('controller.processChangedConfirm'));
        // Reproject the verified acknowledgement so even a caller reusing the
        // returned menu gets the current GUI handles, never the native ticket.
        return this.settingsCache.state(handle, catalog, this.watch === watch ? watch.snapshot.statusLine : undefined)!.menus[menu.kind]!;
      } finally { this.hydrateSettings(watch); }
    });
  }
  setUltracode(workspaceId: string, sessionId: string, on: boolean) {
    const watch = this.watch, handle = watch?.settingsHandle;
    return this.withSessionSetting(workspaceId, sessionId, async () => {
      if (!watch || !handle || watch.failures || watch.snapshot.directoryTrust || !watch.snapshot.settingsInputReady)
        throw new Error(t('controller.confirmIdleEmpty'));
      try {
        const result = await this.backend.setUltracode(watch.workspace, sessionId, on, { panePid: handle.panePid, instanceId: handle.instanceId });
        this.settingsCache.rememberUltracode(handle, result.ultracode);
        return result.ultracode;
      } finally { this.hydrateSettings(watch); }
    });
  }
  getDirectoryTrust(workspaceId: string, sessionId: string) {
    return this.backend.getDirectoryTrust(this.store.get(workspaceId), sessionId);
  }
  async respondDirectoryTrust(workspaceId: string, sessionId: string, token: string, decision: DirectoryTrustDecision) {
    const watch = this.watch;
    if (watch?.snapshot.terminalControl) throw new Error(t('controller.takeoverUseNative'));
    if (this.sending) throw new Error(t('controller.previousInputOrNative'));
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || watch.snapshot.status !== 'waiting'
      || watch.snapshot.directoryTrust?.token !== token || !watch.snapshot.paneId) {
      throw new Error(t('controller.trustPromptChanged'));
    }
    this.sending = true;
    this.trustOperation = { workspaceId, sessionId };
    this.settingRevision++;
    watch.snapshot = { ...watch.snapshot, trustBusy: true };
    this.publish(watch, 'trust-start');
    let completed = false;
    return diagnostic.operation('controller.directory_trust', { workspaceId, sessionId, watchId: watch.id, decision }, async () => {
      try {
        const result = await this.backend.respondDirectoryTrust(this.store.get(workspaceId), sessionId, token, decision);
        completed = true;
        if (decision === 'exit' && this.watch === watch) this.unwatchSession();
        return result;
      } finally {
        this.sending = false;
        this.trustOperation = undefined;
        this.settingRevision++;
        if (this.watch === watch) {
          watch.snapshot = { ...watch.snapshot, trustBusy: false, directoryTrust: completed ? undefined : watch.snapshot.directoryTrust };
          this.publish(watch, 'trust-end');
        }
      }
    });
  }
  private recoveryKey(workspace: Workspace, sessionId: string): string {
    return JSON.stringify([sessionSettingsTarget(workspace), sessionId]);
  }
  /** Typing goes straight to tmux over one persistent shell; frames come back on it. */
  private async openTerminalLink(watch: Watch, control: TerminalControl) {
    const pid = watch.snapshot.panePid;
    if (!pid) return;
    try {
      const link = await this.backend.openTerminalLink(watch.workspace, control.paneId, pid, {
        onFrame: frame => {
          if (this.watch !== watch || watch.terminalLink !== link || watch.snapshot.terminalControl?.token !== control.token) return;
          watch.snapshot = { ...watch.snapshot, terminalFrame: frame };
          this.emit('terminal-frame', { workspaceId: watch.workspace.id, sessionId: watch.sessionId, frame });
        },
        onClosed: reason => {
          if (watch.terminalLink !== link) return;
          watch.terminalLink = undefined;
          // A changed pane ends the takeover; anything else falls back to per-command input.
          if (reason === 'pane' && this.watch === watch && watch.snapshot.terminalControl?.token === control.token) {
            this.revokeTerminalControl(watch, 'link-pane-changed');
            this.publish(watch, 'terminal-input-failed');
          }
        },
      });
      if (this.watch !== watch || watch.snapshot.terminalControl?.token !== control.token) { link.close(); return; }
      watch.terminalLink = link;
    } catch (error) {
      diagnostic.event('controller.terminal_link.unavailable', { watchId: watch.id, error: errorDetails(error) }, 'warn');
    }
  }
  private revokeTerminalControl(watch: Watch, reason: string): void {
    const link = watch.terminalLink;
    watch.terminalLink = undefined;
    link?.close();
    const control = watch.snapshot.terminalControl;
    if (!control) return;
    this.settingRevision++;
    if (watch.settingsHandle) {
      this.settingsCache.invalidate(watch.settingsHandle);
      this.executionModes.delete(watch.settingsHandle);
      watch.settingsHandle = undefined;
    }
    watch.snapshot = { ...watch.snapshot, terminalControl: undefined, settings: undefined, statusLine: undefined, executionMode: undefined };
    diagnostic.event('controller.terminal_control.revoked', { watchId: watch.id, workspaceId: watch.workspace.id,
      sessionId: watch.sessionId, paneId: control.paneId, token: control.token, reason });
  }
  async setTerminalControl(workspaceId: string, sessionId: string, enabled: boolean, token?: string): Promise<TerminalControl | undefined> {
    if (typeof enabled !== 'boolean') throw new Error(t('controller.invalidTakeover'));
    const watch = this.watch;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId) throw new Error(t('controller.takeoverSwitched'));
    if (this.sending || this.settingOperation || this.trustOperation) throw new Error(t('controller.previousInputOrNative'));
    if (!enabled) {
      if (!token || token !== watch.snapshot.terminalControl?.token) throw new Error(t('controller.takeoverExpired'));
      this.revokeTerminalControl(watch, 'user-release');
      this.publish(watch, 'terminal-control-end');
      return;
    }
    if (!watch.snapshot.paneId || watch.failures || watch.snapshot.status === 'connecting' || watch.snapshot.status === 'offline') {
      throw new Error(t('controller.needConnectedTerminal'));
    }
    if (watch.snapshot.terminalControl) return watch.snapshot.terminalControl;
    if (watch.terminalVisible === false) throw new Error(t('controller.terminalHidden'));
    const paneId = watch.snapshot.paneId, handle = watch.settingsHandle, epoch = watch.terminalEpoch;
    this.sending = true;
    return diagnostic.operation('controller.terminal_control.acquire', { workspaceId, sessionId, watchId: watch.id, paneId }, async () => {
      try {
        await this.backend.verifyTerminalPane(watch.workspace, sessionId, paneId, handle);
        if (this.watch !== watch || watch.failures || watch.terminalEpoch !== epoch || watch.snapshot.paneId !== paneId || watch.settingsHandle !== handle) throw new Error(t('controller.terminalChangedRetake'));
        // Keep the lifecycle handle so replacement of even a reused tmux pane
        // ID can revoke manual ownership on the first subsequent poll.
        if (watch.settingsHandle) this.settingsCache.invalidateSelection(watch.settingsHandle, 'model');
        const control = { token: randomUUID(), paneId };
        // Keep this turn JSONL-only even after release: unknown native dialogs
        // must not become assistant prose. A new regular chat send clears it.
        watch.manualRecovery = true;
        this.manualRecoveries.add(this.recoveryKey(watch.workspace, sessionId));
        this.settingRevision++;
        watch.question = undefined;
        watch.permission = undefined;
        watch.snapshot = { ...watch.snapshot, question: undefined, questionBusy: undefined, questionUnconfirmed: undefined, permission: undefined, permissionBusy: undefined, permissionUnconfirmed: undefined, terminalControl: control, statusLine: undefined,
          settings: handle ? this.settingsCache.state(handle, this.catalogs.get(watch.workspace), watch.snapshot.statusLine) : undefined };
        diagnostic.event('controller.terminal_control.acquired', { watchId: watch.id, sessionId, ...control });
        this.publish(watch, 'terminal-control-start');
        void this.openTerminalLink(watch, control);
        return control;
      } finally { this.sending = false; }
    });
  }
  async sendTerminalInput(workspaceId: string, sessionId: string, token: string, input: TerminalInput): Promise<void> {
    const watch = this.watch;
    const control = watch?.snapshot.terminalControl;
    if (!watch || watch.workspace.id !== workspaceId || watch.sessionId !== sessionId || !control || typeof token !== 'string' || token !== control.token) {
      throw new Error(t('controller.takeoverExpiredRetype'));
    }
    const link = watch.terminalLink;
    if (link && !link.closed) {
      // The fast path: validated, written in order, no round trip per key.
      this.backend.validateTerminalInput(input);
      link.send(input);
      return;
    }
    if (this.sending || this.settingOperation || this.trustOperation) throw new Error(t('controller.previousInputOrNative'));
    this.sending = true;
    return diagnostic.operation('controller.terminal_input', { workspaceId, sessionId, watchId: watch.id, token, paneId: control.paneId }, async () => {
      try {
        await this.backend.sendTerminalInput(watch.workspace, sessionId, input, control.paneId, watch.settingsHandle, () => {
          if (this.watch !== watch || watch.snapshot.terminalControl?.token !== token) throw new Error(t('controller.takeoverExpiredStale'));
        });
        // No optimistic user turn: this may be a menu response, slash command,
        // draft edit or tool approval. Only Claude's JSONL establishes a turn.
      } catch (error) {
        this.revokeTerminalControl(watch, 'input-failed');
        if (this.watch === watch) this.publish(watch, 'terminal-input-failed');
        throw error;
      } finally { this.sending = false; }
    });
  }
  async detach() {
    this.unwatchSession();
    this.catalogs.off('change', this.onCatalogChange);
    if (this.settingOperation) await this.settingOperation.finished;
    this.executionModes = new WeakMap();
    this.removeAllListeners();
  }
  async dispose() {
    await this.detach();
    this.settingsCache.dispose();
    await this.catalogs.dispose();
    await this.backend.dispose();
  }
}
