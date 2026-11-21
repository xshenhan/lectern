import { Archive, ChevronDown, ChevronRight, ChevronsUp, Columns2, Copy, FolderOpen, FolderPlus, Hash, History, LogIn, MessageSquare, Pencil, Plus, RefreshCw, Settings2, SquareTerminal, Trash2 } from "lucide-react";
import type { SessionInfo, Workspace } from "../shared/types";
import { confirmAction, copyWithToast, promptText, showToast, type MenuEntry } from "./ContextMenu";
import { setDesktop, type ConnectionProfile } from "./desktop-state";
import type { WorkspaceMachine } from "./workspace-machines";
import { t } from '../shared/i18n';

/** Everything a sidebar right-click can do; App supplies the implementations. */
export interface SidebarMenuActions {
  platform: string;
  demo: boolean;
  busy: boolean;
  connections: ConnectionProfile[];
  addFolder(machine: WorkspaceMachine): void;
  login(machine: WorkspaceMachine): void;
  editConnections(): void;
  importHistory(): void;
  newSession(workspace: Workspace): void;
  refresh(workspace: Workspace): void;
  scanHistory(workspace: Workspace): void;
  editWorkspace(workspace: Workspace): void;
  saveWorkspace(workspace: Workspace): Promise<unknown>;
  removeWorkspace(id: string): Promise<void>;
  open(workspace: Workspace, sessionId: string): void;
  openBeside(workspace: Workspace, session: SessionInfo): void;
  /** Hide from the sidebar (Settings → 回收站 restores); the target's files stay. */
  archiveSession(workspace: Workspace, session: SessionInfo): void;
}

const icon = (Icon: typeof Copy) => <Icon size={14} />;
const address = (machine: WorkspaceMachine) => `${machine.endpoint.host}${machine.endpoint.port ? `:${machine.endpoint.port}` : ""}`;
export const revealLabel = (platform: string) => t(platform === "darwin" ? 'sidebar.revealMac' : platform === "win32" ? 'sidebar.revealWindows' : 'sidebar.revealOther');

export function machineMenu(machine: WorkspaceMachine, actions: SidebarMenuActions): MenuEntry[] {
  const remote = machine.endpoint.kind === "ssh";
  const profile = actions.connections.find(c => c.host === machine.endpoint.host && c.port === machine.endpoint.port);
  return [
    { label: t('sidebar.addFolder'), icon: icon(FolderPlus), disabled: actions.demo, onSelect: () => actions.addFolder(machine) },
    remote && { label: t('sidebar.loginMachine'), icon: icon(LogIn), disabled: actions.demo, onSelect: () => actions.login(machine) },
    !remote && { label: t('sidebar.discoverLocal'), icon: icon(History), disabled: actions.demo, onSelect: actions.importHistory },
    "separator",
    remote && { label: t('sidebar.rename'), icon: icon(Pencil), disabled: actions.demo, onSelect: () => renameMachine(machine, profile, actions.connections) },
    remote && { label: t('sidebar.copyHost'), icon: icon(Copy), onSelect: () => copyWithToast(address(machine)) },
    remote && { label: t('sidebar.editSsh'), icon: icon(Settings2), disabled: actions.demo, onSelect: actions.editConnections },
    "separator",
    remote && { label: t('sidebar.removeMachine'), icon: icon(Trash2), danger: true, disabled: actions.demo, onSelect: () => removeMachine(machine, profile, actions) },
  ].filter(Boolean) as MenuEntry[];
}

async function renameMachine(machine: WorkspaceMachine, profile: ConnectionProfile | undefined, connections: ConnectionProfile[]) {
  const name = await promptText({ title: t('sidebar.renameMachine'), label: t('sidebar.displayName'), value: machine.name, maxLength: 100 });
  if (!name || name === machine.name) return;
  const { host, port } = machine.endpoint;
  setDesktop({ connections: profile ? connections.map(c => c === profile ? { ...c, name } : c)
    : [...connections, { id: crypto.randomUUID(), name, host: host!, port }] });
}

async function removeMachine(machine: WorkspaceMachine, profile: ConnectionProfile | undefined, actions: SidebarMenuActions) {
  const folders = machine.folders.length;
  const ok = await confirmAction({ title: t('sidebar.removeMachineTitle', { name: machine.name }), danger: true, confirmLabel: t('sidebar.remove'),
    message: t('sidebar.removeMachineSafe', { what: folders ? t('sidebar.removeMachineFolders', { count: folders }) : t('sidebar.removeMachineOnly') }) });
  if (!ok) return;
  for (const folder of machine.folders) await actions.removeWorkspace(folder.id);
  if (profile) setDesktop({ connections: actions.connections.filter(c => c !== profile) });
  showToast(t('sidebar.machineRemoved', { name: machine.name }));
}

export function folderMenu(workspace: Workspace, open: boolean, actions: SidebarMenuActions & { toggle(): void; collapseSessions?(): void }): MenuEntry[] {
  const location = workspace.kind === "ssh" ? `${workspace.host}:${workspace.cwd}` : workspace.cwd;
  return [
    { label: t('sidebar.newChat'), icon: icon(Plus), disabled: actions.busy, onSelect: () => actions.newSession(workspace) },
    { label: t(open ? 'sidebar.collapse' : 'sidebar.expand'), icon: icon(open ? ChevronRight : ChevronDown), onSelect: actions.toggle },
    actions.collapseSessions && { label: t('sidebar.collapseChats'), icon: icon(ChevronsUp), hint: t('sidebar.keepFirst'), onSelect: actions.collapseSessions },
    { label: t('sidebar.refreshList'), icon: icon(RefreshCw), onSelect: () => actions.refresh(workspace) },
    workspace.historyScan === false && { label: t('sidebar.scanAll'), icon: icon(History), onSelect: () => actions.scanHistory(workspace) },
    "separator",
    { label: t('sidebar.rename'), icon: icon(Pencil), disabled: actions.demo, onSelect: async () => {
      const name = await promptText({ title: t('sidebar.renameFolder'), label: t('sidebar.displayName'), value: workspace.name, maxLength: 100 });
      if (name && name !== workspace.name) await actions.saveWorkspace({ ...workspace, name });
    } },
    { label: t('sidebar.editFolder'), icon: icon(Settings2), disabled: actions.demo, onSelect: () => actions.editWorkspace(workspace) },
    { label: t('sidebar.copyPath'), icon: icon(Copy), onSelect: () => copyWithToast(workspace.cwd) },
    workspace.kind === "ssh" && { label: t('sidebar.copyHostPath'), icon: icon(Copy), onSelect: () => copyWithToast(location) },
    workspace.kind === "local" && { label: revealLabel(actions.platform), icon: icon(FolderOpen), disabled: actions.demo, onSelect: () => window.desktop.revealWorkspace(workspace.id) },
    "separator",
    { label: t('sidebar.removeFromSidebar'), icon: icon(Trash2), danger: true, disabled: actions.demo, onSelect: async () => {
      const ok = await confirmAction({ title: t('sidebar.removeFolderTitle', { name: workspace.name }), danger: true, confirmLabel: t('sidebar.remove'),
        message: t('sidebar.removeFolderMessage') });
      if (ok) await actions.removeWorkspace(workspace.id);
    } },
  ].filter(Boolean) as MenuEntry[];
}

export function sessionMenu(workspace: Workspace, session: SessionInfo, actions: SidebarMenuActions & { rename(): void }): MenuEntry[] {
  const title = session.title || t('app.newChat'), running = !!session.paneId;
  const resume = `cd ${shellQuote(workspace.cwd)} && claude --resume ${session.id}`;
  return [
    { label: t('sidebar.open'), icon: icon(MessageSquare), onSelect: () => actions.open(workspace, session.id) },
    { label: t('sidebar.openBeside'), icon: icon(Columns2), onSelect: () => actions.openBeside(workspace, session) },
    "separator",
    { label: t('sidebar.rename'), icon: icon(Pencil), hint: "F2", onSelect: actions.rename },
    { label: t('sidebar.copyTitle'), icon: icon(Copy), onSelect: () => copyWithToast(title) },
    { label: t('sidebar.copySessionId'), icon: icon(Hash), onSelect: () => copyWithToast(session.id) },
    { label: t('sidebar.copyResume'), icon: icon(SquareTerminal), onSelect: () => copyWithToast(resume, t('sidebar.copiedResume')) },
    "separator",
    { label: t('sidebar.archive'), icon: icon(Archive), disabled: actions.demo || running, hint: running ? t('sidebar.running') : undefined,
      onSelect: () => actions.archiveSession(workspace, session) },
  ];
}

function shellQuote(value: string) {
  if (value === "~" || value.startsWith("~/")) return value.replace(/[^\w~/.-]/g, ch => `\\${ch}`);
  return /^[\w/.-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
