import { PreferencesDialog } from "./PreferencesDialog";
import { WindowTitlebar } from "./WindowTitlebar";
import { SplitButtons, SplitWorkspace } from "./SplitWorkspace";
import { archiveKey, archiveSession, desktopState, focusChat, forgetProject, sameChat, setDesktop, showChat, shownIn, splitChat, useDesktopState, type ChatTarget } from "./desktop-state";
import { Search, Settings2 } from "lucide-react";
import type { ChatView } from "../shared/types";
import "./workbench.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  Bug,
  Check,
  CircleHelp,
  Folder,
  FolderPlus,
  History,
  Link2,
  ListEnd,
  Loader2,
  Navigation,
  Plus,
  RefreshCw,
  Server,
  Square,
  SquarePen,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import type {
  AppInfo,
  HistoryProject,
  HistoryTarget,
  SessionInfo,
  SessionSnapshot,

  Workspace,
  WorkspaceDiscovery,
} from "../shared/types";
import { ActivityFloat } from "./ActivityFloat";
import { TaskColumn } from "./TaskColumn";
import { imeOwnsKey, isEnterKey } from "./enter-key";
import { useComposerAttachments } from "./useComposerAttachments";
import { liveShells as foregroundShells, panelActivities, shellScreenLines, type ActivityKind, type SessionActivity } from "../shared/activity";
import { LiveShells } from "./MessageDisplay";
import { ArtifactDrawer, type ArtifactTarget } from "./ArtifactDrawer";
import { SshLoginHost } from "./SshLoginDialog";
import { ReleaseNotesDialog } from "./ReleaseNotesDialog";
import { checkForUpdatesFromMenu, UpdatePrompt } from "./UpdatePrompt";
import { QuitPromptHost } from "./QuitDialog";
import { needsSshLogin, openSshLogin } from "./ssh-login";
import { checkSshMachines, markNavigated, setMachineConnection, sshConnectionError, sshMachineKey, sshMachines, useMachineConnections, useNavigated } from "./ssh-machines";
import { commandPolicy } from "../shared/native-commands";
import "./artifacts.css";
import "./context-menu.css";
import { ConversationTranscript } from "./ConversationTranscript";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { TerminalPanel, type TerminalPanelHandle } from "./TerminalPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { SidebarSortButton, SidebarTree } from "./SidebarTree";
import { sshOnly } from "../shared/supported-targets";
import { TooltipHost, tip } from "./Tooltip";
import "./tooltip.css";
import { machineKey, machineName, workspaceMachines, type WorkspaceMachine } from "./workspace-machines";
import { checkHostTools, ensureHostTools, hostMissing, useHostTools } from "./host-tools";
import { HostCheckFailed, HostToolsNotice, OutdatedClaude } from "./HostToolsNotice";
import { isMissingToolsError, machineParams, toolList } from "../shared/host-tools";
import { LecternMark } from "./LecternMark";
import { ResizableSidebar } from "./ResizableSidebar";
import { renameTreeSession, useWorkspaceTree } from "./useWorkspaceTree";
import { SessionSettings } from "./SessionSettings";
import { SessionTelemetryDisplay } from "./SessionTelemetryDisplay";
import { DirectoryTrustCard } from "./DirectoryTrustCard";
import { QuestionCard } from "./QuestionCard";
import { PermissionCard, rejects } from "./PermissionCard";
import type { PermissionAction } from "../shared/native-permission";
import type { QuestionAction } from "../shared/question-action";
import { activeDirectoryTrust } from "./directory-trust-state";
import type { TurnAction } from "../shared/turn-controls";
import { TurnPanel } from "./TurnControls";
import { TurnProgress } from './TurnProgress';
import { RewindPicker } from "./RewindPicker";
import { useComposerCompletion } from "./useComposerCompletion";
import { composerPlaceholder, isMessageInputReady } from "./composer-state";
import { DraftSettings } from "./DraftSettings";
import type { LaunchChoices } from "../shared/model-catalog";
import { outgoingDelivered, showsOutgoing, startOutgoing, withOutgoing, type OutgoingMessage } from "./outgoing-message";
import { sessionSidebarState } from "./sidebar-status";
import { HistoryImportDialog } from "./HistoryImportDialog";
import { confirmAction, ContextMenuHost, showToast } from "./ContextMenu";
import { closeConfirmation } from "./close-confirmation";
import type { SidebarMenuActions } from "./sidebar-menus";
import { HandoffHistoryDialog } from "./HandoffHistoryDialog";
import { CodexPanel } from "./CodexPanel";
import { findImportedWorkspace } from "./history-import";
import {
  reportActionError,
  reportSnapshotApplied,
  setDiagnosticContext,
} from "./diagnostics";
import { t } from '../shared/i18n';
import { rich } from './i18n';

// Message keys, translated when shown.
const statusLabels = {
  connecting: 'app.statusConnecting',
  idle: 'app.statusIdle',
  working: 'app.statusWorking',
  waiting: 'app.statusWaiting',
  offline: 'app.statusOffline',
  error: 'app.statusError',
} as const;
/** Every state the title bar's status shows for a chat, to reserve the widest. */
const sessionStateKeys = [...Object.values(statusLabels), 'app.history', 'app.statusUnconfirmed', 'app.sessionError', 'app.backgroundRunning'] as const;
function errorText(e: unknown) {
  reportActionError(e);
  return e instanceof Error
    ? e.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      )
    : String(e);
}

const unsentDrafts = new Map<string,string>();
// A new chat's model and effort, per folder, in memory only: never a default.
const launchChoicesByFolder = new Map<string, LaunchChoices>();
/** The choices of a first message that did not go out are the folder's again
 * (sending consumed them); nothing chosen keeps whatever the folder has. */
function keepLaunchChoices(workspaceId: string, choices: LaunchChoices) {
  if (choices.model !== undefined || choices.effort !== undefined) launchChoicesByFolder.set(workspaceId, choices);
}
/** The first message of a new chat, from its send until Claude Code receives it. */
interface DraftLaunch { id: string; workspaceId: string; text: string; choices: LaunchChoices; phase: "creating" | "waiting" | "sending"; sessionId?: string; startedAt: number }
const draftKey = (ws:string,sid:string) => JSON.stringify([ws,sid]);
/** Text coming back to an input box that may already hold other text: both kept. */
function mergeDraft(existing: string, text: string) {
  if (!existing.trim()) return text;
  if (!text.trim() || existing.includes(text)) return existing;
  return `${text}\n\n${existing}`;
}
export default function App({view = "primary"}: {view?: ChatView}) {
  const prefs = useDesktopState();
  const primary = view === "primary";
  const [preferencesOpen,setPreferencesOpen] = useState<boolean | "new-machine">(false);
  const [filter,setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const [loaded,setLoaded] = useState(false);
  useEffect(() => {
    if (!primary) return;
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.style.setProperty("--ui-font-size", prefs.fontSize + "px");
    root.style.setProperty("--composer-max-lines", String(prefs.composerMaxLines));
    root.style.setProperty("--chat-line-height", String(prefs.chatLineHeight / 100));
    root.style.setProperty("--composer-line-height", String(prefs.composerLineHeight / 100));
    root.style.setProperty("--tool-summary-font-size", prefs.toolSummaryFontSize + "px");
    root.style.setProperty("--conversation-width", prefs.conversationWidth + "px");
    root.style.setProperty("--preview-code-font-size", prefs.previewCodeFontSize + "px");
    root.style.setProperty("--preview-code-line-height", String(prefs.previewCodeLineHeight / 100));
    root.style.setProperty("--preview-text-font-size", prefs.previewTextFontSize + "px");
    root.style.setProperty("--preview-text-line-height", String(prefs.previewTextLineHeight / 100));
  }, [primary, prefs.theme, prefs.fontSize, prefs.composerMaxLines, prefs.chatLineHeight,
    prefs.composerLineHeight, prefs.toolSummaryFontSize, prefs.conversationWidth, prefs.previewCodeFontSize,
    prefs.previewCodeLineHeight, prefs.previewTextFontSize, prefs.previewTextLineHeight]);
  useEffect(() => {
    if (primary) void window.desktop?.setWindowTheme?.(prefs.theme)
      .catch(error => reportActionError(error, "更新窗口外观失败"));
  }, [primary, prefs.theme]);
  useEffect(() => {
    if (primary) void window.desktop?.setLaunchPreferences?.({ enableWorkflows: prefs.enableWorkflows })
      .catch(error => reportActionError(error, "同步会话启动选项失败"));
  }, [primary, prefs.enableWorkflows]);
  const [info, setInfo] = useState<AppInfo>({
    platform: "",
    version: "",
    demo: false,
  });
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [otherSnapshot, setOtherSnapshot] = useState<SessionSnapshot>();
  const [artifact, setArtifact] = useState<{ workspaceId: string; sessionId: string; trail: ArtifactTarget[] }>();
  const artifactOpener = useRef<HTMLElement | null>(null);
  const drawer = artifact?.workspaceId === workspaceId && artifact.sessionId === sessionId ? artifact : undefined;
  const activityScope = JSON.stringify([workspaceId, sessionId]);
  const [activityChoice, setActivityChoice] = useState<{ scope: string; open: boolean }>();
  const sessionActivity = snapshot?.workspaceId === workspaceId && snapshot.sessionId === sessionId ? snapshot.activity ?? [] : [];
  // Foreground shells appear in the transcript, as in Claude Code; background ones here.
  const items = useMemo(() => panelActivities(sessionActivity), [sessionActivity]);
  const shellScreen = snapshot?.workspaceId === workspaceId && snapshot.sessionId === sessionId ? snapshot.viewport ?? snapshot.screen : '';
  const liveShells = useMemo(() => new Map([...foregroundShells(sessionActivity)].map(([id, shell]) =>
    [id, { ...shell, waiting: snapshot?.status === 'waiting', lines: shell.command ? shellScreenLines(shellScreen ?? '', shell.command) : undefined }])), [sessionActivity, shellScreen, snapshot?.status]);
  const activeCount = items.filter(item => item.status === "running").length;
  // The floating activity card opens by itself where it fits; the user's choice wins for this chat.
  const activityAsked = activityChoice?.scope === activityScope ? activityChoice.open : undefined;
  // The task column of this chat: which subagent, shell or monitor it shows, the kind the card
  // asked for without naming one, and a counter that focuses it.
  const [taskColumn, setTaskColumn] = useState<{ scope: string; key?: string; kind?: ActivityKind; focus: number }>();
  const taskShown = taskColumn?.scope === activityScope && sessionId ? taskColumn : undefined;
  const openTask = (item?: SessionActivity, kind?: ActivityKind) => setTaskColumn(previous => {
    const same = previous?.scope === activityScope;
    // A kind without an entry keeps the one shown when it is of that kind.
    const keep = same && previous.key && (!kind || items.find(entry => entry.id === previous.key)?.kind === kind || kind === 'agent' && previous.key.startsWith('agent:'));
    return { scope: activityScope, focus: (previous?.focus ?? 0) + 1, kind: item?.kind ?? kind, key: item?.id ?? (keep ? previous.key : undefined) };
  });
  const [activityShown, setActivityShown] = useState(false);
  const activityAttachments = useMemo(() => {
    const seen = new Set<string>();
    return (snapshot?.workspaceId === workspaceId && snapshot.sessionId === sessionId ? snapshot.messages : [])
      .flatMap(message => message.attachments ?? []).filter(file => !seen.has(file.id) && !!seen.add(file.id));
  }, [snapshot?.messages, snapshot?.workspaceId, snapshot?.sessionId, workspaceId, sessionId]);
  // A finished turn may have changed the repository.
  const activityRefresh = `${snapshot?.status === 'working' ? 'working' : 'idle'}:${snapshot?.messages.at(-1)?.id ?? ''}`;
  function openArtifact(target: ArtifactTarget) {
    if (!drawer && document.activeElement instanceof HTMLElement) artifactOpener.current = document.activeElement;
    setArtifact(previous => {
      const trail = previous?.workspaceId === workspaceId && previous.sessionId === sessionId ? previous.trail : [];
      const last = trail.at(-1);
      if (last && (('path' in last && 'path' in target && last.path === target.path) ||
        ('attachment' in last && 'attachment' in target && last.attachment.id === target.attachment.id))) return previous;
      return { workspaceId, sessionId, trail: [...trail, target] };
    });
  }
  const closeArtifact = useCallback(() => {
    setArtifact(undefined);
    if (artifactOpener.current?.isConnected) artifactOpener.current.focus({ preventScroll: true });
  }, []);
  const [busy, setBusy] = useState(false);
  const connectionOf = useMachineConnections();
  const navigated = useNavigated();
  const [machinePrompt, setMachinePrompt] = useState<{ key: string; host: string; port?: number; label: string }>();
  const [sending, setSending] = useState(false);
  const [outgoing, setOutgoing] = useState<OutgoingMessage>();
  // An error may come from another folder than the one shown (a new chat started
  // from the sidebar); its login button must target that folder's machine.
  const [errorState, setErrorState] = useState<{ text: string; origin?: Workspace }>({ text: "" });
  const error = errorState.text;
  const setError = useCallback((text: string, origin?: Workspace) => setErrorState({ text, origin }), []);
  const [draft, setDraft] = useState("");
  // Folders are always added on a machine (or edited); there is no machine-less form.
  const [workspaceModal, setWorkspaceModal] = useState<
    Workspace | { machine: WorkspaceMachine } | null
  >(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [codexWorkspaceId, setCodexWorkspaceId] = useState<string>();
  const [bindingOpen, setBindingOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const sidebarOpen = primary && prefs.sidebarOpen;
  const setSidebarOpen = (open: boolean) => setDesktop({sidebarOpen:open});
  const [helpOpen, setHelpOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [historyImportOpen, setHistoryImportOpen] = useState(false);
  const [handoffScope, setHandoffScope] = useState<string>();
  const handoffOpen = handoffScope === activityScope;
  const [settingOperations, setSettingOperations] = useState<
    Record<string, boolean>
  >({});
  const [terminalOperations, setTerminalOperations] = useState<
    Record<string, boolean>
  >({});
  const [answeringScopes, setAnsweringScopes] = useState<ReadonlySet<string>>(() => new Set());
  const terminalPanelRef = useRef<TerminalPanelHandle>(null);
  const selected = useRef<{ workspaceId: string; sessionId: string; draft?: boolean }>({ workspaceId: "", sessionId: "" });
  // A folder view reads its sessions, then opens the newest; until then nothing can be typed.
  const [folderState, setFolderState] = useState<"resolving">();
  const folderResolving = folderState === "resolving";
  const transcript = useRef<ConversationTranscript>(null);
  // The input area floats over the bottom of the conversation (see ConversationTranscript's dock).
  const [composerDock, setComposerDock] = useState<HTMLDivElement | null>(null);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [rewindScope, setRewindScope] = useState<string>();
  const rewindOpen = rewindScope === JSON.stringify([workspaceId, sessionId]) && !!sessionId;
  const readingChat = !handoffOpen && !rewindOpen && followingLatest && !preferencesOpen && !workspaceModal && !historyImportOpen && !helpOpen && !diagnosticsOpen && !bindingOpen && !releaseNotesOpen;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerContext = useRef<HTMLDivElement>(null);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const {
    states: workspaceStates,
    expanded: expandedWorkspaces,
    refresh,
    expand: expandWorkspace,
    toggle: toggleWorkspace,
    patch: patchWorkspace,
    forget: forgetWorkspace,
    trackWorkspace,
  } = useWorkspaceTree(workspaces, sidebarOpen, primary,
    readingChat && snapshot?.workspaceId === workspaceId && snapshot.sessionId === sessionId && prefs.active === view ? snapshot : undefined,
    // The folders of the chats on screen are read first after launch.
    [workspaceId || prefs.panes.primary?.workspaceId, prefs.split ? prefs.panes.secondary?.workspaceId : undefined].filter((id): id is string => !!id));
  const discovery = workspaceStates[workspaceId]?.data;
  const workspaceError = workspaceStates[workspaceId]?.error;
  const loading = workspaceStates[workspaceId]?.loading ?? false;
  const sessionRequest = useRef(0);
  const selectionGeneration = sessionRequest.current;
  const snapshotRevision = useRef(0);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const primaryWorkspace = workspaces.find(item => item.id === prefs.panes.primary?.workspaceId);
  const session = discovery?.sessions.find((item) => item.id === sessionId);
  const hasHandoff = !!session?.historySourceIds?.length;
  useEffect(() => { setHandoffScope(undefined); }, [workspaceId, sessionId, hasHandoff]);
  const paneId = snapshot ? snapshot.paneId : session?.paneId;
  const statusLineManaged = !!paneId && snapshot?.workspaceId === workspaceId &&
    snapshot.sessionId === sessionId && snapshot.statusLineManaged === true;
  const statusLine = statusLineManaged && snapshot?.statusLine?.sessionId === sessionId
    ? snapshot.statusLine : undefined;
  useEffect(() => {
    if (!workspaceId || !sessionId || !terminalOpen) return;
    const visible = (value: boolean) => {
      void window.desktop.setTerminalVisible(workspaceId, sessionId, value, view)
        .catch(error => reportActionError(error, "更新终端显示状态失败"));
    };
    visible(true);
    return () => visible(false);
  }, [workspaceId, sessionId, terminalOpen, view]);
  const settingScope = `${workspaceId}:${sessionId}:${paneId ?? ""}`;
  const settingUIBusy = !!settingOperations[settingScope];
  const terminalLocked =
    !!snapshot?.terminalControl || !!terminalOperations[settingScope];
  const setTerminalOperationBusy = useCallback(
    (scope: string, value: boolean) => {
      setTerminalOperations((previous) => {
        if (!!previous[scope] === value) return previous;
        const next = { ...previous };
        if (value) next[scope] = true;
        else delete next[scope];
        return next;
      });
    },
    [],
  );
  const setSettingOperationBusy = useCallback(
    (scope: string, value: boolean) => {
      setSettingOperations((previous) => {
        if (!!previous[scope] === value) return previous;
        const next = { ...previous };
        if (value) next[scope] = true;
        else delete next[scope];
        return next;
      });
    },
    [],
  );
  const activeStatus =
    snapshot?.status ?? (sessionId || loading ? "connecting" : "offline");
  const directoryTrust = activeDirectoryTrust(snapshot);
  const question = snapshot?.workspaceId === workspaceId && snapshot.sessionId === sessionId &&
    snapshot.paneId && snapshot.panePid && !directoryTrust ? snapshot.question : undefined;
  const questionBusy = !!snapshot?.questionBusy || answeringScopes.has(settingScope);
  async function answerQuestion(action: QuestionAction) {
    if (!question || !paneId || !snapshot?.panePid || questionBusy || terminalLocked ||
        sessionRequest.current !== selectionGeneration || selected.current.workspaceId !== workspaceId || selected.current.sessionId !== sessionId)
      throw new Error(t('app.questionChanged'));
    setAnsweringScopes(previous => new Set(previous).add(settingScope));
    try {
      await window.desktop.answerQuestion(workspaceId, sessionId, paneId, snapshot.panePid, question.token, action);
    } finally {
      setAnsweringScopes(previous => { const next = new Set(previous); next.delete(settingScope); return next; });
    }
  }
  const permission = snapshot?.workspaceId === workspaceId && snapshot.sessionId === sessionId &&
    snapshot.paneId && snapshot.panePid && !directoryTrust && !question ? snapshot.permission : undefined;
  const permissionBusy = !!snapshot?.permissionBusy || answeringScopes.has(settingScope);
  const focusComposerWhenReady = useRef<string | undefined>(undefined);
  async function answerPermission(action: PermissionAction) {
    if (!permission || !paneId || !snapshot?.panePid || permissionBusy || terminalLocked ||
        sessionRequest.current !== selectionGeneration || selected.current.workspaceId !== workspaceId || selected.current.sessionId !== sessionId)
      throw new Error(t('app.permissionChanged'));
    // A refusal, or leaving auto mode (which stops the turn), hands the next move to the user.
    const chosen = action.kind === 'choose' ? permission.options.find(option => option.number === action.number) : undefined;
    const reject = action.kind === 'cancel' || chosen?.key === 'BTab' || rejects(chosen?.label ?? '');
    setAnsweringScopes(previous => new Set(previous).add(settingScope));
    try {
      await window.desktop.answerPermission(workspaceId, sessionId, paneId, snapshot.panePid, permission.token, action);
      // After a refusal Claude waits for guidance: the cursor goes where it is
      // typed as soon as the input box is usable again.
      if (reject) focusComposerWhenReady.current = settingScope;
    } finally {
      setAnsweringScopes(previous => { const next = new Set(previous); next.delete(settingScope); return next; });
    }
  }
  const navigationState = session
    ? sessionSidebarState(session, {
        snapshot,
        selected: true,
        scanError: workspaceStates[workspaceId]?.error,
      })
    : undefined;
  const controls = snapshot?.turnControls;
  const inTurn = !!controls?.running;
  /** /compact is running: a draft can only be queued until the summary is written. */
  const compacting = inTurn && !!controls?.compacting;
  /** A draft typed during a reply: it can be queued or steer the reply (icon buttons by the stop button). */
  const turnDraft = !question && inTurn && !!draft.trim();
  const restoredDraft = controls?.restoredDraft;
  const adoptedDraft = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = restoredDraft && JSON.stringify([workspaceId,sessionId,restoredDraft]);
    if (key && adoptedDraft.current !== key) setDraft(current => current || restoredDraft!);
    adoptedDraft.current = key;
  }, [restoredDraft,workspaceId,sessionId]);
  const outgoingScope = `${workspaceId}:${sessionId}`;
  // A new chat has no transcript yet: its message bubble shows on its own.
  const displayedMessages = useMemo(() => withOutgoing(snapshot?.messages ?? (outgoing?.scope === outgoingScope ? [] : undefined), outgoingScope, outgoing),
    [snapshot?.messages, outgoingScope, outgoing]);
  useEffect(() => {
    if (outgoing && outgoing.scope === outgoingScope && outgoingDelivered(snapshot?.messages, outgoing)) setOutgoing(undefined);
  }, [snapshot?.messages, outgoingScope, outgoing]);
  const canSend =
    !!snapshot &&
    !busy &&
    !!paneId &&
    !snapshot.settingBusy &&
    !snapshot.trustBusy &&
    !question && !questionBusy &&
    !terminalLocked &&
    !settingUIBusy &&
    !controls?.rewind && !controls?.draftOccupied &&
    (inTurn || !!restoredDraft || isMessageInputReady({
      status: activeStatus,
      navigationStatus: snapshot.navigationStatus,
      nativeInputReady: snapshot.nativeInputReady,
    }));
  useEffect(() => {
    if (!canSend || focusComposerWhenReady.current !== settingScope) return;
    focusComposerWhenReady.current = undefined;
    inputRef.current?.focus();
  }, [canSend, settingScope]);
  const canRewind = canSend && !inTurn && !restoredDraft && !sending && !!snapshot?.nativeInputReady;
  // A new chat (no session yet) can be typed into; its first send starts Claude.
  // A folder view that could not be read stays closed until a retry; a new chat
  // the user opened explicitly can always be typed (its send reports any error).
  const isDraft = !!workspace && !sessionId && !folderResolving && (!!prefs.panes[view]?.draft || !workspaceError);
  const [launch, setLaunch] = useState<DraftLaunch>();
  const launchRef = useRef<DraftLaunch | undefined>(undefined);
  launchRef.current = launch;
  // A pane closed while its new chat waits for Claude (a split closing) leaves the
  // first message in that chat's input box rather than losing it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = launchRef.current;
      if (!pending?.sessionId || pending.phase !== "waiting") return;
      const key = draftKey(pending.workspaceId, pending.sessionId);
      unsentDrafts.set(key, mergeDraft(unsentDrafts.get(key) ?? "", pending.text));
      showToast(t('app.chatStartedMessageKept'));
    };
  }, []);
  // A machine without tmux or Claude Code: no new chat or resume starts there (a live pane still works).
  const hostOf = useHostTools();
  const hostStatus = workspace ? hostOf(workspace) : undefined;
  const hostLacks = hostMissing(hostStatus);
  const hostName = workspace?.kind === "ssh" ? machineLabel(workspace) : undefined;
  const hostBlocked = !!workspace && hostLacks.length > 0 && !paneId;
  const canType = canSend || (isDraft && !launch && !busy && !hostBlocked);
  const [draftChoices, setDraftChoicesState] = useState<LaunchChoices>({});
  useEffect(() => { setDraftChoicesState(launchChoicesByFolder.get(workspaceId) ?? {}); }, [workspaceId]);
  const setDraftChoices = useCallback((next: LaunchChoices) => {
    if (next.model !== undefined || next.effort !== undefined) launchChoicesByFolder.set(workspaceId, next);
    else launchChoicesByFolder.delete(workspaceId);
    setDraftChoicesState(next);
  }, [workspaceId]);
  // The first message of a just-started chat goes out once, when its input box is
  // ready; a trust or other startup prompt keeps it waiting. Never resent.
  useEffect(() => {
    if (!launch?.sessionId || launch.phase !== "waiting") return;
    const current = launch, sid = launch.sessionId;
    const drop = () => setOutgoing(o => o?.id === current.id ? undefined : o);
    // Reopening the same chat (a retry, a login, a rename) keeps it waiting; only
    // going elsewhere hands the message to the chat's input box.
    if (selected.current.workspaceId !== current.workspaceId || selected.current.sessionId !== sid) {
      const key = draftKey(current.workspaceId, sid);
      unsentDrafts.set(key, mergeDraft(unsentDrafts.get(key) ?? "", current.text));
      drop(); setLaunch(undefined);
      return;
    }
    if (snapshot?.sessionId === sid && !snapshot.paneId && (snapshot.status === "offline" || snapshot.status === "error") && Date.now() - current.startedAt > 3000) {
      // Claude exited before it could take the message: back to the new chat.
      const ws = workspacesRef.current.find(w => w.id === current.workspaceId);
      drop(); setLaunch(undefined);
      if (ws) {
        patchWorkspace(ws.id, value => ({ ...(value ?? { workspace: ws, panes: [] }), sessions: (value?.sessions ?? []).filter(item => item.id !== sid) }));
        backToDraft(ws, current.text, current.choices);
        setError(t('app.chatStartFailed'), ws);
      }
      return;
    }
    if (!canSend || sending) return;
    setLaunch({ ...current, phase: "sending" });
    setSending(true);
    void window.desktop.sendMessage(current.workspaceId, sid, current.text).then(() => {
      setTimeout(drop, 8000);
    }, e => {
      drop();
      if (mounted.current && selected.current.sessionId === sid) { setDraft(d => mergeDraft(d, current.text)); setError(errorText(e)); }
      else {
        const key = draftKey(current.workspaceId, sid);
        unsentDrafts.set(key, mergeDraft(unsentDrafts.get(key) ?? "", current.text));
        reportActionError(e, "发送第一条消息失败");
      }
    }).finally(() => { setSending(false); setLaunch(l => l?.id === current.id ? undefined : l); });
  }, [launch, canSend, sending, snapshot]);
  /** Keep the new chat but not its automatic first message: the text goes into its input box. */
  function cancelFirstMessage() {
    if (!launch || launch.phase !== "waiting") return;
    setOutgoing(o => o?.id === launch.id ? undefined : o);
    setDraft(d => d || launch.text);
    setLaunch(undefined);
  }
  // Pasted or dropped files become @-mentions; on an SSH machine they are uploaded first.
  // The input box shows them as cards and only the text in the textarea (the draft keeps both).
  const attachments = useComposerAttachments({ workspace, sessionId, enabled: canType && !rewindOpen,
    draft, inputRef, setDraft,
    showing: (ws, sid) => mounted.current && selected.current.workspaceId === ws && selected.current.sessionId === sid,
    stash: (ws, sid, update) => { const key = draftKey(ws, sid); unsentDrafts.set(key, update(unsentDrafts.get(key) ?? "")); },
    onError: showToast });
  const completion = useComposerCompletion({ workspaceId, sessionId: sessionId || (isDraft ? "draft" : ""), view,
    enabled: canType && !sending && !rewindOpen, value: attachments.text, onValue: attachments.setText, inputRef });
  const uploading = attachments.pending.length > 0;
  function openRewind() { setRewindScope(JSON.stringify([workspaceId, sessionId])); }
  useEffect(() => { setRewindScope(undefined); }, [workspaceId, sessionId, paneId]);
  useEffect(() => {
    if (!workspaceId) return;
    // A new chat's text is kept per folder (sessionId "") like any conversation's.
    const key = draftKey(workspaceId, sessionId);
    if (draft) unsentDrafts.set(key,draft); else unsentDrafts.delete(key);
  }, [workspaceId,sessionId,draft]);
  const openSession = useCallback(
    async (wsId: string, id: string) => {
      const request = ++sessionRequest.current;
      const revision = snapshotRevision.current;
      selected.current = { workspaceId: wsId, sessionId: id };
      setFolderState(undefined);
      const currentTarget = desktopState().panes[view];
      showChat(view,{workspaceId:wsId,sessionId:id,title:currentTarget?.sessionId === id ? currentTarget.title : ""});
      setDiagnosticContext(wsId, id);
      setWorkspaceId(wsId);
      const targetWorkspace = workspacesRef.current.find(
        (item) => item.id === wsId,
      );
      if (targetWorkspace) expandWorkspace(targetWorkspace);
      setSessionId(id);
      setArtifact(undefined);
      setSnapshot(undefined);
      setError("");
      setDraft(unsentDrafts.get(draftKey(wsId,id)) || "");
      try {
        const next = await window.desktop.watchSession(wsId, id, view);
        if (
          sessionRequest.current === request &&
          snapshotRevision.current === revision &&
          selected.current.workspaceId === wsId &&
          selected.current.sessionId === id
        )
          setSnapshot(next);
      } catch (e) {
        if (
          sessionRequest.current === request &&
          snapshotRevision.current === revision &&
          selected.current.workspaceId === wsId &&
          selected.current.sessionId === id
        )
          setError(errorText(e));
      }
    },
    [expandWorkspace,view],
  );

  const selectWorkspace = useCallback(
    (ws: Workspace) => {
      const request = ++sessionRequest.current;
      selected.current = { workspaceId: ws.id, sessionId: "" };
      showChat(view,{workspaceId:ws.id,sessionId:"",title:""});
      setDiagnosticContext(ws.id);
      setWorkspaceId(ws.id);
      setSessionId("");
      setArtifact(undefined);
      setSnapshot(undefined);
      setDraft(unsentDrafts.get(draftKey(ws.id, "")) || "");
      setError("");
      setTerminalOpen(false);
      setFolderState("resolving");
      expandWorkspace(ws);
      void window.desktop
        .unwatchSession(view)
        .catch((error) => reportActionError(error, "切换目录失败"));
      // A folder view opens its newest conversation, or becomes a new chat when it has none.
      void refresh(ws.id).then((result) => {
        if (sessionRequest.current !== request || selected.current.workspaceId !== ws.id || selected.current.sessionId) return;
        setFolderState(undefined);
        if (result?.sessions.length && !selected.current.draft) void openSession(ws.id, result.sessions[0].id);
      }, () => { if (sessionRequest.current === request) setFolderState(undefined); });
    },
    [expandWorkspace, refresh, openSession,view],
  );

  /** A new chat in this folder: nothing starts until its first message is sent. */
  const enterDraft = useCallback((ws: Workspace) => {
    ++sessionRequest.current;
    selected.current = { workspaceId: ws.id, sessionId: "", draft: true };
    showChat(view, { workspaceId: ws.id, sessionId: "", title: "", draft: true });
    setDiagnosticContext(ws.id);
    setWorkspaceId(ws.id);
    setSessionId("");
    setArtifact(undefined);
    setSnapshot(undefined);
    setError("");
    setTerminalOpen(false);
    setFolderState(undefined);
    setDraft(unsentDrafts.get(draftKey(ws.id, "")) || "");
    expandWorkspace(ws);
    void window.desktop.unwatchSession(view).catch(error => reportActionError(error, "切换目录失败"));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [expandWorkspace, view]);
  /** A first message that did not go out: back to its folder's new chat with the
   * text and the model and effort it was sent with. */
  function backToDraft(ws: Workspace, text: string, choices: LaunchChoices) {
    keepLaunchChoices(ws.id, choices);
    enterDraft(ws);
    setDraft(d => mergeDraft(d, text));
    setDraftChoicesState(launchChoicesByFolder.get(ws.id) ?? {});
  }

  useEffect(() => {
    let alive = true;
    if (!window.desktop) {
      setError(t('app.needElectron'));
      return;
    }
    void Promise.all([window.desktop.info(), window.desktop.listWorkspaces()])
      .then(([appInfo, list]) => {
        if (!alive) return;
        setInfo(appInfo);
        setWorkspaces(list);
        const restored = desktopState().panes[view];
        const restoredWorkspace = list.find(w => w.id === restored?.workspaceId);
        if (restored && restoredWorkspace) {
          workspacesRef.current = list;
          if (restored.sessionId) void openSession(restored.workspaceId, restored.sessionId);
          else if (restored.draft) enterDraft(restoredWorkspace);
          else selectWorkspace(restoredWorkspace);
        } else {
          showChat(view,null);
          if (primary && list.length) selectWorkspace(list[0]);
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    const unsubscribe = window.desktop.onSnapshot((next) => {
      const secondary = desktopState().panes.secondary;
      if (primary && desktopState().split && secondary?.workspaceId === next.workspaceId && secondary.sessionId === next.sessionId)
        setOtherSnapshot(next);
      if (
        next.workspaceId === selected.current.workspaceId &&
        next.sessionId === selected.current.sessionId
      ) {
        ++snapshotRevision.current;
        setSnapshot(next);
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [selectWorkspace,openSession,enterDraft,view,primary]);
  // Each launch checks every SSH machine once with the everyday, non-interactive
  // connection. Problems show in the sidebar, not as a prompt over the chat.
  // Saving a machine later still connects only when the user asks.
  const startupCheck = useRef(false);
  useEffect(() => {
    if (!primary || !loaded || info.demo || startupCheck.current) return;
    startupCheck.current = true;
    void checkSshMachines(sshMachines(desktopState().connections, workspacesRef.current));
  }, [primary, loaded, info.demo]);
  const target = prefs.panes[view];
  useEffect(() => {
    if (!loaded) return;
    if (target) {
      const ws = workspacesRef.current.find(w => w.id === target.workspaceId);
      if (ws && (selected.current.workspaceId !== target.workspaceId || selected.current.sessionId !== target.sessionId
        || !!selected.current.draft !== !!target.draft)) {
        if (target.sessionId) void openSession(target.workspaceId,target.sessionId);
        else if (target.draft) enterDraft(ws);
        else selectWorkspace(ws);
      }
    } else if (selected.current.workspaceId) {
      ++sessionRequest.current;
      selected.current = {workspaceId:"",sessionId:""};
      setWorkspaceId("");setSessionId("");setSnapshot(undefined);setArtifact(undefined);setTerminalOpen(false);setDraft("");setError("");
      void window.desktop.unwatchSession(view).catch(error=>reportActionError(error,"释放分屏失败"));
    }
  }, [target,view,loaded,openSession,selectWorkspace,enterDraft]);
  useEffect(() => () => { if (!primary) void window.desktop.unwatchSession(view).catch(()=>{}); },[primary,view]);
  useEffect(() => {
    if (!primary) return;
    return window.desktop.onMenuAction?.(action=>{
      if(action==="preferences")setPreferencesOpen(true);
      if(action==="help")setHelpOpen(true);
      if(action==="checkForUpdates")checkForUpdatesFromMenu();
    });
  },[primary]);
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{source:ChatView; saved?:string; open?:ChatView}>).detail;
      void window.desktop.listWorkspaces().then(list => {
        workspacesRef.current=list; setWorkspaces(list);
        const opened = detail?.open === view && list.find(item => item.id === detail.saved);
        if (opened) selectWorkspace(opened);
        else if (detail?.saved && detail.source !== view && selected.current.workspaceId === detail.saved && selected.current.sessionId)
          void openSession(detail.saved,selected.current.sessionId);
      }).catch(error=>reportActionError(error,"同步项目失败"));
    };
    window.addEventListener("lectern-projects-updated",sync);
    return () => window.removeEventListener("lectern-projects-updated",sync);
  }, [openSession,selectWorkspace,view]);

  useEffect(() => {
    if (snapshot) reportSnapshotApplied(snapshot);
  }, [snapshot]);

  async function loadEarlierMessages(cursor: string) {
    const revision = snapshotRevision.current;
    const stillSelected = () => sessionRequest.current === selectionGeneration &&
      selected.current.workspaceId === workspaceId && selected.current.sessionId === sessionId;
    if (!stillSelected()) return;
    try {
      const next = await window.desktop.loadEarlierMessages(workspaceId, sessionId, cursor, prefs.historyPageMiB);
      if (stillSelected() && snapshotRevision.current === revision &&
        next.workspaceId === workspaceId && next.sessionId === sessionId) setSnapshot(next);
    } catch (e) {
      if (stillSelected()) throw new Error(errorText(e));
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (primary && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();setSidebarOpen(true);requestAnimationFrame(()=>filterRef.current?.focus());return;
      }
      if (desktopState().active !== view) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "n" &&
        !workspaceModal &&
        !bindingOpen &&
        !helpOpen &&
        !diagnosticsOpen &&
        !historyImportOpen &&
        !busy
      ) {
        event.preventDefault();
        openDraft();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /** The add-folder dialog of this computer (none on Windows, which reaches SSH machines only). */
  function addLocalFolder() {
    const local = workspaceMachines(info.platform, prefs.connections, workspaces).find(machine => machine.endpoint.kind !== "ssh");
    if (local) setWorkspaceModal({ machine: local });
  }
  /** "New chat" anywhere: a draft in that folder. No tmux pane or Claude process
   * starts until its first message is sent (sendFromDraft). */
  function openDraft(target = workspace ?? (!primary ? primaryWorkspace : undefined), destination: ChatView = view) {
    if (!target) {
      // No folder yet: add one on this computer, or (on Windows) add an SSH machine first.
      if (!info.demo) { if (sshOnly(info.platform)) setPreferencesOpen("new-machine"); else addLocalFolder(); }
      return;
    }
    markNavigated();
    if (destination === view) enterDraft(target);
    else showChat(destination, { workspaceId: target.id, sessionId: "", title: "", draft: true });
  }

  /** Log in to an SSH machine, then reread its folders and the open conversation on it. */
  function loginTo(target: { host: string; port?: number }, label?: string) {
    const same = (item?: Workspace) => item?.kind === "ssh" && item.host === target.host && (item.port ?? 0) === (target.port ?? 0);
    openSshLogin(target, { label: label ?? machineLabel(target), onDone: () => {
      setMachineConnection(sshMachineKey(target.host, target.port), { state: "ok" });
      // Reconnected: whether tmux and Claude Code are there is asked again.
      void checkHostTools({ kind: "ssh", host: target.host, port: target.port }, { force: true });
      setError("");
      for (const item of workspacesRef.current) if (same(item)) void refresh(item.id);
      const open = workspacesRef.current.find(item => item.id === selected.current.workspaceId);
      if (same(open) && selected.current.sessionId) void openSession(open!.id, selected.current.sessionId);
    } });
  }

  /** The name the sidebar shows for an SSH machine. */
  function machineLabel(target: { host?: string; port?: number }) {
    const profile = prefs.connections.find(c => c.host === target.host && (c.port ?? 0) === (target.port ?? 0));
    return profile?.name || `${target.host ?? ""}${target.port ? `:${target.port}` : ""}`;
  }
  /** Going to a machine, folder or conversation in the sidebar is when a known
   * connection problem is worth a prompt; at startup it only shows in the sidebar. */
  function navigateTo(target?: { kind?: string; host?: string; port?: number }) {
    markNavigated();
    if (target?.kind === "local") ensureHostTools({ kind: "local" });
    if (target?.kind !== "ssh" || !target.host) { setMachinePrompt(undefined); return; }
    const key = sshMachineKey(target.host, target.port), status = connectionOf(key);
    // Switching to a machine checks its tools (unless it cannot be reached at all).
    if (status?.state !== "login" && status?.state !== "unreachable" && status?.state !== "unsupported") ensureHostTools({ kind: "ssh", host: target.host, port: target.port });
    setMachinePrompt(status?.state === "login" || status?.state === "unreachable" || status?.state === "unsupported"
      ? { key, host: target.host, port: target.port, label: machineLabel(target) } : undefined);
  }
  function recheckMachine(target: { host: string; port?: number }) {
    const key = sshMachineKey(target.host, target.port);
    void checkSshMachines([{ key, host: target.host, port: target.port, name: machineLabel(target), folders: 0 }], { force: true })
      .then(() => { if (connectionOf(key)?.state === "ok") void checkHostTools({ kind: "ssh", host: target.host, port: target.port }, { force: true }); });
    for (const item of workspacesRef.current) if (item.kind === "ssh" && item.host === target.host && (item.port ?? 0) === (target.port ?? 0)) void refresh(item.id);
  }

  /** Recheck from the notice. Once a check completes, folders refused for a missing tool
   * on this machine are read again, and an open conversation there is reopened. */
  function recheckHost(target: Workspace) {
    const key = machineKey(target);
    void checkHostTools(target, { force: true }).then(status => {
      if (status.state === "failed" || status.state === "checking") return;
      setErrorState(current => isMissingToolsError(current.text) ? { text: "" } : current);
      for (const item of workspacesRef.current) if (machineKey(item) === key) void refresh(item.id);
      const open = workspacesRef.current.find(item => item.id === selected.current.workspaceId);
      if (open && machineKey(open) === key && selected.current.sessionId) void openSession(open.id, selected.current.sessionId);
    });
  }

  async function resume() {
    markNavigated();
    if (!workspace || !sessionId || hostBlocked) return;
    const shown = snapshot?.workspaceId === workspace.id && snapshot.sessionId === sessionId;
    // Do not advance the selection: the transcript is keyed by it and would remount.
    // Opening another conversation meanwhile still advances it and ends this resume.
    const selectionRequest = sessionRequest.current;
    setBusy(true);
    setError("");
    try {
      const resumed = await window.desktop.resumeSession(
        workspace.id,
        sessionId,
      );
      if (
        sessionRequest.current !== selectionRequest ||
        selected.current.workspaceId !== workspace.id ||
        selected.current.sessionId !== sessionId
      )
        return;
      patchWorkspace(workspace.id, (current) => ({
        ...(current ?? { workspace, panes: [] }),
        sessions: (current?.sessions ?? []).map((item) =>
          item.id === sessionId ? resumed : item,
        ),
      }));
      // The loaded transcript stays on screen: the main process already re-read
      // this conversation and pushed the snapshot with the new pane. Only a pane
      // that never loaded it (an earlier read failed) opens it again.
      if (!shown) await openSession(workspace.id, sessionId);
    } catch (e) {
      if (sessionRequest.current === selectionRequest) setError(errorText(e));
      else reportActionError(e, "续接会话失败");
    } finally {
      setBusy(false);
    }
  }

  async function closeConversation() {
    if (!workspace || !sessionId || !paneId || !snapshot?.panePid || busy) return;
    const selectionRequest = sessionRequest.current, panePid = snapshot.panePid;
    // Closing ends this pane's Claude Code: always confirm, naming the work it stops.
    const replying = activeStatus === "working" || !!snapshot.turnControls?.running;
    if (!await confirmAction(closeConfirmation(replying, snapshot.backgroundWork))) return;
    // Another chat or pane by now: this confirmation was not about it.
    if (sessionRequest.current !== selectionRequest || selected.current.sessionId !== sessionId) return;
    setBusy(true);
    setError("");
    try {
      const history = await window.desktop.closeSession(workspace.id, sessionId, paneId, panePid);
      patchWorkspace(workspace.id, (current) => ({
        workspace,
        ...current,
        panes: (current?.panes ?? []).filter(item => item.id !== paneId),
        sessions: history
          ? [history, ...(current?.sessions ?? []).filter(item => item.id !== sessionId)]
          : (current?.sessions ?? []).filter(item => item.id !== sessionId),
      }));
      if (sessionRequest.current !== selectionRequest) return;
      setTerminalOpen(false);
      // Saved history stays on screen: the main process kept this conversation's reader
      // and already pushed it without its pane. Opening it again would blank the chat
      // and remount the transcript (keyed by the selection) until a fresh read arrived.
      if (history && history.id !== sessionId) await openSession(workspace.id, history.id);
      else if (!history) {
        // Nothing was written, so this chat disappears: its typed text, or a first
        // message still waiting for Claude, goes back to the folder's new chat.
        const key = draftKey(workspace.id, sessionId), pending = launchRef.current?.sessionId === sessionId ? launchRef.current : undefined;
        const text = mergeDraft(unsentDrafts.get(key) ?? "", pending?.text ?? "");
        unsentDrafts.delete(key);
        if (pending) { setOutgoing(o => o?.id === pending.id ? undefined : o); setLaunch(undefined); }
        backToDraft(workspace, text, pending?.choices ?? {});
      }
    } catch (e) {
      if (sessionRequest.current === selectionRequest) setError(errorText(e));
      else reportActionError(e, "关闭对话失败");
    } finally {
      setBusy(false);
    }
  }

  async function fork(binding: { paneId: string; panePid: number }) {
    if (!workspace || !sessionId || sending) return;
    const request = sessionRequest.current;
    const stillSelected = () => sessionRequest.current === request && selected.current.workspaceId === workspace.id && selected.current.sessionId === sessionId;
    setSending(true);
    setError('');
    try {
      const result = await window.desktop.forkSession(workspace.id, sessionId, binding.paneId, binding.panePid);
      patchWorkspace(workspace.id, current => ({
        ...(current ?? { workspace, panes: [] }),
        sessions: [result.fork, result.original, ...(current?.sessions ?? []).filter(item => item.id !== result.fork.id && item.id !== result.original.id)],
      }));
      void refresh(workspace.id);
      const key = draftKey(workspace.id, sessionId);
      if (unsentDrafts.get(key)?.trim() === '/fork') unsentDrafts.delete(key);
      if (stillSelected()) await openSession(workspace.id, result.fork.id);
    } catch (e) {
      if (stillSelected()) setError(errorText(e));
      else reportActionError(e, '分支操作失败');
    } finally { setSending(false); }
  }

  /** The first message of a new chat: start Claude Code in this folder (with the
   * draft's model and effort for this session only), then hand the message over
   * once its input box is ready (the effect below). Nothing runs before this. */
  async function sendFromDraft() {
    const target = workspace;
    if (!target || sessionId || launch || busy || hostBlocked || !draft.trim()) return;
    const text = draft, command = text.trim(), policy = commandPolicy(command);
    if (policy.kind === 'block') { setError(policy.message, target); return; }
    if (policy.kind === 'route' && (policy.target === 'model' || policy.target === 'effort')) {
      setDraft(''); composerContext.current?.querySelector<HTMLButtonElement>(`button[data-setting-kind="${policy.target}"]`)?.click();
      return;
    }
    if (policy.kind === 'route') { setError(t('app.draftNoRewind'), target); return; }
    const id = `outgoing:${Date.now()}`, choices = draftChoices, request = sessionRequest.current;
    // Used by this launch only; they come back if it does not start.
    launchChoicesByFolder.delete(target.id);
    const pending = showsOutgoing(text) ? startOutgoing(`${target.id}:`, text, [], id) : undefined;
    if (pending) setOutgoing(pending);
    setDraft('');
    setError('');
    setBusy(true);
    setLaunch({ id, workspaceId: target.id, text, choices, phase: 'creating', startedAt: Date.now() });
    try {
      const next = await window.desktop.createSession(target.id, { ...choices, validateMessage: text });
      patchWorkspace(target.id, current => ({ ...(current ?? { workspace: target, panes: [] }),
        sessions: [next, ...(current?.sessions ?? []).filter(item => item.id !== next.id)] }));
      if (!mounted.current || sessionRequest.current !== request || selected.current.workspaceId !== target.id || selected.current.sessionId) {
        // The user went elsewhere meanwhile, or this pane closed: the message waits
        // in the new chat's input box (nothing is opened or watched from here).
        unsentDrafts.set(draftKey(target.id, next.id), text);
        setOutgoing(current => current?.id === id ? undefined : current);
        setLaunch(undefined);
        if (selected.current.workspaceId === target.id && !selected.current.sessionId) setDraftChoicesState(launchChoicesByFolder.get(target.id) ?? {});
        showToast(t('app.chatStartedMessageKept'));
        return;
      }
      setDraftChoices({});
      if (pending) setOutgoing({ ...pending, scope: `${target.id}:${next.id}` });
      const opening = openSession(target.id, next.id);
      setLaunch({ id, workspaceId: target.id, text, choices, phase: 'waiting', sessionId: next.id, startedAt: Date.now() });
      await opening;
    } catch (e) {
      setOutgoing(current => current?.id === id ? undefined : current);
      setLaunch(undefined);
      keepLaunchChoices(target.id, choices);
      // Still (or again) in this folder's new chat, even if it was reopened meanwhile:
      // the text and choices come back where the user sees them.
      if (mounted.current && selected.current.workspaceId === target.id && !selected.current.sessionId) {
        setDraft(current => mergeDraft(current, text));
        setDraftChoicesState(launchChoicesByFolder.get(target.id) ?? {});
        setError(errorText(e), target);
      } else {
        const key = draftKey(target.id, '');
        unsentDrafts.set(key, mergeDraft(unsentDrafts.get(key) ?? '', text));
        reportActionError(e, '新建会话失败');
        if (!mounted.current) showToast(t('app.chatStartFailedFolder'));
      }
    } finally { setBusy(false); }
  }

  async function send(mode: "queue" | "steer" = "queue") {
    if (isDraft && !sessionId) { await sendFromDraft(); return; }
    if (!workspace || !sessionId || !draft.trim() || sending || !canSend)
      return;
    const text = draft;
    const command = text.trim();
    const policy = commandPolicy(command);
    if (policy.kind === 'block') { setError(policy.message); return; }
    if (policy.kind === 'route' && (policy.target === 'model' || policy.target === 'effort')) {
      // Lectern drives these pickers itself; typing them would leave the chat waiting on a native menu.
      const trigger = composerContext.current?.querySelector<HTMLButtonElement>(`button[data-setting-kind="${policy.target}"]`);
      if (!trigger || trigger.disabled) { setError(t('app.cannotSwitchNow', { target: policy.target })); return; }
      setDraft(''); trigger.click();
      return;
    }
    if (policy.kind === 'route') {
      if (!canRewind || !paneId || !snapshot?.panePid) setError(t('app.rewindWhenReady'));
      else if (policy.target === 'fork') await fork({ paneId, panePid: snapshot.panePid });
      else { setDraft(''); openRewind(); }
      return;
    }
    const request = sessionRequest.current;
    const stillSelected = () => sessionRequest.current === request && selected.current.workspaceId === workspace.id && selected.current.sessionId === sessionId;
    setSending(true);
    setError("");
    // Like the native client, the composer clears and a plain message shows
    // at once; the main process still reports success only after typing it.
    const turnInput = !!(paneId && snapshot?.panePid && (inTurn || restoredDraft));
    const pending = !turnInput && showsOutgoing(text)
      ? startOutgoing(`${workspace.id}:${sessionId}`, text, snapshot?.messages, `outgoing:${Date.now()}`) : undefined;
    if (pending) setOutgoing(pending);
    setDraft(current => (current === text ? "" : current));
    transcript.current?.scrollToLatest();
    try {
      if (turnInput && paneId && snapshot?.panePid) {
        const action: TurnAction = restoredDraft ? {kind:'sendRestored',text,original:restoredDraft} : {kind:mode,text};
        await window.desktop.turnAction(workspace.id,sessionId,paneId,snapshot.panePid,action);
      } else await window.desktop.sendMessage(workspace.id, sessionId, text);
      if (
        selected.current.workspaceId === workspace.id &&
        selected.current.sessionId === sessionId
      ) {
        transcript.current?.scrollToLatest();
        inputRef.current?.focus();
      }
      // The controller's bubble normally replaces it at once; never leave one behind.
      if (pending) setTimeout(() => setOutgoing(current => (current === pending ? undefined : current)), 8000);
    } catch (e) {
      if (pending) setOutgoing(current => (current === pending ? undefined : current));
      // Nothing was sent: give the text back unless the user typed something new.
      if (stillSelected()) { setDraft(current => (current ? current : text)); setError(errorText(e)); }
      else reportActionError(e, '操作原会话时出错');
    } finally {
      setSending(false);
    }
  }

  async function actOnTurn(action: TurnAction) {
    if (!workspace || !sessionId || !paneId || !snapshot?.panePid || sending || question || questionBusy) return;
    setSending(true);
    setError("");
    try {
      await window.desktop.turnAction(workspace.id,sessionId,paneId,snapshot.panePid,action);
    } catch (e) {
      if (selected.current.workspaceId === workspace.id && selected.current.sessionId === sessionId) setError(errorText(e));
    } finally { setSending(false); }
  }

  async function saveWorkspace(next: Workspace) {
    markNavigated();
    if (info.demo)
      throw new Error(
        t('app.demoAddFolder'),
      );
    if (findImportedWorkspace(workspacesRef.current.filter(w => w.id !== next.id), next, next.cwd))
      throw new Error(t('app.folderExists'));
    const saved = await window.desktop.saveWorkspace(next);
    // The folder opens in the pane the user works in; another pane opens it once it has the new list.
    const destination = desktopState().active;
    window.dispatchEvent(new CustomEvent("lectern-projects-updated",{detail:{source:view,saved:saved.id,open:destination !== view ? destination : undefined}}));
    trackWorkspace(saved);
    setWorkspaces((current) =>
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved],
    );
    if (destination === view) selectWorkspace(saved);
  }

  /** A new folder lists its saved conversations only after the user asks. */
  async function scanHistory(target: Workspace) {
    markNavigated();
    try {
      const saved = await window.desktop.enableHistoryScan(target.id);
      // A changed workspace signature drops any discovery started before the flag flipped.
      trackWorkspace(saved);
      setWorkspaces(current => current.map(item => item.id === saved.id ? saved : item));
      const result = await refresh(saved.id);
      // The active pane shows this folder with nothing open: show its newest conversation, as on selection.
      const shown = desktopState().panes[desktopState().active];
      if (result?.sessions.length && shown?.workspaceId === saved.id && !shown.sessionId) selectFromTree(saved, result.sessions[0].id);
    } catch (e) { setError(errorText(e), target); }
  }

  /** "> " quoted lines appended to the draft, then the caret goes to its end. */
  function quoteIntoComposer(text: string) {
    const quoted = text.trim().split("\n").map(line => line ? `> ${line}` : ">").join("\n");
    setDraft(current => `${current.trimEnd() ? current.trimEnd() + "\n\n" : ""}${quoted}\n\n`);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  /** Rename without changing what either pane shows; an open conversation is re-read. */
  async function renameWorkspace(next: Workspace) {
    const saved = await window.desktop.saveWorkspace(next);
    window.dispatchEvent(new CustomEvent("lectern-projects-updated",{detail:{source:view,saved:saved.id}}));
    trackWorkspace(saved);
    setWorkspaces(current => current.map(item => item.id === saved.id ? saved : item));
    void refresh(saved.id);
    if (selected.current.workspaceId === saved.id && selected.current.sessionId) void openSession(saved.id, selected.current.sessionId);
  }

  /** Out of Lectern's sidebar only; the conversation's files on the target stay. */
  function archiveTreeSession(target: Workspace, chat: SessionInfo) {
    archiveSession({ workspaceId: target.id, sessionId: chat.id, title: chat.title || t('app.newChat') });
    for (const pane of ["primary", "secondary"] as const) {
      if (!sameChat(desktopState().panes[pane], { workspaceId: target.id, sessionId: chat.id, title: "" })) continue;
      if (pane === view) selectWorkspace(target);
      else showChat(pane, { workspaceId: target.id, sessionId: "", title: "" });
    }
    showToast(t('app.archived'));
  }

  const menuActions: SidebarMenuActions = {
    platform: info.platform, demo: !!info.demo, busy, connections: prefs.connections,
    addFolder: machine => setWorkspaceModal({ machine }),
    login: machine => machine.endpoint.host && loginTo({ host: machine.endpoint.host, port: machine.endpoint.port }, machine.name),
    editConnections: () => setPreferencesOpen(true),
    importHistory: () => setHistoryImportOpen(true),
    newSession: target => { navigateTo(target); openDraft(target, prefs.active); },
    refresh: target => void refresh(target.id),
    scanHistory: target => void scanHistory(target),
    editWorkspace: target => setWorkspaceModal(target),
    saveWorkspace: renameWorkspace,
    removeWorkspace,
    open: (target, id) => selectFromTree(target, id),
    openBeside: (target, chat) => splitChat({ workspaceId: target.id, sessionId: chat.id, title: chat.title || t('app.chat') }, "right"),
    archiveSession: archiveTreeSession,
  };

  async function removeWorkspace(id: string) {
    markNavigated();
    if (info.demo) throw new Error(t('app.demoCannotRemove'));
    await window.desktop.removeWorkspace(id);
    forgetWorkspace(id);
    forgetProject(id);
    window.dispatchEvent(new Event("lectern-projects-updated"));
    const remaining = workspaces.filter((item) => item.id !== id);
    setWorkspaces(remaining);
    if (workspaceId === id) {
      if (remaining.length) selectWorkspace(remaining[0]);
      else {
        ++sessionRequest.current;
        selected.current = { workspaceId: "", sessionId: "" };
        setDiagnosticContext();
        setWorkspaceId("");
        setSessionId("");
        setSnapshot(undefined);
        await window.desktop.unwatchSession(view);
      }
    }
  }

  async function importHistoryProjects(
    target: HistoryTarget,
    projects: HistoryProject[],
    resolvedClaudeDir: string,
  ) {
    markNavigated();
    if (info.demo)
      throw new Error(
        t('app.demoNoDiscover'),
      );
    const inventory = await window.desktop.listWorkspaces();
    let firstWorkspace: Workspace | undefined;
    try {
      for (const project of projects) {
        if (!project.exists) continue;
        const existing = findImportedWorkspace(
          inventory,
          target,
          project.cwd,
          resolvedClaudeDir,
        );
        if (existing) {
          firstWorkspace ??= existing;
          continue;
        }
        const saved = await window.desktop.saveWorkspace({
          ...target,
          id: crypto.randomUUID(),
          name: project.cwd.split("/").filter(Boolean).at(-1) || project.cwd,
          cwd: project.cwd,
        });
        inventory.push(saved);
        firstWorkspace ??= saved;
      }
    } finally {
      // Reflect each successful save even if a later directory fails to import.
      setWorkspaces(inventory);
      window.dispatchEvent(new Event("lectern-projects-updated"));
      if (firstWorkspace) selectWorkspace(firstWorkspace);
    }
  }

  const visibleSelection = prefs.panes[prefs.active];
  // A new chat can move to another folder on the same machine.
  const sameMachineFolders = workspace ? workspaces.filter(item => machineKey(item) === machineKey(workspace)) : [];
  const archivedKeys = new Set(prefs.archivedSessions.map(a => archiveKey(a.workspaceId, a.sessionId)));
  const alternativeSession = Object.values(workspaceStates).flatMap(entry => (entry.data?.sessions || [])
    .filter(chat => chat.paneId || !archivedKeys.has(archiveKey(entry.data!.workspace.id, chat.id))).map(chat => ({
    workspaceId:entry.data!.workspace.id,sessionId:chat.id,title:chat.title || t('app.chat'),
  }))).find(chat=>!sameChat(chat,prefs.panes[view])) || null;
  function selectFromTree(w:Workspace,id:string) {
    navigateTo(w);
    expandWorkspace(w);
    const chat:ChatTarget={workspaceId:w.id,sessionId:id,title:workspaceStates[w.id]?.data?.sessions.find(c=>c.id===id)?.title || t('app.chat')};
    const destination = desktopState().active;
    // A conversation shows in one pane at most: one already open in the other pane gets the focus there.
    const shown = shownIn(desktopState(), chat);
    if (shown) {
      focusChat(shown);
      window.dispatchEvent(new CustomEvent("lectern-return-to-chat", { detail: shown }));
      return;
    }
    showChat(destination,chat);
    if (destination === view && (selected.current.workspaceId !== w.id || selected.current.sessionId !== id))
      void openSession(w.id,id);
  }
  useEffect(() => {
    const returnToChat = (event: Event) => {
      if ((event as CustomEvent<ChatView>).detail === view) setArtifact(undefined);
    };
    window.addEventListener("lectern-return-to-chat", returnToChat);
    return () => window.removeEventListener("lectern-return-to-chat", returnToChat);
  }, [view]);
  const bannerText = error || snapshot?.error || workspaceError;
  const bannerOrigin = error ? errorState.origin ?? workspace : workspace;
  // At startup a machine that is not connected shows only in the sidebar: what
  // was restored from last time raises no connection prompt until the user
  // goes somewhere (a machine, folder or conversation) or acts on a folder.
  const quietBanner = !navigated && sshConnectionError(bannerText)
    // The machine's notice below already says what is missing and how to install it.
    || isMissingToolsError(bannerText) && hostLacks.length > 0;
  const hostConnection = workspace?.kind === "ssh" ? connectionOf(sshMachineKey(workspace.host ?? "", workspace.port))?.state : undefined;
  const promptStatus = machinePrompt && connectionOf(machinePrompt.key);
  const promptConnection = promptStatus && (promptStatus.state === "login" || promptStatus.state === "unreachable" || promptStatus.state === "unsupported")
    // The error above already names this machine and offers its login.
    && !(bannerText && !quietBanner && sshConnectionError(bannerText) && bannerOrigin?.kind === "ssh"
      && sshMachineKey(bannerOrigin.host ?? "", bannerOrigin.port) === machinePrompt.key) ? promptStatus : undefined;
  const content = (
    <div data-platform={info.platform} className={`app-shell${primary ? "" : " desk-secondary"}${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <div className="conversation-layout">
      {primary && <ResizableSidebar>
        <div className="sidebar-brand">
          <LecternMark className="brand-mark" small />
          <span>Lectern</span>
        </div>
        <button
          className="new-chat-button"
          onClick={() => openDraft(workspaces.find(w => w.id === visibleSelection?.workspaceId) ?? workspace, prefs.active)}
        >
          <SquarePen size={17} />
          {t('app.newChatButton')}<span>{info.platform === "darwin" ? "⌘ N" : "Ctrl N"}</span>
        </button>
        <label className="project-filter"><Search size={14}/><input ref={filterRef} aria-label={t('app.filter')} placeholder={t('app.filter')} value={filter} onChange={e=>setFilter(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"){setFilter("");e.currentTarget.blur();}}}/></label>
        <div className="sidebar-section-heading">
          <span>{t('app.machines')}</span>
          <div className="sidebar-heading-actions">
          <SidebarSortButton mode={prefs.sidebarSort} />
          {!sshOnly(info.platform) && <button
            className="icon-button"
            aria-label={t('app.discoverLocal')}
            onClick={() => setHistoryImportOpen(true)}
            disabled={info.demo}
            title={
              info.demo
                ? t('app.discoverDemo')
                : t('app.discoverTitle')
            }
          >
            <History size={15} />
          </button>}
          <button className="machine-create" aria-label={t('app.addSshMachine')} title={t('app.addSshMachine')} disabled={info.demo}
            onClick={() => setPreferencesOpen("new-machine")}><Plus size={12}/>SSH</button>
          </div>
        </div>
        <SidebarTree
          platform={info.platform}
          onAddFolder={machine => setWorkspaceModal({ machine })}
          filter={filter}
          workspaces={workspaces}
          states={workspaceStates}
          expanded={expandedWorkspaces}
          workspaceId={visibleSelection?.workspaceId ?? workspaceId}
          sessionId={visibleSelection?.sessionId ?? sessionId}
          snapshot={snapshot}
          otherSnapshot={prefs.split && prefs.panes.secondary?.sessionId === otherSnapshot?.sessionId && prefs.panes.secondary?.workspaceId === otherSnapshot?.workspaceId ? otherSnapshot : undefined}
          busy={busy}
          demo={info.demo}
          onToggle={target => { navigateTo(target); toggleWorkspace(target); }}
          onSelect={selectFromTree}
          onNavigateMachine={machine => navigateTo(machine.endpoint)}
          onOpenDraft={target => { navigateTo(target); openDraft(target, prefs.active); }}
          onOpenMachine={machine => {
            if (machine.folders.length) openDraft(machine.folders[0], prefs.active);
            else if (!info.demo) setWorkspaceModal({ machine });
          }}
          draftWorkspaceId={visibleSelection?.draft ? visibleSelection.workspaceId : undefined}
          onRename={async (id, chat, title) => {
            try {
              await renameTreeSession(id, chat, title);
            } catch (error) {
              throw new Error(errorText(error));
            }
          }}
          onRefresh={(id) => {
            void refresh(id);
          }}
          onNew={(target) => {
            navigateTo(target);
            openDraft(target, prefs.active);
          }}
          onEdit={setWorkspaceModal}
          onLogin={machine => machine.endpoint.host && loginTo({ host: machine.endpoint.host, port: machine.endpoint.port }, machine.name)}
          onScanHistory={target => void scanHistory(target)}
          menuActions={menuActions}
        />
        <div className="sidebar-bottom">
          <button className="help-button" aria-label={t('app.settingsTitle')} title={t('app.settingsTitle')} onClick={()=>setPreferencesOpen(true)}><Settings2 size={16}/><span>{t('app.settings')}</span></button>
          <button className="help-button" aria-label={t('app.guide')} title={t('app.guide')} onClick={() => setHelpOpen(true)}>
            <CircleHelp size={16} />
          </button>
          <button className="help-button" aria-label={t('app.diagnostics')} title={t('app.diagnosticsTitle')} onClick={() => setDiagnosticsOpen(true)}>
            <Bug size={16} />
          </button>
          <span className="version">{info.version && "v" + info.version}</span>
          <button className="release-notes-button" type="button" title={t('app.releaseNotesTitle')} onClick={() => setReleaseNotesOpen(true)}>{t('app.releaseNotes')}</button>
        </div>
      </ResizableSidebar>}

      <SplitWorkspace view={view} second={primary && prefs.split ? <App view="secondary"/> : null}>
      <main className={`main-area${drawer || taskShown ? " artifact-open" : ""}`} {...attachments.dropTarget}>
        <header className="topbar">
          <div className="topbar-left">
            <span className="topbar-title" title={session?.title || workspace?.name}>
              {session?.title || (sessionId ? t('app.newChat') : workspace?.name || t('app.chat'))}
            </span>
            {info.demo && <span className="demo-badge">{t('app.demoBadge')}</span>}
          </div>
          <div className="topbar-actions">
            <SplitButtons view={view} alternative={alternativeSession}/>
            {!info.demo && workspace?.kind === "local" && <button type="button" className="toolbar-button"
              title={t('codex.open')} aria-label={t('codex.open')} aria-haspopup="dialog"
              onClick={() => setCodexWorkspaceId(workspace.id)}>Codex</button>}
            {hasHandoff && <button type="button" className="toolbar-button" aria-label={t('app.handoff')} title={t('app.handoffTitle')} aria-haspopup="dialog"
              onClick={() => setHandoffScope(activityScope)}><History size={16} /><span>{t('app.handoff')}</span></button>}
            {sessionId && <button className={`toolbar-button${activityShown ? " selected" : ""}`} title={t('app.activityTitle')} aria-label={t('app.activityTitle')} aria-expanded={activityShown}
              onClick={() => setActivityChoice({ scope: activityScope, open: !activityShown })}>
              <Activity size={16} /><span>{t('app.activity')}</span>{activeCount > 0 && <b className="activity-toolbar-count">{activeCount}</b>}</button>}
            {workspace && <button className={`toolbar-button${drawer ? " selected" : ""}`} aria-label={t('app.browseFolder')} title={t('app.browseFolder')} aria-expanded={!!drawer}
              onClick={() => drawer ? closeArtifact() : openArtifact({ path: "." })}><Folder size={16} /><span>{t('app.files')}</span></button>}
            {sessionId && (
              <>
                <button
                  className={`toolbar-button${terminalOpen ? " selected" : ""}`}
                  onClick={() => {
                    if (terminalOpen) terminalPanelRef.current?.close();
                    else setTerminalOpen(true);
                  }}
                  aria-pressed={terminalOpen}
                  title={t('app.terminalTitle')}
                >
                  <Terminal size={16} />
                  <span>{t('app.terminal')}</span>
                </button>
                <button
                  className="icon-button"
                  onClick={() => {
                    setBindingOpen(true);
                    if (workspace) void refresh(workspace.id);
                  }}
                  title={t('app.bindTmux')}
                  aria-label={t('app.bindTmux')}
                >
                  <Link2 size={17} />
                </button>
                <div className="toolbar-divider" />
                {/* Mounted while the chat has a pane, so the buttons left of it never move under the pointer. */}
                {paneId && (
                  <button
                    className="toolbar-button"
                    disabled={!snapshot?.panePid || busy || sending || settingUIBusy || snapshot.settingBusy || snapshot.trustBusy || questionBusy || terminalLocked}
                    onClick={() => void closeConversation()}
                    title={t('app.closeChatTitle')}
                    aria-label={t('app.closeChatLabel')}
                  >
                    <Unplug size={16} />
                    <span>{t('app.closeChat')}</span>
                  </button>
                )}
              </>
            )}
            <span
              className={`connection-status status-${navigationState?.kind === "history" || navigationState?.kind === "unknown" ? "offline" : (navigationState?.kind ?? activeStatus)}`}
              title={navigationState?.background ? navigationState.detail : undefined}
            >
              <span className="connection-dot" />
              {/* As wide as its longest state, so state changes never shift the toolbar. */}
              <span className="connection-label">
                <span>{sessionId
                  ? navigationState?.kind === "history"
                    ? t('app.history')
                    : navigationState?.kind === "unknown"
                      ? t('app.statusUnconfirmed')
                      : navigationState?.kind === "error"
                        ? t('app.sessionError')
                        : navigationState?.background ? t('app.backgroundRunning') : t(statusLabels[activeStatus])
                  : !workspace ? t('app.statusOffline')
                    : workspace.kind === "ssh" ? t('app.sshConnection') : t('app.localConnection')}</span>
                {sessionId && sessionStateKeys.map(key => <i key={key} aria-hidden="true" data-text={t(key)} />)}
              </span>
            </span>
          </div>
        </header>
        {info.demo && (
          <div className="notice-banner demo-notice" role="status">
            <span>
              {rich('app.demoNotice', { command: <code>npm start</code> })}
            </span>
          </div>
        )}
        {bannerText && !quietBanner && (
          <div className="error-banner" role="alert">
            <Unplug size={17} />
            <span>{bannerText}</span>
            {bannerOrigin?.kind === "ssh" && bannerOrigin.host && needsSshLogin(bannerText) && <button
              onClick={() => loginTo({ host: bannerOrigin.host!, port: bannerOrigin.port })}>{t('app.login', { machine: machineLabel(bannerOrigin) })}</button>}
            <button
              onClick={() => {
                if (error && errorState.origin && errorState.origin.id !== workspace?.id) {
                  setError("");
                  void refresh(errorState.origin.id);
                } else if (workspace) {
                  if (sessionId) {
                    void refresh(workspace.id);
                    void openSession(workspace.id, sessionId);
                  } else if (selected.current.draft) {
                    // A new chat stays a new chat: its text is still in the input box.
                    setError("");
                    void refresh(workspace.id);
                  } else selectWorkspace(workspace);
                }
              }}
            >
              {t('app.retry')}
            </button>
            <button
              className="icon-button"
              aria-label={t('app.dismissError')}
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {promptConnection && (
          <div className="machine-prompt" role="alert" data-machine-key={machinePrompt!.key}>
            <Unplug size={17} />
            {/* A Windows (or other unsupported) target needs no login: only the explanation. */}
            <span>{promptConnection.state === "unsupported" ? promptConnection.message
              : t('app.promptLine', { problem: t(promptConnection.state === "login" ? 'app.notLoggedIn' : 'app.cannotConnect', { machine: machinePrompt!.label }), message: promptConnection.message })}</span>
            {promptConnection.state !== "unsupported" && <button onClick={() => loginTo({ host: machinePrompt!.host, port: machinePrompt!.port }, machinePrompt!.label)}>{t('app.login', { machine: machinePrompt!.label })}</button>}
            <button onClick={() => recheckMachine(machinePrompt!)}>{t('app.retry')}</button>
            <button className="icon-button" aria-label={t('app.dismissPrompt')} onClick={() => setMachinePrompt(undefined)}>
              <X size={15} />
            </button>
          </div>
        )}
        {workspace && hostStatus && <HostToolsNotice machineKey={machineKey(workspace)} machine={hostName} status={hostStatus} onRecheck={() => recheckHost(workspace)}/>}
        {/* A connection problem shows as the machine's own prompt; anything else that stopped the check is said here. */}
        {workspace && hostStatus?.state === "failed" && hostConnection !== "login" && hostConnection !== "unreachable" && hostConnection !== "unsupported" &&
          <HostCheckFailed machine={hostName} message={hostStatus.message} onRecheck={() => recheckHost(workspace)}/>}
        {workspace && hostStatus?.state === "ok" && <OutdatedClaude machineKey={machineKey(workspace)} machine={hostName} tools={hostStatus.tools}/>}
        {discovery?.diagnostic && (
          <div className="notice-banner">{discovery.diagnostic}</div>
        )}
        {!!discovery?.panes.filter((pane) => pane.active && !pane.sessionId)
          .length &&
          !discovery.sessions.length && (
            <div className="notice-banner">
              {t('app.unboundTerminal')}
            </div>
          )}
        {snapshot?.notice && (
          <div className="notice-banner">{snapshot.notice}</div>
        )}
        {activeStatus === "waiting" && !directoryTrust && !question && !permission && (
          <div className="waiting-banner">
            <Terminal size={16} />
            <span>
              {t('app.waitingTakeOver', { detail: snapshot?.navigationStatus === "waiting" && snapshot.navigationStatusDetail || t('app.waitingInput') })}
            </span>
            <button onClick={() => setTerminalOpen(true)}>{t('app.viewTerminal')}</button>
          </div>
        )}

        {/* The conversation scrolls the full height; the input area floats over its bottom. */}
        <div className="conversation-stage">
        <LiveShells.Provider value={liveShells}>
        <ConversationTranscript key={selectionGeneration} ref={transcript} dock={composerDock} workspace={workspace} sessionId={snapshot?.sessionId} replyDetail={prefs.replyDetail} onFollowLatest={setFollowingLatest}
          tasks={snapshot?.tasks} messages={displayedMessages} historyPage={snapshot?.historyPage} loadEarlier={loadEarlierMessages} openArtifact={openArtifact}
          onRewind={canRewind ? uuid => void actOnTurn({ kind: 'rewindTo', uuid }) : undefined}
          onQuote={snapshot?.sessionId ? quoteIntoComposer : undefined}
          overlay={sessionId && workspace ? <ActivityFloat key={activityScope} workspaceId={workspace.id} folderName={workspace.name} items={items}
            attachments={activityAttachments} sessionId={sessionId} refreshKey={activityRefresh} choice={activityAsked} cliVersion={snapshot?.cliVersion}
            machine={{ name: machineName(workspace, info.platform, prefs.connections), remote: workspace.kind === "ssh" }}
            onChoice={open => setActivityChoice({ scope: activityScope, open })} onShownChange={setActivityShown}
            onOpenPath={path => openArtifact({ path })} onOpenAttachment={file => openArtifact(file.path ? { path: file.path } : { attachment: file })}
            onOpenTask={openTask} /> : undefined}>
            <div className="welcome">
              <LecternMark className="welcome-symbol" />
              <h1>{workspace ? t('app.startNewChat') : primary ? t('app.addProjectFolder') : t('app.chooseSplitChat')}</h1>
              <p>{workspace ? (folderResolving ? t('app.readingFolder') : t('app.firstMessageHint'))
                : primary ? (sshOnly(info.platform) ? t('app.welcomeWindows')
                  : t('app.welcomeIntro')) : t('app.splitHint')}</p>
              {workspace ? (
                <div className="welcome-workspace">
                  <span>
                    {workspace.kind === "ssh" ? (
                      <Server size={16} />
                    ) : (
                      <Folder size={16} />
                    )}
                  </span>
                  <div>
                    <strong>{workspace.name}</strong>
                    <code>{workspace.cwd}</code>
                  </div>
                  {sameMachineFolders.length > 1 && isDraft && !launch ? <select className="welcome-folder-switch" aria-label={t('app.draftFolder')}
                    value={workspace.id} onChange={event => {
                      const next = sameMachineFolders.find(item => item.id === event.target.value);
                      if (!next) return;
                      // The typed text and choices move with the new chat (not copied,
                      // and not over text already waiting in that folder).
                      const from = draftKey(workspace.id, ""), to = draftKey(next.id, "");
                      if (draft) unsentDrafts.set(to, mergeDraft(unsentDrafts.get(to) ?? "", draft));
                      unsentDrafts.delete(from);
                      if (!launchChoicesByFolder.has(next.id)) keepLaunchChoices(next.id, draftChoices);
                      launchChoicesByFolder.delete(workspace.id);
                      openDraft(next);
                    }}>
                    {sameMachineFolders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select> : <Check size={15} />}
                </div>
              ) : !primary ? (
                primaryWorkspace && <button className="secondary-button" onClick={() => openDraft(primaryWorkspace)}>
                  <Plus size={16}/>{t('app.newChatIn', { name: primaryWorkspace.name })}
                </button>
              ) : (
                <div className="welcome-connect-actions">
                  {!sshOnly(info.platform) && <>
                  <button className="primary-button" onClick={() => setHistoryImportOpen(true)} disabled={info.demo}
                    title={t('app.scanTitle')}>
                    <History size={17} />
                    {t('app.scanLocal')}
                  </button>
                  <button className="secondary-button" onClick={addLocalFolder} disabled={info.demo}>
                    <FolderPlus size={17} />
                    {t('app.addLocalFolder')}
                  </button>
                  </>}
                  <button className={sshOnly(info.platform) ? "primary-button" : "secondary-button"} onClick={() => setPreferencesOpen("new-machine")} disabled={info.demo}>
                    <Server size={17} />
                    {t('app.addSsh')}
                  </button>
                </div>
              )}
            </div>
        </ConversationTranscript>
        </LiveShells.Provider>

        <div ref={setComposerDock} onWheel={event => transcript.current?.wheelFromDock(event.nativeEvent)}
          className={`composer-area${question || permission ? " composer-has-question" : ""}${directoryTrust ? " composer-has-trust" : ""}${terminalOpen ? " composer-has-terminal" : ""}${terminalLocked ? " composer-has-manual-terminal" : ""}`}
        >
          {terminalOpen && (
            <TerminalPanel
              key={settingScope}
              ref={terminalPanelRef}
              workspaceId={workspaceId}
              sessionId={sessionId}
              screen={snapshot?.viewport ?? snapshot?.screen ?? ""}
              frame={snapshot?.terminalFrame}
              paneId={paneId}
              status={activeStatus}
              capturedAt={snapshot?.screenCapturedAt}
              observationStatus={snapshot?.navigationStatus}
              control={snapshot?.terminalControl}
              automatedBusy={
                questionBusy || snapshot?.trustBusy ||
                snapshot?.settingBusy ||
                settingUIBusy ||
                busy ||
                sending
              }
              onBusyChange={(value) =>
                setTerminalOperationBusy(settingScope, value)
              }
              onClose={() => setTerminalOpen(false)}
            />
          )}
          {question && !terminalOpen && (terminalLocked ?
            <div className="resume-bar"><span>{t('app.questionInTerminal')}</span><button onClick={() => setTerminalOpen(true)}>{t('app.viewTerminal')}</button></div> :
            <QuestionCard key={JSON.stringify([workspaceId, sessionId, paneId, snapshot?.panePid, question.interactionId])}
              question={question} unconfirmed={snapshot?.questionUnconfirmed} busy={questionBusy || busy || sending || settingUIBusy || !!snapshot?.settingBusy || !!snapshot?.trustBusy}
              onAction={answerQuestion} onViewTerminal={() => setTerminalOpen(true)} />)}
          {permission && !terminalOpen && (terminalLocked ?
            <div className="resume-bar"><span>{t('app.permissionInTerminal')}</span><button onClick={() => setTerminalOpen(true)}>{t('app.viewTerminal')}</button></div> :
            <PermissionCard key={JSON.stringify([workspaceId, sessionId, paneId, snapshot?.panePid, permission.toolUseId, permission.kind])}
              permission={permission} unconfirmed={snapshot?.permissionUnconfirmed} busy={permissionBusy || busy || sending || settingUIBusy || !!snapshot?.settingBusy || !!snapshot?.trustBusy}
              onAction={answerPermission} onViewTerminal={() => setTerminalOpen(true)} />)}
          {directoryTrust && (
            <DirectoryTrustCard
              key={`${workspaceId}:${sessionId}:${directoryTrust.paneId}:${directoryTrust.cwd}`}
              workspaceId={workspaceId}
              prompt={directoryTrust}
              busy={
                snapshot?.trustBusy || snapshot?.settingBusy || terminalLocked
              }
              onViewTerminal={() => setTerminalOpen(true)}
              onExited={() => {
                if (
                  !workspace ||
                  selected.current.workspaceId !== workspaceId ||
                  selected.current.sessionId !== sessionId ||
                  sessionRequest.current !== selectionGeneration
                ) return;
                // "No, exit" before a new chat's first message: back to that new chat, message intact.
                if (launch?.sessionId === sessionId) {
                  const { text, choices } = launch;
                  setOutgoing(o => o?.id === launch.id ? undefined : o);
                  setLaunch(undefined);
                  patchWorkspace(workspace.id, current => ({ ...(current ?? { workspace, panes: [] }), sessions: (current?.sessions ?? []).filter(item => item.id !== sessionId) }));
                  backToDraft(workspace, text, choices);
                } else selectWorkspace(workspace);
              }}
            />
          )}
          {launch && launch.phase !== "creating" && launch.sessionId === sessionId && <div className="resume-bar first-message-bar" role="status">
            <span>{launch.phase === "sending" ? t('app.sendingFirst') : t('app.firstQueued')}</span>
            {launch.phase === "waiting" && <button type="button" onClick={cancelFirstMessage}>{t('app.cancelSend')}</button>}
          </div>}
          {snapshot?.pendingFork && <div className="resume-bar">
            <span>{t('app.forkPending')}</span>
            <button type="button" disabled={sending || busy || terminalLocked} onClick={() => void fork(snapshot.pendingFork!)}>
              <RefreshCw size={14} />{t('app.finishFork')}
            </button>
          </div>}
          {sessionId && snapshot && !snapshot.pendingFork && !paneId && snapshot.status === "idle" && session?.path && (
            <div className="resume-bar">
              <span>{t('app.savedOnMachine')}</span>
              <button onClick={() => void resume()} disabled={busy || hostBlocked}>
                {busy ? (
                  <Loader2 size={14} className="rotating" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {t('app.resume')}
              </button>
            </div>
          )}
          {!question && <>
          <TurnPanel state={controls} busy={sending || terminalLocked || busy} act={action => void actOnTurn(action)}/>
          <TurnProgress snapshot={snapshot} />
          <form
            className={`composer${!canType ? " composer-inactive" : ""}${attachments.dragging ? " composer-drop" : ""}`}
            data-drop-hint={workspace?.kind === "ssh" ? t('app.dropUpload') : t('app.dropReference')}
            onSubmit={(event) => {
              event.preventDefault();
              if (!uploading) void send();
            }}
          >
            {attachments.strip}
            <textarea
              ref={inputRef}
              aria-label={t('app.messageLabel')}
              placeholder={composerPlaceholder({
                workspace: !!workspace, sessionId: !!sessionId, snapshot: !!snapshot, paneId: !!paneId,
                canSend, inTurn, compacting, terminalLocked, draftOccupied: !!controls?.draftOccupied,
                settingBusy: settingUIBusy || !!snapshot?.settingBusy, trustBusy: !!snapshot?.trustBusy,
                questionBusy, rewind: !!controls?.rewind, busy, permission: !!permission,
                status: activeStatus, navigationStatus: snapshot?.navigationStatus,
                draft: isDraft, folderResolving: !!workspace && !sessionId && folderResolving,
                launching: launch?.phase === "creating", pendingFirst: !!launch && launch.phase !== "creating",
                hostBlocked: hostBlocked ? t('hostTools.composerBlocked', { ...machineParams(hostName), tools: toolList(hostLacks) }) : undefined,
              })}
              {...completion.inputProps}
              onPaste={attachments.onPaste}
              value={attachments.text}
              disabled={!canType}
              rows={1}
              onKeyDown={(event) => {
                if (completion.onKeyDown(event) || imeOwnsKey(event.nativeEvent)) return;
                // Shift + either Enter starts a new line. macOS has no native newline for
                // Shift + keypad Enter, so both insert it here (undoable, like typing).
                if (isEnterKey(event) && event.shiftKey) {
                  event.preventDefault();
                  document.execCommand("insertText", false, "\n");
                  return;
                }
                // The keypad Enter submits like the main Return key.
                if (isEnterKey(event) && !event.shiftKey) {
                  event.preventDefault();
                  if (uploading) { showToast(t('app.stillUploading')); return; }
                  void send((event.ctrlKey || event.metaKey) && !compacting ? "steer" : "queue");
                }
              }}
            />
            {completion.popup}
            <div className="composer-toolbar">
            <button type="button" className="composer-attach" aria-label={t('app.addFile')} disabled={!canType || rewindOpen}
              {...tip(t('app.addFile'), workspace?.kind === "ssh"
                ? t('app.addFileSshTip')
                : t('app.addFileLocalTip'))}
              onClick={attachments.choose}><Plus size={18} /></button>
            {attachments.fileInput}
            {/* Model and effort sit in the input box's bottom right, before the send button. */}
            <div className="composer-settings" ref={composerContext}>
              {isDraft ? <DraftSettings key={workspaceId} workspaceId={workspaceId} choices={draftChoices} onChange={setDraftChoices}
                disabled={!!launch || busy} /> : <SessionSettings key={settingScope} workspaceId={workspaceId} sessionId={sessionId} paneId={paneId} status={activeStatus}
                navigationStatus={snapshot?.navigationStatus} nativeInputReady={snapshot?.settingsInputReady}
                pendingSettingCommand={snapshot?.pendingSettingCommand} settings={snapshot?.settings}
                statusLineManaged={statusLineManaged} statusLine={statusLine}
                settingBusy={!!question || questionBusy || sending || busy || snapshot?.settingBusy || snapshot?.trustBusy || terminalLocked}
                onBusyChange={value => setSettingOperationBusy(settingScope, value)}/>}
            </div>
            <div className="composer-controls">
                {/* During a reply a draft can wait for the turn or steer it now. */}
                {turnDraft && <>
                  <button type="button" className="composer-turn-action" aria-label={t('app.queue')}
                    {...(compacting ? tip(t('app.queue'), t('app.queueCompactingTip'))
                      : tip(t('app.queue'), t('app.queueTip')))}
                    disabled={!canSend || sending || uploading} onClick={() => void send("queue")}><ListEnd size={17} /></button>
                  {!compacting && <button type="button" className="composer-turn-action" aria-label={t('app.steer')}
                    {...tip(t('app.steer'), t('app.steerTip'))}
                    disabled={!canSend || sending || uploading} onClick={() => void send("steer")}><Navigation size={15} /></button>}
                </>}
                {(activeStatus === "working" || controls?.canStop) ? (
                  <button
                    type="button"
                    className="interrupt-button"
                    onClick={() => void actOnTurn({kind:"stop"})}
                    disabled={!controls?.canStop || !paneId || !snapshot?.panePid || terminalLocked || sending || busy || settingUIBusy}
                    {...tip(t('app.stop'), t('app.stopTip'))}
                    aria-label={t('app.stop')}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : !turnDraft && (
                  <button
                    className="send-button"
                    type="submit"
                    disabled={!canType || !draft.trim() || sending || uploading}
                    aria-label={inTurn ? t('app.queue') : t('app.send')}
                    {...(inTurn ? tip(t('app.queue'), t('app.queueInTurnTip')) : tip(t('app.send'), t('app.sendTip')))}
                  >
                    {sending || launch ? (
                      <Loader2 size={18} className="rotating" />
                    ) : (
                      <ArrowUp size={19} />
                    )}
                  </button>
                )}
            </div>
            </div>
          </form>
          </>}
          <div className="composer-footnote">
            {paneId && snapshot && (snapshot.historyPage?.hasOlder || snapshot.messages.some(m => m.rewindUuid)) && <button className="rewind-launch" type="button"
              aria-label={t('app.rewind')} disabled={!canRewind} onClick={openRewind}
              {...tip(t('app.rewind'), t('app.rewindTip'))}><History size={15}/></button>}
            {/* The status bar: permission mode, context and cache, subscription windows. */}
            {!isDraft && <div className="composer-context">
              <SessionTelemetryDisplay executionMode={snapshot?.executionMode} executionModeLastObserved={snapshot?.executionModeLastObserved}
                contextUsage={snapshot?.contextUsage} statusLineManaged={statusLineManaged} statusLine={statusLine}
                endpointBilling={snapshot?.endpointBilling} showCacheTtl={prefs.showCacheTtl} showSubscriptionQuota={prefs.showSubscriptionQuota}
                timeZone={prefs.quotaTimeZone}/>
            </div>}
          </div>
          {!question && rewindOpen && snapshot && <RewindPicker snapshot={snapshot} busy={sending || busy || terminalLocked}
            onClose={() => setRewindScope(undefined)} onLoadEarlier={async () => {
              if (snapshot.historyPage?.hasOlder) await loadEarlierMessages(snapshot.historyPage.cursor);
            }} onSelect={async uuid => { setRewindScope(undefined); await actOnTurn({kind:'rewindTo', uuid}); }}/>}
        </div>
        </div>
      </main>
      {taskShown && workspace && <TaskColumn key={activityScope} workspace={workspace} sessionId={sessionId} view={view} items={items}
        listed={snapshot?.workspaceId === workspaceId && snapshot.sessionId === sessionId && !!snapshot.subagentsListed}
        selected={taskShown.key} kind={taskShown.kind} focusToken={taskShown.focus} replyDetail={prefs.replyDetail} sizeMiB={prefs.historyPageMiB} openArtifact={openArtifact}
        onSelect={key => setTaskColumn(previous => previous && { ...previous, key })} onClose={() => setTaskColumn(undefined)} />}
      {/* Each split pane keeps its own file panel beside its chat (the activity card floats inside it). */}
      {drawer && workspace && <ArtifactDrawer key={JSON.stringify([workspace.id, sessionId, drawer.trail.length, drawer.trail.at(-1)])}
        workspace={workspace} sessionId={sessionId} target={drawer.trail.at(-1)!} canGoBack={drawer.trail.length > 1}
        onClose={closeArtifact} onOpen={path => openArtifact({ path })}
        onBack={() => setArtifact(previous => previous && previous.trail.length > 1 ? { ...previous, trail: previous.trail.slice(0, -1) } : previous)} />}
      </SplitWorkspace>
      </div>
      {!info.demo && codexWorkspaceId && workspace?.kind === "local" && workspace.id === codexWorkspaceId &&
        <CodexPanel key={workspace.id} workspace={workspace} sort={prefs.sidebarSort} onClose={() => setCodexWorkspaceId(undefined)} />}
      {handoffOpen && workspace && session?.historySourceIds?.length ? <HandoffHistoryDialog key={activityScope} workspace={workspace} tipId={sessionId} view={view}
        sources={session.historySourceIds} replyDetail={prefs.replyDetail} sizeMiB={prefs.historyPageMiB} onClose={() => setHandoffScope(undefined)} /> : null}
      {workspaceModal && !info.demo && (
        <WorkspaceDialog
          workspace={"id" in workspaceModal ? workspaceModal : undefined}
          machine={"machine" in workspaceModal ? workspaceModal.machine : undefined}
          workspaces={workspaces}
          platform={info.platform}
          onClose={() => setWorkspaceModal(null)}
          onSave={saveWorkspace}
          onRemove={removeWorkspace}
        />
      )}
      {bindingOpen && (
        <BindingDialog
          discovery={discovery}
          current={sessionId}
          busy={busy}
          onClose={() => setBindingOpen(false)}
          onBind={async (id) => {
            setBusy(true);
            try {
              await window.desktop.bindSession(workspaceId, sessionId, id);
              await refresh(workspaceId);
              await openSession(workspaceId, sessionId);
              setBindingOpen(false);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {preferencesOpen && <PreferencesDialog workspaces={workspaces} platform={info.platform} newMachine={preferencesOpen === "new-machine"} onClose={()=>setPreferencesOpen(false)}/>}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {releaseNotesOpen && <ReleaseNotesDialog current={info.version} onClose={() => setReleaseNotesOpen(false)} />}
      <UpdatePrompt />
      {primary && <SshLoginHost />}
      <TooltipHost />
      {diagnosticsOpen && (
        <DiagnosticsPanel onClose={() => setDiagnosticsOpen(false)} />
      )}
      {historyImportOpen && !info.demo && (
        <HistoryImportDialog
          workspaces={workspaces}
          onClose={() => setHistoryImportOpen(false)}
          onImport={importHistoryProjects}
          onView={selectWorkspace}
        />
      )}
    </div>
  );
  if (!primary) return content;
  return (
    <div className="desktop-window">
      <WindowTitlebar workspaces={workspaces} platform={info.platform}
/>
      {content}
      <ContextMenuHost />
      <QuitPromptHost platform={info.platform} />
    </div>
  );
}

function BindingDialog({
  discovery,
  current,
  busy,
  onClose,
  onBind,
}: {
  discovery?: WorkspaceDiscovery;
  current: string;
  busy: boolean;
  onClose(): void;
  onBind(id: string): Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      className="modal"
      aria-labelledby="binding-title"
    >
      <div className="modal-header">
        <div>
          <h2 id="binding-title">{t('app.bindTitle')}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label={t('app.close')}>
          <X size={19} />
        </button>
      </div>
      <p className="modal-description">
        {t('app.bindIntro')}
      </p>
      <div className="binding-list">
        {discovery?.panes
          .filter((pane) => pane.active)
          .map((pane) => (
            <button
              disabled={busy || !current}
              key={pane.id}
              onClick={() => void onBind(pane.id)}
            >
              <Terminal size={18} />
              <span>
                <strong>
                  {pane.sessionName}
                  <code>{pane.id}</code>
                </strong>
                <small>{pane.cwd}</small>
                <small>
                  {pane.command}
                  {pane.sessionId ? ` · ${pane.sessionId.slice(0, 8)}` : ""}
                </small>
              </span>
              <Link2 size={16} />
            </button>
          ))}
        {!discovery?.panes.some((pane) => pane.active) && (
          <p className="empty-binding">
            {rich('app.noPanes', { command: <code>{t('app.bindCommand')}</code> })}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <div className="spacer" />
        <button className="secondary-button" onClick={onClose}>
          {t('app.close')}
        </button>
      </div>
    </dialog>
  );
}

function HelpDialog({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      className="modal help-modal"
      aria-labelledby="help-title"
    >
      <div className="modal-header">
        <div>
          <h2 id="help-title">{t('app.guide')}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label={t('app.close')}>
          <X size={19} />
        </button>
      </div>
      <div className="help-content">
        <h3>{t('app.helpStartTitle')}</h3>
        <p>{t('app.helpStart')}</p>
        <h3>{t('app.helpRemoteTitle')}</h3>
        <p>{t('app.helpRemote')}</p>
        <h3>{t('app.helpPromptsTitle')}</h3>
        <p>{t('app.helpPrompts')}</p>
        <h3>{t('app.helpInputTitle')}</h3>
        <p>{t('app.helpInput')}</p>
        <h3>{t('app.helpRepliesTitle')}</h3>
        <p>{t('app.helpReplies')}</p>
        <h3>{t('app.helpQuitTitle')}</h3>
        <p>{t('app.helpQuit')}</p>
      </div>
      <div className="modal-footer">
        <div className="spacer" />
        <button className="primary-button" onClick={onClose}>
          {t('app.gotIt')}
        </button>
      </div>
    </dialog>
  );
}
