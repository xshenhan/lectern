import { readActivityFiles, decodeActivityFiles } from './activity-files';
import { decodeTaskList, taskListFrame } from './native-task-list';
import { nativeTaskPanel } from '../core/native-task-screen';
import type { ConversationTask } from '../shared/types';
import type { ActivityReadTarget, ActivitySample } from '../core/session-activity';
import { HistoryIndex } from './history-index';
import { physicalStamp, selectPhysicalHistory } from './physical-history';
import { PhysicalHistoryPages } from './physical-history-pages';
import type { HistoryIndexDiskStore } from './history-index-disk-store';
import { TranscriptPages, decodeFileWindow, liveTranscriptScript, receiptOnFailure, transcriptVersionGuard, type HistoryCursor, type HistoryPage, type LiveCursor } from './transcript-pages';
export type { HistoryCursor, HistoryPage, LiveCursor } from './transcript-pages';
import { WorkspaceArtifacts } from './artifacts';
import { ComposerCompletions } from './composer-completions';
import { EndpointBillingCache } from './endpoint-billing';
import type { EndpointBilling, GitChangesResult, SubagentFile, SubagentListing } from '../shared/types';
import { applySubagentPoll, decodeSubagentList, subagentListScript, subagentPaths, subagentPollScript, subagentPollState, type SubagentPollState } from './subagent-files';
import { decodeTaskOutput, taskOutputScript, type TaskOutputRead, type TaskOutputWindow } from './task-output-files';
import { createHash, randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import type { SettingSwitchMode, DirectoryTrustDecision, DirectoryTrustResult, DirectoryTrustSnapshot, HistoryScan, HistoryTarget, ReplyBaselines, TranscriptPosition, NativeStatusLineObservation, PaneInfo, SessionInfo, SessionSettingKind, SessionSettingSnapshot, TerminalFrame, TerminalInput, TerminalKey, Workspace, WorkspaceDirectoryPage, WorkspaceDiscovery, WorkspaceEndpoint } from '../shared/types';
import { TERMINAL_KEYS } from '../shared/types';
import { sessionSettingsTarget } from '../shared/session-setting-ticket';
import { Transport, quoteShell as q, validateWorkspace, type TransportOptions } from './transport';
import { uploadAttachment } from './attachment-upload';
import { gitChanges, privacyGuarded } from './git-changes';
import type { AnswerPrompt } from './ssh-login';
import { linkScript, startTerminalLink, type TerminalLink } from './terminal-link';
import { diagnostic, errorDetails, getDiagnosticsInfo, summarize } from '../diagnostics';
import { missingCwdNotice, scanHistoryProjects } from './history';
import { normalizeSessionTitle } from '../shared/session-title';
import { readRecentCustomTitle } from './session-title';
import { renameInactiveSession } from './history-rename';
import { SESSION_UUID, decodePresence, matchPresence, presenceReadScript, presenceUnchangedGuard, sessionPresenceScript, sessionProcess, tornPresence, type NativePresence, type NativeStatus } from './native-presence';
import { decodeStatusLineSample, readStatusLineSample, statusLineLaunch, statusLineMarker, statusLineRegistration } from './native-status-line';
import { paneNavigationStatus, type NavigationStatus, type ViewportObservation } from './session-status';
import { KeybindingUnconfirmed, NativeKeybindings } from './native-keybindings';
import { effortFrameGuard, keysNotSent, NativeSettings, NavigationKeyNotSent, SessionSettingError, TranscriptChangedNoKeys, type SettingChoices, type SettingDriver } from './native-settings';
import { launchChoiceArgs, parseModelProbe, PROBE_ARGS, PROBE_INPUT } from './model-probe';
import { launchSettings } from './launch-settings';
import type { LaunchChoices, ModelCatalog } from '../shared/model-catalog';
import { composerFrameGuard, animatedLabelText, guardWindow } from './composer-frame-guard';
import { performTurnAction, type TurnDriver, type RewindTarget } from './native-turn-controls';
import { performQuestionAction, type QuestionDriver } from './native-question-actions';
import { performPermissionAction } from './native-permission-actions';
import type { NativePermissionScreen, PermissionAction } from '../shared/native-permission';
import type { QuestionAction } from '../shared/question-action';
import type { NativeQuestionScreen } from '../shared/native-question';
import { forkReceipt, hasForkLineage, submitNativeFork } from './native-fork';
import type { TurnAction } from '../shared/turn-controls';
import { turnComposer, rewindGuardLines } from '../core/turn-controls';
import { parseAutoModeNudge, stripTerminalEscapes } from '../core/screen';
import { parseDirectoryTrust } from '../core/trust-screen';
import { focusedSettingCommandHistory, hasPendingSettingCommand, isIdleEmptyComposer, parseSettingScreen } from '../core/settings-screen';
import { NativeDirectoryTrust, DirectoryTrustError, TrustKeyNotSent, type TrustDriver, type TrustObservation } from './native-trust';
import { t } from '../shared/i18n';
import { hostProbeScript, HostToolsError, parseHostProbe } from './host-probe';
import { missingTools, missingToolsMessage, type HostCheck, type HostTool } from '../shared/host-tools';
export { quoteShell, validateWorkspace, runCommand, commandInvocation } from './transport';
export { HostToolsError } from './host-probe';

const UUID = SESSION_UUID;
const DIRECTORY_PAGE_SIZE = 250;
const KEYS = new Set<string>(TERMINAL_KEYS);
// Unrecognized tmux key names are silently typed as literal words.
const tmuxKey = (key: TerminalKey) => key === 'Backspace' ? 'BSpace' : key === 'Delete' ? 'DC' : key;
// tmux under a remote C locale replaces control-byte separators with underscores.
const SEP = '|~lectern~|';
// Suffix of an input's not-sent receipt when the transcript revision guard (not the screen) refused it.
const RECORD_CHANGED = '_RECORD';
const PANE_FORMAT = ['#{pane_id}', '#{pane_pid}', '#{pane_current_path}', '#{session_name}', '#{pane_current_command}', '#{pane_dead}', '#{@lectern_session_id}', '#{@lectern_mapping}', '#{@lectern_cwd}', '#{@lectern_claude_dir}', '#{pane_width}', '#{pane_height}', '#{cursor_x}', '#{cursor_y}', '#{pane_dead_status}', '#{pane_dead_signal}', '#{window_id}', '#{pid}:#{start_time}', `#{=255:${statusLineMarker}}`, '#{@lectern_config_override}', '#{@lectern_fork_origin}', '#{pane_title}'].join(SEP);
interface ProcessRow { pid: number; ppid: number; pgid: number; tpgid: number; args: string }
interface InternalPane extends PaneInfo { forkOrigin?: string; configOverride?: boolean; pid: number; claudePid?: number; native?: NativePresence; presenceFingerprint?: string; presenceTorn?: boolean; boundSessionId?: string; identityError?: string; nativeTarget: string; serverInstance?: string; statusMarker?: string; dead: boolean; deadStatus?: number; deadSignal?: string; boundCwd?: string; boundClaudeDir?: string; width: number; height: number; cursorX: number; cursorY: number }
interface Location { tmuxVersion: string; cwd: string; cwdAliases: string[]; claudeDir: string; projectDirs: string[]; /** `uname -s` of the target. */ os?: string }
interface SettingRuntime { panePid?: number; instanceId?: string }
function runtimeIdentity(workspace: Workspace, location: Location, pane?: InternalPane): string | undefined {
  if (pane?.active && pane.native?.registrationId && pane.serverInstance) {
    return createHash('sha256').update(JSON.stringify([workspace.kind, workspace.host, workspace.port,
      location.cwd, location.claudeDir, pane.serverInstance, pane.pid, pane.native.registrationId])).digest('hex');
  }
}
export interface LaunchPreferences { enableWorkflows: boolean }
export interface BackendOptions { historyIndexStore?: HistoryIndexDiskStore; tmuxSocket?: string; claudeCommand?: string; claudeArgs?: string[]; /** Optional local OpenSSH config, primarily for isolated integration tests. */ sshConfigPath?: string; /** Demo mode only: a slower or failing target (see TransportOptions). */ rehearsal?: TransportOptions['rehearsal'] }
export interface SubagentRead { jsonl: Buffer; reset: boolean; missing: boolean; hasMore: boolean; cursor: LiveCursor; olderCursor?: HistoryCursor; skippedHistoryRecords?: number }
export interface ReadResult { /** Asked for with `listSubagents`: every subagent of the session (subagent-files.ts). */ subagents?: SubagentListing;
  /** Asked for with `findSessionProcess`: whether a Claude Code process runs the session anywhere (its native record). */
  sessionProcess?: { alive: boolean; startedAt?: number; uncertain?: boolean }; nativeTasks?: ConversationTask[]; endpointBilling?: EndpointBilling; transcriptPosition?: TranscriptPosition; olderCursor?: HistoryCursor; skippedHistoryRecords?: number; activitySamples?: ActivitySample[]; statusLineManaged?: boolean; statusLine?: NativeStatusLineObservation; session: SessionInfo; screen: string; viewport?: string; terminalFrame?: TerminalFrame; jsonl: Buffer; reset: boolean; active: boolean; hasMore: boolean; panePid?: number; runtimeInstanceId?: string; screenCapturedAt?: string; nativeStatus?: NativeStatus; nativeWaitingFor?: string; nativeStartedAt?: number; directoryTrust?: DirectoryTrustSnapshot }
export class SessionMappingError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionMappingError'; }
}
export class WorkspaceChangedError extends Error {
  constructor() { super('Workspace changed while scanning; refresh to use the current session bindings'); }
}
/** The session has no transcript and no live pane: Claude exited before writing
 * anything (a refused trust prompt, a crash), so no pane is bound any more. */
export class SessionGoneError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionGoneError'; }
}

export function projectSlug(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (Math.imul(hash, 31) + cwd.charCodeAt(i)) | 0;
  return slug.slice(0, 200) + '-' + Math.abs(hash).toString(36);
}
function assertSessionId(value: string): void { if (!UUID.test(value)) throw new Error('Invalid Claude session UUID'); }
function assertPaneId(value: string): void { if (!/^%\d+$/.test(value)) throw new Error('Invalid tmux pane ID'); }
function expandPath(value: string): string { return value === '~' ? '"$HOME"' : value.startsWith('~/') ? `"$HOME"/${q(value.slice(2))}` : q(value); }
function parseProcesses(raw: string): ProcessRow[] {
  return raw.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], args: m[5] }] : [];
  });
}

/** The foreground Claude processes in a pane. Claude Code forks helpers (git, rg, the
 * statusLine command) in its own process group, and between fork and exec such a child
 * still shows Claude's command line: only the outermost Claude counts, otherwise a
 * probe in that window reads two Claudes and drops the session's identity. */
export function foregroundClaudePids(panePid: number, rows: ProcessRow[], options: BackendOptions = {}): number[] {
  const descendants = new Set([panePid]);
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
  const claudes = rows.filter(row => {
    if (!descendants.has(row.pid) || row.tpgid <= 0 || row.pgid !== row.tpgid) return false;
    if (options.claudeCommand) {
      const expected = options.claudeCommand;
      const starts = row.args === expected || row.args.startsWith(expected + ' ') || row.args.startsWith(basename(expected) + ' ');
      return starts && (options.claudeArgs ?? []).every(arg => row.args.includes(arg));
    }
    return /^(?:\S*\/)?claude(?:\s|$)/.test(row.args) || /^(?:\S*\/)?node(?:\s+.*)?\s+\S*(?:@anthropic-ai\/claude-code\/cli\.js|\/claude-code\/cli\.js)(?:\s|$)/.test(row.args);
  });
  const matched = new Set(claudes.map(row => row.pid)), parent = new Map(rows.map(row => [row.pid, row.ppid]));
  const nested = (pid: number) => {
    for (let at = parent.get(pid), depth = 0; at !== undefined && at > 1 && depth < 256; at = parent.get(at), depth++) if (matched.has(at)) return true;
    return false;
  };
  return claudes.filter(row => !nested(row.pid)).map(row => row.pid);
}

// A tagged session keeps its original project after native /cd. Accept the
// process's new cwd only when tmux currently reports it for that exact binding.
function presenceDirectories(location: Location, pane: { cwd: string; boundCwd?: string; boundClaudeDir?: string }): string[] {
  if (pane.boundCwd && location.cwdAliases.includes(pane.boundCwd) && pane.boundClaudeDir === location.claudeDir && pane.cwd.startsWith('/')) {
    return [...location.cwdAliases, pane.cwd];
  }
  return location.cwdAliases;
}

export function isClaudeForeground(panePid: number, rows: ProcessRow[], options: BackendOptions = {}): boolean {
  return foregroundClaudePids(panePid, rows, options).length > 0;
}

// tmux preserves OSC-8 links in the styled capture used for guarded input.
// Remove the link delimiters individually so native trust's "Security guide"
// link text remains visible to the strict dialog parser.
function withoutOscLinks(viewport: string) {
  return viewport.replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, '');
}
/** Inline switches Claude Code applies without a menu (see inlineSettingArgument). */
const inlineSettingCommand = /^\/(?:model [A-Za-z0-9][A-Za-z0-9._:\/@\[\]+-]{0,127}|effort (?:low|medium|high|xhigh|max|auto|ultracode (?:on|off)))$/;
export class Backend {
  private readonly transport: Transport;
  private readonly endpointBilling?: EndpointBillingCache;
  readonly artifacts: WorkspaceArtifacts;
  readonly completions: ComposerCompletions;
  private readonly locations = new Map<string, Location>();
  private readonly workspaceSignatures = new Map<string, string>();
  private readonly workspaceRevisions = new Map<string, number>();
  // Session-list mutations invalidate discovery, but must not invalidate an
  // unrelated UUID's in-flight trust confirmation. Only config changes do so.
  private readonly workspaceConfigRevisions = new Map<string, number>();
  private readonly historyIndexes = new Map<string, HistoryIndex>();
  private readonly physicalPages = new Map<string, PhysicalHistoryPages>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly cursors = new Map<string, LiveCursor>();
  /** What the session polls have read of each session's subagent folder (at most 64 sessions). */
  private readonly subagentPolls = new Map<string, SubagentPollState>();
  private readonly readGenerations = new Map<string, number>();
  private screenCache?: { identity: string; checksum: string; screen: string; viewport: string; nativeTasks?: ConversationTask[]; capturedAt: number; scrollbackAt: number };
  // Once a pane publishes native identity, a torn/missing record cannot
  // silently restore the static tag's write authority, even following /clear.
  private readonly registeredPanes = new Map<string, Map<string, string | undefined>>();
  private readonly navigationCache = new Map<string, { identity: string; time: number; observed: NavigationStatus }>();
  private readonly inputGuards = new Map<string, string>();
  private readonly sending = new Set<string>();
  // A lost reply after Enter is ambiguous. Retries of the same source process
  // may finish verification/resume but may never submit a second slash command.
  private readonly forks = new Map<string, { source: InternalPane; known: Set<string>; scope: string; forkId?: string; completed?: boolean }>();
  private readonly settings = new NativeSettings();
  private readonly directoryTrust = new NativeDirectoryTrust();
  private readonly autoModeNudges = new Map<string, { attempts: number; running: boolean }>();
  private readonly loggedRuntimes = new Set<string>();
  // One host check per machine (kind, host, port); a definite answer stays until a recheck.
  private readonly hostChecks = new Map<string, Promise<HostCheck>>();
  // When each folder's discovery last succeeded or failed: quitting trusts a failure
  // instead of waiting on the machine again (knownRunning).
  private readonly discoveries = new Map<string, { okAt?: number; failedAt?: number; error?: string }>();
  constructor(private readonly options: BackendOptions = {}) {
    this.transport = new Transport(options.sshConfigPath, { rehearsal: options.rehearsal });
    if (!options.claudeCommand) this.endpointBilling = new EndpointBillingCache(this.transport);
    this.artifacts = new WorkspaceArtifacts(this.transport);
    this.completions = new ComposerCompletions(this.transport, this.artifacts);
    if (options.tmuxSocket && !/^[A-Za-z0-9_.-]{1,80}$/.test(options.tmuxSocket)) throw new Error('Invalid tmux socket name');
  }
  private tmux(...args: string[]): string { return ['tmux', ...(this.options.tmuxSocket ? ['-L', this.options.tmuxSocket] : []), ...args].map(q).join(' '); }
  private launchPreferences: LaunchPreferences = { enableWorkflows: true };
  /** Applies to processes Lectern starts from now on; running ones keep theirs. */
  setLaunchPreferences(preferences: LaunchPreferences): void { this.launchPreferences = { enableWorkflows: preferences.enableWorkflows !== false }; }
  private key(workspace: Workspace, sessionId: string): string { return `${workspace.id}:${sessionId}`; }
  private revision(workspaceId: string): number { return this.workspaceRevisions.get(workspaceId) ?? 0; }
  private configRevision(workspaceId: string): number { return this.workspaceConfigRevisions.get(workspaceId) ?? 0; }
  private touchWorkspace(workspaceId: string): void { this.workspaceRevisions.set(workspaceId, this.revision(workspaceId) + 1); }
  private assertCurrentWorkspace(workspace: Workspace, revision: number): void {
    if (this.revision(workspace.id) !== revision || this.workspaceSignatures.get(workspace.id) !== JSON.stringify(workspace)) throw new WorkspaceChangedError();
  }
  private assertCurrentWorkspaceConfiguration(workspace: Workspace, revision: number): void {
    if (this.configRevision(workspace.id) !== revision || this.workspaceSignatures.get(workspace.id) !== JSON.stringify(workspace)) throw new DirectoryTrustError(t('backend.workspaceConfigChanged'));
  }
  private async locate(workspace: Workspace): Promise<Location> {
    validateWorkspace(workspace);
    const signature = JSON.stringify(workspace);
    if (this.workspaceSignatures.has(workspace.id) && this.workspaceSignatures.get(workspace.id) !== signature) this.invalidateWorkspace(workspace.id);
    this.workspaceSignatures.set(workspace.id, signature);
    const revision = this.revision(workspace.id);
    // Session lists and everything after them need tmux: say so before trying.
    await this.requireTools(workspace, ['tmux']);
    const cached = this.locations.get(signature); if (cached) return cached;
    const configDirectory = workspace.claudeDir ? expandPath(workspace.claudeDir) : '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const script = `command -v tmux >/dev/null 2>&1 || { printf '%s\\n' ${q(this.toolsMessage(workspace, ['tmux']))} >&2; exit 1; }\ncd ${expandPath(workspace.cwd)} || exit 1\nprintf '%s\\0%s\\0%s\\0%s\\0%s\\0' "$(pwd -P)" ${configDirectory} "$PWD" "$(tmux -V)" "$(uname -s)"`;
    const { stdout } = await this.transport.run(workspace, script);
    const [cwd, claudeDir, logicalCwd, tmuxVersion, os] = stdout.toString('utf8').split('\0');
    if (!cwd?.startsWith('/') || !claudeDir?.startsWith('/')) throw new Error('Could not resolve target directories');
    const cwdAliases = [...new Set([cwd, logicalCwd].filter(Boolean))];
    const slugs = new Set(cwdAliases.flatMap(alias => [projectSlug(alias), alias.replace(/[/.]/g, '-')]));
    const location = { cwd, cwdAliases, claudeDir, tmuxVersion, os, projectDirs: [...slugs].map(slug => `${claudeDir}/projects/${slug}`) };
    // An older lookup must not repopulate state cleared by a concurrent edit.
    this.assertCurrentWorkspace(workspace, revision);
    this.locations.set(signature, location);
    diagnostic.event('backend.workspace.located', { workspaceId: workspace.id, kind: workspace.kind, host: workspace.host, cwd, cwdAliases, claudeDir, configMode: workspace.claudeDir ? 'explicit' : 'target-environment-or-default', tmuxVersion, os });
    return location;
  }
  private probeScript(location: Location): string {
    const paneList = this.tmux('list-panes', '-a', '-F', PANE_FORMAT);
    // Only panes Lectern started (tmux sessions named lectern-…) and panes the user
    // explicitly bound are considered. Windows the user opened are never read.
    // Keep unrelated process arguments on the target. One remote command
    // returns panes, only their descendant processes, and bounded PID records.
    return `lectern_panes=$({ ${paneList} 2>/dev/null || true; } | awk -F '[|]~lectern~[|]' '$4 ~ /^lectern-/ || $8 == "manual"')
printf '%s\\0' "$lectern_panes"
[ -n "$lectern_panes" ] || exit 0
lectern_roots=$(printf '%s\\n' "$lectern_panes" | awk -F '[|]~lectern~[|]' '$2 ~ /^[1-9][0-9]*$/ {printf "%s ",$2}')
lectern_rows=$(ps -eo pid=,ppid=,pgid=,tpgid=,args= | awk -v roots="$lectern_roots" '
BEGIN {n=split(roots,a); for(i=1;i<=n;i++) root[a[i]]=1}
$1 ~ /^[0-9]+$/ { parent[$1]=$2; row[$1]=$0 }
END {for(pid in row) {p=pid; for(d=0; d<256 && p>1; d++){if(p in root){print row[pid]; break} p=parent[p]}}}')
printf '%s\\0' "$lectern_rows"
lectern_foreground=$(printf '%s\\n' "$lectern_rows" | awk '$3==$4 && $4>0 {print $1}')
${presenceReadScript(location.claudeDir)}`;
  }
  private async probe(workspace: Workspace): Promise<InternalPane[]> {
    const location = await this.locate(workspace);
    // A torn native record (see tornPresence) is read again shortly, at most twice.
    for (let attempt = 0; ; attempt++) {
      const { stdout } = await this.transport.run(workspace, this.probeScript(location), { tag: 'tmux.probe' });
      const panes = this.parseProbe(workspace, location, stdout);
      if (attempt >= 2 || !panes.some(pane => pane.presenceTorn)) return panes;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  private parseProbe(workspace: Workspace, location: Location, stdout: Buffer): InternalPane[] {
    const [rawPanes, rawPs, ...records] = stdout.toString('utf8').split('\0');
    const rows = parseProcesses(rawPs ?? ''), { frames, unsafe } = decodePresence(records);
    let registered = this.registeredPanes.get(workspace.id);
    if (!registered) this.registeredPanes.set(workspace.id, registered = new Map());
    const panes: InternalPane[] = rawPanes.split('\n').filter(Boolean).flatMap(line => {
      const parts = line.split(SEP); if (parts.length < 21 || !/^%\d+$/.test(parts[0])) return [];
      const [id, pid, cwd, sessionName, command, dead, rawId, mapping, boundCwd, boundClaudeDir, width, height, cursorX, cursorY, deadStatus, deadSignal, windowId, server, statusMarker, override, forkOrigin, ...title] = parts;
      const pids = dead === '1' ? [] : foregroundClaudePids(+pid, rows, this.options);
      const claudePid = pids.length === 1 ? pids[0] : undefined;
      const nativeTarget = `${sessionName}:${windowId}.${id}`, registration = `${nativeTarget}:${pid}`;
      const frame = claudePid ? frames.get(claudePid) : undefined;
      const native = frame ? matchPresence(frame, nativeTarget, presenceDirectories(location, { cwd, boundCwd, boundClaudeDir })) : undefined;
      const boundSessionId = UUID.test(rawId) ? rawId : undefined;
      if (native || (frame && !registered.has(registration))) registered.set(registration, native?.sessionId);
      const lastNativeId = registered.get(registration);
      let identityError: string | undefined;
      if (pids.length > 1) identityError = t('backend.multipleClaude');
      else if (claudePid && !native && (unsafe || frame || UUID.test(forkOrigin) || registered.has(registration))) identityError = t('backend.identityUnverified');
      return [{ id, pid: +pid, claudePid, cwd, forkOrigin: UUID.test(forkOrigin) ? forkOrigin : undefined, configOverride: override ? override === '1' : undefined, explicitlyBound: mapping === 'manual', sessionName, command, nativeTarget, native, statusMarker, serverInstance: /^[1-9]\d*:[1-9]\d*$/.test(server) ? server : undefined, presenceFingerprint: native && frame?.fingerprint, presenceTorn: !!frame && !native && tornPresence(frame), boundSessionId, identityError,
        dead: dead === '1', deadStatus: /^\d+$/.test(deadStatus) ? +deadStatus : undefined, deadSignal: deadSignal || undefined, title: title.join(SEP),
        sessionId: native?.sessionId ?? lastNativeId ?? boundSessionId, managed: mapping === 'exact', boundCwd: boundCwd || undefined, boundClaudeDir: boundClaudeDir || undefined,
        width: +width, height: +height, cursorX: +cursorX, cursorY: +cursorY, active: !!claudePid && !identityError }];
    });
    diagnostic.event('backend.panes.probed', { workspaceId: workspace.id, paneCount: panes.length, activeClaudeCount: panes.filter(p => p.active).length, mappedCount: panes.filter(p => p.sessionId).length }, 'debug');
    return panes;
  }
  private paneBelongs(pane: InternalPane, location: Location, hasHistory = false): boolean {
    if (pane.boundClaudeDir && pane.boundClaudeDir !== location.claudeDir) return false;
    if (pane.boundCwd) return location.cwdAliases.includes(pane.boundCwd);
    // Without a recorded cwd, a pane whose session is known can be checked against
    // the transcript's original cwd even if the live process moved. Panes without
    // a session only match their own cwd.
    return location.cwdAliases.includes(pane.cwd) || (!!pane.sessionId && hasHistory);
  }
  private currentPane(panes: InternalPane[], session: SessionInfo, location: Location, forRead = false): InternalPane | undefined {
    const mapped = panes.filter(p => (p.sessionId === session.id || p.identityError && p.boundSessionId === session.id) && this.paneBelongs(p, location, !!session.path));
    const active = mapped.filter(p => p.active);
    if (active.length > 1) throw new SessionMappingError('Multiple live Claude panes claim this session; resolve the conflicting tmux bindings before sending');
    const selected = active[0] ?? (mapped.length === 1 ? mapped[0] : undefined);
    if (!forRead && selected?.identityError) throw new SessionMappingError(selected.identityError);
    if (!forRead && !selected && panes.some(p => p.boundSessionId === session.id && p.native && p.native.sessionId !== session.id)) {
      throw new SessionMappingError(t('backend.newUuidChoose'));
    }
    return selected;
  }
  private async navigationViewports(workspace: Workspace, panes: InternalPane[], styled = false): Promise<Map<string, ViewportObservation>> {
    const observations = new Map<string, ViewportObservation>();
    const live = panes.filter(pane => !pane.dead && !pane.identityError), selected = live.slice(0, 64);
    for (const pane of live.slice(64)) observations.set(pane.id, { error: t('backend.paneLimit') });
    for (let start = 0; start < selected.length; start += 16) {
      const batch = selected.slice(start, start + 16), marker = `\n__LECTERN_VIEWPORT_${randomUUID()}__:`;
      // Default capture-pane bounds are the current visible viewport, not history.
      // A bounded pipe also prevents unusually large panes from growing our buffers.
      const script = batch.map(pane => `printf '%s\\0' ${q(pane.id)}\n{ ${this.tmux('capture-pane', '-p', '-J', ...(styled ? ['-e'] : []), '-t', pane.id)} 2>&1; result=$?; printf '%s%s' ${q(marker)} "$result"; } | head -c 16512 | base64\nprintf '\\0'`).join('\n');
      try {
        const result = await this.transport.run(workspace, script, { tag: 'tmux.navigation_status', timeoutMs: 5000, maxBytes: batch.length * 23000 });
        const fields = result.stdout.toString('utf8').split('\0');
        for (let index = 0; index + 1 < fields.length; index += 2) {
          const paneId = fields[index];
          if (!batch.some(pane => pane.id === paneId)) continue;
          const output = Buffer.from(fields[index + 1], 'base64').toString('utf8');
          const markerAt = output.lastIndexOf(marker);
          if (markerAt < 0 || Buffer.byteLength(output.slice(0, markerAt)) > 16384) observations.set(paneId, { error: t('backend.screenTooLarge') });
          else if (output.slice(markerAt + marker.length) !== '0') observations.set(paneId, { error: t('backend.captureFailed') });
          else observations.set(paneId, { screen: output.slice(0, markerAt) });
        }
        for (const pane of batch) if (!observations.has(pane.id)) observations.set(pane.id, { error: t('backend.noScreen') });
      } catch (error) {
        diagnostic.event('backend.navigation_status.failed', { workspaceId: workspace.id, paneIds: batch.map(pane => pane.id), error: errorDetails(error) }, 'warn');
        for (const pane of batch) observations.set(pane.id, { error: t('backend.statusReadFailed') });
      }
    }
    return observations;
  }
  private navIdentity(pane: InternalPane): string | undefined {
    return pane.active && pane.native?.status ? JSON.stringify([pane.nativeTarget, pane.claudePid, pane.presenceFingerprint, pane.width, pane.height, pane.cursorX, pane.cursorY]) : undefined;
  }
  private rememberNavigation(workspace: Workspace, pane: InternalPane, observed: NavigationStatus, time: number): void {
    const identity = this.navIdentity(pane);
    if (identity) this.navigationCache.set(this.key(workspace, pane.id), { identity, observed, time });
  }
  private async applyNavigationStatuses(workspace: Workspace, sessions: SessionInfo[], panes: InternalPane[]): Promise<void> {
    const selections = new Map<string, InternalPane | undefined>();
    for (const session of sessions) {
      const mapped = panes.filter(pane => pane.sessionId === session.id), active = mapped.filter(pane => pane.active);
      if (active.length > 1) { session.status = 'error'; session.statusDetail = t('backend.multiplePanes'); continue; }
      const latest = [...mapped].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))[0];
      selections.set(session.id, active[0] ?? latest);
    }
    const now = Date.now(), fresh = new Map<string, NavigationStatus>(), toCapture: InternalPane[] = [];
    for (const [key, entry] of this.navigationCache) if (now - entry.time >= 2500) this.navigationCache.delete(key);
    for (const pane of new Set(selections.values())) {
      if (!pane) continue;
      const entry = this.navigationCache.get(this.key(workspace, pane.id));
      if (entry && entry.identity === this.navIdentity(pane) && !this.sending.size) fresh.set(pane.id, entry.observed);
      else toCapture.push(pane);
    }
    const viewports = await this.navigationViewports(workspace, toCapture);
    for (const session of sessions) {
      if (!selections.has(session.id)) continue;
      const pane = selections.get(session.id), cached = pane && fresh.get(pane.id);
      const observed = cached ?? paneNavigationStatus(pane, pane ? viewports.get(pane.id) : undefined);
      Object.assign(session, { background: undefined }, observed);
      if (pane && !cached && viewports.get(pane.id)?.screen !== undefined) this.rememberNavigation(workspace, pane, observed, now);
    }
    diagnostic.event('backend.navigation_status.result', { workspaceId: workspace.id, sessionCount: sessions.length, states: sessions.map(session => ({ sessionId: session.id, paneId: session.paneId, status: session.status, statusDetail: session.statusDetail, background: session.background })) }, 'debug');
  }
  /** Interactive SSH login that leaves a reusable master; see Transport.login. */
  sshLogin(target: { host?: string; port?: number }, answer: AnswerPrompt, signal?: AbortSignal) {
    return this.transport.login(target, answer, signal);
  }
  /** Whether everyday (non-interactive) commands reach this SSH machine now. Never prompts. */
  async checkSshConnection(target: { host?: string; port?: number }): Promise<{ ok: true } | { ok: false; message: string }> {
    const workspace = validateWorkspace({ id: 'ssh-check', name: 'SSH check', kind: 'ssh', cwd: '/', host: target?.host, port: target?.port });
    try {
      await this.transport.run(workspace, 'exit 0', { tag: 'ssh.check', timeoutMs: 20_000, maxBytes: 4096 });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
    }
  }
  /**
   * Whether tmux and Claude Code can run on this machine, looked up with the PATH
   * sessions launch with: one command (host-probe.ts). A completed check is kept per
   * machine until `force` (Recheck); a check that could not run is never kept and
   * never reads as a missing tool.
   */
  checkHost(target: WorkspaceEndpoint, force = false): Promise<HostCheck> {
    let machine: Workspace;
    try { machine = validateWorkspace({ id: 'host-check', name: 'Host check', kind: target?.kind, host: target?.host, port: target?.port, cwd: '~' }); }
    catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([machine.kind, machine.kind === 'ssh' ? machine.host : null, machine.kind === 'ssh' ? machine.port ?? null : null]);
    let check = force ? undefined : this.hostChecks.get(key);
    if (!check) {
      const started = this.probeHost(machine);
      check = started;
      this.hostChecks.set(key, started);
      void started.then(result => { if (!result.ok && this.hostChecks.get(key) === started) this.hostChecks.delete(key); });
    }
    return check;
  }
  private probeHost(machine: Workspace): Promise<HostCheck> {
    return diagnostic.operation('backend.host_check', { kind: machine.kind, host: machine.host, port: machine.port }, async (): Promise<HostCheck> => {
      try {
        // A test double for claude may not answer --version; only the real CLI is asked.
        const script = hostProbeScript({ claude: this.options.claudeCommand ?? 'claude', version: !this.options.claudeCommand });
        const { stdout } = await this.transport.run(machine, script, { tag: 'host.tools', timeoutMs: 20_000, maxBytes: 64 * 1024 });
        const tools = parseHostProbe(stdout.toString('utf8'));
        diagnostic.event('backend.host_check.result', { kind: machine.kind, host: machine.host, system: tools.system, distro: tools.distro, managers: tools.managers,
          tmux: tools.tmux.path ? tools.tmux.version ?? 'found' : 'missing', claude: tools.claude.path ? tools.claude.version ?? 'found' : 'missing' });
        return { ok: true, tools };
      } catch (error) {
        diagnostic.event('backend.host_check.failed', { kind: machine.kind, host: machine.host, error: errorDetails(error) }, 'warn');
        return { ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
      }
    });
  }
  /** Refuse with an explanation when the machine lacks a tool `needs` lists. A check that
   * could not connect fails as that connection error; one that merely ran out of time
   * says nothing about the tools, so the operation goes ahead as before. */
  private async requireTools(workspace: Workspace, needs: readonly HostTool[]): Promise<void> {
    const check = await this.checkHost(workspace);
    if (!check.ok) {
      if (/timed out; no input is retried/.test(check.message)) return;
      throw new Error(check.message);
    }
    const missing = missingTools(check.tools);
    if (missing.some(tool => needs.includes(tool))) throw new HostToolsError(this.toolsMessage(workspace, missing), missing);
  }
  private toolsMessage(workspace: Workspace, missing: readonly HostTool[]) {
    return missingToolsMessage(workspace.kind === 'ssh' ? `${workspace.host}${workspace.port ? `:${workspace.port}` : ''}` : undefined, missing);
  }
  async listWorkspaceDirectories(target: WorkspaceEndpoint, path: string, offset = 0): Promise<WorkspaceDirectoryPage> {
    if (!target || typeof target !== 'object') throw new Error('Invalid workspace endpoint');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - DIRECTORY_PAGE_SIZE) throw new Error(t('backend.invalidFolderPage'));
    const { kind, host, port } = target;
    const workspace = validateWorkspace({ id: 'directory-browser', name: 'Directory browser', cwd: path === '' ? '~' : path, kind, host, port });
    // Shell globbing in a fixed locale gives each page the same order. Emit one
    // extra directory to distinguish a full final page from a continuation.
    const script = `export LC_ALL=C
cd -L ${expandPath(workspace.cwd)} || exit 1
[ -r . ] && [ -x . ] || { printf '%s\\n' ${q(t('backend.noFolderPermission'))} >&2; exit 1; }
printf '%s\\0' "$PWD"
count=0
for item in ./* ./.*; do
  name=\${item#./}
  case "$name" in (.|..|*[[:cntrl:]]*|*'${SEP}'*) continue;; esac
  [ -d "$item" ] && [ -r "$item" ] && [ -x "$item" ] || continue
  count=$((count + 1))
  [ "$count" -gt ${offset} ] || continue
  printf '%s\\0' "$name"
  [ "$count" -le ${offset + DIRECTORY_PAGE_SIZE} ] || break
done
exit 0`;
    const { stdout } = await this.transport.run(workspace, script, { tag: 'workspace.directories', maxBytes: 1024 * 1024 });
    const [resolvedPath, ...directories] = stdout.toString('utf8').split('\0');
    if (!resolvedPath.startsWith('/') || directories.pop() !== '') throw new Error(t('backend.cannotReadFolder'));
    validateWorkspace({ ...workspace, cwd: resolvedPath });
    const nextOffset = directories.length > DIRECTORY_PAGE_SIZE ? offset + DIRECTORY_PAGE_SIZE : undefined;
    return { path: resolvedPath, directories: directories.slice(0, DIRECTORY_PAGE_SIZE), ...(nextOffset !== undefined ? { nextOffset } : {}) };
  }
  async discoverHistoryProjects(target: HistoryTarget): Promise<HistoryScan> {
    return diagnostic.operation('backend.history_projects', { targetKind: target?.kind }, () => scanHistoryProjects(target, this.transport));
  }
  async discover(workspace: Workspace, baselines?: ReplyBaselines): Promise<WorkspaceDiscovery> {
    const outcome = (patch: { okAt?: number; failedAt?: number; error?: string }) =>
      this.discoveries.set(workspace.id, { ...this.discoveries.get(workspace.id), ...patch });
    return this.discoverNow(workspace, baselines).then(result => { outcome({ okAt: Date.now() }); return result; }, error => {
      if (!(error instanceof WorkspaceChangedError)) {
        outcome({ failedAt: Date.now(), error: String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 300) });
      }
      throw error;
    });
  }
  private async discoverNow(workspace: Workspace, baselines?: ReplyBaselines): Promise<WorkspaceDiscovery> {
    return diagnostic.operation('backend.discover', { workspaceId: workspace.id }, async () => {
    const locating = this.locate(workspace);
    const revision = this.revision(workspace.id);
    const location = await locating;
    this.endpointBilling?.observe(workspace, location.claudeDir);
    this.assertCurrentWorkspace(workspace, revision);
    let index = this.historyIndexes.get(workspace.id);
    if (!index) { index = new HistoryIndex(this.options.historyIndexStore?.forWorkspace(workspace, location)); this.historyIndexes.set(workspace.id, index); }
    // A folder whose history the user has not asked for lists only running Lectern panes.
    const [history, machinePanes] = await Promise.all([workspace.historyScan === false ? { files: [] as Awaited<ReturnType<HistoryIndex['scan']>>['files'], truncated: false, limited: false }
      : index.scan(this.transport, workspace, location.projectDirs, location.cwdAliases), this.probe(workspace)]);
    const allPanes = machinePanes;
    const found = new Map<string, SessionInfo>();
    const unknownDirectories = history.files.filter(f => !f.metadata.cwd).length;
    const live = new Set(allPanes.flatMap(p => p.active || p.identityError ? [p.sessionId,p.boundSessionId].filter((id): id is string => !!id) : []));
    const physical = selectPhysicalHistory(history.files, location.cwdAliases, live);
    const layouts = new Map<string, PhysicalHistoryPages>();
    for (const selected of physical.sessions) {
      const {id, file:{path,inode,size}} = selected;
      // No prompt and no reply (cost records, a model switch, an unused new
      // chat): not part of the folder's history. A running pane still shows it.
      if (selected.file.metadata.contentless && !selected.previous.length && !live.has(id)) continue;
      const metadata = selected.file.id === id ? selected.file.metadata : history.files.find(f => f.id === id && location.cwdAliases.includes(f.metadata.cwd ?? ''))!.metadata;
      if (selected.previous.length || selected.file.id !== id) layouts.set(this.key(workspace,id),new PhysicalHistoryPages(selected));
      const info: SessionInfo = { id, ...(selected.previous.length && {historySegmentCount:selected.previous.length+1,historySourceIds:selected.previous.map(p=>p.file.id)}), title: metadata.title ?? t('backend.newConversation'), titleSource: metadata.titleSource, forkParentId: metadata.forkParentId, path, updatedAt: metadata.updatedAt, mapping: 'unbound' };
      // No extra transcript I/O for old history or an unchanged file. Renderer
      // hints are positions only; file paths always come from verified discovery.
      const previous = baselines?.[id];
      info.replyProgress = { inode, offset: size, ...(previous?.inode === inode && previous.offset > size && { reset: true }) };
      if (previous && (previous.inode === inode || previous.inode === 'missing' && previous.offset === 0) &&
          Number.isSafeInteger(previous.offset) && previous.offset >= 0 && previous.offset < size) {
        info.replyProgress = await new TranscriptPages(this.transport, workspace, id, [path]).replyProgress(inode, size, previous.offset);
      }
      found.set(id, info);
    }
    const panes = allPanes.filter(p => this.paneBelongs(p, location, !!p.sessionId && found.has(p.sessionId)));
    const activeMappings = new Map<string, InternalPane[]>();
    for (const pane of panes) {
      if (!pane.sessionId || !pane.active) continue;
      const group = activeMappings.get(pane.sessionId) ?? [];
      group.push(pane); activeMappings.set(pane.sessionId, group);
    }
    for (const [sessionId, mapped] of activeMappings) {
      const pane = mapped[0];
      const info: SessionInfo = found.get(sessionId) ?? { id: sessionId, title: t('backend.newConversation'), mapping: 'unbound' };
      if (!info.path && mapped.length === 1 && pane.boundCwd && location.cwdAliases.includes(pane.boundCwd)) {
        // Claude can persist /rename before its first user turn supplies a cwd.
        // The managed pane proves project membership for this otherwise anonymous file.
        const empty = history.files.find(file => file.id === sessionId && !file.metadata.cwd && file.metadata.titleSource === 'custom');
        if (empty?.metadata.title) Object.assign(info, { title: empty.metadata.title, titleSource: 'custom' });
      }
      if (mapped.length === 1) { info.paneId = pane.id; info.mapping = pane.managed ? 'exact' : 'manual'; info.explicitlyBound = pane.explicitlyBound; }
      found.set(info.id, info);
    }
    for (const pane of panes) {
      if (!pane.identityError || !pane.sessionId || found.has(pane.sessionId)) continue;
      const previous = this.sessions.get(this.key(workspace, pane.sessionId));
      if (previous) found.set(pane.sessionId, { ...previous, paneId: undefined, mapping: 'unbound' });
    }
    const sessions = [...found.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    await this.applyNavigationStatuses(workspace, sessions, panes);
    // Do not let a slow pre-edit/pre-launch scan delete or replace newer entries.
    this.assertCurrentWorkspace(workspace, revision);
    for (const key of this.sessions.keys()) {
      if (key.startsWith(workspace.id + ':') && !found.has(key.slice(workspace.id.length + 1))) {
        diagnostic.event('backend.mapping.removed', { workspaceId: workspace.id, sessionId: key.slice(workspace.id.length + 1), previousPaneId: this.sessions.get(key)?.paneId });
        this.sessions.delete(key);
        this.resetRead(workspace.id, key.slice(workspace.id.length + 1));
      }
    }
    for (const key of new Set([...this.physicalPages.keys(), ...layouts.keys()])) {
      if (!key.startsWith(workspace.id + ':')) continue;
      const next = layouts.get(key), old = this.physicalPages.get(key);
      if (old?.key !== next?.key && this.cursors.has(key)) this.resetRead(workspace.id,key.slice(workspace.id.length+1));
      if (next) this.physicalPages.set(key,next); else this.physicalPages.delete(key);
    }
    for (const info of sessions) {
      const previous = this.sessions.get(this.key(workspace, info.id));
      if (previous?.paneId !== info.paneId || previous?.mapping !== info.mapping) diagnostic.event('backend.mapping.changed', { workspaceId: workspace.id, sessionId: info.id, previousPaneId: previous?.paneId, paneId: info.paneId, previousMapping: previous?.mapping, mapping: info.mapping });
      this.sessions.set(this.key(workspace, info.id), info);
    }
    const diagnostics = [...physical.notes];
    if (history.truncated) diagnostics.push('History discovery is limited to 1,000 files; older sessions may be omitted.');
    if (history.limited) diagnostics.push(t('backend.historyBudget'));
    const cwdNotice = missingCwdNotice(history.files);
    if (cwdNotice) diagnostics.push(cwdNotice);
    if ([...activeMappings.values()].some(group => group.length > 1)) diagnostics.push(t('backend.boundTwice'));
    if (!sessions.length && panes.some(p => p.active && !p.sessionId)) diagnostics.push(t('backend.unboundTerminal'));
    diagnostic.event('backend.discovery.result', { workspaceId: workspace.id, cwd: location.cwd, sessionCount: sessions.length, historyCount: sessions.filter(s => s.path).length, activeMappedCount: sessions.filter(s => s.paneId).length, paneCount: panes.length, unknownDirectories, diagnostics, mappings: sessions.map(s => ({ sessionId: s.id, paneId: s.paneId, mapping: s.mapping })) });
    return { workspace: { ...workspace, cwd: location.cwd }, sessions, panes, diagnostic: diagnostics.join(' ') || undefined };
    });
  }
  private async getSession(workspace: Workspace, sessionId: string): Promise<SessionInfo> {
    assertSessionId(sessionId);
    const locating = this.locate(workspace);
    const revision = this.revision(workspace.id);
    await locating;
    this.assertCurrentWorkspace(workspace, revision);
    let session = this.sessions.get(this.key(workspace, sessionId));
    if (!session) { await this.discover(workspace); session = this.sessions.get(this.key(workspace, sessionId)); }
    this.assertCurrentWorkspace(workspace, revision);
    if (!session) throw new Error('Session does not belong to this workspace');
    return session;
  }
  /** The resolved Claude executable with the environment and per-process settings
   * Lectern gives every Claude it runs: sessions in tmux and the model-list probe. */
  private async claudeInvocation(workspace: Workspace, location: Location, statusLineFor?: string) {
    const executable = this.options.claudeCommand ?? 'claude';
    const missing = q(this.toolsMessage(workspace, ['claude']));
    const resolution = await this.transport.run(workspace, `command -v ${q(executable)} || { printf '%s\\n' "\${lectern_claude_path_error:-$(printf '%s' ${missing})}" >&2; exit 1; }`, { tag: 'claude.executable', maxBytes: 8192 });
    const resolvedExecutable = resolution.stdout.toString('utf8').trim();
    if (!resolvedExecutable.startsWith('/') || /[\x00-\x1f\x7f]/.test(resolvedExecutable)) throw new Error('Claude must resolve to one absolute executable path on the target');
    // Programmatic custom commands are demo/test doubles. A custom Claude binary
    // named claude supports the same per-launch settings as the normal CLI.
    const nativeCli = !this.options.claudeCommand || basename(executable) === 'claude';
    const callback = statusLineFor && nativeCli ? statusLineLaunch(statusLineFor, randomUUID().replace(/-/g, ''), location.tmuxVersion) : undefined;
    // Only this process's settings change (auto mode, no prompt suggestions,
    // workflows unless the user opted out); the user's own settings files stay as they are.
    const settings = nativeCli ? JSON.stringify(launchSettings({ statusLine: callback && JSON.parse(callback.settings), enableWorkflows: this.launchPreferences.enableWorkflows })) : undefined;
    // Merely setting the default directory can change how native Claude resolves
    // its global config/account state. Preserve the target's normal environment;
    // only an explicitly selected configuration directory is an override.
    const configOverride = workspace.claudeDir ? `export CLAUDE_CONFIG_DIR=${q(location.claudeDir)}; ` : '';
    // Existing tmux servers may have an older PATH than this SSH connection.
    // Keep the resolved launcher and its node/bin directory in the child too.
    const environment = `export PATH=${q(posix.dirname(resolvedExecutable))}:"$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${configOverride}${callback ? callback.register + '; ' : ''}`;
    return { argv: [resolvedExecutable, ...(this.options.claudeArgs ?? [])], settingsArgs: settings ? ['--settings', settings] : [], environment };
  }
  private async launchCommand(workspace: Workspace, location: Location, sessionId: string, resume: boolean, title?: string, choices: LaunchChoices = {}): Promise<string> {
    const invocation = await this.claudeInvocation(workspace, location, title === undefined ? sessionId : undefined);
    // A new chat's model and effort apply to that session only; nothing is saved as a default.
    const flags = resume || title !== undefined ? [] : launchChoiceArgs(choices);
    const command = [...invocation.argv, ...invocation.settingsArgs, ...flags, resume ? '--resume' : '--session-id', sessionId, ...(title === undefined ? [] : ['--name', title])].map(q).join(' ');
    return `${invocation.environment}exec ${command}`;
  }
  /** The machine-level location for one Claude configuration: its home directory. */
  private machineWorkspace(workspace: Workspace): Workspace {
    const identity = JSON.stringify([workspace.kind, workspace.host, workspace.port, workspace.claudeDir]);
    return { ...workspace, id: 'models-' + createHash('sha256').update(identity).digest('hex'), name: 'Model list', cwd: '~', claudeDir: workspace.claudeDir, historyScan: false };
  }
  /** Ask Claude Code on the target which models and effort levels it offers,
   * through its SDK control requests: no TUI, no tmux pane, no prompt, no transcript. */
  async probeModelCatalog(workspace: Workspace): Promise<ModelCatalog> {
    return diagnostic.operation('backend.model_probe', { workspaceId: workspace.id, kind: workspace.kind, host: workspace.host }, async () => {
      const machine = this.machineWorkspace(workspace);
      await this.requireTools(machine, ['tmux', 'claude']);
      const location = await this.locate(machine);
      const invocation = await this.claudeInvocation(machine, location);
      const command = [...invocation.argv, ...PROBE_ARGS, ...invocation.settingsArgs].map(q).join(' ');
      // Run in the home directory: no project's settings, hooks or MCP servers.
      const script = `${invocation.environment}cd ~ || exit 1\nprintf '%s' ${q(PROBE_INPUT)} | ${command}`;
      const { stdout } = await this.transport.run(machine, script, { tag: 'claude.model_probe', timeoutMs: 45_000, maxBytes: 8 * 1024 * 1024 });
      const catalog = parseModelProbe(stdout.toString('utf8'));
      diagnostic.event('backend.model_probe.result', { workspaceId: workspace.id, version: catalog.version, models: catalog.models.length, defaults: catalog.defaults });
      return catalog;
    });
  }
  private async launch(workspace: Workspace, sessionId: string, resume: boolean, name?: string, choices: LaunchChoices = {}): Promise<SessionInfo> {
    return diagnostic.operation('backend.launch', { workspaceId: workspace.id, sessionId, action: resume ? 'resume' : 'create' }, async () => {
    // A new or resumed conversation needs both: refuse with what to install, not a shell error.
    await this.requireTools(workspace, ['tmux', 'claude']);
    const location = await this.locate(workspace);
    const runtimeKey = JSON.stringify(workspace);
    if (getDiagnosticsInfo().enabled && !this.loggedRuntimes.has(runtimeKey)) {
      this.loggedRuntimes.add(runtimeKey);
      if (this.options.claudeCommand) diagnostic.event('backend.runtime', { workspaceId: workspace.id, executable: this.options.claudeCommand, customExecutable: true, versionProbeSkipped: true });
      else {
        try {
          const runtime = await this.transport.run(workspace, `command -v claude; claude --version`, { tag: 'claude.version', timeoutMs: 5000, maxBytes: 8192 });
          const [executable, ...version] = runtime.stdout.toString('utf8').trim().split('\n');
          diagnostic.event('backend.runtime', { workspaceId: workspace.id, executable, claudeVersion: version.join(' ').slice(0, 512) });
        } catch (error) { diagnostic.event('backend.runtime.unavailable', { workspaceId: workspace.id, error: errorDetails(error) }, 'warn'); }
      }
    }
    const discovery = await this.discover(workspace);
    if (resume && discovery.panes.some(pane => (pane.sessionId === sessionId || 'boundSessionId' in pane && pane.boundSessionId === sessionId) && 'identityError' in pane && pane.identityError)) {
      throw new SessionMappingError(t('backend.resumeIdentityUnverified'));
    }
    if (discovery.panes.filter(pane => pane.sessionId === sessionId && pane.active).length > 1) throw new Error('Multiple live Claude panes claim this session; resolve the conflicting tmux bindings before resuming');
    const existing = discovery.sessions.find(s => s.id === sessionId);
    if (existing?.paneId) return existing;
    if (resume && !existing?.path) throw new Error('Cannot resume a missing transcript');
    const shellCommand = await this.launchCommand(workspace, location, sessionId, resume, undefined, choices);
    // exec prevents a failed/exited Claude process from falling back into an interactive shell.
    const script = `${this.tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-x', '120', '-y', '40', '-s', name ?? `lectern-${sessionId.slice(0, 8)}-${randomUUID().slice(0, 6)}`, '-c', location.cwd, `sh -c ${q(shellCommand)}`)}`;
    this.touchWorkspace(workspace.id);
    const revision = this.revision(workspace.id);
    const { stdout } = await this.transport.run(workspace, script);
    const paneId = stdout.toString('utf8').trim(); assertPaneId(paneId);
    await this.writeBinding(workspace, location, sessionId, paneId, 'exact');
    this.assertCurrentWorkspace(workspace, revision);
    this.touchWorkspace(workspace.id);
    const info: SessionInfo = { ...(existing ?? { id: sessionId, title: t('backend.newConversation') }), paneId, mapping: 'exact' };
    this.sessions.set(this.key(workspace, sessionId), info);
    diagnostic.event('backend.launch.bound', { workspaceId: workspace.id, sessionId, paneId, cwd: location.cwd, mapping: 'exact', resume, configOverride: !!workspace.claudeDir });
    return info;
    });
  }
  /** A new conversation. Model and effort choices apply to this session only. */
  /** The working changes of the folder's git repository. A local macOS folder inside
   * Desktop, Documents, … is read only when the user asks (`explicit`). */
  async gitChanges(workspace: Workspace, explicit = false): Promise<GitChangesResult> {
    validateWorkspace(workspace);
    if (!explicit && privacyGuarded(workspace)) return { kind: 'guarded' };
    const changes = await gitChanges(this.transport, workspace);
    return changes ? { kind: 'repo', changes } : { kind: 'none' };
  }
  /** A pasted or dropped file, copied into the target's temporary directory; its path there. */
  uploadAttachment(workspace: Workspace, name: string, data: Buffer): Promise<string> {
    return uploadAttachment(this.transport, validateWorkspace(workspace), name, data);
  }
  async createSession(workspace: Workspace, choices: LaunchChoices = {}): Promise<SessionInfo> { return this.launch(workspace, randomUUID(), false, undefined, choices); }
  async renameSession(workspace: Workspace, sessionId: string, value: string): Promise<SessionInfo> {
    const title = normalizeSessionTitle(value);
    return this.withInput(workspace, sessionId, async () => {
      const discovery = await this.discover(workspace);
      const session = discovery.sessions.find(item => item.id === sessionId);
      if (!session) throw new Error(t('backend.sessionNotFound'));
      if (session.titleSource === 'custom' && session.title === title) return session;
      const location = await this.locate(workspace);
      const revision = this.configRevision(workspace.id);
      const paths = this.transcriptPaths(session, location);
      const readTitle = () => readRecentCustomTitle(this.transport, workspace, sessionId, paths);
      let confirmed: string | undefined;
      if (session.paneId) {
        if (session.status !== 'idle') throw new Error(t('backend.renameWhenIdle'));
        const before = await readTitle();
        await this.submitText(workspace, sessionId, '/rename ' + title, session.paneId);
        // Claude can resolve a collision with another running session by adding
        // a suffix. Return its actual persisted name and never resend the command.
        const deadline = Date.now() + 10000;
        do {
          const current = await readTitle();
          if (current && (current === title || current !== before)) {
            confirmed = current;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
        if (!confirmed) throw new Error(t('backend.renameUnconfirmed'));
      } else {
        if (!session.path || session.status !== 'history') throw new Error(t('backend.renameStateUnknown'));
        const command = await this.launchCommand(workspace, location, sessionId, true, title);
        await renameInactiveSession(this.transport, workspace, sessionId, title, location, command, async () => (await readTitle()) === title);
        confirmed = title;
      }
      this.assertCurrentWorkspaceConfiguration(workspace, revision);
      this.touchWorkspace(workspace.id);
      const key = this.key(workspace, sessionId);
      const updated: SessionInfo = { ...(this.sessions.get(key) ?? session), title: confirmed, titleSource: 'custom' };
      this.sessions.set(key, updated);
      return updated;
    });
  }
  async resumeSession(workspace: Workspace, sessionId: string): Promise<SessionInfo> { assertSessionId(sessionId); return this.withInput(workspace, sessionId, () => this.launch(workspace, sessionId, true)); }
  pendingFork(workspace: Workspace, sessionId: string) {
    const scope = sessionSettingsTarget(workspace);
    for (const record of this.forks.values()) if (!record.completed && record.scope === scope && record.source.native?.sessionId === sessionId)
      return {paneId:record.source.id, panePid:record.source.pid};
  }
  async forkSession(workspace: Workspace, sessionId: string, paneId: string, panePid: number): Promise<{ original: SessionInfo; fork: SessionInfo }> {
    assertPaneId(paneId);
    if (!Number.isSafeInteger(panePid) || panePid < 2) throw new Error(t('backend.invalidPanePid'));
    return this.withInput(workspace, sessionId, async () => {
      const location = await this.locate(workspace), revision = this.configRevision(workspace.id);
      const key = JSON.stringify([sessionSettingsTarget(workspace), sessionId, paneId, panePid]);
      const probe = async () => {
        const panes = await this.probe(workspace);
        this.assertCurrentWorkspaceConfiguration(workspace, revision);
        return panes;
      };
      let journal = this.forks.get(key);
      if (!journal) {
        const discovery = await this.discover(workspace), original = discovery.sessions.find(s => s.id === sessionId);
        if (!original?.path) throw new Error(t('backend.forkNeedsTranscript'));
        const source = this.currentPane(await probe(), original, location);
        if (!source?.active || !source.serverInstance || !source.native?.registrationId || source.native.sessionId !== sessionId || source.id !== paneId || source.pid !== panePid || !location.cwdAliases.includes(source.cwd))
          throw new SessionMappingError(t('backend.forkCannotVerify'));
        journal = { source, scope: sessionSettingsTarget(workspace), known: new Set(discovery.sessions.map(s => s.id)) };
        try {
          await submitNativeFork(this.settingDriver(workspace, sessionId, {
            expected: { panePid, instanceId: runtimeIdentity(workspace, location, source) }, onSwitchDispatch: () => this.forks.set(key, journal!),
          }), paneId, panePid);
        } catch (e) {
          // Only this one-use receipt proves Enter never ran. A disconnect is
          // ambiguous and must retain its recovery journal.
          if (e instanceof NavigationKeyNotSent) this.forks.delete(key);
          throw e;
        }
      }
      const { source, known } = journal;
      const changed = () => new SessionMappingError(t('backend.forkProcessChanged'));
      const target = (panes: InternalPane[]) => {
        const p = panes.find(p => p.id === paneId);
        if (!p || p.pid !== source.pid || p.serverInstance !== source.serverInstance || p.nativeTarget !== source.nativeTarget || p.claudePid !== source.claudePid || !location.cwdAliases.includes(p.cwd)) throw changed();
        if (!p.native || !p.active) return;
        if (p.native.procStart !== source.native!.procStart) throw changed();
        if (p.native.sessionId === sessionId && !journal!.forkId) return;
        if (!p.native.registrationId || known.has(p.native.sessionId) || journal!.forkId && journal!.forkId !== p.native.sessionId ||
            panes.some(other => other.id !== p.id && other.sessionId === p.native!.sessionId && (other.active || other.identityError))) throw changed();
        return p;
      };
      const wait = async <T>(sample: () => Promise<T | undefined>, error: string): Promise<T> => {
        const until = Date.now() + 12000;
        do { const found = await sample(); if (found) return found; await new Promise(r => setTimeout(r, 180)); } while (Date.now() < until);
        throw new Error(error);
      };
      const forkPane = await wait(async () => target(await probe()), t('backend.forkUuidPending'));
      const forkId = forkPane.native!.sessionId;
      return this.withInput(workspace, forkId, async () => {
        if (!journal!.forkId) {
          const files = location.projectDirs.map(dir => `${dir}/${forkId}.jsonl`);
          await wait(async () => {
            const observed = target(await probe());
            if (observed?.sessionId !== forkId) throw changed();
            const view = (await this.navigationViewports(workspace, [observed])).get(paneId)?.screen;
            if (!view || !forkReceipt(view, sessionId, forkId)) return;
            const result = await this.transport.run(workspace, liveTranscriptScript(files, undefined, false), { tag: 'session.fork.lineage' });
            const { data } = decodeFileWindow(result.stdout);
            return hasForkLineage(data, sessionId, forkId) || undefined;
          }, t('backend.forkLineageUnproven'));
          journal!.forkId = forkId;
        }
        // Claude Code rewrites its PID record a few times while the branch settles (busy,
        // the new UUID, its name, idle). A refused guard changed nothing: probe again and
        // retag against the record as it is now, while it still names the fork (3 tries).
        for (let attempt = 1; ; attempt++) {
          const fresh = target(await probe());
          if (!fresh || fresh.native!.sessionId !== forkId) throw changed();
          if (fresh.boundSessionId === sessionId) {
            // Retag only this exact foreground process, never a pane found by
            // timestamp or by cwd. Leave unrelated/manual binding options intact.
            const format = '#{pane_pid}:#{pid}:#{start_time}:#{@lectern_session_id}';
            const identity = this.tmux('display-message', '-p', '-t', paneId, format);
            const retag = this.tmux('set-option', '-p', '-t', paneId, '@lectern_session_id', forkId, ';', 'set-option', '-p', '-t', paneId, '@lectern_fork_origin', sessionId);
            try {
              await this.transport.run(workspace, `set -e\n[ "$(${identity})" = ${q(`${panePid}:${fresh.serverInstance}:${sessionId}`)} ]\n${this.nativeGuard(fresh, location, t('native.presenceChangedNoKeys'))}${retag}`, {tag:'session.fork.rebind'});
            } catch (error) { if (attempt < 3 && keysNotSent(error)) continue; throw error; }
          } else if (fresh.boundSessionId && fresh.boundSessionId !== forkId) throw changed();
          break;
        }
        this.touchWorkspace(workspace.id);
        // Stable name also covers a transport disconnect after new-session but
        // before its reply: retries can observe that pane without duplicating it.
        const name = `lectern-resume-${forkId}`;
        const panes = await probe();
        const owners = panes.filter(p => p.sessionId === sessionId && p.active);
        if (owners.length > 1) throw changed();
        if (!owners.length && !panes.some(p => p.sessionName === name)) await this.launch(workspace, sessionId, true, name);
        const originalPane = await wait(async () => {
          const all = await probe();
          if (!target(all)) throw changed();
          const matches = all.filter(p => p.sessionId === sessionId && (p.active || p.identityError));
          if (matches.length > 1) throw changed();
          const p = matches[0];
          if (p?.id !== paneId && p?.active && p.native?.registrationId && p.native.sessionId === sessionId && this.paneBelongs(p, location) && location.cwdAliases.includes(p.cwd)) return p;
        }, t('backend.forkResumePending'));
        const discovery = await this.discover(workspace);
        const original = discovery.sessions.find(s => s.id === sessionId && s.paneId === originalPane.id);
        const fork = discovery.sessions.find(s => s.id === forkId && s.paneId === paneId);
        if (!original || !fork) throw changed();
        journal!.completed = true;
        journal!.known.clear();
        // Keep a bounded replay window for duplicate IPC replies. Expired
        // requests still cannot submit: their source PID no longer owns the UUID.
        if (this.forks.size > 128) for (const [k,j] of this.forks) { if (k !== key && j.completed) { this.forks.delete(k); break; } }
        return { original, fork };
      });
    });
  }
  /** What Lectern last saw running in a folder (discovery, launches, reads) and when its
   * discovery last succeeded or failed. No I/O: for quitting. */
  knownRunning(workspaceId: string): { sessions: SessionInfo[]; okAt?: number; failedAt?: number; error?: string } {
    const sessions = [...this.sessions.entries()].filter(([key, info]) => key.startsWith(workspaceId + ':') && !!info.paneId).map(([, info]) => ({ ...info }));
    return { sessions, ...this.discoveries.get(workspaceId) };
  }
  /** The conversations running in a folder now, with their pane PIDs: one tmux probe and one
   * screen read, no history scan, nothing remembered. For quitting. */
  async runningSessions(workspace: Workspace): Promise<(SessionInfo & { paneId: string; panePid: number })[]> {
    return diagnostic.operation('backend.running_sessions', { workspaceId: workspace.id }, async () => {
      const location = await this.locate(workspace), probed = await this.probe(workspace);
      const panes = probed.filter(pane => this.paneBelongs(pane, location, !!pane.sessionId && !!this.sessions.get(this.key(workspace, pane.sessionId))?.path));
      const mapped = new Map<string, InternalPane[]>();
      for (const pane of panes) if (pane.active && pane.sessionId) mapped.set(pane.sessionId, [...(mapped.get(pane.sessionId) ?? []), pane]);
      const sessions: (SessionInfo & { paneId: string; panePid: number })[] = [];
      // As in discovery: a conversation claimed by two live panes has no pane of its own.
      for (const [id, [pane, ...others]] of mapped) {
        if (others.length) continue;
        const known = this.sessions.get(this.key(workspace, id));
        sessions.push({ ...(known ?? { id, title: t('backend.newConversation') }), id, paneId: pane.id, panePid: pane.pid, mapping: pane.managed ? 'exact' : 'manual' });
      }
      await this.applyNavigationStatuses(workspace, sessions, panes);
      return sessions;
    });
  }
  /** Quitting: close a listed conversation after checking it again. A conversation whose
   * Claude Code is already gone counts as closed; one that moved or changed fails. */
  async closeListed(workspace: Workspace, sessionId: string, paneId: string, panePid?: number): Promise<void> {
    assertSessionId(sessionId); assertPaneId(paneId);
    const location = await this.locate(workspace), panes = await this.probe(workspace);
    const pane = panes.find(item => item.id === paneId);
    const elsewhere = panes.some(item => item.id !== paneId && item.active && item.sessionId === sessionId && this.paneBelongs(item, location, true));
    if (!pane || pane.dead || (!pane.claudePid && !pane.identityError)) {
      if (elsewhere) throw new SessionMappingError(t('backend.closeBindingChanged'));
      return;
    }
    if (pane.identityError) throw new SessionMappingError(pane.identityError);
    if (pane.sessionId !== sessionId || (panePid !== undefined && pane.pid !== panePid)) throw new SessionMappingError(t('backend.closeBindingChanged'));
    await this.closeSession(workspace, sessionId, paneId, pane.pid, false);
  }
  async closeSession(workspace: Workspace, sessionId: string, expectedPane: string, expectedPid: number, rediscover = true): Promise<SessionInfo | null> {
    assertPaneId(expectedPane);
    if (!Number.isSafeInteger(expectedPid) || expectedPid < 1) throw new Error(t('backend.invalidPid'));
    return diagnostic.operation('backend.close', { workspaceId: workspace.id, sessionId, expectedPane, expectedPid }, () =>
      this.withInput(workspace, sessionId, async () => {
        const location = await this.locate(workspace);
        const session = await this.getSession(workspace, sessionId);
        const pane = this.currentPane(await this.probe(workspace), session, location);
        if (!pane?.active || pane.id !== expectedPane || pane.pid !== expectedPid || !pane.claudePid) {
          throw new SessionMappingError(t('backend.closeBindingChanged'));
        }
        // A TERM gives the native app an opportunity to flush its transcript.
        // This also works during dialogs without typing text into their controls.
        const identity = '#{pane_id}|#{pane_pid}|#{@lectern_session_id}';
        const expected = `${expectedPane}|${expectedPid}|${pane.boundSessionId ?? ''}`;
        // tmux 3.8 and later report an empty #{pane_pid} once the pane's process has
        // exited (remain-on-exit); pane IDs are never reused within a server.
        const exited = `${expectedPane}||${pane.boundSessionId ?? ''}`;
        const getIdentity = this.tmux('display-message', '-p', '-t', expectedPane, identity);
        const proc = pane.claudePid;
        const script = `set -eu
export LC_ALL=C
[ "$(${getIdentity})" = ${q(expected)} ] || { echo ${q(t('backend.closeIdentityChanged'))} >&2; exit 1; }
ps -p ${proc} -o pgid=,tpgid= | awk 'NF == 2 && $1 > 0 && $1 == $2 { found=1 } END { exit !found }' || { echo ${q(t('backend.claudeLeftForeground'))} >&2; exit 1; }
${pane.presenceFingerprint ? presenceUnchangedGuard(location.claudeDir, proc, pane.presenceFingerprint) : ''}
kill -TERM ${proc}
tries=0
while kill -0 ${proc} 2>/dev/null; do
 case "$(ps -p ${proc} -o stat= 2>/dev/null)" in (*Z*) break;; esac
 tries=$((tries + 1)); [ "$tries" -lt 80 ] || { echo ${q(t('backend.claudeStillExiting'))} >&2; exit 1; }
 sleep 0.1
done
list_target() {
 if all=$(${this.tmux('list-panes', '-a', '-F', identity + '|#{pane_dead}|#{pane_current_command}')} 2>&1); then
  printf '%s\\n' "$all" | awk -F '|' -v id=${q(expectedPane)} '$1 == id'
 else
  case "$all" in (*'no server running'*|*'no sessions'*|*'No such file or directory'*) return 0;; (*) echo "$all" >&2; return 1;; esac
 fi
}
remaining=$(list_target)
expected=${q(expected)}
exited=${q(exited)}
case "$remaining" in
 ('') exit 0;;
 ("$expected|1|"*|"$exited|1|"*|"$expected|0|sh"|"$expected|0|bash"|"$expected|0|zsh"|"$expected|0|dash"|"$expected|0|fish"|"$expected|0|ksh")
   if ! error=$(${this.tmux('kill-pane', '-t', expectedPane)} 2>&1); then
     remaining=$(list_target)
     [ -z "$remaining" ] || { echo "$error" >&2; exit 1; }
   fi;;
 ("$expected|"*) remaining=$(list_target); [ -z "$remaining" ] || { echo ${q(t('backend.otherForegroundProgram'))} >&2; exit 1; };;
 (*) echo ${q(t('backend.closeStoppedIdentity'))} >&2; exit 1;;
esac
remaining=$(list_target)
[ -z "$remaining" ] || { echo ${q(t('backend.paneNotClosed'))} >&2; exit 1; }`;
        await this.transport.run(workspace, script, { tag: 'tmux.close_session', timeoutMs: 16000 });
        this.touchWorkspace(workspace.id);
        // The read cursor stays: the open chat keeps its transcript and its next
        // read only adds what Claude flushed on exit (a fresh watch resets it anyway).
        this.sessions.delete(this.key(workspace, sessionId));
        // Quitting closes many in a row and reads nothing afterwards.
        if (!rediscover) return null;
        const discovery = await this.discover(workspace);
        return discovery.sessions.find(item => item.id === sessionId) ?? null;
      }));
  }
  private async writeBinding(workspace: Workspace, location: Location, sessionId: string, paneId: string, mapping: 'exact' | 'manual'): Promise<void> {
    await this.transport.run(workspace, 'set -e\n' + [
      ['@lectern_session_id', sessionId], ['@lectern_mapping', mapping], ['@lectern_cwd', location.cwd], ['@lectern_claude_dir', location.claudeDir], ['@lectern_config_override', workspace.claudeDir ? '1' : '0'],
    ].map(([option, value]) => this.tmux('set-option', '-p', '-t', paneId, option, value)).join('\n'));
  }
  async bindSession(workspace: Workspace, sessionId: string, paneId: string): Promise<void> {
    assertPaneId(paneId);
    const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
    const panes = await this.probe(workspace), pane = panes.find(p => p.id === paneId);
    if (!pane || !this.paneBelongs(pane, location, pane.sessionId === sessionId && !!session.path) || !pane.active) throw new Error('Select a live Claude pane in this working directory');
    if (pane.native && pane.native.sessionId !== sessionId) throw new SessionMappingError(t('backend.uuidMismatch'));
    if (panes.some(p => p.id !== paneId && p.sessionId === sessionId && p.active)) throw new Error('This session is already bound to another live pane');
    this.touchWorkspace(workspace.id);
    const revision = this.revision(workspace.id);
    await this.writeBinding(workspace, location, sessionId, paneId, 'manual');
    this.assertCurrentWorkspace(workspace, revision);
    this.touchWorkspace(workspace.id);
    this.sessions.set(this.key(workspace, sessionId), { ...session, paneId, mapping: 'manual', explicitlyBound: true });
    diagnostic.event('backend.mapping.bound', { workspaceId: workspace.id, sessionId, paneId, previousPaneId: session.paneId, mapping: 'manual' });
  }
  resetRead(workspaceId: string, sessionId: string): void {
    const key = `${workspaceId}:${sessionId}`;
    this.screenCache = undefined;
    this.cursors.delete(key);
    this.readGenerations.set(key, (this.readGenerations.get(key) ?? 0) + 1);
    diagnostic.event('backend.jsonl.cursor_reset', { workspaceId, sessionId, generation: this.readGenerations.get(key) }, 'debug');
  }
  invalidateWorkspace(workspaceId: string): void {
    this.completions.reset(workspaceId);
    this.historyIndexes.get(workspaceId)?.invalidate();
    this.historyIndexes.delete(workspaceId);
    for (const key of this.physicalPages.keys()) if (key.startsWith(workspaceId + ':')) this.physicalPages.delete(key);
    void this.options.historyIndexStore?.remove(workspaceId);
    for (const key of this.navigationCache.keys()) if (key.startsWith(workspaceId + ':')) this.navigationCache.delete(key);
    this.touchWorkspace(workspaceId);
    this.workspaceConfigRevisions.set(workspaceId, this.configRevision(workspaceId) + 1);
    for (const key of this.sessions.keys()) if (key.startsWith(workspaceId + ':')) this.sessions.delete(key);
    for (const key of new Set([...this.cursors.keys(), ...this.readGenerations.keys()])) if (key.startsWith(workspaceId + ':')) {
      this.cursors.delete(key);
      this.readGenerations.set(key, (this.readGenerations.get(key) ?? 0) + 1);
    }
    const signature = this.workspaceSignatures.get(workspaceId);
    if (signature) this.locations.delete(signature);
    this.workspaceSignatures.delete(workspaceId);
    diagnostic.event('backend.workspace.invalidated', { workspaceId, revision: this.revision(workspaceId), configurationRevision: this.configRevision(workspaceId) });
  }
  private transcriptPaths(session: SessionInfo, location: Location) {
    return session.path ? [session.path] : location.projectDirs.map(dir => `${dir}/${session.id}.jsonl`);
  }
  /** Read-only access to the predecessor's complete ORIGINAL file, including
   * any branch that was not copied after the matching compact boundary. */
  async readHandoffHistory(workspace: Workspace, tipSessionId: string, sourceSessionId: string, cursor?: HistoryCursor, sizeMiB = 0.125): Promise<HistoryPage> {
    assertSessionId(sourceSessionId);
    await this.getSession(workspace,tipSessionId);
    const key = this.key(workspace,tipSessionId), layout = this.physicalPages.get(key);
    const file = layout?.source.previous.find(part => part.file.id === sourceSessionId)?.file;
    if (!file || !layout) throw new Error(t('backend.sourceNotVerified'));
    const ticket = `${layout.key}:${sourceSessionId}`;
    if (cursor && (cursor.layout !== ticket || cursor.inode !== file.inode || cursor.size !== file.size)) throw new Error(t('backend.handoffChanged'));
    const frame = {before:cursor?.before ?? file.size, size:file.size, inode:file.inode, frozenStamp:physicalStamp(file), layout:ticket};
    const page = await new TranscriptPages(this.transport,workspace,sourceSessionId,[file.path]).older(frame,sizeMiB);
    if (this.physicalPages.get(key)?.key !== layout.key) throw new Error(t('backend.handoffChanged'));
    return page;
  }
  private async subagentDirs(workspace: Workspace, sessionId: string) {
    const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
    return [...(session.path ? [posix.dirname(session.path)] : []), ...location.projectDirs];
  }
  private subagentPoll(key: string): SubagentPollState {
    const state = this.subagentPolls.get(key) ?? subagentPollState();
    // Most recently polled last; the oldest goes beyond 64 sessions.
    this.subagentPolls.delete(key);
    this.subagentPolls.set(key, state);
    if (this.subagentPolls.size > 64) this.subagentPolls.delete(this.subagentPolls.keys().next().value!);
    return state;
  }
  /** The subagent transcripts of a session, newest first, with their meta files. */
  async listSubagents(workspace: Workspace, sessionId: string): Promise<SubagentFile[]> {
    const dirs = await this.subagentDirs(workspace, sessionId);
    const { stdout } = await this.transport.run(workspace, subagentListScript(dirs, sessionId), { tag: 'session.subagents', maxBytes: 4 * 1024 * 1024 });
    return decodeSubagentList(stdout);
  }
  /** A subagent's own transcript, read like the open conversation's: the newest
   * page first (reset), then appended bytes from `cursor`. */
  async readSubagent(workspace: Workspace, sessionId: string, agentId: string, cursor?: LiveCursor): Promise<SubagentRead> {
    const files = subagentPaths(await this.subagentDirs(workspace, sessionId), sessionId, agentId);
    const response = await this.transport.run(workspace, liveTranscriptScript(files, cursor, true), { tag: 'session.subagent', maxBytes: 2 * 1024 * 1024 });
    const window = decodeFileWindow(response.stdout);
    const page = window.reset && window.inode !== 'missing'
      ? await new TranscriptPages(this.transport, workspace, sessionId, files, '', agentId).page(window) : undefined;
    let jsonl = page?.jsonl ?? window.data;
    let skipPartial = page?.skipPartial ?? false;
    if (!window.reset && cursor?.skipPartial) {
      const lf = jsonl.indexOf(10);
      skipPartial = lf < 0;
      jsonl = lf < 0 ? Buffer.alloc(0) : jsonl.subarray(lf + 1);
    }
    return { jsonl, reset: window.reset, missing: window.inode === 'missing', hasMore: window.end < window.size, olderCursor: page?.olderCursor,
      skippedHistoryRecords: page?.skippedHistoryRecords, cursor: { offset: window.end, inode: window.inode, skipPartial, stamp: window.stamp, guard: window.guard } };
  }
  /** A window of a background shell's or monitor's native output file (task-output-files.ts). */
  async readTaskOutput(workspace: Workspace, sessionId: string, taskId: string, window: TaskOutputWindow): Promise<TaskOutputRead> {
    const script = taskOutputScript(await this.subagentDirs(workspace, sessionId), sessionId, taskId, window);
    const { stdout } = await this.transport.run(workspace, script, { tag: 'session.task_output', maxBytes: window.limit + 1024 });
    return decodeTaskOutput(stdout);
  }
  async readSubagentOlder(workspace: Workspace, sessionId: string, agentId: string, cursor: HistoryCursor, sizeMiB?: number): Promise<HistoryPage> {
    const files = subagentPaths(await this.subagentDirs(workspace, sessionId), sessionId, agentId);
    return new TranscriptPages(this.transport, workspace, sessionId, files, '', agentId).older(cursor, sizeMiB);
  }
  async readOlderHistory(workspace: Workspace, sessionId: string, cursor: HistoryCursor, sizeMiB?: number): Promise<HistoryPage> {
    const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
    const key = this.key(workspace,sessionId), layout = this.physicalPages.get(key);
    if (layout) {
      const page = await layout.older(this.transport,workspace,cursor,sizeMiB);
      if (this.physicalPages.get(key)?.key !== layout.key) throw new Error(t('backend.resumedHistoryChanged'));
      return page;
    }
    if (cursor.layout) throw new Error(t('backend.resumedHistoryChanged'));
    return new TranscriptPages(this.transport, workspace, sessionId, this.transcriptPaths(session, location)).older(cursor, sizeMiB);
  }
  async readSession(workspace: Workspace, sessionId: string, forceViewport = false, activityTargets: ActivityReadTarget[] = [], tailFirst = false, terminalVisible = false, recheckLayout = true, listSubagents = false, findSessionProcess = false): Promise<ReadResult> {
    return diagnostic.operation('backend.read', { workspaceId: workspace.id, sessionId }, async () => {
    const key = this.key(workspace, sessionId), generation = this.readGenerations.get(key) ?? 0;
    this.readGenerations.set(key, generation);
    const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
    const cursor = this.cursors.get(key), layout = this.physicalPages.get(key);
    const candidates = this.transcriptPaths(session, location);
    const script = liveTranscriptScript(candidates, cursor, tailFirst);
    const separator = `__LECTERN_TRANSCRIPT_${randomUUID()}__`;
    const activitySeparator = activityTargets.length ? `__LECTERN_ACTIVITY_${randomUUID()}__` : '';
    // The subagent folder, in the same command (subagent-files.ts): `=` alone when nothing changed.
    const subagentSeparator = listSubagents ? `__LECTERN_SUBAGENTS_${randomUUID()}__` : '';
    // A live Claude Code process of this session outside Lectern's panes (native-presence.ts).
    const processSeparator = findSessionProcess ? `__LECTERN_PROCESS_${randomUUID()}__` : '';
    const subagentPoll = listSubagents ? this.subagentPoll(key) : undefined, bsd = /^(Darwin|.*BSD)$/.test(location.os ?? '');
    const subagentDirs = [...(session.path ? [posix.dirname(session.path)] : []), ...location.projectDirs];
    const pollScript = `${readStatusLineSample(session.paneId, this.options.tmuxSocket)}
${activitySeparator ? readActivityFiles(sessionId, location.projectDirs, activityTargets) + '\nprintf %s ' + q(activitySeparator) : ''}
${subagentPoll ? subagentPollScript(subagentDirs, sessionId, subagentPoll, bsd) + '\nprintf %s ' + q(subagentSeparator) : ''}
${processSeparator ? '(\n' + sessionPresenceScript(location.claudeDir, sessionId) + '\n)\nprintf %s ' + q(processSeparator) : ''}
(
${this.probeScript(location)}
)
printf '%s' ${q(separator)}
${script}`;
    const response = await this.transport.run(workspace, pollScript, { tag: 'session.poll', maxBytes: 20 * 1024 * 1024 });
    const boundary = response.stdout.indexOf(separator);
    if (boundary < 0) throw new Error('Incomplete session poll response');
    const statusEnd = response.stdout.indexOf(0);
    if (statusEnd < 0 || statusEnd >= boundary) throw new Error('Incomplete status line poll response');
    const statusFrame = response.stdout.subarray(0, statusEnd).toString('ascii');
    const activityEnd = activitySeparator ? response.stdout.indexOf(activitySeparator, statusEnd + 1) : statusEnd + 1;
    if (activityEnd < 0 || activityEnd > boundary) throw new Error('Incomplete activity poll response');
    const activitySamples = activitySeparator ? decodeActivityFiles(response.stdout.subarray(statusEnd + 1, activityEnd)) : [];
    const subagentsStart = activityEnd + activitySeparator.length;
    const subagentsEnd = subagentSeparator ? response.stdout.indexOf(subagentSeparator, subagentsStart) : subagentsStart;
    if (subagentsEnd < 0 || subagentsEnd > boundary) throw new Error('Incomplete subagent poll response');
    if (subagentPoll) applySubagentPoll(response.stdout.subarray(subagentsStart, subagentsEnd), subagentPoll, bsd);
    const subagents = subagentPoll && { revision: subagentPoll.revision, files: subagentPoll.files };
    const processStart = subagentsEnd + subagentSeparator.length;
    const processEnd = processSeparator ? response.stdout.indexOf(processSeparator, processStart) : processStart;
    if (processEnd < 0 || processEnd > boundary) throw new Error('Incomplete session process response');
    const elsewhere = processSeparator ? sessionProcess(response.stdout.subarray(processStart, processEnd).toString('ascii').split('\0'), sessionId) : undefined;
    const paneData = this.parseProbe(workspace, location, response.stdout.subarray(processEnd + processSeparator.length, boundary));
    const record = { stdout: response.stdout.subarray(boundary + separator.length) };
    const pane = this.currentPane(paneData, session, location, true);
    const window = decodeFileWindow(record.stdout);
    const { inode, size, offset, reset } = window;
    const nextOffset = window.end;
    if (layout && (reset || layout.source.file.id !== sessionId) && recheckLayout && !layout.matchesTip(window)) {
      // The tip may have appended between sidebar discovery and opening it.
      // Reverify the edge once; a replacement must not inherit the old prefix.
      await this.discover(workspace);
      return this.readSession(workspace,sessionId,forceViewport,activityTargets,tailFirst,terminalVisible,false,listSubagents,findSessionProcess);
    }
    if (layout && layout.source.file.id !== sessionId && !layout.matchesTip(window)) throw new Error(t('backend.aliasCopyChanged'));
    const page = reset && tailFirst
      ? await new TranscriptPages(this.transport, workspace, sessionId, candidates).page(window) : undefined;
    if (page && layout) page.olderCursor = layout.cursor(page.olderCursor, window);
    let jsonl = page?.jsonl ?? window.data;
    let skipPartial = page?.skipPartial ?? false;
    if (!reset && cursor?.skipPartial) {
      const lf = jsonl.indexOf(10);
      skipPartial = lf < 0;
      jsonl = lf < 0 ? Buffer.alloc(0) : jsonl.subarray(lf + 1);
    }
    let screen = '', viewport = '', viewportError: string | undefined, capturedAt: number | undefined;
    let terminalFrame: TerminalFrame | undefined;
    let nativeTasks: ConversationTask[] | undefined;
    const identity = pane && JSON.stringify([key, pane.nativeTarget, pane.cwd, pane.pid, pane.claudePid, pane.native?.procStart, pane.native?.registrationId, pane.serverInstance,
      pane.native?.status, pane.native?.waitingFor, pane.width, pane.height, pane.cursorX, pane.cursorY]);
    const cached = identity && this.screenCache?.identity === identity ? this.screenCache : undefined;
    const stable = pane?.native?.status && ['idle', 'shell', 'waiting'].includes(pane.native.status);
    if (cached && stable && !this.sending.size && !forceViewport && !terminalVisible && !reset && !jsonl.length && Date.now() - cached.capturedAt < 2500) {
      screen = cached.screen; viewport = cached.viewport; capturedAt = cached.capturedAt; nativeTasks = cached.nativeTasks;
    } else if (pane && identity && !pane.identityError) {
      const marker = `\n__LECTERN_CAPTURE_${randomUUID()}__:`;
      const previous = cached && Date.now() - cached.scrollbackAt < 5000 ? cached : undefined;
      const capture = (...bounds: string[]) => this.tmux('capture-pane', '-p', '-J', ...bounds, '-t', pane.id);
      // Native /clear can retain the old UUID's tmux scrollback. Only the
      // current viewport may contribute provisional text to that new session.
      const onlyVisible = !!pane.forkOrigin || !!pane.native && pane.boundSessionId !== sessionId;
      const after = pane.claudePid ? presenceReadScript(location.claudeDir, pane.claudePid) : '';
      const captureScript = `lectern_visible=$({ ${capture()} 2>&1; printf '%s%s' ${q(marker)} "$?"; } | head -c 16512)
printf '%s' "$lectern_visible" | base64
printf '\\0'
lectern_checksum=$(printf '%s' "\${lectern_visible%${q(marker + '0')}}" | cksum)
printf '%s\\0' "$lectern_checksum"
${onlyVisible ? '' : `if [ "$lectern_checksum" != ${q(previous?.checksum ?? '')} ]; then
 { ${capture('-S', '-2000')} 2>&1; printf '%s%s' ${q(marker)} "$?"; } | head -c ${2 * 1024 * 1024 + 128} | base64
fi`}
printf '\\0'
${terminalVisible ? `{ ${this.tmux('capture-pane', '-p', '-e', '-t', pane.id, ';', 'display-message', '-p', '-t', pane.id, '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag}')} 2>/dev/null; printf '%s%s' ${q(marker)} "$?"; } | head -c 262272 | base64` : ''}
printf '\\0'
${taskListFrame(location.claudeDir, sessionId)}
printf '\\0'
${after}`;
      const captured = await this.transport.run(workspace, captureScript, { tag: 'tmux.session_capture', maxBytes: (terminalVisible ? 5 : 4) * 1024 * 1024 });
      const [visibleFrame, checksum, historyFrame, physicalFrame, taskFrame, ...postCapture] = captured.stdout.toString('utf8').split('\0');
      if (pane.claudePid) {
        const observed = decodePresence(postCapture);
        const frame = observed.frames.get(pane.claudePid);
        const native = frame ? matchPresence(frame, pane.nativeTarget, presenceDirectories(location, pane)) : undefined;
        if (observed.unsafe || (frame || pane.native) && (!native || native.sessionId !== sessionId || pane.native && (native.procStart !== pane.native.procStart || native.registrationId !== pane.native.registrationId))) {
          this.screenCache = undefined;
          throw new SessionMappingError(t('backend.identityChangedDuringCapture'));
        }
        if (native && frame) { pane.native = native; pane.presenceFingerprint = frame.fingerprint; }
      }
      const decode = (encoded: string | undefined, limit: number): ViewportObservation => {
        if (encoded === undefined) return { error: t('backend.captureIncomplete') };
        const output = Buffer.from(encoded, 'base64').toString('utf8'), at = output.lastIndexOf(marker);
        if (at < 0 || Buffer.byteLength(output.slice(0, at)) > limit) return { error: t('backend.captureTooLarge') };
        if (output.slice(at + marker.length) !== '0') return { error: t('backend.captureTmuxFailed') };
        return { screen: output.slice(0, at) };
      };
      // Keep escape sequences and physical wraps out of the chat/status parsers.
      // One tmux command list samples the rows and cursor for this pane together.
      if (physicalFrame) {
        const physical = decode(physicalFrame, 262144).screen;
        const dims = physical?.match(/\n(\d+) (\d+) (\d+) (\d+) ([01])\n$/);
        if (physical && dims && dims.index !== undefined) {
          const [, cols, rows, x, y, visible] = dims.map(Number);
          if (cols > 0 && cols <= 1024 && rows > 0 && rows <= 512 && x <= cols && y < rows)
            terminalFrame = { paneId: pane.id, ansi: physical.slice(0, dims.index), cols, rows, cursorX: Math.min(cols - 1, x), cursorY: y, cursorVisible: !!visible };
        }
      }
      const visible = decode(visibleFrame, 16384);
      viewport = visible.screen ?? ''; viewportError = visible.error;
      if (onlyVisible) screen = viewport;
      else if (!historyFrame && previous && previous.checksum === checksum) screen = previous.screen;
      else {
        const historyScreen = decode(historyFrame, 2 * 1024 * 1024);
        if (historyScreen.error) throw new Error(historyScreen.error);
        screen = historyScreen.screen!;
      }
      capturedAt = Date.now();
      const scrollbackAt = !onlyVisible && !historyFrame && previous ? previous.scrollbackAt : capturedAt;
      if (!viewportError) {
        const panel = nativeTaskPanel(stripTerminalEscapes(viewport).split('\n'));
        if (panel) nativeTasks = panel.tasks ?? decodeTaskList(taskFrame);
        this.screenCache = { identity, checksum, screen, viewport, capturedAt, scrollbackAt, nativeTasks };
      }
      diagnostic.event('backend.pane.viewport', { workspaceId: workspace.id, sessionId, paneId: pane.id, ...summarize(viewport), error: viewportError }, viewportError ? 'warn' : 'debug');
    }
    if (pane) diagnostic.event('backend.pane.captured', { workspaceId: workspace.id, sessionId, paneId: pane.id, width: pane.width, height: pane.height, cursorX: pane.cursorX, cursorY: pane.cursorY, joinWrappedLines: true, scrollbackStart: -2000, active: pane.active, dead: pane.dead, ...summarize(screen) }, 'debug');
    if (!pane && paneData.some(p => p.boundSessionId === sessionId && p.native && p.native.sessionId !== sessionId) && inode === 'missing') {
      throw new SessionMappingError(t('backend.newUuidSelect'));
    }
    if (inode === 'missing' && (!pane || pane.dead)) {
      this.sessions.delete(key);
      this.resetRead(workspace.id, sessionId);
      throw new SessionGoneError('Session transcript no longer exists and no live Claude pane is bound to it');
    }
    if (this.physicalPages.get(key)?.key !== layout?.key) throw new Error(t('backend.resumedHistoryChanged'));
    if (this.readGenerations.get(key) === generation) this.cursors.set(key, { offset: nextOffset, inode, skipPartial, stamp: window.stamp, guard: window.guard });
    const currentSession: SessionInfo = { ...session, paneId: pane?.active ? pane.id : undefined, mapping: pane?.active ? (pane.managed ? 'exact' : 'manual') : 'unbound', background: undefined, ...paneNavigationStatus(pane, pane ? { screen: viewport, error: viewportError } : undefined) };
    if (pane && capturedAt && !viewportError) this.rememberNavigation(workspace, pane, { status: currentSession.status!, statusDetail: currentSession.statusDetail, background: currentSession.background }, capturedAt);
    diagnostic.event('backend.jsonl.read', { workspaceId: workspace.id, sessionId, path: session.path ?? candidates[0], pathInferred: !session.path, inode, offset, windowBytes: window.data.length, selectedBytes: jsonl.length, fileSize: size, olderBefore: page?.olderCursor?.before, ...summarize(jsonl), reset, hasMore: nextOffset < size, generation, cursorCommitted: this.readGenerations.get(key) === generation }, 'debug');
    if (this.sessions.get(key) === session) this.sessions.set(key, currentSession);
    const directoryTrust = this.directoryTrust.observe({ workspaceId: workspace.id, sessionId, targetKey: `${JSON.stringify(workspace)}:${this.configRevision(workspace.id)}` }, { paneId: pane?.id, active: !!pane?.active && !viewportError, viewport, cwdAliases: location.cwdAliases });
    if (pane?.active && pane.managed && !viewportError && viewport && parseAutoModeNudge(viewport)) this.declineAutoModeNudge(workspace, sessionId, pane.id);
    // These fields survive a desktop restart but change on a new native
    // registration, tmux server, pane or resolved target.
    const runtimeInstanceId = runtimeIdentity(workspace, location, pane);
    const registration = pane && statusLineRegistration(pane, session.paneId === pane.id ? statusFrame.split(',', 1)[0] : undefined);
    const statusLine = registration && session.paneId === pane?.id ? decodeStatusLineSample(statusFrame, registration, sessionId) : undefined;
    return { subagents, sessionProcess: elsewhere, nativeTasks, endpointBilling: this.endpointBilling?.observe(workspace, location.claudeDir), transcriptPosition: { inode, offset: nextOffset }, olderCursor: page?.olderCursor, skippedHistoryRecords: page?.skippedHistoryRecords, activitySamples, statusLineManaged: !!registration, statusLine, session: currentSession, screen, viewport, terminalFrame, jsonl, reset, active: pane?.active ?? false, hasMore: nextOffset < size, panePid: pane?.pid, runtimeInstanceId, screenCapturedAt: capturedAt ? new Date(capturedAt).toISOString() : undefined, nativeStatus: pane?.native?.status, nativeWaitingFor: pane?.native?.waitingFor, nativeStartedAt: pane?.native?.startedAt, directoryTrust };
    });
  }
  private async livePane(workspace: Workspace, sessionId: string, expected?: SettingRuntime): Promise<string> {
    const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
    const pane = this.currentPane(await this.probe(workspace), session, location);
    if (!pane?.active) throw new Error('Claude is not running in this pane. Resume the conversation before sending; input was not sent.');
    if ((expected?.panePid !== undefined && pane.pid !== expected.panePid) ||
        (expected?.instanceId !== undefined && runtimeIdentity(workspace, location, pane) !== expected.instanceId))
      throw new Error('Terminal pane process changed; enable control again before sending input');
    this.inputGuards.set(this.key(workspace, sessionId), this.nativeGuard(pane, location));
    return pane.id;
  }
  private nativeGuard(pane: InternalPane, location: Location, message?: string): string {
    return pane.claudePid && pane.presenceFingerprint ? presenceUnchangedGuard(location.claudeDir, pane.claudePid, pane.presenceFingerprint, message) + '\n' : '';
  }
  private sendPaneInput(workspace: Workspace, sessionId: string, command: string) {
    // livePane refreshed this guard during the current withInput transaction.
    return this.transport.run(workspace, (this.inputGuards.get(this.key(workspace, sessionId)) ?? '') + command);
  }
  /** Lectern starts its sessions with auto mode as the default (launch-settings.ts),
   * which keeps Claude Code from asking "Make auto mode your default permission
   * mode?". Should a release ask anyway in a pane Lectern launched, answer "No, keep
   * manual mode": the session stays in auto mode and the user's settings files are not
   * written. Every key is bound to the exact frame it was chosen from (the setting
   * driver's guard); at most two attempts per pane, then the dialog is left to the user. */
  private declineAutoModeNudge(workspace: Workspace, sessionId: string, paneId: string): void {
    const key = `${this.key(workspace, sessionId)}:${paneId}`;
    const state = this.autoModeNudges.get(key) ?? { attempts: 0, running: false };
    if (state.running || state.attempts >= 2 || this.sending.has(sessionId.toLowerCase())) return;
    state.attempts++;
    state.running = true;
    this.autoModeNudges.set(key, state);
    void diagnostic.operation('backend.auto_mode_nudge.decline', { workspaceId: workspace.id, sessionId, paneId, attempt: state.attempts }, () => this.withInput(workspace, sessionId, async () => {
      const driver = this.settingDriver(workspace, sessionId);
      let downs = 0;
      for (let step = 0; step < 10; step++) {
        const frame = await driver.inspect(true);
        const nudge = frame.paneId === paneId ? parseAutoModeNudge(frame.viewport) : undefined;
        if (!nudge) return;
        if (nudge.focused === 'no') { await driver.key('Enter', paneId, true); return; }
        // Claude may drop a key while it mounts the chooser: press Down again only
        // after the focus visibly stayed put for a while.
        if (downs === 0 || (downs === 1 && step >= 4)) { downs++; await driver.key('Down', paneId, true); }
        else await new Promise(resolve => setTimeout(resolve, 150));
      }
    })).catch(error => diagnostic.event('backend.auto_mode_nudge.failed', { workspaceId: workspace.id, sessionId, paneId, error: errorDetails(error) }, 'warn'))
      .finally(() => { state.running = false; });
  }
  private async withInput<T>(workspace: Workspace, sessionId: string, operation: () => Promise<T>): Promise<T> {
    assertSessionId(sessionId);
    // SSH aliases and local/SSH routes may reach the same physical pane.
    // Bind the lease to the native UUID
    // from the outset; a cloned transcript only contends while input is active.
    const lease = sessionId.toLowerCase();
    if (this.sending.has(lease)) { const error = new Error(t('backend.inputBusy')); error.name = 'SessionInputBusyError'; throw error; }
    this.sending.add(lease);
    this.navigationCache.clear();
    this.screenCache = undefined;
    try { return await operation(); } finally { this.sending.delete(lease); this.inputGuards.delete(this.key(workspace, sessionId)); this.screenCache = undefined; }
  }
  async sendMessage(workspace: Workspace, sessionId: string, text: string, expectedEmptyPane?: string): Promise<void> {
    return diagnostic.operation('backend.send', { workspaceId: workspace.id, sessionId }, async () => {
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('Message must be 1–100,000 characters without terminal control codes');
    return this.withInput(workspace, sessionId, () => this.submitText(workspace, sessionId, text, expectedEmptyPane));
    });
  }
  /** Claude Code collapses a pasted block into "[Pasted text #1 +N lines]"
   * and keeps it as a paste in the prompt. Typed text with Ctrl+J newlines is
   * recorded like the user's own keystrokes. Short literal chunks with a pause
   * stay below the size at which Claude Code treats one read as a paste. */
  private typedInput(paneId: string, text: string): string | undefined {
    if (!text.includes('\n') && text.length <= 600) return;
    // Leading / and ! switch Claude Code into command or shell entry, and tabs
    // or carriage returns are keys of their own. Those keep the paste path.
    if (/^[/!]/.test(text) || /[\t\r]/.test(text) || text.length > 20_000) return;
    const steps: string[] = [];
    text.split('\n').forEach((line, index) => {
      if (index) steps.push(this.tmux('send-keys', '-t', paneId, 'C-j'));
      for (const chunk of line.match(/[\s\S]{1,200}/gu) ?? []) steps.push(this.tmux('send-keys', '-t', paneId, '-l', '--', chunk));
    });
    return steps.join('\nsleep 0.01\n');
  }
  private async submitText(workspace: Workspace, sessionId: string, text: string, expectedPane?: string): Promise<void> {
    const bufferName = `lectern-${randomUUID()}`;
    diagnostic.event('backend.send.request', { workspaceId: workspace.id, sessionId, ...summarize(text), automaticRetry: false });
    try {
      const paneId = await this.livePane(workspace, sessionId);
      if (expectedPane && paneId !== expectedPane) throw new SessionSettingError(t('backend.settingPaneChangedNoCommand'));
      const typing = this.typedInput(paneId, text);
      if (typing && await new NativeKeybindings(this.transport, workspace).permits((await this.locate(workspace)).claudeDir, 'ctrl+j', ['Chat'])) {
        // Recheck immediately before typing and before Enter. Never silently retry an uncertain send.
        if (await this.livePane(workspace, sessionId) !== paneId) throw new Error('The pane binding changed while sending; input was not submitted');
        await this.sendPaneInput(workspace, sessionId, typing);
        diagnostic.event('backend.send.typed', { paneId, lines: text.split('\n').length, newlineKey: 'ctrl+j' });
        await new Promise(resolve => setTimeout(resolve, 150));
        if (await this.livePane(workspace, sessionId) !== paneId) throw new Error('The pane binding changed while sending; input was not submitted');
        await this.sendPaneInput(workspace, sessionId, this.tmux('send-keys', '-t', paneId, 'Enter'));
        diagnostic.event('backend.send.enter_accepted', { paneId, receipt: 'tmux_command_completed', claudeAcknowledged: false, automaticRetry: false });
        return;
      }
      await this.transport.run(workspace, this.tmux('load-buffer', '-b', bufferName, '-'), { input: text });
      diagnostic.event('backend.send.buffer_loaded', { paneId, bufferName });
      // Recheck immediately before paste and before Enter. Never silently retry an uncertain send.
      if (await this.livePane(workspace, sessionId) !== paneId) throw new Error('The pane binding changed while sending; input was not submitted');
      if (expectedPane) {
        const observation = await this.settingDriver(workspace, sessionId).inspect();
        if (observation.paneId !== expectedPane || !isIdleEmptyComposer(observation.viewport)) throw new SessionSettingError(t('backend.settingComposerChanged'));
      }
      await this.sendPaneInput(workspace, sessionId, this.tmux('paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', paneId));
      diagnostic.event('backend.send.pasted', { paneId, bracketedPaste: true, preserveNewlines: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await this.livePane(workspace, sessionId) !== paneId) throw new Error('The pane binding changed while sending; input was not submitted');
      await this.sendPaneInput(workspace, sessionId, this.tmux('send-keys', '-t', paneId, 'Enter'));
      diagnostic.event('backend.send.enter_accepted', { paneId, receipt: 'tmux_command_completed', claudeAcknowledged: false, automaticRetry: false });
    } finally {
      await this.transport.run(workspace, `${this.tmux('delete-buffer', '-b', bufferName)} 2>/dev/null || true`).catch(() => {});
    }
  }
  async sendKey(workspace: Workspace, sessionId: string, key: TerminalKey): Promise<void> {
    return diagnostic.operation('backend.key', { workspaceId: workspace.id, sessionId, key }, async () => {
    if (!KEYS.has(key)) throw new Error('Unsupported terminal key');
    return this.withInput(workspace, sessionId, async () => {
    const paneId = await this.livePane(workspace, sessionId);
    await this.sendPaneInput(workspace, sessionId, this.tmux('send-keys', '-t', paneId, tmuxKey(key)));
    diagnostic.event('backend.key.accepted', { paneId, key, receipt: 'tmux_command_completed' });
    });
    });
  }
  async verifyTerminalPane(workspace: Workspace, sessionId: string, expectedPaneId: string, expected?: SettingRuntime): Promise<void> {
    assertPaneId(expectedPaneId);
    return this.withInput(workspace, sessionId, async () => {
      if (await this.livePane(workspace, sessionId, expected) !== expectedPaneId) throw new Error('Terminal pane changed; enable control again before sending input');
    });
  }
  /** Same rules for the per-command path and the persistent takeover link. */
  validateTerminalInput(input: TerminalInput) {
    if (!input || typeof input !== 'object' || !['text', 'literal', 'key'].includes(input.type)) throw new Error('Unsupported terminal input');
    if (input.type === 'key' && !KEYS.has(input.key)) throw new Error('Unsupported terminal key');
    if (input.type === 'literal' && (typeof input.text !== 'string' || !input.text.length || input.text.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(input.text))) throw new Error('Typed terminal input must contain 1–1024 printable characters');
    if (input.type === 'text' && (typeof input.text !== 'string' || !input.text.length || Buffer.byteLength(input.text, 'utf8') > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cs}]/u.test(input.text))) throw new Error('Terminal text must be 1–65,536 UTF-8 bytes without terminal control codes');
  }
  /**
   * A takeover's fast path: one persistent shell that sends keys as they come and
   * returns screen captures. The pane must still have the PID verified at takeover.
   */
  async openTerminalLink(workspace: Workspace, paneId: string, panePid: number, events: Parameters<typeof startTerminalLink>[2]): Promise<TerminalLink> {
    assertPaneId(paneId);
    if (!Number.isSafeInteger(panePid) || panePid < 2) throw new Error(t('backend.invalidPanePid'));
    const buffer = 'lectern-link-' + randomUUID();
    const script = linkScript({
      sendKeys: this.tmux('send-keys', '-t', paneId), loadBuffer: this.tmux('load-buffer', '-b', buffer, '-'),
      pasteBuffer: this.tmux('paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', paneId),
      capture: this.tmux('capture-pane', '-p', '-e', '-t', paneId, ';', 'display-message', '-p', '-t', paneId, '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag}'),
      identity: this.tmux('display-message', '-p', '-t', paneId, '#{pane_pid}:#{pane_dead}'), expected: `${panePid}:0`,
    });
    const link = await startTerminalLink(await this.transport.stream(workspace, script), paneId, events);
    diagnostic.event('backend.terminal_link.opened', { workspaceId: workspace.id, paneId });
    return link;
  }
  async sendTerminalInput(workspace: Workspace, sessionId: string, input: TerminalInput, expectedPaneId: string, expected?: SettingRuntime, assertOwned?: () => void): Promise<void> {
    return diagnostic.operation('backend.terminal_input', { workspaceId: workspace.id, sessionId }, async () => {
      assertPaneId(expectedPaneId);
      this.validateTerminalInput(input);
      return this.withInput(workspace, sessionId, async () => {
        const paneId = await this.livePane(workspace, sessionId, expected);
        if (paneId !== expectedPaneId) throw new Error('Terminal pane changed; enable control again before sending input');
        assertOwned?.(); // The view may have closed during the foreground probe.
        const captureId = diagnostic.capture('terminal.input', input.type === 'key' ? input.key : input.text, { type: input.type, workspaceId: workspace.id, sessionId, paneId });
        diagnostic.event('backend.terminal_input.request', { paneId, type: input.type, key: input.type === 'key' ? input.key : undefined, captureId, automaticRetry: false });
        if (input.type === 'key') {
          await this.sendPaneInput(workspace, sessionId, this.tmux('send-keys', '-t', paneId, tmuxKey(input.key)));
          diagnostic.event('backend.terminal_input.accepted', { paneId, type: 'key', key: input.key, captureId, receipt: 'tmux_command_completed' });
          return;
        }
        if (input.type === 'literal') {
          // tmux itself treats a standalone ';' argv as a command separator,
          // even after shell quoting. Hex bytes preserve every literal key.
          const bytes = [...Buffer.from(input.text, 'utf8')].map(byte => byte.toString(16).padStart(2, '0'));
          await this.sendPaneInput(workspace, sessionId, this.tmux('send-keys', '-t', paneId, '-H', ...bytes));
          diagnostic.event('backend.terminal_input.accepted', { paneId, type: 'literal', captureId, automaticEnter: false, receipt: 'tmux_command_completed' });
          return;
        }
        const bufferName = `lectern-terminal-${randomUUID()}`;
        try {
          await this.transport.run(workspace, this.tmux('load-buffer', '-b', bufferName, '-'), { input: input.text });
          diagnostic.event('backend.terminal_input.buffer_loaded', { paneId, bufferName, captureId });
          if (await this.livePane(workspace, sessionId, expected) !== paneId) throw new Error('The pane binding changed while pasting terminal text; input was not pasted');
          assertOwned?.();
          await this.sendPaneInput(workspace, sessionId, this.tmux('paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', paneId));
          diagnostic.event('backend.terminal_input.accepted', { paneId, type: 'text', captureId, bracketedPaste: true, preserveNewlines: true, automaticEnter: false, receipt: 'tmux_command_completed' });
        } finally {
          await this.transport.run(workspace, `${this.tmux('delete-buffer', '-b', bufferName)} 2>/dev/null || true`).catch(() => {});
        }
      });
    });
  }
  async turnAction(workspace: Workspace, sessionId: string, paneId: string, panePid: number, action: TurnAction, target?: RewindTarget, assertCurrent?: () => void, position?: TranscriptPosition) {
    assertPaneId(paneId);
    if (!Number.isSafeInteger(panePid) || panePid < 2) throw new Error(t('backend.invalidPanePid'));
    return this.withInput(workspace, sessionId, async () => {
      let historyGuard: string | undefined;
      if (target && position) {
        const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
        const cursor = this.cursors.get(this.key(workspace,sessionId));
        if (cursor?.inode !== position.inode || cursor?.offset !== position.offset) throw new Error(t('backend.rewindHistoryChanged'));
        historyGuard = transcriptVersionGuard(this.transcriptPaths(session, location), cursor);
      }
      return performTurnAction(this.settingDriver(workspace, sessionId, {historyGuard}), paneId, panePid, action, target, assertCurrent);
    });
  }
  async answerQuestion(workspace: Workspace, sessionId: string, paneId: string, panePid: number, screen: NativeQuestionScreen,
    action: QuestionAction, expected: SettingRuntime, position: TranscriptPosition | undefined, assertCurrent: () => void) {
    assertPaneId(paneId);
    if (!Number.isSafeInteger(panePid) || panePid < 2) throw new Error(t('backend.invalidPanePid'));
    return this.withInput(workspace, sessionId, async () => {
      let historyGuard: string | undefined;
      if (position && position.inode !== 'missing') {
        const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
        const cursor = this.cursors.get(this.key(workspace, sessionId));
        if (cursor?.inode !== position.inode || cursor.offset !== position.offset) throw new Error(t('backend.questionRecordChanged'));
        historyGuard = transcriptVersionGuard(this.transcriptPaths(session, location), cursor);
      }
      const driver = this.settingDriver(workspace, sessionId, { expected, historyGuard, assertCurrent });
      return performQuestionAction(driver, paneId, panePid, screen, action, assertCurrent);
    });
  }
  async answerPermission(workspace: Workspace, sessionId: string, paneId: string, panePid: number, screen: NativePermissionScreen,
    action: PermissionAction, expected: SettingRuntime, position: TranscriptPosition | undefined, assertCurrent: () => void) {
    assertPaneId(paneId);
    if (!Number.isSafeInteger(panePid) || panePid < 2) throw new Error(t('backend.invalidPanePid'));
    return this.withInput(workspace, sessionId, async () => {
      let historyGuard: string | undefined;
      if (position && position.inode !== 'missing') {
        const session = await this.getSession(workspace, sessionId), location = await this.locate(workspace);
        const cursor = this.cursors.get(this.key(workspace, sessionId));
        if (cursor?.inode !== position.inode || cursor.offset !== position.offset) throw new Error(t('backend.permissionRecordChanged'));
        historyGuard = transcriptVersionGuard(this.transcriptPaths(session, location), cursor);
      }
      const driver = this.settingDriver(workspace, sessionId, { expected, historyGuard, assertCurrent });
      return performPermissionAction(driver, paneId, panePid, screen, action, assertCurrent);
    });
  }
  private settingDriver(workspace: Workspace, sessionId: string, options: { expected?: SettingRuntime; historyGuard?: string; assertCurrent?: () => void; onSwitchDispatch?: () => void } = {}): SettingDriver & TurnDriver & QuestionDriver {
    const { expected } = options;
    const resolve = async () => {
      const session = await this.getSession(workspace, sessionId);
      const location = await this.locate(workspace);
      return { session, location, revision: this.configRevision(workspace.id) };
    };
    const select = (panes: InternalPane[], session: SessionInfo, location: Location) => {
      const pane = this.currentPane(panes, session, location);
      if ((expected?.panePid !== undefined && pane?.pid !== expected.panePid)
        || (expected?.instanceId !== undefined && runtimeIdentity(workspace, location, pane) !== expected.instanceId)) {
        throw new SessionSettingError(t('backend.settingProcessChanged'));
      }
      return pane;
    };
    let resolved: ReturnType<typeof resolve> | undefined;
    const bindings = new NativeKeybindings(this.transport, workspace);
    let kind: SessionSettingKind = 'model';
    let last: { pane: InternalPane; viewport: string; location: Location } | undefined;
    let pending: Awaited<ReturnType<SettingDriver['inspect']>> | undefined;
    // 问答的焦点、勾选与编辑器状态均有文本标记。终端主题动画会单独改变 ANSI 颜色。
    const capture = (id: string) => this.tmux('capture-pane', '-p', '-J', ...(options.assertCurrent ? [] : ['-e']), '-t', id);

    // Capture only the expected pane and resolve the complete foreground/UUID
    // mapping in the same round trip. A changed or ambiguous binding discards
    // both captures. Two equal frames separated by a probe and a settle interval
    // can satisfy the native menu's stability check without another SSH call.
    const read = async (settle: boolean, input = '', rejectedNavigation?: string, switchSession = false, torn = 0): Promise<{ paneId: string; viewport: string; stable: boolean }> => {
      const { session, location, revision } = await (resolved ??= resolve());
      this.assertCurrentWorkspaceConfiguration(workspace, revision);
      const paneId = last?.pane.id ?? session.paneId ?? this.currentPane(await this.probe(workspace), session, location)?.id;
      if (!paneId) throw new SessionSettingError(t('backend.claudeNotForeground'));
      assertPaneId(paneId);
      if (switchSession) {
        options.onSwitchDispatch?.();
        const {stdout} = await this.transport.run(workspace, 'set -e\n' + input, { tag: 'session.branch.submit' });
        if (rejectedNavigation && stdout.equals(Buffer.from(rejectedNavigation))) throw new NavigationKeyNotSent();
        return { paneId, viewport: '', stable: false };
      }
      const marker = '__LECTERN_FRAME_' + randomUUID() + '__', boundary = '\0' + marker + '\0';
      const script = `set -e
${input}
lectern_frame() { { ${capture(paneId)} 2>&1; printf '%s%d' ${q(marker)} "$?"; } | head -c 16512; }
${settle ? 'lectern_frame\nsleep 0.06 &\nlectern_delay=$!' : ''}
printf '\\0'
(
${this.probeScript(location)}
)
printf '\\0%s\\0' ${q(marker)}
${settle ? 'wait "$lectern_delay"' : ''}
lectern_frame`;
      const { stdout } = await this.transport.run(workspace, script, { tag: input ? 'settings.input_observe' : 'settings.observe' });
      this.assertCurrentWorkspaceConfiguration(workspace, revision);
      if (rejectedNavigation && stdout.equals(Buffer.from(rejectedNavigation))) throw new NavigationKeyNotSent();
      if (rejectedNavigation && stdout.equals(Buffer.from(rejectedNavigation + RECORD_CHANGED))) throw new TranscriptChangedNoKeys();
      const split = stdout.indexOf(0), end = stdout.indexOf(boundary, split + 1);
      if (split < 0 || end < 0) throw new SessionSettingError(t('backend.settingScreenIncomplete'));
      const panes = this.parseProbe(workspace, location, stdout.subarray(split + 1, end));
      // A torn native record (see tornPresence): observe again, without the input, which
      // has either been sent already or refused. At most twice, as probe() does.
      if (torn < 2 && panes.some(pane => pane.id === paneId && pane.presenceTorn)) {
        await new Promise(resolve => setTimeout(resolve, 30));
        return read(settle, '', undefined, false, torn + 1);
      }
      const pane = select(panes, session, location);
      if (!pane?.active || !pane.claudePid || pane.id !== paneId || (last && (last.pane.pid !== pane.pid
        || last.pane.claudePid !== pane.claudePid || last.pane.serverInstance !== pane.serverInstance
        || last.pane.native?.procStart !== pane.native?.procStart
        || last.pane.native?.registrationId !== pane.native?.registrationId))) {
        throw new SessionSettingError(t('backend.settingBindingChanged'));
      }
      const decode = (bytes: Buffer) => {
        const index = bytes.lastIndexOf(marker);
        if (index < 0 || index > 16384 || bytes.subarray(index + marker.length).toString() !== '0') throw new SessionSettingError(t('backend.settingScreenUnreadable'));
        return bytes.subarray(0, index).toString('utf8');
      };
      const viewport = decode(stdout.subarray(end + boundary.length));
      const stable = settle && animatedLabelText(decode(stdout.subarray(0, split))) === animatedLabelText(viewport);
      last = { pane, viewport, location };
      return { paneId, viewport, stable };
    };

    // Bind a key to the locally parsed frame at the instant of dispatch, even
    // on legacy panes without native PID records. Never send the captured text
    // back through the shell. A redraw or external draft aborts before input.
    const guard = (paneId: string, frameKind: 'effort' | 'setting-paste' | 'exact', rejectedNavigation?: string, tailLines?: number) => {
      if (!last || last.pane.id !== paneId) throw new SessionSettingError(t('backend.settingPaneChangedNoInput'));
      const { pane, viewport, location } = last;
      const format = ['#{pane_id}', '#{pane_pid}', '#{session_name}:#{window_id}.#{pane_id}', '#{@lectern_session_id}', '#{@lectern_cwd}', '#{@lectern_claude_dir}', '#{pane_dead}', ...(pane.serverInstance ? ['#{pid}:#{start_time}'] : [])].join(SEP);
      const expected = [pane.id, pane.pid, pane.nativeTarget, pane.boundSessionId, pane.boundCwd, pane.boundClaudeDir, '0', ...(pane.serverInstance ? [pane.serverInstance] : [])].join(SEP);
      const frameGuard = frameKind === 'setting-paste' ? composerFrameGuard(viewport, tailLines)
        : { tailLines, ...(frameKind === 'effort' ? effortFrameGuard(viewport, tailLines) : { viewport, filter: '' }) };
      // The rows the digest covers, on the target and here (task rows, animated labels).
      const framed = guardWindow(viewport, frameGuard);
      return `[ "$(${this.tmux('display-message', '-p', '-t', paneId, format)})" = ${q(expected)} ] || { echo ${q(t('backend.settingPaneChangedNoInput'))} >&2; exit 1; }
ps -p ${pane.claudePid} -o pgid=,tpgid= | awk 'NF == 2 && $1 > 0 && $1 == $2 { found=1 } END { exit !found }' || { echo ${q(t('backend.claudeLeftNoInput'))} >&2; exit 1; }
${this.nativeGuard(pane, location, t('native.presenceChangedNoKeys'))}lectern_digest=$(${capture(paneId)}${framed.filter} | head -c 16385 | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; })
[ "\${lectern_digest%% *}" = ${q(createHash('sha256').update(framed.expected).digest('hex'))} ] || { ${rejectedNavigation ? `printf '%s' ${q(rejectedNavigation)}; exit 0` : `echo ${q(t('native.screenChangedNoKeys'))} >&2; exit 1`}; }
`;
    };
    // Foreground discovery also rejects a second active pane claiming this
    // UUID. Check all panes before each input, then bind the dispatch itself to
    // both the observed target and the last parsed viewport on the target.
    const input = async (paneId: string, key: string, contexts: Parameters<NativeKeybindings['guard']>[2], command: string, settle: boolean, tailLines?: number, settingPaste = false, switchSession = false) => {
      const { session, location, revision } = await (resolved ??= resolve());
      this.assertCurrentWorkspaceConfiguration(workspace, revision);
      const [keymap, panes] = await Promise.all([bindings.guard(location.claudeDir, key, contexts), this.probe(workspace)]);
      const pane = select(panes, session, location);
      if (!pane?.active || pane.id !== paneId || pane.claudePid !== last?.pane.claudePid) throw new SessionSettingError(t('backend.settingBindingChanged'));
      // This one-use receipt can only be printed on the guard branch before
      // send-keys. A transport error after dispatch never authorizes a retry.
      const guardedNavigation = (contexts.includes('ModelPicker') && ['Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'].includes(key))
        || (contexts.includes('EffortSlider') && ['Left', 'Right', 'Escape'].includes(key));
      const rejectedNavigation = guardedNavigation || switchSession || options.assertCurrent
        ? 'LECTERN_MENU_KEY_NOT_SENT_' + randomUUID() : undefined;
      const frameKind = settingPaste ? 'setting-paste' : contexts.includes('EffortSlider') ? 'effort' : 'exact';
      // The transcript revision guard runs first: for a question or permission answer its
      // failure is printed as a receipt that nothing was sent (TranscriptChangedNoKeys).
      const recordGuard = !options.historyGuard ? '' : options.assertCurrent && rejectedNavigation
        ? receiptOnFailure(options.historyGuard, rejectedNavigation + RECORD_CHANGED) : options.historyGuard;
      options.assertCurrent?.();
      return read(settle, recordGuard + keymap + guard(paneId, frameKind, rejectedNavigation, tailLines) + command, rejectedNavigation, switchSession);
    };
    const submitCommand = async (command: string, paneId: string) => {
      kind = command.startsWith('/effort') ? 'effort' : 'model';
      pending = await input(paneId, 'Enter', ['Chat'], this.tmux('send-keys', '-t', paneId, 'Enter') + '\nsleep 0.03', true);
    };
    return {
      frame: async () => {
        const frame = await read(false);
        return { ...frame, panePid: last!.pane.pid, nativeStatus: last!.pane.native?.status, nativeWaitingFor: last!.pane.native?.waitingFor };
      },
      questionKey: async key => {
        if (!last) throw new Error(t('backend.questionScreenUnchecked'));
        const binding = key === 'BTab' ? 'shift+tab' : key.replace(/^C-/, 'ctrl+');
        await input(last.pane.id, binding, ['Question', 'Select', 'Confirmation', 'Tabs', 'TextInput'], this.tmux('send-keys', '-t', last.pane.id, key), false);
      },
      pasteQuestion: async text => {
        if (!last) throw new Error(t('backend.questionInputUnchecked'));
        const paneId = last.pane.id, name = 'lectern-answer-' + randomUUID();
        try {
          await this.transport.run(workspace, this.tmux('load-buffer', '-b', name, '-'), { input: text });
          await input(paneId, 'Enter', ['Question', 'Select', 'Confirmation', 'TextInput'], this.tmux('paste-buffer', '-p', '-r', '-d', '-b', name, '-t', paneId), false);
        } finally { await this.transport.run(workspace, `${this.tmux('delete-buffer', '-b', name)} 2>/dev/null || true`).catch(() => {}); }
      },
      keyForTurn: async (action, footerOnly) => {
        if (!last) throw new Error(t('backend.nativeScreenUnchecked'));
        const { pane, viewport } = last;
        const keys: Record<typeof action, [string, string[]]> = {
          queue: ['ctrl+x enter', ['C-x','Enter']], steer: ['ctrl+x ctrl+s', ['C-x','C-s']],
          stop: ['Escape',['Escape']], up: ['Up',['Up']], down: ['Down',['Down']],
          accept: ['Enter',['Enter']], cancel: ['Escape',['Escape']], submit: ['Enter',['Enter']], clear: ['ctrl+c',['C-c']],
          erase: ['ctrl+u', ['C-u']], switchSession: ['Enter', ['Enter']],
        };
        const [binding, tmuxKeys] = keys[action];
        const contexts: Parameters<NativeKeybindings['guard']>[2] = ['up','down','accept','cancel'].includes(action) ? ['Select','Confirmation'] : ['Chat'];
        const tail = footerOnly && turnComposer(viewport)?.tailLines;
        await input(pane.id, binding, contexts, this.tmux('send-keys', '-t', pane.id, ...tmuxKeys), false, tail ? tail - 1 : rewindGuardLines(viewport), false, action === 'switchSession');
      },
      pasteForTurn: async (text, footerOnly) => {
        if (!last) throw new Error(t('backend.nativeInputUnchecked'));
        const { pane, viewport } = last;
        const name = 'lectern-turn-' + randomUUID();
        const tail = footerOnly && turnComposer(viewport)?.tailLines;
        const typing = this.typedInput(pane.id, text);
        if (typing && await bindings.permits(last.location.claudeDir, 'ctrl+j', ['Chat'])) {
          await input(pane.id, 'ctrl+j', ['Chat'], typing, false, tail ? tail - 1 : undefined);
          return;
        }
        try {
          await this.transport.run(workspace, this.tmux('load-buffer','-b',name,'-'), { input: text });
          await input(pane.id, 'Enter', ['Chat'], this.tmux('paste-buffer','-p','-r','-d','-b',name,'-t',pane.id), false, tail ? tail - 1 : undefined);
        } finally { await this.transport.run(workspace, `${this.tmux('delete-buffer','-b',name)} 2>/dev/null || true`).catch(() => {}); }
      },
      guardsViewport: true,
      permitsPageKey: async key => Boolean(last && (!this.options.claudeCommand || basename(this.options.claudeCommand) === 'claude')
        && await bindings.permits(last.location.claudeDir, key, ['ModelPicker', 'Select'])),
      submitPending: submitCommand,
      inspect: async (settle = false) => {
        if (!pending) return read(settle);
        const frame = pending;
        pending = undefined;
        return frame;
      },
      type: async (command, paneId) => {
        // Fixed ASCII literals only: the bare menu commands or a whitelisted inline switch.
        if (command !== '/model' && command !== '/effort' && !inlineSettingCommand.test(command)) throw new SessionSettingError(t('backend.unsupportedSettingCommand'));
        if (!last || !isIdleEmptyComposer(last.viewport)) throw new SessionSettingError(t('backend.composerNotEmpty'));
        const idleViewport = last.viewport;
        kind = command.startsWith('/effort') ? 'effort' : 'model';
        const buffer = 'lectern-setting-' + randomUUID();
        // Both commands are fixed ASCII literals. Load and consume the private
        // tmux buffer on the target. Re-probe after paste, before Enter.
        let pasted = await input(paneId, 'Enter', ['Chat'], `${this.tmux('set-buffer', '-b', buffer, command)}
trap ${q(this.tmux('delete-buffer', '-b', buffer) + ' 2>/dev/null || true')} 0
${this.tmux('paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', paneId)}
sleep 0.1`, false, undefined, true);
        // tmux acknowledges the paste before Claude paints it. Wait only while
        // we still see the exact old frame, and never repeat the paste or Enter.
        // A changed draft, permission prompt or foreground process ends the wait.
        for (const delayMs of [60, 120, 240]) {
          if (pasted.viewport !== idleViewport) break;
          diagnostic.event('backend.settings.await_redraw', { kind, paneId, delayMs });
          await new Promise(resolve => setTimeout(resolve, delayMs));
          pasted = await read(false);
        }
        if (!hasPendingSettingCommand(pasted.viewport, command as Parameters<typeof hasPendingSettingCommand>[1], idleViewport)) {
          diagnostic.capture('settings.viewport', pasted.viewport, { kind, phase: 'command-entry-rejected', paneId, sessionId });
          throw new SessionSettingError(t('backend.commandNotShown'));
        }
        await submitCommand(command, paneId);
      },
      key: async (key, paneId, confirmation) => {
        if (!last) throw new SessionSettingError(t('backend.settingScreenUnread'));
        const context = kind === 'model' ? 'ModelPicker' : 'EffortSlider';
        const send = key === 's' ? this.tmux('send-keys', '-t', paneId, '-l', 's') : this.tmux('send-keys', '-t', paneId, key);
        pending = await input(paneId, key, confirmation ? ['Confirmation', 'Select'] : [context, 'Select'], send + '\nsleep 0.03', true);
        diagnostic.event('backend.settings.key_accepted', { paneId, key, receipt: 'tmux_command_completed', automaticRetry: false });
      },
    };
  }
  bindSettingChoices(workspace: Workspace, sessionId: string, paneId: string, choices: SettingChoices): SessionSettingSnapshot {
    assertSessionId(sessionId);
    assertPaneId(paneId);
    return this.settings.bindChoices({ workspaceId: workspace.id, sessionId, targetKey: sessionSettingsTarget(workspace) }, paneId, choices);
  }
  async setUltracode(workspace: Workspace, sessionId: string, on: boolean, expected?: SettingRuntime): Promise<{ ultracode: boolean; message: string }> {
    return this.withInput(workspace, sessionId, () => this.settings.setUltracode(this.settingDriver(workspace, sessionId, { expected }),
      { workspaceId: workspace.id, sessionId, targetKey: sessionSettingsTarget(workspace) }, on));
  }
  async setSessionSetting(workspace: Workspace, sessionId: string, token: string, optionId: string, expected?: SettingRuntime, mode: SettingSwitchMode = 'menu'): Promise<SessionSettingSnapshot> {
    return this.withInput(workspace, sessionId, async () => {
      const driver = this.settingDriver(workspace, sessionId, { expected }), context = { workspaceId: workspace.id, sessionId, targetKey: sessionSettingsTarget(workspace) };
      // Inline: one typed command. Choices without an inline name use the menu.
      if (mode === 'inline') { const applied = await this.settings.setInline(driver, context, token, optionId); if (applied) return applied; }
      return this.settings.set(driver, context, token, optionId);
    });
  }
  private directoryTrustDriver(workspace: Workspace, session: SessionInfo, location: Location, configurationRevision: number): TrustDriver {
    // One round trip per observation: the setting driver captures the pane and
    // resolves the foreground/UUID mapping together, binds every key to the
    // exact frame it was chosen from, and returns the frame painted after it.
    const assertCurrent = () => this.assertCurrentWorkspaceConfiguration(workspace, configurationRevision);
    const driver = this.settingDriver(workspace, session.id, { assertCurrent });
    // After Enter Claude registers its native presence (or exits on No), so the
    // pre-trust identity no longer binds. Closure is read-only: re-resolve the
    // session's pane on every observation instead.
    let phase: 'guarded' | 'entered' | 'closure' = 'guarded';
    const observe = async (): Promise<TrustObservation> => {
      assertCurrent();
      const pane = this.currentPane(await this.probe(workspace), session, location);
      assertCurrent();
      if (!pane?.active) return { paneId: pane?.id, active: false, viewport: '', cwdAliases: location.cwdAliases };
      const viewport = (await this.navigationViewports(workspace, [pane])).get(pane.id);
      assertCurrent();
      if (viewport?.error || viewport?.screen === undefined) throw new DirectoryTrustError(viewport?.error || t('backend.trustScreenUnreadable'));
      return { paneId: pane.id, active: true, viewport: viewport.screen, cwdAliases: location.cwdAliases };
    };
    return {
      inspect: async () => {
        if (phase === 'closure') return observe();
        try {
          const frame = await driver.inspect();
          if (phase === 'entered') phase = 'closure';
          return { paneId: frame.paneId, active: true, viewport: withoutOscLinks(frame.viewport), cwdAliases: location.cwdAliases };
        } catch (error) {
          if (phase === 'entered') { phase = 'closure'; return observe(); }
          const current = await observe();
          if (!current.active) return current;
          throw error;
        }
      },
      key: async (key, expectedPane) => {
        try {
          await driver.key(key, expectedPane, true);
          if (key === 'Enter') phase = 'entered';
        } catch (error) {
          if (error instanceof NavigationKeyNotSent) throw new TrustKeyNotSent(t('backend.trustKeysNotSent'));
          if (error instanceof KeybindingUnconfirmed) throw new TrustKeyNotSent(error.message);
          // Enter and the frame after it share one round trip. Whether it landed
          // is decided by the closure check, which never presses anything again.
          if (key !== 'Enter') throw error;
          phase = 'closure';
          diagnostic.event('backend.directory_trust.enter_unobserved', { paneId: expectedPane, error: error instanceof Error ? error.message : String(error) });
        }
        diagnostic.event('backend.directory_trust.key_accepted', { paneId: expectedPane, key, receipt: 'tmux_command_completed', automaticRetry: false });
      },
    };
  }
  async getDirectoryTrust(workspace: Workspace, sessionId: string): Promise<DirectoryTrustSnapshot | undefined> {
    return this.withInput(workspace, sessionId, async () => {
      const location = await this.locate(workspace), session = await this.getSession(workspace, sessionId), revision = this.configRevision(workspace.id);
      return this.directoryTrust.get(this.directoryTrustDriver(workspace, session, location, revision), { workspaceId: workspace.id, sessionId, targetKey: `${JSON.stringify(workspace)}:${revision}` });
    });
  }
  async respondDirectoryTrust(workspace: Workspace, sessionId: string, token: string, decision: DirectoryTrustDecision): Promise<DirectoryTrustResult> {
    return this.withInput(workspace, sessionId, async () => {
      const location = await this.locate(workspace), session = await this.getSession(workspace, sessionId), revision = this.configRevision(workspace.id);
      return this.directoryTrust.respond(this.directoryTrustDriver(workspace, session, location, revision), { workspaceId: workspace.id, sessionId, targetKey: `${JSON.stringify(workspace)}:${revision}` }, token, decision);
    });
  }
  async dispose(): Promise<void> { this.completions.reset(); await this.transport.dispose(); await this.options.historyIndexStore?.flush(); }
}
