import type {
  NavigationSessionStatus,
  SessionInfo,
  SidebarStatusObservation,
} from "../shared/types";
import { t, type MessageKey } from '../shared/i18n';

type SessionDot = 'idle' | 'working' | 'background' | 'waiting' | 'error' | 'unread';
interface ObservedState {
  kind: NavigationSessionStatus;
  label: string;
  detail: string;
  live: boolean | "unknown";
}
const labelKeys: Record<NavigationSessionStatus, MessageKey> = {
  history: 'sidebar.history',
  idle: 'sidebar.idle',
  working: 'sidebar.working',
  waiting: 'sidebar.waiting',
  error: 'sidebar.error',
  unknown: 'sidebar.unknown',
};
const label = (kind: NavigationSessionStatus) => t(labelKeys[kind]);
interface StatusOptions {
  snapshot?: SidebarStatusObservation;
  observation?: SidebarStatusObservation;
  selected?: boolean;
  scanError?: string;
  unread?: boolean;
}
/** `loading`: the chat is being read; the sidebar spins its knot and keeps the state shown. */
export interface SidebarSessionState extends ObservedState { dot?: SessionDot; background?: boolean; loading?: boolean }
function observedState(session: SessionInfo, options: StatusOptions): ObservedState {
  const snapshot = options.snapshot;
  if (snapshot && snapshot.status !== 'connecting') {
    if (snapshot.status === "offline")
      return {
        kind: "unknown",
        label: t('sidebar.offline'),
        detail: snapshot.error || t('sidebar.connectionUnconfirmed'),
        live: "unknown",
      };
    if (snapshot.status === "error" || snapshot.navigationStatus === "error")
      return {
        kind: "error",
        label: label('error'),
        detail:
          snapshot.error || snapshot.navigationStatusDetail || t('sidebar.sessionError'),
        live: snapshot.paneId ? true : "unknown",
      };
    if (snapshot.status === "working" || snapshot.status === "waiting") {
      return {
        kind: snapshot.status,
        label: label(snapshot.status),
        detail:
          snapshot.status === "working"
            ? t('sidebar.claudeReplying')
            : t('sidebar.confirmInTerminal'),
        live: snapshot.paneId ? true : "unknown",
      };
    }
    if (snapshot.navigationStatus === "unknown")
      return {
        kind: "unknown",
        label: label('unknown'),
        detail: snapshot.navigationStatusDetail || t('sidebar.stateUnconfirmed'),
        live: snapshot.paneId ? true : "unknown",
      };
    if (!snapshot.paneId)
      return {
        kind: "history",
        label: session.path ? t('sidebar.history') : t('sidebar.ended'),
        detail: session.path
          ? t('sidebar.savedHistory')
          : t('sidebar.endedNoHistory'),
        live: false,
      };
    const kind = snapshot.navigationStatus ?? snapshot.status;
    return {
      kind,
      label: label(kind),
      detail:
        snapshot.navigationStatusDetail || (kind === "idle"
          ? t('sidebar.runningIdle')
          : kind === "working"
            ? t('sidebar.claudeReplying')
            : t('sidebar.confirmInTerminal')),
      live: true,
    };
  }
  if (options.scanError)
    return {
      kind: "unknown",
      label: t('sidebar.unknown'),
      detail: options.scanError,
      live: "unknown",
    };
  const kind = session.status ?? (session.paneId ? "unknown" : "history");
  return {
    kind,
    label: label(kind),
    detail:
      session.statusDetail ||
      (kind === "history"
        ? t('sidebar.savedHistory')
        : kind === "idle"
          ? t('sidebar.runningIdle')
          : kind === "working"
            ? t('sidebar.claudeReplying')
            : kind === "waiting"
              ? t('sidebar.confirmInTerminal')
              : kind === "error"
                ? t('sidebar.sessionError')
                : t('sidebar.stateUnconfirmed')),
    live: kind === "history" ? false : session.paneId ? true : "unknown",
  };
}

/** The reply is done but Claude Code still runs background work for this chat. */
function backgroundWork(session: SessionInfo, state: ObservedState, options: StatusOptions): string | undefined {
  if (state.kind !== 'idle' || state.live !== true) return;
  return options.snapshot ? options.snapshot.background : session.background;
}

export function sessionSidebarState(session: SessionInfo, { observation, ...options }: StatusOptions = {}): SidebarSessionState {
  const loading = options.snapshot?.status === 'connecting' || (!options.snapshot && options.selected);
  // While the transcript loads, show the latest matched pane state and keep the loading indicator.
  if (options.snapshot?.status === 'connecting') options.snapshot = undefined;
  // A compact observation applies only to the pane still bound in discovery.
  if (!options.snapshot && !options.scanError && observation?.paneId && observation.paneId === session.paneId && observation.status !== 'connecting') {
    options.snapshot = observation;
  }
  const state = { ...observedState(session, options), ...(loading && { loading: true }) };
  const background = backgroundWork(session, state, options);
  if (background) {
    // Not finished: background shells, subagents, monitors or workflows still run.
    const unread = options.unread ? t('sidebar.unreadSuffix') : '';
    return { ...state, label: t('sidebar.background'), detail: t('sidebar.backgroundDetail', { work: background, unread }), dot: 'background', background: true };
  }
  const offline = options.snapshot?.status === 'offline' || (!options.snapshot && !!options.scanError);
  const dot: SessionDot | undefined = offline || state.kind === 'error' ? 'error' : state.kind === 'waiting' ? 'waiting' :
    options.unread ? 'unread' : state.kind === 'working' ? 'working' : state.live === true ? 'idle' : undefined;
  return dot === 'unread' ? {
    ...state, dot,
    label: state.kind === 'working' ? state.label : t('sidebar.unread'),
    detail: t('sidebar.unreadDetail', { detail: state.detail }),
  } : { ...state, dot };
}

export function aggregateSidebarState(states: SidebarSessionState[]) {
  for (const dot of ['error', 'waiting', 'unread'] as const) if (states.some(state => state.dot === dot)) return dot;
  return undefined;
}

type SortSession = Pick<SessionInfo, 'updatedAt'>;
type SortState = Pick<SidebarSessionState, 'kind' | 'background'>;

export function isActiveSidebarSession(state: SortState) {
  return state.kind === 'working' || state.kind === 'waiting' || state.background === true;
}

export function compareSidebarSessions(a: SortSession, b: SortSession) {
  // A new chat that has not written its first record yet belongs with the newest chats.
  return (b.updatedAt ?? '\uffff').localeCompare(a.updatedAt ?? '\uffff');
}

type SortedConversation = { session: SortSession; state: SortState };
export function compareActiveSidebarSessions(a: SortedConversation, b: SortedConversation) {
  return Number(isActiveSidebarSession(b.state)) - Number(isActiveSidebarSession(a.state))
    || compareSidebarSessions(a.session, b.session);
}
