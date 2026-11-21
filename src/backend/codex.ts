import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import type { CodexDecision, CodexThread, CodexThreadSummary, CodexWorkspace } from '../shared/codex';
import { t } from '../shared/i18n';
import { array, CodexAppServer, CodexRpcError, object, requestId, string, type CodexObject, type CodexProcessOptions, type RequestId } from './codex-app-server';

type Message = CodexThread['messages'][number];
type Approval = CodexThread['approvals'][number];
type SavedThread = Omit<CodexThreadSummary, 'status'> & { cwd: string };
type OwnedThread = SavedThread & { saved: boolean };
type PendingApproval = Approval & { requestId: RequestId; method: string; params: CodexObject };
type LiveThread = {
  server: CodexAppServer;
  owner: OwnedThread;
  messages: Map<string, Message>;
  patches: Map<string, string>;
  approvals: Map<string, PendingApproval>;
  start?: Promise<void>;
  acceptStart?: () => Promise<void>;
  starting?: boolean;
  turnId?: string;
  completedTurnId?: string;
  error?: string;
};

const detailLimit = 64 * 1024;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const titleFrom = (input: string) => [...input.trim().replace(/\s+/gu, ' ')].slice(0, 100).join('');
const approvalKey = (id: RequestId) => JSON.stringify(id);
const patchKey = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId]);
const safeDetail = (text: string) => text.length <= detailLimit && !/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(text);

function message(value: unknown): Message | undefined {
  const item = object(value), id = string(item.id);
  if (!id) return;
  if (item.type === 'agentMessage' && typeof item.text === 'string') return { id, role: 'assistant', text: item.text };
  if (item.type === 'userMessage') {
    const text = array(item.content).map(object).filter(part => part.type === 'text').map(part => string(part.text)).join('\n');
    if (text) return { id, role: 'user', text };
  }
}

function filePatch(item: CodexObject): string | undefined {
  const changes = array(item.changes);
  if (!changes.length) return;
  const parts = [];
  let size = 0;
  for (const value of changes) {
    const change = object(value), kind = object(change.kind);
    const path = string(change.path), action = string(kind.type);
    if (!path || /[\r\n]/u.test(path) || !['add', 'delete', 'update'].includes(action) || typeof change.diff !== 'string') return;
    const dest = string(kind.move_path);
    if (/[\r\n]/u.test(dest)) return;
    const part = `${action} ${path}${dest ? ` → ${dest}` : ''}\n${change.diff}`;
    size += part.length + 2;
    if (size > detailLimit || !safeDetail(part)) return;
    parts.push(part);
  }
  return parts.join('\n\n');
}

/** A private stdio bridge for Codex chats created by Lectern on this computer. */
export class CodexBackend {
  private readonly owned = new Map<string, OwnedThread>();
  private readonly live = new Map<string, LiveThread>();
  private readonly loading = new Map<string, Promise<LiveThread>>();
  private indexRead?: Promise<void>;
  private indexWrite: Promise<void> = Promise.resolve();
  private connection?: { server: CodexAppServer; ready: Promise<void> };
  private disposed = false;

  constructor(private readonly indexPath: string, private readonly options: CodexProcessOptions = {}) {}

  async list(cwd: string): Promise<CodexWorkspace> {
    this.validPath(cwd);
    await this.loadIndex();
    return { threads: [...this.owned.values()].filter(row => row.cwd === cwd).map(row => this.summary(row)) };
  }

  async read(cwd: string, threadId: string): Promise<CodexThread> {
    return this.snapshot(await this.getThread(cwd, threadId));
  }

  async create(cwd: string): Promise<CodexThread> {
    this.validPath(cwd);
    await this.loadIndex();
    const server = await this.getServer();
    const result = await server.request('thread/start', { cwd, ephemeral: false, approvalsReviewer: 'user' });
    const record = this.verifyThread(result, cwd);
    const id = string(record.id);
    if (this.owned.has(id)) throw new Error('Codex returned an existing thread ID for a new chat.');
    this.verifyServer(server);
    // Codex only writes a new rollout once the first message starts. An empty
    // draft can be shown now, but cannot be restored after the server exits.
    const owner = { cwd, id, title: '', updatedAt: Date.now(), saved: false };
    this.owned.set(id, owner);
    return this.snapshot(this.attach(server, owner));
  }

  async send(cwd: string, threadId: string, text: string): Promise<void> {
    if (typeof text !== 'string' || !text.trim() || text.length > 200_000) throw new Error('Invalid Codex message.');
    const thread = await this.getThread(cwd, threadId);
    if (thread.start || thread.starting || thread.turnId) throw new Error('Codex is already responding in this chat.');
    thread.start = this.startTurn(thread, text);
    try { await thread.start; }
    finally { thread.start = undefined; }
  }

  async interrupt(cwd: string, threadId: string): Promise<void> {
    const thread = await this.getThread(cwd, threadId);
    if (!thread.turnId) await thread.start;
    if (thread.turnId) await thread.server.request('turn/interrupt', { threadId, turnId: thread.turnId });
  }

  async answer(cwd: string, threadId: string, approvalId: string, decision: CodexDecision): Promise<void> {
    if (decision !== 'accept' && decision !== 'decline') throw new Error('Invalid Codex approval decision.');
    const thread = await this.getThread(cwd, threadId);
    const pending = [...thread.approvals.values()].find(request => request.id === approvalId);
    if (!pending) throw new Error('This Codex approval is no longer pending.');
    thread.approvals.delete(approvalKey(pending.requestId));
    await thread.server.result(pending.requestId, { decision });
  }

  hasActiveTurns(): boolean {
    return [...this.live.values()].some(thread => thread.starting || thread.turnId || thread.approvals.size);
  }

  dispose(): void {
    this.disposed = true;
    this.connection?.server.close();
  }

  private validPath(cwd: string): void {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw new Error('Invalid Codex workspace.');
  }

  private loadIndex(): Promise<void> {
    return this.indexRead ??= (async () => {
      let contents: string;
      try { contents = await readFile(this.indexPath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const index = object(JSON.parse(contents));
      if (index.version !== 1 || !Array.isArray(index.threads)) throw new Error('Invalid Lectern Codex chat index.');
      for (const value of index.threads) {
        const row = object(value);
        if (typeof row.cwd !== 'string' || !isAbsolute(row.cwd) || typeof row.id !== 'string' || !row.id ||
          typeof row.title !== 'string' || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) {
          throw new Error('Invalid Lectern Codex chat index entry.');
        }
        this.owned.set(row.id, { cwd: row.cwd, id: row.id, title: row.title, updatedAt: row.updatedAt, saved: true });
      }
    })();
  }

  private saveIndex(): Promise<void> {
    this.indexWrite = this.indexWrite.catch(() => {}).then(async () => {
      const threads = [...this.owned.values()].filter(row => row.saved).map(({ cwd, id, title, updatedAt }) => ({ cwd, id, title, updatedAt }));
      await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
      const staging = this.indexPath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(staging, JSON.stringify({ version: 1, threads }), { mode: 0o600, flag: 'wx', flush: true });
        await rename(staging, this.indexPath);
      } finally { await rm(staging, { force: true }).catch(() => {}); }
    });
    return this.indexWrite;
  }

  private summary({ id, title, updatedAt }: OwnedThread): CodexThreadSummary {
    const live = this.live.get(id);
    const status = live?.approvals.size ? 'waiting' : live?.turnId || live?.starting ? 'working' : live?.error ? 'error' : 'idle';
    return { id, title, updatedAt, status };
  }

  private snapshot(thread: LiveThread): CodexThread {
    return { ...this.summary(thread.owner), messages: [...thread.messages.values()],
      approvals: [...thread.approvals.values()].map(({ id, title, detail }) => ({ id, title, detail })), error: thread.error };
  }

  private verifyServer(server: CodexAppServer): void {
    if (this.disposed || this.connection?.server !== server) throw new Error('Codex App Server disconnected.');
  }

  private verifyThread(result: CodexObject, cwd: string, id?: string): CodexObject {
    const record = object(result.thread), paths = [string(result.cwd), string(record.cwd)].filter(Boolean);
    if (!string(record.id) || (id && record.id !== id) || !paths.length || paths.some(path => !isAbsolute(path) || relative(cwd, path))) {
      throw new Error('Codex returned a chat outside the requested workspace.');
    }
    return record;
  }

  private async getServer(): Promise<CodexAppServer> {
    if (this.disposed) throw new Error('Codex App Server is closed.');
    if (!this.connection) {
      const server = new CodexAppServer(this.options,
        (method, params, id) => this.receive(server, method, params, id), error => this.disconnected(server, error));
      const ready = server.connect().catch(error => { server.close(error); throw error; });
      this.connection = { server, ready };
    }
    const { server, ready } = this.connection;
    await ready;
    this.verifyServer(server);
    return server;
  }

  private disconnected(server: CodexAppServer, error: Error): void {
    if (this.connection?.server !== server) return;
    this.connection = undefined;
    for (const [id, thread] of this.live) {
      if (thread.server !== server) continue;
      if (thread.starting || thread.turnId || thread.approvals.size) thread.error = error.message;
      thread.starting = false;
      thread.acceptStart = undefined;
      thread.turnId = undefined;
      thread.approvals.clear();
      if (!thread.owner.saved) { this.owned.delete(id); this.live.delete(id); }
    }
  }

  private async getThread(cwd: string, threadId: string): Promise<LiveThread> {
    this.validPath(cwd);
    await this.loadIndex();
    const owner = typeof threadId === 'string' ? this.owned.get(threadId) : undefined;
    if (!owner || owner.cwd !== cwd) throw new Error('Codex chat is unavailable in this workspace.');
    const live = this.live.get(owner.id);
    if (live && !this.disposed && this.connection?.server === live.server) return live;
    let loading = this.loading.get(owner.id);
    if (!loading) {
      loading = this.restore(owner).finally(() => this.loading.delete(owner.id));
      this.loading.set(owner.id, loading);
    }
    return loading;
  }

  private attach(server: CodexAppServer, owner: OwnedThread): LiveThread {
    const thread: LiveThread = { server, owner, messages: new Map(), patches: new Map(), approvals: new Map() };
    this.live.set(owner.id, thread);
    return thread;
  }

  private async restore(owner: OwnedThread): Promise<LiveThread> {
    const server = await this.getServer();
    const { cwd, id: threadId } = owner;
    const result = await server.request('thread/resume', { cwd, threadId, excludeTurns: true, approvalsReviewer: 'user' });
    const record = this.verifyThread(result, cwd, threadId);
    let turns = array(record.turns);
    let cursor = string(result.turnsBackwardsCursor);
    const seen = new Set<string>();
    const pages: unknown[][] = [];
    try {
      do {
        if (seen.has(cursor)) throw new Error('Codex returned a repeated history cursor.');
        seen.add(cursor);
        const page = await server.request('thread/turns/list', { threadId, cursor: cursor || undefined, limit: 16, itemsView: 'full', sortDirection: 'desc' });
        if (!Array.isArray(page.data)) throw new Error('Codex returned invalid chat history.');
        pages.push([...page.data].reverse());
        cursor = string(page.nextCursor);
      } while (cursor);
      turns = pages.reverse().flat();
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code !== -32601) throw error;
      // Older Codex supports full history directly on thread/resume.
      if (!turns.length) {
        const legacy = await server.request('thread/resume', { cwd, threadId, approvalsReviewer: 'user' });
        turns = array(this.verifyThread(legacy, cwd, threadId).turns);
      }
    }
    this.verifyServer(server);
    const priorError = this.live.get(owner.id)?.error;
    const thread = this.attach(server, owner);
    thread.error = priorError;
    for (const turn of turns) {
      for (const item of array(object(turn).items)) {
        const value = message(item);
        if (value) thread.messages.set(value.id, value);
      }
    }
    return thread;
  }

  private async startTurn(thread: LiveThread, text: string): Promise<void> {
    this.verifyServer(thread.server);
    const owner = thread.owner, clientUserMessageId = randomUUID();
    thread.messages.set(clientUserMessageId, { id: clientUserMessageId, role: 'user', text });
    thread.starting = true;
    thread.error = undefined;
    let saved: Promise<void> | undefined;
    const accept = () => {
      if (saved) return saved;
      thread.acceptStart = undefined;
      if (!owner.title) owner.title = titleFrom(text);
      owner.updatedAt = Date.now();
      owner.saved = true;
      return saved = this.saveIndex().catch(error => {
        thread.error = `Could not save the Codex chat index. ${errorText(error)}`;
      });
    };
    thread.acceptStart = accept;
    let accepted: CodexObject;
    try {
      const result = await thread.server.request('turn/start', {
        threadId: owner.id, clientUserMessageId, input: [{ type: 'text', text, text_elements: [] }],
      });
      accepted = object(result.turn);
      if (!string(accepted.id)) throw new Error('Codex did not return a turn ID.');
    } catch (error) {
      // turn/started may have already confirmed the request before its reply
      // was lost. Keep the accepted message and its ownership record.
      if (saved) { await saved; return; }
      if (error instanceof CodexRpcError && !thread.turnId && thread.starting) {
        thread.starting = false;
        thread.acceptStart = undefined;
        thread.messages.delete(clientUserMessageId);
      }
      // A transport failure may follow actual acceptance. Never retry a send
      // automatically or let a second send begin while its state is uncertain.
      thread.error = errorText(error);
      throw error;
    }
    thread.starting = false;
    const turnId = string(accepted.id);
    if (turnId !== thread.completedTurnId && this.connection?.server === thread.server) thread.turnId = turnId;
    await accept();
  }

  private receive(server: CodexAppServer, method: string, params: CodexObject, id?: RequestId): void {
    if (this.connection?.server !== server) return;
    const thread = this.live.get(string(params.threadId));
    if (id !== undefined) {
      const known = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
      if (known) {
        if (thread?.server === server && this.matchesTurn(thread, string(params.turnId))) {
          const approval = this.approval(thread, method, params, id);
          if (approval) { thread.approvals.set(approvalKey(id), approval); return; }
        }
        void server.result(id, { decision: 'decline' }).catch(() => {});
      } else void server.reject(id).catch(() => {});
      return;
    }
    if (!thread || thread.server !== server) return;
    if (method === 'serverRequest/resolved' && requestId(params.requestId)) thread.approvals.delete(approvalKey(params.requestId));
    const turn = object(params.turn), turnId = string(turn.id) || string(params.turnId);
    if (!this.matchesTurn(thread, turnId)) return;
    switch (method) {
      case 'turn/started':
        thread.turnId = turnId;
        void thread.acceptStart?.();
        return;
      case 'turn/completed':
        for (const item of array(turn.items)) this.writeAssistant(thread, item);
        thread.turnId = undefined;
        thread.starting = false;
        thread.completedTurnId = turnId;
        thread.approvals.clear();
        thread.patches.clear();
        if (turn.status === 'failed') thread.error = string(object(turn.error).message) || 'Codex turn failed.';
        return;
      case 'item/started': {
        const item = object(params.item);
        if (item.type === 'fileChange') this.updatePatch(thread, turnId, string(item.id), item);
        return;
      }
      case 'item/fileChange/patchUpdated': {
        this.updatePatch(thread, turnId, string(params.itemId), params);
        return;
      }
      case 'item/agentMessage/delta': {
        const itemId = string(params.itemId);
        if (!itemId || typeof params.delta !== 'string') return;
        const text = (thread.messages.get(itemId)?.text ?? '') + params.delta;
        thread.messages.set(itemId, { id: itemId, role: 'assistant', text });
        return;
      }
      case 'item/completed':
        this.writeAssistant(thread, params.item);
        return;
      case 'error':
        if (params.willRetry === false) thread.error = string(object(params.error).message) || 'Codex turn failed.';
        return;
    }
  }

  private matchesTurn(thread: LiveThread, turnId: string): boolean {
    return !!turnId && turnId !== thread.completedTurnId && (thread.turnId ? turnId === thread.turnId : !!thread.starting);
  }

  private writeAssistant(thread: LiveThread, item: unknown): void {
    const value = message(item);
    if (value?.role === 'assistant') thread.messages.set(value.id, value);
  }

  private updatePatch(thread: LiveThread, turnId: string, itemId: string, item: CodexObject): void {
    const key = patchKey(turnId, itemId), patch = filePatch(item);
    if (patch === thread.patches.get(key)) return;
    if (patch) thread.patches.set(key, patch); else thread.patches.delete(key);
    for (const [approvalId, previous] of thread.approvals) {
      if (previous.method !== 'item/fileChange/requestApproval' || previous.params.itemId !== itemId) continue;
      const current = this.approval(thread, previous.method, previous.params, previous.requestId);
      if (current) thread.approvals.set(approvalId, current);
      else {
        thread.approvals.delete(approvalId);
        void thread.server.result(previous.requestId, { decision: 'decline' }).catch(() => {});
      }
    }
  }

  private approval(thread: LiveThread, method: string, params: CodexObject, id: RequestId): PendingApproval | undefined {
    let title: string, detail: string;
    if (method === 'item/commandExecution/requestApproval') {
      if (params.kind && params.kind !== 'command') return;
      if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')) return;
      const network = object(params.networkApprovalContext);
      if (params.networkApprovalContext) {
        const host = string(network.host), protocol = string(network.protocol);
        if (!host || !protocol) return;
        title = t('codex.approvalNetwork');
        detail = `${protocol} ${host}`;
      } else {
        const command = string(params.command), cwd = string(params.cwd);
        if (!command || !cwd || /[\r\n]/u.test(cwd)) return;
        title = t('codex.approvalCommand');
        detail = `${cwd}\n\n${command}`;
      }
    } else {
      if (params.grantRoot) return;
      const patch = thread.patches.get(patchKey(string(params.turnId), string(params.itemId)));
      if (!patch) return;
      title = t('codex.approvalFiles');
      detail = patch;
    }
    const reason = string(params.reason);
    if (reason) detail += '\n\n' + reason;
    if (!safeDetail(detail)) return;
    return { id: randomUUID(), title, detail, requestId: id, method, params };
  }
}
