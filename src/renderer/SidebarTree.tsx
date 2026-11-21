import { useId, useMemo, useState, type ReactNode } from "react";
import { workspaceMachines, type WorkspaceMachine } from "./workspace-machines";
import { Laptop, FolderPlus, LogIn } from "lucide-react";
import "./machine-tree.css";
import { archiveKey, beginChatDrag, endChatDrag, moveProject, orderProjects, setDesktop, useDesktopState, workspaceDragType, type SidebarSortMode } from "./desktop-state";
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";
import type { SessionInfo, SessionSnapshot, Workspace } from "../shared/types";
import { SessionRenameDialog } from "./SessionRenameDialog";
import type { WorkspaceDiscoveryState } from "./workspace-discovery-cache";
import { aggregateSidebarState, compareSidebarSessions, sessionSidebarState } from "./sidebar-status";
import { showContextMenu } from "./ContextMenu";
import { folderMenu, machineMenu, sessionMenu, type SidebarMenuActions } from "./sidebar-menus";
import { HoverPrefetch } from "./sidebar-prefetch";
import { useMachineConnections, type MachineConnection } from "./ssh-machines";
import { hostMissing, useHostTools } from "./host-tools";
import { isMissingToolsError, toolList } from "../shared/host-tools";
import { needsSshLogin } from "./ssh-login";
import { t } from '../shared/i18n';

const initialSessions = 5, moreSessions = 10;
const sortLabels = { recent: 'sidebar.sortRecent', priority: 'sidebar.sortPriority' } as const;

export function SidebarSortButton({ mode }: { mode: SidebarSortMode }) {
  const label = t('sidebar.sortConversations');
  const current = t(sortLabels[mode]);
  return <button type="button" className="icon-button" aria-label={label} aria-description={current}
    aria-haspopup="menu" title={t('sidebar.sortCurrent', { mode: current })}
    onClick={event => showContextMenu(event, (['recent', 'priority'] as const).map(sort => ({
      label: t(sortLabels[sort]), icon: sort === mode ? <Check size={14} /> : undefined,
      onSelect: () => setDesktop({ sidebarSort: sort }),
    })), label)}>
    <ArrowDownWideNarrow size={15} aria-hidden="true" />
  </button>;
}

function MachineSection({ machine, searchOpen, demo, add, login, menu, connection, onNavigate, onOpen, children }: {
  machine: WorkspaceMachine; searchOpen: boolean; demo: boolean; add(): void; login?(): void; menu?: SidebarMenuActions;
  connection?: MachineConnection; onNavigate?(): void; onOpen?(): void; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const open = !collapsed || searchOpen;
  const id = useId();
  const remote = machine.endpoint.kind === "ssh";
  const address = remote ? `${machine.endpoint.host}${machine.endpoint.port ? `:${machine.endpoint.port}` : ""}` : undefined;
  const problem = remote && (connection?.state === "login" || connection?.state === "unreachable" || connection?.state === "unsupported") ? connection : undefined;
  // A machine without tmux or Claude Code (see host-tools.ts) is marked like a connection problem.
  const lacks = hostMissing(useHostTools()(machine.endpoint));
  return <section className="machine-section" aria-label={machine.name} data-machine-key={machine.key} data-connection={remote ? connection?.state : undefined}
    data-missing-tools={lacks.join(" ") || undefined}>
    <div className="machine-heading" onContextMenu={menu && (event => showContextMenu(event, machineMenu(machine, { ...menu, addFolder: () => { setCollapsed(false); add(); } }), machine.name))}>
      <button type="button" className="machine-toggle" aria-expanded={open} aria-controls={id}
        aria-label={t('sidebar.collapseMachine', { open: String(open), name: machine.name })} title={t(open ? 'sidebar.collapse' : 'sidebar.expand')}
        onClick={() => { setCollapsed(open); onNavigate?.(); }}>
        {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
      </button>
      <button type="button" className="machine-open" aria-label={t('sidebar.newChatOnMachine', { name: machine.name })}
        title={[address || machine.name, problem?.message, t(machine.folders.length ? 'sidebar.clickNewChat' : 'sidebar.clickAddFolder')].filter(Boolean).join("\n")}
        onClick={() => { setCollapsed(false); onNavigate?.(); onOpen?.(); }}>
        {remote ? <Server size={15}/> : <Laptop size={15}/>}<strong>{machine.name}</strong>
        {problem && <span className={`machine-connection state-${problem.state}`}>{t(problem.state === "login" ? 'sidebar.stateLogin' : problem.state === "unsupported" ? 'sidebar.stateUnsupported' : 'sidebar.stateOffline')}</span>}
        {!problem && lacks.length > 0 && <span className="machine-connection state-missing" title={t('hostTools.badgeTitle', { tools: toolList(lacks) })}>{t('hostTools.badge')}</span>}
      </button>
      {remote && login && <button type="button" className="icon-button machine-login" aria-label={t('sidebar.login', { name: machine.name })} data-attention={!!problem || undefined}
        title={t('sidebar.loginTitle')} disabled={demo} onClick={login}><LogIn size={15}/></button>}
      <button type="button" className="icon-button machine-add" aria-label={t('sidebar.addFolderOn', { name: machine.name })}
        title={t('sidebar.addFolder')} disabled={demo} onClick={() => { setCollapsed(false); add(); }}><FolderPlus size={15}/></button>
    </div>
    {open && <div className="machine-folders" id={id}>
      {children}
      {!machine.folders.length && <span className="machine-empty">{t('sidebar.noFolders')}</span>}
    </div>}
  </section>;
}

const hoverPrefetch = new HoverPrefetch((workspaceId, sessionId) => {
  void window.desktop.prefetchSession?.(workspaceId, sessionId).catch(() => { /* Opening reads it normally. */ });
});

export function SidebarTree({
  workspaces,
  platform,
  onAddFolder,
  states,
  expanded,
  workspaceId,
  sessionId,
  snapshot,
  otherSnapshot,
  busy,
  demo,
  onToggle,
  onSelect,
  onRename,
  onRefresh,
  onNew,
  onEdit,
  onLogin,
  onNavigateMachine,
  onOpenMachine,
  onOpenDraft,
  draftWorkspaceId,
  onScanHistory,
  menuActions,
  filter = "",
}: {
  workspaces: Workspace[];
  platform: string;
  onAddFolder(machine: WorkspaceMachine): void;
  states: Record<string, WorkspaceDiscoveryState>;
  expanded: Set<string>;
  workspaceId: string;
  sessionId: string;
  snapshot?: SessionSnapshot;
  otherSnapshot?: SessionSnapshot;
  busy: boolean;
  demo: boolean;
  onToggle(workspace: Workspace): void;
  onSelect(workspace: Workspace, sessionId: string): void;
  onRename(workspaceId: string, sessionId: string, title: string): Promise<void>;
  onRefresh(workspaceId: string): void;
  onNew(workspace: Workspace): void;
  onEdit(workspace: Workspace): void;
  onLogin?(machine: WorkspaceMachine): void;
  /** The user went to a machine, from its heading. */
  onNavigateMachine?(machine: WorkspaceMachine): void;
  /** A machine's or folder's name: a new chat there (nothing starts until it is sent). */
  onOpenMachine?(machine: WorkspaceMachine): void;
  onOpenDraft?(workspace: Workspace): void;
  /** The folder whose new chat the active split shows. */
  draftWorkspaceId?: string;
  onScanHistory?(workspace: Workspace): void;
  /** Right-click menus for machines, folders and conversations. */
  menuActions?: SidebarMenuActions;
  filter?: string;
}) {
  const prefs = useDesktopState();
  const connectionOf = useMachineConnections();
  const [over,setOver] = useState("");
  const [rename, setRename] = useState<{ workspaceId: string; session: SessionInfo } | null>(null);
  // Each folder lists five conversations initially; Show more adds ten at a time.
  const [shown, setShown] = useState<Record<string, number>>({});
  const ordered = orderProjects(workspaces, prefs.projectOrder);
  // Archived conversations leave the sidebar; a running one always stays visible.
  const archived = useMemo(() => new Set(prefs.archivedSessions.map(a => archiveKey(a.workspaceId, a.sessionId))), [prefs.archivedSessions]);
  const listed = (workspace: Workspace) => (states[workspace.id]?.data?.sessions ?? []).filter(s => s.paneId || !archived.has(archiveKey(workspace.id, s.id)));
  const machines = workspaceMachines(platform, demo ? [] : prefs.connections, ordered);
  const query = filter.trim().toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]) => values.some(v => v?.toLocaleLowerCase().includes(query));
  const visible = machines.flatMap(machine => {
    const machineMatch = !query || matches(machine.name, machine.endpoint.host);
    const folders = machineMatch ? machine.folders : machine.folders.filter(w => matches(w.name, w.cwd) || listed(w).some(s => matches(s.title)));
    return machineMatch || folders.length ? [{ machine, folders, machineMatch }] : [];
  });
  return (
    <nav className="sidebar-tree" aria-label={t('sidebar.treeLabel')}>
      {visible.map(({ machine, folders, machineMatch }) => <MachineSection key={machine.key} machine={machine}
        searchOpen={!!query} demo={demo} add={() => onAddFolder(machine)} login={onLogin && (() => onLogin(machine))} menu={menuActions}
        connection={connectionOf(machine.key)} onNavigate={onNavigateMachine && (() => onNavigateMachine(machine))}
        onOpen={onOpenMachine && (() => onOpenMachine(machine))}>
        {folders.map(workspace => {
        const entry = states[workspace.id];
        const open = expanded.has(workspace.id) || !!query;
        const folderMatches = machineMatch || matches(workspace.name, workspace.cwd);
        const allSessions = listed(workspace);
        const seenTitles = new Set<string>(), duplicateTitles = new Set<string>();
        for (const { title } of allSessions) {
          if (seenTitles.has(title)) duplicateTitles.add(title);
          seenTitles.add(title);
        }
        const displayStates = new Map(allSessions.map(session => [session.id, sessionSidebarState(session, {
          snapshot: [snapshot, otherSnapshot].find(item => item?.workspaceId === workspace.id && item?.sessionId === session.id),
          selected: workspace.id === workspaceId && session.id === sessionId,
          scanError: entry?.error, unread: entry?.unreadSessionIds?.has(session.id),
        })]));
        const sortStates = prefs.sidebarSort === 'priority' ? displayStates : undefined;
        const matching = allSessions.filter(chat=>!query || folderMatches || chat.title?.toLocaleLowerCase().includes(query))
          .sort((a, b) => compareSidebarSessions(a, b, sortStates));
        const limit = shown[workspace.id] ?? initialSessions;
        const sessions = query ? matching : matching.filter((chat, index) => index < limit || (workspace.id === workspaceId && chat.id === sessionId));
        const hidden = matching.length - sessions.length;
        const collapsible = open && !query && limit > initialSessions;
        const collapseSessions = () => setShown(current => {
          const next = { ...current };
          delete next[workspace.id];
          return next;
        });
        const deferred = workspace.historyScan === false;
        const folderStatus = entry?.error ? 'error' : aggregateSidebarState([...displayStates.values()]);
        const folderDetail = folderStatus && t(({ error: 'sidebar.folderError', waiting: 'sidebar.folderWaiting', unread: 'sidebar.folderUnread' } as const)[folderStatus]);
        const childrenId = `workspace-children-${workspace.id}`;
        return (
          <div className="workspace-tree-group" key={workspace.id}>
            <div
              className={`workspace-row${workspaceId === workspace.id ? " active" : ""}`}
              data-workspace-id={workspace.id}
              data-status={folderStatus}
              draggable
              data-drag-over={over === workspace.id || undefined}
              onDragStart={e=>{e.dataTransfer.setData(workspaceDragType,workspace.id);e.dataTransfer.effectAllowed="move";}}
              onDragOver={e=>{if(e.dataTransfer.types.includes(workspaceDragType)){e.preventDefault();e.dataTransfer.dropEffect="move";setOver(workspace.id);}}}
              onDragLeave={()=>setOver("")} onDragEnd={()=>setOver("")}
              onDrop={e=>{if(e.dataTransfer.types.includes(workspaceDragType)){e.preventDefault();setOver("");const from=e.dataTransfer.getData(workspaceDragType);if(machine.folders.some(w=>w.id===from))moveProject(ordered.map(w=>w.id),from,workspace.id);}}}
              onContextMenu={menuActions && (event => showContextMenu(event, folderMenu(workspace, open, { ...menuActions, toggle: () => onToggle(workspace),
                collapseSessions: collapsible ? collapseSessions : undefined }), workspace.name))}
            >
              <button
                type="button"
                className="workspace-toggle"
                aria-label={t('sidebar.toggleFolder', { open: String(open), name: workspace.name })}
                aria-expanded={open}
                aria-controls={childrenId}
                title={t(open ? 'sidebar.collapseList' : 'sidebar.expandList')}
                onClick={() => onToggle(workspace)}
              >
                {open ? (
                  <ChevronDown className="workspace-chevron" size={12} />
                ) : (
                  <ChevronRight className="workspace-chevron" size={12} />
                )}
              </button>
              <button
                className="workspace-select"
                aria-label={workspace.name}
                aria-current={draftWorkspaceId === workspace.id ? "page" : undefined}
                aria-description={folderDetail}
                onClick={() => onOpenDraft ? onOpenDraft(workspace) : onToggle(workspace)}
                onKeyDown={(event) => {
                  if (
                    (event.key === "ArrowRight" && !open) ||
                    (event.key === "ArrowLeft" && open)
                  ) {
                    event.preventDefault();
                    onToggle(workspace);
                  }
                }}
                title={`${workspace.name}\n${workspace.kind === "ssh" ? `${workspace.host}:` : ""}${workspace.cwd}${onOpenDraft ? "\n" + t('sidebar.clickToStart') : ""}`}
              >
                <Folder className="workspace-folder-icon" size={14} />
                <span className="workspace-name">{workspace.name}</span>
                {folderStatus && <span className={`session-status-dot state-${folderStatus}`} aria-hidden="true" title={folderDetail} />}
              </button>
              <div className="workspace-row-actions">
                {collapsible && <button
                  type="button"
                  className="icon-button workspace-collapse-sessions"
                  aria-label={t('sidebar.collapseChatsOf', { name: workspace.name })}
                  title={t('sidebar.collapseChatsTitle', { count: initialSessions })}
                  onClick={collapseSessions}
                >
                  <ChevronsUp size={13} />
                </button>}
                <button
                  className="icon-button"
                  aria-label={t('sidebar.newChatIn', { name: workspace.name })}
                  title={t('sidebar.newChat')}
                  onClick={() => onNew(workspace)}
                >
                  <Plus size={13} />
                </button>
                <button
                  className="icon-button workspace-settings"
                  aria-label={t('sidebar.editFolderOf', { name: workspace.name })}
                  title={t(demo ? 'sidebar.demoFolderFixed' : 'sidebar.editFolderTitle')}
                  onClick={() => onEdit(workspace)}
                  disabled={demo}
                >
                  <MoreHorizontal size={13} />
                </button>
              </div>
            </div>
            {open && (
              <div
                id={childrenId}
                className="workspace-children"
                role="group"
                aria-label={t('sidebar.sessionsOf', { name: workspace.name })}
              >
                {sessions.map(session => {
                  const state = displayStates.get(session.id)!;
                  const title = session.title || t('app.newChat');
                  const identity = [session.historySegmentCount && t('sidebar.segments', { count: session.historySegmentCount }), session.forkParentId && t('sidebar.branch'),
                    duplicateTitles.has(session.title) && session.id.slice(0, 8)].filter(Boolean).join(' ');
                  const selected =
                    workspace.id === workspaceId && session.id === sessionId;
                  return (
                    <div className="session-row-wrap" key={session.id}>
                      <button
                        className={`session-row${selected ? " active" : ""}`}
                        draggable
                        onDragStart={e=>beginChatDrag(e.dataTransfer,{workspaceId:workspace.id,sessionId:session.id,title})}
                        onDragEnd={endChatDrag}
                        onClick={() => { hoverPrefetch.leave(); onSelect(workspace, session.id); }}
                        onMouseEnter={() => { if (!selected) hoverPrefetch.point(workspace.id, session.id); }}
                        onFocus={() => { if (!selected) hoverPrefetch.point(workspace.id, session.id); }}
                        onMouseLeave={() => hoverPrefetch.leave()}
                        onBlur={() => hoverPrefetch.leave()}
                        onContextMenu={menuActions && (event => showContextMenu(event, sessionMenu(workspace, session, { ...menuActions, rename: () => setRename({ workspaceId: workspace.id, session }) }), title))}
                        aria-keyshortcuts="F2"
                        onKeyDown={(event) => {
                          if (event.key === "F2") {
                            event.preventDefault();
                            setRename({ workspaceId: workspace.id, session });
                          }
                        }}
                        aria-current={selected ? "page" : undefined}
                        aria-label={[title, identity, state.label, state.loading && t('sidebar.loading')].filter(Boolean).join(t('sidebar.ariaJoin'))}
                        aria-busy={state.loading || undefined}
                        title={`${session.titleSource === "prompt" ? t('sidebar.firstMessage') : ""}${title}\n${session.id}${session.forkParentId ? `\n${t('sidebar.branchFrom', { id: session.forkParentId })}` : ''}\n${state.detail}${session.paneId && !session.path ? "\n" + t('sidebar.waitingFirstRecord') : ""}`}
                        data-workspace-id={workspace.id}
                        data-session-id={session.id}
                        data-session-live={state.live}
                        data-session-persisted={!!session.path}
                        data-status={state.kind}
                        data-session-state={state.kind}
                        data-background={state.background || undefined}
                        data-loading={state.loading || undefined}
                      >
                        <span className="session-title">{title}</span>
                        {identity && <small>{identity}</small>}
                        <span className="session-state-label">{state.label}</span>
                        {state.dot && <span className={`session-status-dot state-${state.dot}`} aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className="icon-button session-rename"
                        title={t('sidebar.renameSession')}
                        aria-label={t('sidebar.renameSessionOf', { title })}
                        onClick={() => setRename({ workspaceId: workspace.id, session })}
                      >
                        <Pencil size={13} />
                      </button>
                    </div>
                  );
                })}
                {(hidden > 0 || collapsible) && <div className="tree-more-row">
                  {hidden > 0 && (
                    <button type="button" className="tree-more" aria-label={t('sidebar.showMoreOf', { name: workspace.name })}
                      onClick={() => setShown(current => ({ ...current, [workspace.id]: limit + moreSessions }))}>
                      {t('sidebar.showMore')}<small>{t('sidebar.moreCount', { count: hidden })}</small>
                    </button>
                  )}
                  {collapsible && <button type="button" className="tree-more tree-collapse" aria-label={t('sidebar.collapseMoreOf', { name: workspace.name })}
                    onClick={collapseSessions}>{t('sidebar.collapseChats')}</button>}
                </div>}
                {deferred && !entry?.error && (
                  <div className="tree-note tree-note-scan">
                    <span>{t(sessions.length ? 'sidebar.historyNotScanned' : 'sidebar.folderNotScanned')}</span>
                    <button className="tree-note-action" disabled={!onScanHistory} onClick={() => onScanHistory?.(workspace)}>{t('sidebar.scanAll')}</button>
                  </div>
                )}
                {entry?.error && (
                  <div
                    className="tree-note tree-note-error"
                    title={entry.error}
                  >
                    <span>{t(needsSshLogin(entry.error) ? 'sidebar.needsLogin' : isMissingToolsError(entry.error) ? 'hostTools.folderNote' : 'sidebar.connectionUnknown')}</span>
                    {workspace.kind === "ssh" && onLogin && needsSshLogin(entry.error) && <button className="tree-note-action"
                      aria-label={t('sidebar.login', { name: machine.name })} title={t('sidebar.loginWithin', { name: machine.name })} disabled={demo}
                      onClick={() => onLogin(machine)}>{t('sidebar.loginShort')}</button>}
                    <button
                      className="icon-button"
                      aria-label={t('sidebar.retryFolder', { name: workspace.name })}
                      onClick={() => onRefresh(workspace.id)}
                      disabled={entry.loading}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                )}
                {!sessions.length &&
                  !entry?.error && !deferred &&
                  (entry?.loading || !entry?.data ? (
                    <div className="tree-note">
                      <Loader2 className="rotating" size={11} />
                      <span>{t('sidebar.readingSessions')}</span>
                    </div>
                  ) : (
                    <div className="tree-note">
                      <span>{t('sidebar.noSessions')}</span>
                      <button
                        className="tree-note-action"
                        onClick={() => onNew(workspace)}
                      >
                        {t('sidebar.newShort')}
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        );
      })}</MachineSection>)}
      {query && !visible.length && <div className="tree-empty">{t('sidebar.noMatches')}</div>}
      {rename && (
        <SessionRenameDialog
          session={rename.session}
          onSave={title => onRename(rename.workspaceId, rename.session.id, title)}
          onClose={() => setRename(null)}
        />
      )}
    </nav>
  );
}
