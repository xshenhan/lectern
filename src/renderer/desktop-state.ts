import { useSyncExternalStore } from "react";
import type { ChatView } from "../shared/types";
import { DEFAULT_HISTORY_PAGE_MIB, historyPageSizeMiB } from '../shared/history-paging';
import { markNavigated } from "./ssh-machines";
import { validTimeZone } from "./quota-time";

export interface ChatTarget {
  workspaceId: string;
  sessionId: string;
  title: string;
  /** A new chat in this folder that has not started yet (sessionId is ""). No
   * tmux pane or Claude process exists until its first message is sent. */
  draft?: true;
}
export type ReplyDetail = "compact" | "individual";
export type SidebarSortMode = "recent" | "priority";
export type SplitDirection = "columns" | "rows";
export type SplitEdge = "left" | "right" | "top" | "bottom";
/** A conversation taken out of Lectern's sidebar. Its files on the target are untouched. */
export interface ArchivedSession { workspaceId: string; sessionId: string; title: string; archivedAt: string }
export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port?: number;
}
export const defaultChatLayout = {
  chatLineHeight: 130,
  composerLineHeight: 135,
  toolSummaryFontSize: 13,
  conversationWidth: 1000,
};
export const maxConversationWidth = 1200;
// `label` is a message key (shown with t()).
export const chatLayoutRanges = [
  { key: "chatLineHeight", label: "prefs.chatLineHeight", min: 120, max: 190, step: 5, unit: "%" },
  { key: "composerLineHeight", label: "prefs.composerLineHeight", min: 120, max: 190, step: 5, unit: "%" },
  { key: "toolSummaryFontSize", label: "prefs.toolSummaryFontSize", min: 11, max: 18, step: 1, unit: " px" },
  { key: "conversationWidth", label: "prefs.conversationWidth", min: 800, max: maxConversationWidth, step: 20, unit: " px" },
] as const;
type ChatLayout = typeof defaultChatLayout;
/** The right-hand file preview. Sizes are absolute, like the tool summary size. */
export const defaultPreview = {
  previewCodeFontSize: 13,
  previewCodeLineHeight: 140,
  previewTextFontSize: 15,
  previewTextLineHeight: 140,
  previewWrap: true,
  previewLineNumbers: true,
  previewHighlight: true,
};
export const previewRanges = [
  { key: "previewCodeFontSize", label: "prefs.previewCodeFontSize", min: 10, max: 18, step: 1, unit: " px" },
  { key: "previewCodeLineHeight", label: "prefs.previewCodeLineHeight", min: 120, max: 200, step: 5, unit: "%" },
  { key: "previewTextFontSize", label: "prefs.previewTextFontSize", min: 12, max: 20, step: 1, unit: " px" },
  { key: "previewTextLineHeight", label: "prefs.previewTextLineHeight", min: 130, max: 200, step: 5, unit: "%" },
] as const;
export const previewToggles = [
  { key: "previewWrap", label: "prefs.previewWrap" },
  { key: "previewLineNumbers", label: "prefs.previewLineNumbers" },
  { key: "previewHighlight", label: "prefs.previewHighlight" },
] as const;
type PreviewSettings = typeof defaultPreview;
interface DesktopState extends ChatLayout, PreviewSettings {
  theme: "system" | "light" | "dark";
  fontSize: number;
  /** The message box grows with its text up to this many lines, then scrolls. */
  composerMaxLines: number;
  replyDetail: ReplyDetail;
  /** inline: `/model <alias>` / `/effort <level>`, saved as Claude's default for new
   * sessions. menu: the native picker, this session only. */
  settingSwitch: "inline" | "menu";
  /** Lectern-launched sessions turn on dynamic workflows so /effort offers Ultracode. */
  enableWorkflows: boolean;
  historyPageMiB: number;
  showCacheTtl: boolean;
  showSubscriptionQuota: boolean;
  /** IANA zone for the 7d refill time ("Asia/Shanghai"); "" is this computer's zone. */
  quotaTimeZone: string;
  sidebarOpen: boolean;
  sidebarSort: SidebarSortMode;
  split: boolean;
  direction: SplitDirection;
  ratio: number;
  active: ChatView;
  panes: Record<ChatView, ChatTarget | null>;
  projectOrder: string[];
  connections: ConnectionProfile[];
  /** Conversations hidden from the sidebar; restorable from Settings → 回收站. */
  archivedSessions: ArchivedSession[];
}
export const defaultFontSize = 18;
export const composerLineRange = { min: 3, max: 30 } as const;
export const defaultAppearance = {
  theme: "system",
  fontSize: defaultFontSize,
  composerMaxLines: 10,
  replyDetail: "compact",
  showCacheTtl: true,
  showSubscriptionQuota: true,
  quotaTimeZone: "",
} as const;
export const defaultSessionOptions = { settingSwitch: "inline", enableWorkflows: true } as const;
const defaults: DesktopState = {
  ...defaultAppearance,
  ...defaultSessionOptions,
  ...defaultChatLayout,
  ...defaultPreview,
  historyPageMiB: DEFAULT_HISTORY_PAGE_MIB,
  sidebarOpen: true,
  sidebarSort: "recent",
  split: false,
  direction: "columns",
  ratio: 0.5,
  active: "primary",
  panes: { primary: null, secondary: null },
  projectOrder: [],
  connections: [],
  archivedSessions: [],
};
const key = "lectern.desktop.preferences.v1";
const listeners = new Set<() => void>();
const bounded = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

function target(value: unknown): ChatTarget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ChatTarget>;
  return typeof row.workspaceId === "string" &&
    typeof row.sessionId === "string" &&
    typeof row.title === "string"
    ? {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        title: row.title,
        ...(row.draft === true && row.sessionId === "" && { draft: true as const }),
      }
    : null;
}
export function validHost(host: string) {
  return (
    host.length <= 255 &&
    /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_\[][A-Za-z0-9_.:\[\]-]*$/.test(
      host,
    )
  );
}
export function loadDesktopState(storage?: Pick<Storage, "getItem">): DesktopState {
  try {
    const p = JSON.parse((storage ?? window.localStorage).getItem(key) ?? "null");
    if (!p || typeof p !== "object") return defaults;
    // Each setting is read independently: a missing or invalid one takes its default.
    const layout = { ...defaultChatLayout };
    for (const { key, min, max, step } of chatLayoutRanges) {
      const value = bounded(p[key], min, max, layout[key]);
      layout[key] = min + Math.round((value - min) / step) * step;
    }
    const preview = { ...defaultPreview };
    for (const { key, min, max, step } of previewRanges) {
      const value = bounded(p[key], min, max, preview[key]);
      preview[key] = min + Math.round((value - min) / step) * step;
    }
    for (const { key } of previewToggles) preview[key] = typeof p[key] === "boolean" ? p[key] : defaultPreview[key];
    return {
      ...layout,
      ...preview,
      theme: p.theme === "dark" || p.theme === "light" ? p.theme : "system",
      fontSize: bounded(p.fontSize, 14, 20, defaultFontSize),
      composerMaxLines: Math.round(bounded(p.composerMaxLines, composerLineRange.min, composerLineRange.max, defaultAppearance.composerMaxLines)),
      replyDetail: p.replyDetail === "individual" ? "individual" : defaultAppearance.replyDetail,
      settingSwitch: p.settingSwitch === "menu" ? "menu" : defaultSessionOptions.settingSwitch,
      enableWorkflows: p.enableWorkflows !== false,
      historyPageMiB: historyPageSizeMiB(p.historyPageMiB),
      showCacheTtl: p.showCacheTtl !== false,
      showSubscriptionQuota: p.showSubscriptionQuota !== false,
      quotaTimeZone: typeof p.quotaTimeZone === "string" && validTimeZone(p.quotaTimeZone) ? p.quotaTimeZone : "",
      sidebarOpen: p.sidebarOpen !== false,
      sidebarSort: p.sidebarSort === "priority" ? "priority" : defaults.sidebarSort,
      split: p.split === true,
      direction: p.direction === "rows" ? "rows" : "columns",
      ratio: bounded(p.ratio, 0.25, 0.75, 0.5),
      active: p.split && p.active === "secondary" ? "secondary" : "primary",
      panes: { primary: target(p.panes?.primary), secondary: target(p.panes?.secondary) },
      projectOrder: Array.isArray(p.projectOrder)
        ? p.projectOrder.filter((s: unknown) => typeof s === "string")
        : [],
      connections: Array.isArray(p.connections)
        ? p.connections.filter(
            (c: ConnectionProfile) =>
              c &&
              typeof c.id === "string" &&
              typeof c.name === "string" &&
              typeof c.host === "string" &&
              validHost(c.host) &&
              (c.port === undefined ||
                (Number.isInteger(c.port) && c.port > 0 && c.port <= 65535)),
          )
        : [],
      archivedSessions: Array.isArray(p.archivedSessions)
        ? p.archivedSessions.filter((a: ArchivedSession) => a && typeof a.workspaceId === "string" && typeof a.sessionId === "string"
            && typeof a.title === "string" && typeof a.archivedAt === "string").slice(-5000)
        : [],
    };
  } catch {
    return defaults;
  }
}
let state = loadDesktopState();
export const desktopState = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useDesktopState = () =>
  useSyncExternalStore(subscribe, desktopState);
export function setDesktop(patch: Partial<DesktopState>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        ...state,
        panes: Object.fromEntries(
          Object.entries(state.panes).map(([view, chat]) => [
            view,
            chat && { ...chat, title: "" },
          ]),
        ),
      }),
    );
  } catch {
    /* Keep this window usable if storage is unavailable. */
  }
  listeners.forEach((fn) => fn());
}
export function sameChat(a: ChatTarget | null, b: ChatTarget | null) {
  return a?.workspaceId === b?.workspaceId && a?.sessionId === b?.sessionId;
}
/** The same conversation, and both or neither a new-chat draft. */
export function sameTarget(a: ChatTarget | null, b: ChatTarget | null) {
  return sameChat(a, b) && !!a?.draft === !!b?.draft;
}
export function showChat(view: ChatView, chat: ChatTarget | null) {
  if (
    sameTarget(state.panes[view], chat) &&
    state.panes[view]?.title === chat?.title
  )
    return;
  setDesktop({ panes: { ...state.panes, [view]: chat } });
}
export function focusChat(view: ChatView) {
  if (view !== state.active) setDesktop({ active: view });
}
export function splitChat(
  chat: ChatTarget | null,
  edge: SplitEdge,
  origin: ChatView = state.active,
) {
  markNavigated();
  const first = edge === "left" || edge === "top";
  const other = state.panes[origin];
  // A conversation shows in one pane at most: one already on screen gets the focus instead.
  const shown = chat && shownIn(state, chat);
  if (shown) { focusChat(shown); return; }
  setDesktop({
    split: true,
    direction: edge === "top" || edge === "bottom" ? "rows" : "columns",
    panes: first
      ? { primary: chat, secondary: other }
      : { primary: other, secondary: chat },
    active: first ? "primary" : "secondary",
  });
}
export function closeSplit(view: ChatView = "secondary") {
  setDesktop({
    split: false,
    active: "primary",
    panes: {
      primary: state.panes[view === "secondary" ? "primary" : "secondary"],
      secondary: null,
    },
  });
}
/** The pane already showing this conversation, if any (only the primary one when not split). */
export function shownIn(layout: Pick<DesktopState, "split" | "panes">, chat: ChatTarget): ChatView | undefined {
  if (sameChat(layout.panes.primary, chat)) return "primary";
  if (layout.split && sameChat(layout.panes.secondary, chat)) return "secondary";
  return undefined;
}
/** What dropping a dragged conversation on an edge of the workspace does. */
export type ChatDropPlan =
  | { kind: "split" }
  | { kind: "replace"; view: ChatView }
  | { kind: "merge"; keep: ChatView }
  | { kind: "none" };
/**
 * One conversation: only another one can split the screen. Two: dropping one of
 * them on the other side merges back to that one alone; a third replaces the side
 * it is dropped on; dropping a conversation on its own side changes nothing.
 */
export function planChatDrop(layout: Pick<DesktopState, "split" | "panes" | "active">, chat: ChatTarget | null, edge: SplitEdge): ChatDropPlan {
  if (!layout.split) return chat && sameChat(chat, layout.panes[layout.active]) ? { kind: "none" } : { kind: "split" };
  const first = edge === "left" || edge === "top";
  const side: ChatView = first ? "primary" : "secondary", other: ChatView = first ? "secondary" : "primary";
  if (chat && sameChat(chat, layout.panes[side])) return { kind: "none" };
  if (chat && sameChat(chat, layout.panes[other])) return { kind: "merge", keep: other };
  return { kind: "replace", view: side };
}
export function dropChat(chat: ChatTarget, edge: SplitEdge) {
  const plan = planChatDrop(state, chat, edge);
  if (plan.kind === "split") splitChat(chat, edge);
  else if (plan.kind === "merge") { markNavigated(); closeSplit(plan.keep === "primary" ? "secondary" : "primary"); }
  else if (plan.kind === "replace") { markNavigated(); showChat(plan.view, chat); focusChat(plan.view); }
}
// The data of a drag is unreadable until the drop; the workspace needs to know
// which conversation is coming to label its drop zones.
let draggedChat: ChatTarget | null = null;
export function beginChatDrag(data: DataTransfer, chat: ChatTarget) {
  data.setData(chatDragType, JSON.stringify(chat));
  data.effectAllowed = "copy";
  draggedChat = chat;
}
export function endChatDrag() { draggedChat = null; }
export const currentChatDrag = () => draggedChat;
export const chatDragType = "application/x-lectern-chat";
export const workspaceDragType = "application/x-lectern-workspace";
export function readDraggedChat(data: DataTransfer) {
  try {
    return target(JSON.parse(data.getData(chatDragType)));
  } catch {
    return null;
  }
}
export function orderProjects<T extends { id: string }>(
  projects: T[],
  order: string[],
) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...projects].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
}
export function moveProject(
  ids: string[],
  from: string,
  to: string,
) {
  if (from === to || !ids.includes(from) || !ids.includes(to)) return;
  const next = ids.filter((id) => id !== from);
  next.splice(ids.indexOf(to), 0, from);
  setDesktop({ projectOrder: next });
}
export const archiveKey = (workspaceId: string, sessionId: string) => `${workspaceId}\n${sessionId}`;
export function archiveSession(entry: Omit<ArchivedSession, "archivedAt">) {
  const others = state.archivedSessions.filter(a => archiveKey(a.workspaceId, a.sessionId) !== archiveKey(entry.workspaceId, entry.sessionId));
  setDesktop({ archivedSessions: [...others, { ...entry, archivedAt: new Date().toISOString() }] });
}
export function restoreSessions(keys: string[]) {
  const restore = new Set(keys);
  setDesktop({ archivedSessions: state.archivedSessions.filter(a => !restore.has(archiveKey(a.workspaceId, a.sessionId))) });
}
export function forgetProject(id: string) {
  setDesktop({
    archivedSessions: state.archivedSessions.filter(a => a.workspaceId !== id),
    projectOrder: state.projectOrder.filter((w) => w !== id),
    panes: {
      primary:
        state.panes.primary?.workspaceId === id ? null : state.panes.primary,
      secondary:
        state.panes.secondary?.workspaceId === id
          ? null
          : state.panes.secondary,
    },
  });
}
