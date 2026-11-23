import type { SessionInfo, Workspace, WorkspaceDiscovery } from "../shared/types";

/** Reads of one machine share a lane; a slow folder on one machine (a large
 * local project) never holds up the folders of another. */
export function discoveryLane(workspace: Pick<Workspace, "kind" | "host" | "port">): string {
  if (workspace.kind === "ssh") return `ssh:${workspace.host ?? ""}:${workspace.port ?? ""}`;
  return "local";
}

export interface WorkspaceDiscoveryState {
  data?: WorkspaceDiscovery;
  loading: boolean;
  error?: string;
  updatedAt?: number;
  unreadSessionIds?: ReadonlySet<string>;
}
interface Request {
  id: string;
  generation: number;
  promise: Promise<WorkspaceDiscovery | undefined>;
  resolve(value: WorkspaceDiscovery | undefined): void;
}

/** Directory reads share a queue with a small limit per lane (machine); each
 * directory has one active read. */
export class WorkspaceDiscoveryCache {
  private readonly states = new Map<string, WorkspaceDiscoveryState>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, Request>();
  private readonly runningIds = new Set<string>();
  private readonly allRequests = new Set<Request>();
  private queue: Request[] = [];
  private readonly activeByLane = new Map<string, number>();
  private disposed = false;
  private readonly concurrency: number;
  constructor(
    private readonly discover: (id: string) => Promise<WorkspaceDiscovery | undefined>,
    private readonly onChange: (
      states: Record<string, WorkspaceDiscoveryState>,
    ) => void,
    private readonly options: {
      concurrency?: number;
      /** The lane (machine) of a directory; without it all share one lane. */
      lane?: (id: string) => string;
      onError?: (error: unknown, id: string) => void;
      onResult?: (result: WorkspaceDiscovery, id: string) => void;
    } = {},
  ) {
    this.concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
  }

  get(id: string) {
    return this.states.get(id);
  }
  snapshot() {
    return Object.fromEntries(this.states);
  }
  private publish() {
    if (!this.disposed) this.onChange(this.snapshot());
  }
  private generation(id: string) {
    return this.generations.get(id) ?? 0;
  }
  private advance(id: string) {
    this.generations.set(id, this.generation(id) + 1);
  }
  private isCurrent(request: Request) {
    return (
      !this.disposed &&
      request.generation === this.generation(request.id) &&
      this.pending.get(request.id) === request
    );
  }
  private settle(request: Request, value?: WorkspaceDiscovery) {
    request.resolve(value);
    this.allRequests.delete(request);
    if (this.pending.get(request.id) === request)
      this.pending.delete(request.id);
  }

  refresh(id: string): Promise<WorkspaceDiscovery | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const existing = this.pending.get(id);
    if (existing && this.isCurrent(existing)) return existing.promise;
    let resolve!: Request["resolve"];
    const promise = new Promise<WorkspaceDiscovery | undefined>((done) => {
      resolve = done;
    });
    const request = { id, generation: this.generation(id), promise, resolve };
    this.pending.set(id, request);
    this.allRequests.add(request);
    this.queue.push(request);
    this.states.set(id, { ...this.states.get(id), loading: true });
    this.publish();
    this.pump();
    return promise;
  }

  invalidate(id: string) {
    if (this.disposed) return;
    this.advance(id);
    this.states.delete(id);
    this.publish();
    this.pump();
  }
  forget(id: string) {
    this.invalidate(id);
  }
  applyRenamedSession(id: string, session: SessionInfo) {
    const entry = this.states.get(id);
    if (!entry) return;
    const data = entry.data;
    if (!data || !data.sessions.some(item => item.id === session.id)) {
      this.invalidate(id);
      void this.refresh(id);
      return;
    }
    this.patch(id, () => ({
      ...data,
      sessions: data.sessions.map(item => item.id === session.id
        ? { ...item, title: session.title, titleSource: session.titleSource }
        : item),
    }));
  }
  patch(
    id: string,
    update: (data: WorkspaceDiscovery | undefined) => WorkspaceDiscovery,
  ) {
    if (this.disposed) return;
    const data = update(this.states.get(id)?.data);
    this.advance(id);
    this.states.set(id, { data, loading: false, updatedAt: Date.now() });
    this.publish();
    this.pump();
  }

  private pump() {
    if (this.disposed) return;
    this.queue = this.queue.filter((request) => {
      if (this.isCurrent(request)) return true;
      this.settle(request);
      return false;
    });
    for (let index = 0; index < this.queue.length; ) {
      const request = this.queue[index], lane = this.options.lane?.(request.id) ?? "";
      if (this.runningIds.has(request.id) || (this.activeByLane.get(lane) ?? 0) >= this.concurrency) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      this.activeByLane.set(lane, (this.activeByLane.get(lane) ?? 0) + 1);
      this.runningIds.add(request.id);
      void this.execute(request, lane);
    }
  }

  private async execute(request: Request, lane: string) {
    try {
      let result = await this.discover(request.id);
      // A folder or binding change can supersede a scan even when the view hasn't changed.
      if (!result && this.isCurrent(request)) result = await this.discover(request.id);
      if (this.isCurrent(request)) {
        if (result) this.options.onResult?.(result, request.id);
        this.states.set(request.id, {
          // If the retry was also superseded, keep the list until the next scheduled read.
          ...(result ? { data: result } : this.states.get(request.id)),
          loading: false,
          updatedAt: Date.now(),
        });
        this.publish();
        this.settle(request, result);
      } else this.settle(request);
    } catch (error) {
      if (this.isCurrent(request)) {
        this.states.set(request.id, {
          ...this.states.get(request.id),
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        });
        this.publish();
        try {
          this.options.onError?.(error, request.id);
        } catch {
          /* Diagnostics must not stop the queue. */
        }
      }
      this.settle(request);
    } finally {
      const active = (this.activeByLane.get(lane) ?? 1) - 1;
      if (active > 0) this.activeByLane.set(lane, active);
      else this.activeByLane.delete(lane);
      this.runningIds.delete(request.id);
      this.pump();
    }
  }

  dispose() {
    this.disposed = true;
    for (const request of this.allRequests) request.resolve(undefined);
    this.allRequests.clear();
    this.pending.clear();
    this.queue = [];
  }
}

/**
 * Which folders to read now, with at most `slots` reads per lane (machine).
 * Folders never read come first, those on screen (an open chat's folder or an
 * expanded one) ahead of the rest; then refreshes, longest overdue first (on
 * screen first when equally due). Equal ones keep the sidebar order. On-screen and live folders refresh every 5 s,
 * others every 30 s, failed ones every minute.
 */
export function plannedReads(workspaces: readonly Workspace[], state: (id: string) => WorkspaceDiscoveryState | undefined,
  { now, slots, expanded, visible, focus }: { now: number; slots: number; expanded: ReadonlySet<string>; visible: boolean; focus: readonly string[] }): string[] {
  const free = new Map<string, number>(), due: { id: string; lane: string; at: number; shown: boolean }[] = [];
  for (const workspace of workspaces) {
    const lane = discoveryLane(workspace), entry = state(workspace.id);
    if (!free.has(lane)) free.set(lane, slots);
    if (entry?.loading) { free.set(lane, free.get(lane)! - 1); continue; }
    const shown = focus.includes(workspace.id) || visible && expanded.has(workspace.id);
    const live = entry?.data?.sessions.some(session => session.paneId);
    const interval = entry?.error ? 60000 : live || shown ? 5000 : 30000;
    const at = entry?.updatedAt ? entry.updatedAt + interval : 0;
    if (at <= now) due.push({ id: workspace.id, lane, at, shown });
  }
  const rank = (item: typeof due[number]) => [item.at ? 1 : 0, item.at, item.shown ? 0 : 1];
  due.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const ids: string[] = [];
  for (const item of due) {
    const left = free.get(item.lane)!;
    if (left <= 0) continue;
    free.set(item.lane, left - 1);
    ids.push(item.id);
  }
  return ids;
}
