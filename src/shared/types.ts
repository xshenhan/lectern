import type { Locale, LocalePreference } from './i18n';
import type { SshConfigImport } from './ssh-config';
import type { UpdateState } from './update-check';
import type { HostCheck } from './host-tools';
import type { LaunchPreferences } from './prompt-cache';
export type HostKind = 'local' | 'ssh';
export interface Workspace {
  id: string;
  name: string;
  kind: HostKind;
  cwd: string;
  /** SSH config alias or user@hostname. System OpenSSH owns authentication. */
  host?: string;
  port?: number;
  /** Absolute target config directory override; otherwise inherit the target environment. */
  claudeDir?: string;
  /** false: saved conversations are not scanned until the user asks (new folders start this way).
   * Running Lectern panes in the folder are still listed. Absent means scanning is on. */
  historyScan?: false;
}
export type WorkspaceEndpoint = Pick<Workspace, 'kind' | 'host' | 'port'>;
/** An SSH machine to log in to; the alias or user@host as typed in the connection. */
export interface SshLoginTarget { host: string; port?: number }
export type SshLoginPromptKind = 'secret' | 'text' | 'hostkey' | 'confirm' | 'info';
/** One OpenSSH prompt during an in-app login (password, one-time code, new host key…). */
export interface SshLoginPrompt { loginId: string; promptId: string; kind: SshLoginPromptKind; text: string; context?: string }
export interface WorkspaceDirectoryPage { path: string; directories: string[]; nextOffset?: number }
export type HistoryTarget = WorkspaceEndpoint & Pick<Workspace, 'claudeDir'>;
export interface HistoryProject {
  cwd: string;
  sessionCount: number;
  latestAt?: string;
  exists: boolean;
}
export interface HistoryScan {
  projects: HistoryProject[];
  scannedFiles: number;
  skippedFiles: number;
  truncated: boolean;
  claudeDir: string;
  diagnostic?: string;
}
export interface CompletionItem {
  /** Literal command name or cwd-relative path, without the trigger or quoting. */
  value: string;
  kind: 'command' | 'directory' | 'file';
  source: 'builtin' | 'user' | 'project' | 'plugin' | 'workspace';
}
export interface CompletionQuery { kind: 'slash' | 'mention'; prefix: string }
export interface ArtifactEntry {
  name: string;
  /** Workspace-relative for project files, absolute for explicitly allowed external paths. */
  path: string;
  kind: 'file' | 'directory';
}
export interface ArtifactDirectory { path: string; entries: ArtifactEntry[]; truncated: boolean; nextOffset?: number }
/** No existence check is made for paths outside the workspace until the user opens them. */
export type ArtifactResolution = { path: string } | 'outside' | 'missing' | null;
/** A path as written, or with the directory Claude Code was in when it wrote it (the record's
 * `cwd`, absolute): a relative path is looked for there first. */
export type ArtifactReference = string | { path: string; cwd: string };
export type ArtifactPreview = {
  path: string;
  name: string;
  size: number;
  mime: string;
  truncated: boolean;
  notice?: string;
  text?: string;
  data?: Uint8Array;
} & (
  | { kind: 'directory'; entries: ArtifactEntry[]; nextOffset?: number }
  | { kind: 'text' | 'markdown' | 'code' | 'image' | 'pdf' | 'video' | 'audio' | 'document' | 'binary' }
);
export interface PaneInfo {
  id: string;
  sessionName: string;
  cwd: string;
  command: string;
  title: string;
  sessionId?: string;
  managed: boolean;
  /** Attached by an explicit Lectern binding to a user's existing tmux pane. */
  explicitlyBound?: boolean;
  active: boolean;
}
export interface TranscriptPosition { inode: string; offset: number }
export type ReplyBaselines = Record<string, TranscriptPosition>;

export interface SessionInfo {
  /** End of the observed file; completedThrough is a proven reply record end, not an mtime. */
  replyProgress?: TranscriptPosition & { completedThrough?: number; reset?: boolean };
  id: string;
  title: string;
  titleSource?: 'custom' | 'ai' | 'summary' | 'prompt';
  forkParentId?: string;
  historySegmentCount?: number;
  historySourceIds?: string[];
  path?: string;
  updatedAt?: string;
  paneId?: string;
  mapping: 'exact' | 'manual' | 'unbound';
  explicitlyBound?: boolean;
  status?: NavigationSessionStatus;
  statusDetail?: string;
  /** The reply is done but background shells, subagents, monitors or workflows still run. */
  background?: string;
}
export type NavigationSessionStatus = 'history' | 'idle' | 'working' | 'waiting' | 'error' | 'unknown';
export interface ToolBlock {
  /** 调用之前的正文长度，单位与 String.slice 一致。null 表示调用位于尚未加载的历史页。 */
  textOffset?: number | null;
  id: string;
  name: string;
  input: string;
  result?: string;
  editPatch?: import('./edit-patch').EditHunk[];
  cellEdit?: { before: string; after: string };
  isError?: boolean;
  /** Not a tool: reasoning Claude Code folds into "Thought for Ns". Its text is `result`. */
  thought?: { durationMs?: number };
  /** No result, and none will come: the subagent that called it was interrupted or stopped, or ended
   * (or its end is unknown) without one. Shown as such, not as in progress (subagent-reader.ts). */
  unfinished?: 'interrupted' | 'incomplete';
  /** Claude Code's working directory when it wrote the call, and when it wrote the result (a `cd` in
   * the command already shows in the result's). Relative paths in each are resolved from there. */
  cwd?: string;
  resultCwd?: string;
}
/** One changed file of a git working tree (paths relative to its root). */
export interface GitChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
  from?: string;
  added?: number;
  removed?: number;
  binary?: true;
}
export interface GitChanges { root: string; repo: string; branch?: string; files: GitChange[]; total: number; added: number; removed: number }
/** A folder's repository changes; `guarded`: a macOS privacy folder, read only when the user asks. */
export type GitChangesResult = { kind: 'repo'; changes: GitChanges } | { kind: 'none' } | { kind: 'guarded' };
export interface PeerMessage {
  id: string;
  sender?: string;
  source: 'session' | 'agent' | 'handback' | 'coordinator';
  unverified?: boolean;
  text: string;
}
export interface MessageAttachment {
  id: string;
  name: string;
  image?: true;
  revision?: string;
  /** 图片前已有的正文字数（UTF-16）、工具调用数和代理消息数。 */
  textOffset?: number;
  toolsBefore?: number;
  peersBefore?: number;
  /** Present for file-backed references. Embedded transcript bodies are fetched on demand by id. */
  path?: string;
  /** A folder Claude Code attached (an @-mentioned directory). */
  directory?: true;
}
export interface ChatMessage {
  /** Active-branch, persisted human checkpoint; never a GUI turn index. */
  rewindUuid?: string;
  taskNotifications?: { id: string; text: string }[];
  peerMessages?: (PeerMessage & { textOffset: number; toolsBefore: number })[];
  attachments?: MessageAttachment[];
  /** The user interrupted this reply (Esc, or a refused tool permission). */
  interrupted?: boolean;
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tools: ToolBlock[];
  /** The working directory along a message's text: from each `textOffset` on, the `cwd` Claude Code
   * recorded with that text (it changes after a `cd`). Relative paths in the text are resolved from there;
   * a prompt has one, where Claude Code read its @-mentions. */
  cwds?: { textOffset: number; cwd: string }[];
  source: 'jsonl' | 'preview' | 'pending';
  status: 'streaming' | 'complete';
  timestamp?: string;
}
export type SessionStatus = 'connecting' | 'idle' | 'working' | 'waiting' | 'offline' | 'error';
export type { ExecutionModeObservation, ContextUsageObservation } from '../core/session-telemetry';
export type EndpointBilling = 'subscription' | 'api' | 'third-party' | 'signed-out' | 'unknown';
export interface SubscriptionWindow {
  usedPercentage: number;
  /** Unix epoch seconds, never a relative duration. */
  resetsAt?: number;
}
export interface NativeStatusLineObservation {
  promptCache?: { ttl?: '5m' | '1h'; expiresAt?: number; warm?: boolean; cachingObserved?: boolean };
  fiveHour?: SubscriptionWindow;
  sevenDay?: SubscriptionWindow;
  /** Unix epoch seconds: the 5h and 7d figures are at least this recent (main/quota-as-of.ts). Absent: not known. */
  quotaAsOf?: number;
  /** Native gateway spend_limit or custom route observed in the live callback environment. */
  nonSubscriptionRoute?: 'gateway' | 'custom';
  sessionId: string;
  modelId: string;
  modelName?: string;
  effort?: string;
  contextWindowSize?: number;
  usedPercentage?: number;
  /** Current request's input, including cache reads and writes, when supplied. */
  inputTokens?: number;
  /** The running CLI's version, from the status line callback. */
  version?: string;
}
export interface ConversationTask {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}
/** A live native progress line, not JSONL usage or a billing counter. Keep
 * abbreviated values at their original precision (e.g. 1.5k, not 1500). */
export interface TurnProgressObservation {
  activity: string;
  compactPhase?: 'before' | 'compacting' | 'after';
  elapsed?: string;
  tokens?: { display: string; direction?: 'up' | 'down' };
  detail?: string;
}
/** Last completed compaction recorded in this session's loaded main history. */
export interface CompactReceipt {
  id: string;
  timestamp?: string;
  trigger?: 'auto' | 'manual';
  durationMs?: number;
  /** Optional last live counter observed for this exact operation; not persisted request usage. */
  lastObservedTokens?: TurnProgressObservation['tokens'];
  /** Native estimates of context size on each side, NOT compaction request usage. */
  preTokens?: number;
  postTokens?: number;
}
export interface HandoffHistorySnapshot {
  messages: ChatMessage[];
  /** 原文件内已脱离所选路径的记录，单独按落盘顺序展示。 */
  otherRecords?: ChatMessage[];
  cursor?: string;
  notice?: string;
}

/** A subagent transcript file of a session (`<session>/subagents/agent-<id>.jsonl`). */
export interface SubagentFile {
  agentId: string;
  /** Its transcript's size (listSubagents; the poll's listing leaves it out). */
  size?: number;
  modifiedAt?: string;
  /** From its `.meta.json`, when Claude Code wrote one. */
  agentType?: string;
  description?: string;
  /** The Agent call that launched it. */
  toolUseId?: string;
  /** Claude Code 2.1.310+: the subagent's last run has ended. */
  finished?: boolean;
  /** Claude Code 2.1.310+ (absent from 2.1.300 meta files). */
  isBuiltIn?: boolean;
  /** Claude Code 2.1.310+: its latest resume (written with `finished` cleared). */
  revivedAt?: string;
  /** Stopped from the UI or TaskStop (kept across a later resume). */
  stoppedByUser?: boolean;
  /** `requestShape` "foreground": a call that waited for the subagent. */
  foreground?: boolean;
  /** Claude Code 2.1.330+: the subagent's model. */
  model?: string;
  /** When its meta file was last written: its launch, resume or end. */
  metaModifiedAt?: string;
  /** The time of its transcript's first record (its launch), when read. */
  startedAt?: string;
}

/** Every subagent of a session as the poll lists them (subagent-files.ts): changes only when a meta file or the set of transcripts does. */
export interface SubagentListing { revision: number; files: SubagentFile[] }

/** One subagent's own conversation, read incrementally like the main transcript. */
export interface SubagentTranscript {
  agentId: string;
  /** Grows whenever the messages change; a caller already at it gets no messages. */
  revision: number;
  messages?: ChatMessage[];
  historyPage: { hasOlder: boolean; cursor: string };
  notice?: string;
  /** Claude Code has not written its transcript (yet), or it is gone. */
  missing?: boolean;
}

/** Where a background shell's or monitor's shown output comes from. */
export interface TaskOutputSource {
  /** 'task' (its own output file), 'file:<n>' (a file its command wrote to) or 'transcript'. */
  key: string;
  kind: 'task' | 'file' | 'transcript';
  /** A redirect file as resolved: absolute, or under `~`. */
  path?: string;
  stream?: 'stdout' | 'stderr' | 'both';
}
/** A background shell's or monitor's output for the task column. */
export interface TaskOutput {
  toolId: string;
  /** Grows whenever anything below changes; a caller already at it gets no text. */
  revision: number;
  sources: TaskOutputSource[];
  /** The key of the source shown. */
  source: string;
  text?: string;
  /** Bytes before the shown text that were not read (0: it starts at the beginning). */
  omitted: number;
  /** More can be read before the shown text. */
  hasOlder: boolean;
  /** missing: the file is not there (yet); privacy: a macOS privacy folder, read only on request. */
  state: 'ok' | 'missing' | 'privacy' | 'error';
  error?: string;
  /** From the end of the task's own output file. */
  exitCode?: number;
  killed?: boolean;
  /** The task's own output file exists and holds no output. */
  ownEmpty?: boolean;
}
export interface TaskOutputRequest { revision?: number; source?: string; older?: boolean; explicit?: boolean }

export interface SessionSnapshot {
  turnProgress?: TurnProgressObservation;
  lastCompact?: CompactReceipt;
  tasks?: ConversationTask[];
  /** A branch command was submitted; retry only verification and recovery. */
  pendingFork?: { paneId: string; panePid: number };
  /** How far this view has actually consumed the transcript. */
  transcriptPosition?: TranscriptPosition;
  activity?: import('./activity').SessionActivity[];
  workspaceId: string;
  sessionId: string;
  paneId?: string;
  panePid?: number;
  messages: ChatMessage[];
  /** An opaque ticket for the previous page of this particular transcript view. */
  historyPage?: { hasOlder: boolean; cursor: string };
  screen: string;
  /** Current tmux viewport, without scrollback, when available. */
  viewport?: string;
  /** Styled physical rows and cursor, only requested by an open terminal view. */
  terminalFrame?: TerminalFrame;
  /** Local observation time; retained on read failures to identify a stale frame. */
  screenCapturedAt?: string;
  /** Fresh pane evidence, separate from the message reducer's pending-turn state. */
  navigationStatus?: NavigationSessionStatus;
  navigationStatusDetail?: string;
  /** The reply is done but background shells, subagents, monitors or workflows still run. */
  background?: string;
  /** Background shells, subagents, monitors and workflows of the live process, also during a reply. */
  backgroundWork?: import('./activity').BackgroundCounts;
  /** Fresh, strictly recognized empty native composer; recovery sends recheck before paste. */
  nativeInputReady?: boolean;
  /** The same empty composer takes /model and /effort: also while the reply is over and
   * only background subagents or workflows keep Claude Code busy (never during a reply). */
  settingsInputReady?: boolean;
  turnControls?: import('./turn-controls').TurnControls;
  /** A legacy pane with unknown navigation shows this exact focused slash completion. */
  pendingSettingCommand?: SessionSettingKind;
  /** A native model/effort menu transaction owns this session's input. */
  settingBusy?: boolean;
  question?: import('./question-action').QuestionSnapshot;
  questionBusy?: boolean;
  questionUnconfirmed?: boolean;
  /** Claude Code's tool permission dialog, when one is shown and owned by a pending tool call. */
  permission?: import('./native-permission').PermissionSnapshot;
  permissionBusy?: boolean;
  permissionUnconfirmed?: boolean;
  /** A directory trust choice is awaiting native acknowledgement. */
  trustBusy?: boolean;
  /** Explicit manual ownership of this watch's exact native pane. */
  terminalControl?: TerminalControl;
  /** Native model/effort catalog cached for this exact live pane. */
  settings?: SessionSettingsState;
  /** The live Claude process was launched with the Lectern status line callback. */
  statusLineManaged?: boolean;
  statusLine?: NativeStatusLineObservation;
  /** Current connection's CLI login category, not the historical conversation's payer. */
  endpointBilling?: EndpointBilling;
  executionMode?: import('../core/session-telemetry').ExecutionModeObservation;
  executionModeLastObserved?: boolean;
  contextUsage?: import('../core/session-telemetry').ContextUsageObservation;
  /** Claude Code version of the running process (status line), else of the latest record. */
  cliVersion?: string;
  /** Only while Claude Code works elsewhere than where the conversation started (the newest record's
   * `cwd` after a `cd`): that directory, and the folder's absolute path (`launch`) its files are relative to. */
  workingDirectory?: { current: string; launch: string };
  /** Claude Code 2.1.310+: `activity` lists every subagent of the session, each with its state
   * from its meta file (core/subagent-status.ts), whatever part of the transcript is loaded. */
  subagentsListed?: boolean;
  /** Only a strictly recognized prompt for this exact workspace can populate this. */
  directoryTrust?: DirectoryTrustSnapshot;
  status: SessionStatus;
  error?: string;
  /** Recoverable parser/mapping notices. */
  notice?: string;
}
/** The sidebar can use a live reader without sending an off-screen transcript. */
export type SidebarStatusObservation = Pick<SessionSnapshot, 'status' | 'paneId' |
  'navigationStatus' | 'navigationStatusDetail' | 'background' | 'backgroundWork' | 'error'>;
export interface SidebarStatusUpdate {
  workspaceId: string;
  sessionId: string;
  observation?: SidebarStatusObservation;
}
export interface WorkspaceDiscovery {
  workspace: Workspace;
  sessions: SessionInfo[];
  panes: PaneInfo[];
  diagnostic?: string;
}
export const TERMINAL_KEYS = ['Enter', 'Escape', 'Space', 'C-c', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab',
  'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'C-a', 'C-b', 'C-d', 'C-e', 'C-f', 'C-g', 'C-k', 'C-l', 'C-n', 'C-p', 'C-r', 'C-u', 'C-w', 'C-y'] as const;
export type TerminalKey = typeof TERMINAL_KEYS[number];
export type TerminalInput = { type: 'text'; text: string } | { type: 'literal'; text: string } | { type: 'key'; key: TerminalKey };
export interface TerminalControl { token: string; paneId: string }
export interface TerminalFrame { paneId: string; ansi: string; cols: number; rows: number; cursorX: number; cursorY: number; cursorVisible: boolean;
  /** Increases with each capture from a takeover's fast link; poll captures have none. */
  seq?: number }
/** A takeover frame pushed between snapshots. */
export interface TerminalFrameEvent { workspaceId: string; sessionId: string; frame: TerminalFrame }
export type DirectoryTrustDecision = 'trust' | 'exit' | 'continue';
export interface DirectoryTrustSnapshot {
  token: string;
  sessionId: string;
  paneId: string;
  cwd: string;
  observedAt: string;
  acceptLabel: string;
  cancelLabel: string;
  cancelDecision?: 'exit' | 'continue';
  warnings?: string[];
  /** Native "Trusting this folder loads …" sentence naming the files trust loads. */
  disclosure?: string;
  /** Only native text can establish session-only scope. */
  scope: 'session' | 'unspecified';
}
export interface DirectoryTrustResult {
  decision: DirectoryTrustDecision;
  sessionId: string;
  paneId: string;
  closed: true;
}
export type SessionSettingKind = 'model' | 'effort';
export interface SessionSettingsState {
  initialization: 'pending' | 'loading' | 'ready' | 'failed';
  menus: Partial<Record<SessionSettingKind, SessionSettingSnapshot>>;
  /** Last native selections restored for this CLI instance, for display only. */
  observed?: Partial<Record<SessionSettingKind, Pick<SessionSettingOption, 'label' | 'description'>>>;
  loading?: SessionSettingKind;
  errors?: Partial<Record<SessionSettingKind, string>>;
  error?: string;
  /** Ultracode in this CLI instance: its composer border, or Lectern's verified switch. */
  ultracode?: boolean;
  /** The Claude Code version that reported the machine's model list. */
  cliVersion?: string;
}
export interface SessionSettingOption { id: string; label: string; description?: string; current: boolean; disabled?: boolean }
export type SettingSwitchMode = 'inline' | 'menu';
export interface SessionSettingSnapshot {
  /** Choices read in the dedicated machine pane, then bound to this business session. */
  source?: 'catalog';
  kind: SessionSettingKind;
  token: string;
  sessionId: string;
  paneId: string;
  observedAt: string;
  command: string;
  options: SessionSettingOption[];
  currentOptionId?: string;
  complete: boolean;
  /** Effort menus: whether the native slider offers Ultracode (dynamic workflows on). */
  ultracodeAvailable?: boolean;
  /** A later native read failed. The previous rows are display-only until refreshed. */
  refreshRequired?: boolean;
  detail?: string;
  /** Exact override or cap acknowledgement for this native effort selection. */
  nativeFeedback?: string;
}
export interface AppInfo { platform: string; version: string; demo: boolean }
/** The app language: what is shown, what the user picked and what the OS asks for. */
export interface LocaleState { locale: Locale; preference: LocalePreference; system: Locale }
export interface DiagnosticsInfo {
  enabled: boolean;
  captureContent: boolean;
  directory: string;
  runId: string;
  maxFileBytes: number;
  maxFiles: number;
  droppedEvents: number;
  lastError?: string;
}
export interface RendererDiagnostic {
  kind: 'error' | 'unhandledrejection' | 'render' | 'action';
  message: string;
  stack?: string;
  workspaceId?: string;
  sessionId?: string;
  data?: Record<string, string | number | boolean | undefined>;
}
export type ChatView = 'primary' | 'secondary';
export type MenuAction = "preferences" | "help" | "checkForUpdates";

export interface DesktopAPI {
  onMenuAction(callback: (action: MenuAction) => void): () => void;
  /** Includes the current native window state after subscribing. */
  onWindowReadable(callback: (readable: boolean) => void): () => void;
  info(): Promise<AppInfo>;
  localeState(): Promise<LocaleState>;
  /** Saves the choice and switches every window and the application menu to it. */
  setLocalePreference(preference: LocalePreference): Promise<LocaleState>;
  onLocaleChange(callback: (state: LocaleState) => void): () => void;
  setWindowTheme(theme: 'system' | 'light' | 'dark'): Promise<void>;
  diagnosticsInfo(): Promise<DiagnosticsInfo>;
  setDiagnosticContent(enabled: boolean): Promise<DiagnosticsInfo>;
  openDiagnosticsDirectory(): Promise<void>;
  markDiagnosticIncident(note: string): Promise<string>;
  reportRendererDiagnostic(report: RendererDiagnostic): Promise<void>;
  listWorkspaces(): Promise<Workspace[]>;
  discoverHistoryProjects(target: HistoryTarget): Promise<HistoryScan>;
  saveWorkspace(workspace: Workspace): Promise<Workspace>;
  removeWorkspace(id: string): Promise<void>;
  /** Start scanning a folder's saved conversations (see Workspace.historyScan). */
  enableHistoryScan(id: string): Promise<Workspace>;
  listWorkspaceDirectories(target: WorkspaceEndpoint, path: string, offset?: number): Promise<WorkspaceDirectoryPage>;
  createWorkspaceDirectory(target: WorkspaceEndpoint, parentPath: string, name: string): Promise<string>;
  /** `/effort ultracode on|off` in this session only; resolves to the verified state. */
  setUltracode(workspaceId: string, sessionId: string, on: boolean): Promise<boolean>;
  /** Options for Claude processes Lectern starts later (dynamic workflows for Ultracode,
   * prompt-cache lifetimes). */
  setLaunchPreferences(preferences: LaunchPreferences): Promise<void>;
  /** Concrete Host aliases from this computer's ~/.ssh/config (and its Includes). */
  listSshConfigHosts(): Promise<SshConfigImport>;
  /** Show a local (this computer) folder in Finder / Explorer / the file manager. */
  revealWorkspace(workspaceId: string): Promise<void>;
  /** Log in once with prompts shown in the app; resolves when a reusable connection exists. */
  sshLogin(loginId: string, target: SshLoginTarget): Promise<'existing' | 'connected'>;
  /** Non-interactive reachability check (BatchMode): ok, or the SSH error to classify. */
  checkSshConnection(target: SshLoginTarget): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Whether tmux and Claude Code are usable on the machine (one probe, kept until `force`): the tools found, or why the check could not run. */
  checkHost(target: WorkspaceEndpoint, force?: boolean): Promise<HostCheck>;
  /** Reply to a prompt; null cancels the login. */
  answerSshLogin(loginId: string, promptId: string, answer: string | null): Promise<void>;
  cancelSshLogin(loginId: string): Promise<void>;
  onSshLoginPrompt(callback: (prompt: SshLoginPrompt) => void): () => void;
  onTerminalFrame(callback: (event: TerminalFrameEvent) => void): () => void;
  copyText(text: string): Promise<void>;
  copyImage(png: Uint8Array): Promise<void>;
  /** The working changes of the git repository the folder is in (`explicit`: the user asked, so a guarded folder is read too). */
  gitChanges(workspaceId: string, explicit?: boolean): Promise<GitChangesResult>;
  /** The path of a file dropped or pasted from disk; empty for clipboard data such as screenshots. */
  pathForFile(file: File): string;
  /** Copies a pasted or dropped file into the temporary directory of the folder's machine; its path there. */
  uploadAttachment(workspaceId: string, name: string, data: Uint8Array): Promise<string>;
  previewInlineImage(workspaceId: string, path: string): Promise<ArtifactPreview>;
  previewInlineImageThumbnail(workspaceId: string, path: string): Promise<ArtifactPreview>;
  completeComposer(workspaceId: string, view: ChatView, requestId: string, query: CompletionQuery): Promise<CompletionItem[]>;
  cancelComposerCompletion(view: ChatView, requestId: string): Promise<void>;
  /** A conversation in this workspace is shown: index its files for `@` in the background. */
  prefetchFileIndex(workspaceId: string): Promise<void>;
  /** A file index scan for this workspace finished; an open `@` list may ask again. */
  onFileIndexUpdated(callback: (workspaceId: string) => void): () => void;
  previewMessageAttachment(workspaceId: string, sessionId: string, id: string): Promise<ArtifactPreview>;
  /** Embedded images are encoded on this computer; images attached by path, on the machine they are on. */
  previewMessageAttachmentThumbnail(workspaceId: string, sessionId: string, id: string): Promise<ArtifactPreview>;
  downloadMessageAttachment(workspaceId: string, sessionId: string, id: string): Promise<boolean>;
  resolveArtifactReferences(workspaceId: string, references: ArtifactReference[]): Promise<ArtifactResolution[]>;
  listArtifactDirectory(workspaceId: string, path?: string, offset?: number): Promise<ArtifactDirectory>;
  previewArtifact(workspaceId: string, path: string): Promise<ArtifactPreview>;
  downloadArtifact(workspaceId: string, path: string): Promise<boolean>;
  /** Undefined means the scan was superseded by a change to this folder or its bindings. */
  discover(workspaceId: string, baselines?: ReplyBaselines): Promise<WorkspaceDiscovery | undefined>;
  /** A new conversation. Model and effort apply to this session only; validateMessage is checked, never sent. */
  createSession(workspaceId: string, options?: { model?: string; effort?: string; validateMessage?: string }): Promise<SessionInfo>;
  /** The models and effort levels Claude Code offers on this folder's machine (read once per run). */
  modelCatalog(workspaceId: string, retry?: boolean): Promise<import('./model-catalog').ModelCatalogState>;
  renameSession(workspaceId: string, sessionId: string, title: string): Promise<SessionInfo>;
  setTerminalVisible(workspaceId: string, sessionId: string, visible: boolean, view?: ChatView): Promise<void>;
  closeSession(workspaceId: string, sessionId: string, paneId: string, panePid: number): Promise<SessionInfo | null>;
  resumeSession(workspaceId: string, sessionId: string): Promise<SessionInfo>;
  forkSession(workspaceId: string, sessionId: string, paneId: string, panePid: number): Promise<{ original: SessionInfo; fork: SessionInfo }>;
  bindSession(workspaceId: string, sessionId: string, paneId: string): Promise<void>;
  watchSession(workspaceId: string, sessionId: string, view?: ChatView): Promise<SessionSnapshot>;
  /** Read a conversation's first page in the background before it is opened (e.g. on hover). */
  prefetchSession(workspaceId: string, sessionId: string): Promise<void>;
  loadEarlierMessages(workspaceId: string, sessionId: string, cursor: string, sizeMiB?: number): Promise<SessionSnapshot>;
  readHandoffHistory(workspaceId: string, tipId: string, sourceId: string, cursor?: string, sizeMiB?: number, view?: ChatView): Promise<HandoffHistorySnapshot>;
  releaseHandoffHistory(workspaceId: string, tipId: string, view?: ChatView): Promise<void>;
  /** The subagent transcripts Claude Code wrote for this conversation. */
  listSubagents(workspaceId: string, sessionId: string): Promise<SubagentFile[]>;
  /** A subagent's conversation: new records since the last read, or an older page with `older`. */
  readSubagent(workspaceId: string, sessionId: string, agentId: string, request?: { revision?: number; older?: string; sizeMiB?: number; toolUseId?: string }, view?: ChatView): Promise<SubagentTranscript>;
  releaseSubagents(workspaceId: string, sessionId: string, view?: ChatView): Promise<void>;
  /** A background shell's or monitor's output, named by its tool call (the main process finds its command and task). */
  readTaskOutput(workspaceId: string, sessionId: string, toolId: string, request?: TaskOutputRequest, view?: ChatView): Promise<TaskOutput>;
  releaseTaskOutputs(workspaceId: string, sessionId: string, view?: ChatView): Promise<void>;
  unwatchSession(view?: ChatView): Promise<void>;
  answerQuestion(workspaceId: string, sessionId: string, paneId: string, panePid: number, token: string, action: import('./question-action').QuestionAction): Promise<void>;
  answerPermission(workspaceId: string, sessionId: string, paneId: string, panePid: number, token: string, action: import('./native-permission').PermissionAction): Promise<void>;
  turnAction(workspaceId: string, sessionId: string, paneId: string, panePid: number, action: import('./turn-controls').TurnAction): Promise<void>;
  sendMessage(workspaceId: string, sessionId: string, text: string): Promise<void>;
  sendKey(workspaceId: string, sessionId: string, key: TerminalKey): Promise<void>;
  setTerminalControl(workspaceId: string, sessionId: string, enabled: boolean, token?: string): Promise<TerminalControl | undefined>;
  sendTerminalInput(workspaceId: string, sessionId: string, token: string, input: TerminalInput): Promise<void>;
  getDirectoryTrust(workspaceId: string, sessionId: string): Promise<DirectoryTrustSnapshot | undefined>;
  respondDirectoryTrust(workspaceId: string, sessionId: string, token: string, decision: DirectoryTrustDecision): Promise<DirectoryTrustResult>;
  getSessionSetting(workspaceId: string, sessionId: string, kind: SessionSettingKind): Promise<SessionSettingSnapshot>;
  /** 'inline' types `/model <alias>` or `/effort <level>` (saved as the default for new
   * sessions); 'menu' picks in the native menu for this session only. */
  setSessionSetting(workspaceId: string, sessionId: string, token: string, optionId: string, mode?: SettingSwitchMode): Promise<SessionSettingSnapshot>;
  onSnapshot(callback: (snapshot: SessionSnapshot) => void): () => void;
  onSidebarStatus(callback: (update: SidebarStatusUpdate) => void): () => void;
  /** Update check (src/main/updates.ts): state, actions and pushed changes. */
  updateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdateDownload(): Promise<UpdateState>;
  dismissUpdate(mode: 'later' | 'skip'): Promise<UpdateState>;
  setUpdatePreferences(preferences: { autoCheck: boolean }): Promise<UpdateState>;
  openDownloadedUpdate(): Promise<void>;
  revealDownloadedUpdate(): Promise<void>;
  openUpdatePage(): Promise<void>;
  onUpdateState(callback: (state: UpdateState) => void): () => void;
  /** The quit dialog while one is up (src/shared/quit.ts), else null. */
  quitPrompt(): Promise<import('./quit').QuitPrompt | null>;
  onQuitPrompt(callback: (prompt: import('./quit').QuitPrompt | null) => void): () => void;
  /** The dialog is on screen; otherwise the main process falls back to a native one. */
  quitPromptShown(id: number): Promise<void>;
  /** `remember` applies to "leave" only. */
  answerQuit(id: number, answer: import('./quit').QuitAnswer, remember?: boolean): Promise<void>;
  quitPreferences(): Promise<import('./quit').QuitPreferences>;
  setQuitPreferences(preferences: import('./quit').QuitPreferences): Promise<import('./quit').QuitPreferences>;
  sshConnectionPreferences(): Promise<import('./ssh-connections').SshConnectionPreferences>;
  /** Saved, then applied to SSH connections made from now on. */
  setSshConnectionPreferences(preferences: import('./ssh-connections').SshConnectionPreferences): Promise<import('./ssh-connections').SshConnectionPreferences>;
}
