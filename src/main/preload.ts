import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAPI, LocaleState, MenuAction, SessionSnapshot, SshLoginPrompt, TerminalFrameEvent } from '../shared/types';
import type { UpdateState } from '../shared/update-check';
import type { QuitPrompt } from '../shared/quit';
// macOS can reopen a closed window from its menu before React mounts.
const menuListeners = new Set<(action: MenuAction) => void>();
let pendingMenuAction: MenuAction | undefined;
ipcRenderer.on('lectern:menu-action', (_event, action: MenuAction) => {
  if (!menuListeners.size) pendingMenuAction = action;
  else menuListeners.forEach(listener => listener(action));
});
const api: DesktopAPI = {
  codexWorkspace: (id, thread) => ipcRenderer.invoke('lectern:codexWorkspace', id, thread),
  codexCreate: id => ipcRenderer.invoke('lectern:codexCreate', id),
  codexSend: (id, thread, text) => ipcRenderer.invoke('lectern:codexSend', id, thread, text),
  codexInterrupt: (id, thread) => ipcRenderer.invoke('lectern:codexInterrupt', id, thread),
  codexAnswer: (id, thread, approval, decision) => ipcRenderer.invoke('lectern:codexAnswer', id, thread, approval, decision),
  onWindowReadable: callback => {
    // Subscribe first: a late initial response must not undo a newer blur/hide.
    let initial = true;
    const listener = (_: Electron.IpcRendererEvent, readable: boolean) => { initial = false; callback(readable); };
    ipcRenderer.on('lectern:window-readable', listener);
    void ipcRenderer.invoke('lectern:windowReadable').then(value => { if (initial) callback(value === true); }).catch(() => {});
    return () => { initial = false; ipcRenderer.removeListener('lectern:window-readable', listener); };
  },
  onMenuAction: callback => {
    menuListeners.add(callback);
    if (pendingMenuAction) {
      const action = pendingMenuAction;
      pendingMenuAction = undefined;
      callback(action);
    }
    return () => { menuListeners.delete(callback); };
  },
  info: () => ipcRenderer.invoke('lectern:info'),
  localeState: () => ipcRenderer.invoke('lectern:localeState'),
  setLocalePreference: preference => ipcRenderer.invoke('lectern:setLocalePreference', preference),
  onLocaleChange: callback => {
    const listener = (_: Electron.IpcRendererEvent, state: LocaleState) => callback(state);
    ipcRenderer.on('lectern:locale', listener);
    return () => { ipcRenderer.removeListener('lectern:locale', listener); };
  },
  setWindowTheme: theme => ipcRenderer.invoke('lectern:setWindowTheme', theme),
  diagnosticsInfo: () => ipcRenderer.invoke('lectern:diagnosticsInfo'),
  setDiagnosticContent: enabled => ipcRenderer.invoke('lectern:setDiagnosticContent', enabled),
  openDiagnosticsDirectory: () => ipcRenderer.invoke('lectern:openDiagnosticsDirectory'),
  markDiagnosticIncident: note => ipcRenderer.invoke('lectern:markDiagnosticIncident', note),
  reportRendererDiagnostic: report => ipcRenderer.invoke('lectern:reportRendererDiagnostic', report),
  listWorkspaces: () => ipcRenderer.invoke('lectern:listWorkspaces'),
  discoverHistoryProjects: target => ipcRenderer.invoke('lectern:discoverHistoryProjects', target),
  saveWorkspace: workspace => ipcRenderer.invoke('lectern:saveWorkspace', workspace),
  removeWorkspace: id => ipcRenderer.invoke('lectern:removeWorkspace', id),
  enableHistoryScan: id => ipcRenderer.invoke('lectern:enableHistoryScan', id),
  listWorkspaceDirectories: (target, path, offset) => ipcRenderer.invoke('lectern:listWorkspaceDirectories', target, path, offset),
  listSshConfigHosts: () => ipcRenderer.invoke('lectern:listSshConfigHosts'),
  setLaunchPreferences: preferences => ipcRenderer.invoke('lectern:setLaunchPreferences', preferences),
  setUltracode: (workspaceId, sessionId, on) => ipcRenderer.invoke('lectern:setUltracode', workspaceId, sessionId, on),
  revealWorkspace: workspaceId => ipcRenderer.invoke('lectern:revealWorkspace', workspaceId),
  sshLogin: (loginId, target) => ipcRenderer.invoke('lectern:sshLogin', loginId, target),
  answerSshLogin: (loginId, promptId, answer) => ipcRenderer.invoke('lectern:answerSshLogin', loginId, promptId, answer),
  checkSshConnection: target => ipcRenderer.invoke('lectern:checkSshConnection', target),
  checkHost: (target, force) => ipcRenderer.invoke('lectern:checkHost', target, force === true),
  cancelSshLogin: loginId => ipcRenderer.invoke('lectern:cancelSshLogin', loginId),
  onSshLoginPrompt: callback => {
    const listener = (_: Electron.IpcRendererEvent, prompt: SshLoginPrompt) => callback(prompt);
    ipcRenderer.on('lectern:ssh-login-prompt', listener);
    return () => { ipcRenderer.removeListener('lectern:ssh-login-prompt', listener); };
  },
  copyText: text => ipcRenderer.invoke('lectern:copyText', text),
  copyImage: png => ipcRenderer.invoke('lectern:copyImage', png),
  gitChanges: (ws, explicit) => ipcRenderer.invoke('lectern:gitChanges', ws, explicit === true),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  uploadAttachment: (ws, name, data) => ipcRenderer.invoke('lectern:uploadAttachment', ws, name, data),
  previewInlineImage: (id, path) => ipcRenderer.invoke('lectern:previewInlineImage', id, path),
  previewInlineImageThumbnail: (id, path) => ipcRenderer.invoke('lectern:previewInlineImageThumbnail', id, path),
  completeComposer: (id, view, request, query) => ipcRenderer.invoke('lectern:completeComposer', id, view, request, query),
  cancelComposerCompletion: (view, request) => ipcRenderer.invoke('lectern:cancelComposerCompletion', view, request),
  prefetchFileIndex: id => ipcRenderer.invoke('lectern:prefetchFileIndex', id),
  onFileIndexUpdated: callback => {
    const listener = (_: Electron.IpcRendererEvent, workspaceId: string) => callback(workspaceId);
    ipcRenderer.on('lectern:file-index', listener);
    return () => { ipcRenderer.removeListener('lectern:file-index', listener); };
  },
  previewMessageAttachment: (ws, sid, id) => ipcRenderer.invoke('lectern:previewMessageAttachment', ws, sid, id),
  previewMessageAttachmentThumbnail: (ws, sid, id) => ipcRenderer.invoke('lectern:previewMessageAttachmentThumbnail', ws, sid, id),
  downloadMessageAttachment: (ws, sid, id) => ipcRenderer.invoke('lectern:downloadMessageAttachment', ws, sid, id),
  resolveArtifactReferences: (id, paths) => ipcRenderer.invoke('lectern:resolveArtifactReferences', id, paths),
  listArtifactDirectory: (id, path, offset) => ipcRenderer.invoke('lectern:listArtifactDirectory', id, path, offset),
  previewArtifact: (id, path) => ipcRenderer.invoke('lectern:previewArtifact', id, path),
  downloadArtifact: (id, path) => ipcRenderer.invoke('lectern:downloadArtifact', id, path),
  discover: (id, baselines) => ipcRenderer.invoke('lectern:discover', id, baselines),
  createSession: (id, options) => ipcRenderer.invoke('lectern:createSession', id, options),
  modelCatalog: (id, retry) => ipcRenderer.invoke('lectern:modelCatalog', id, retry),
  renameSession: (id, session, title) => ipcRenderer.invoke('lectern:renameSession', id, session, title),
  setTerminalVisible: (id, sid, visible, view) => ipcRenderer.invoke('lectern:setTerminalVisible', id, sid, visible, view),
  closeSession: (id, sid, pane, pid) => ipcRenderer.invoke('lectern:closeSession', id, sid, pane, pid),
  resumeSession: (id, session) => ipcRenderer.invoke('lectern:resumeSession', id, session),
  forkSession: (id, session, pane, pid) => ipcRenderer.invoke('lectern:forkSession', id, session, pane, pid),
  bindSession: (id, session, pane) => ipcRenderer.invoke('lectern:bindSession', id, session, pane),
  watchSession: (id, session, view) => ipcRenderer.invoke('lectern:watchSession', id, session, view),
  prefetchSession: (id, session) => ipcRenderer.invoke('lectern:prefetchSession', id, session),
  loadEarlierMessages: (id, session, cursor, sizeMiB) => ipcRenderer.invoke('lectern:loadEarlierMessages', id, session, cursor, sizeMiB),
  readHandoffHistory: (ws, tip, source, cursor, size, view) => ipcRenderer.invoke('lectern:readHandoffHistory', ws, tip, source, cursor, size, view),
  releaseHandoffHistory: (ws, tip, view) => ipcRenderer.invoke('lectern:releaseHandoffHistory', ws, tip, view),
  listSubagents: (id, session) => ipcRenderer.invoke('lectern:listSubagents', id, session),
  readSubagent: (id, session, agent, request, view) => ipcRenderer.invoke('lectern:readSubagent', id, session, agent, request, view),
  releaseSubagents: (id, session, view) => ipcRenderer.invoke('lectern:releaseSubagents', id, session, view),
  readTaskOutput: (id, session, tool, request, view) => ipcRenderer.invoke('lectern:readTaskOutput', id, session, tool, request, view),
  releaseTaskOutputs: (id, session, view) => ipcRenderer.invoke('lectern:releaseTaskOutputs', id, session, view),
  unwatchSession: view => ipcRenderer.invoke('lectern:unwatchSession', view),
  answerQuestion: (id, session, pane, pid, token, action) => ipcRenderer.invoke('lectern:answerQuestion', id, session, pane, pid, token, action),
  answerPermission: (id, session, pane, pid, token, action) => ipcRenderer.invoke('lectern:answerPermission', id, session, pane, pid, token, action),
  turnAction: (id, session, pane, pid, action) => ipcRenderer.invoke('lectern:turnAction', id, session, pane, pid, action),
  sendMessage: (id, session, text) => ipcRenderer.invoke('lectern:sendMessage', id, session, text),
  sendKey: (id, session, key) => ipcRenderer.invoke('lectern:sendKey', id, session, key),
  setTerminalControl: (id, session, enabled, token) => ipcRenderer.invoke('lectern:setTerminalControl', id, session, enabled, token),
  sendTerminalInput: (id, session, token, input) => ipcRenderer.invoke('lectern:sendTerminalInput', id, session, token, input),
  getDirectoryTrust: (id, session) => ipcRenderer.invoke('lectern:getDirectoryTrust', id, session),
  respondDirectoryTrust: (id, session, token, decision) => ipcRenderer.invoke('lectern:respondDirectoryTrust', id, session, token, decision),
  getSessionSetting: (id, session, kind) => ipcRenderer.invoke('lectern:getSessionSetting', id, session, kind),
  setSessionSetting: (id, session, token, option, mode) => ipcRenderer.invoke('lectern:setSessionSetting', id, session, token, option, mode),
  onTerminalFrame: callback => {
    const listener = (_: Electron.IpcRendererEvent, event: TerminalFrameEvent) => callback(event);
    ipcRenderer.on('lectern:terminal-frame', listener);
    return () => { ipcRenderer.removeListener('lectern:terminal-frame', listener); };
  },
  onSnapshot: callback => {
    const listener = (_: Electron.IpcRendererEvent, snapshot: SessionSnapshot) => callback(snapshot);
    ipcRenderer.on('lectern:snapshot', listener);
    return () => { ipcRenderer.removeListener('lectern:snapshot', listener); };
  },
  updateState: () => ipcRenderer.invoke('lectern:updateState'),
  checkForUpdates: () => ipcRenderer.invoke('lectern:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('lectern:downloadUpdate'),
  cancelUpdateDownload: () => ipcRenderer.invoke('lectern:cancelUpdateDownload'),
  dismissUpdate: mode => ipcRenderer.invoke('lectern:dismissUpdate', mode),
  setUpdatePreferences: preferences => ipcRenderer.invoke('lectern:setUpdatePreferences', preferences),
  openDownloadedUpdate: () => ipcRenderer.invoke('lectern:openDownloadedUpdate'),
  revealDownloadedUpdate: () => ipcRenderer.invoke('lectern:revealDownloadedUpdate'),
  openUpdatePage: () => ipcRenderer.invoke('lectern:openUpdatePage'),
  onUpdateState: callback => {
    const listener = (_: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on('lectern:update-state', listener);
    return () => { ipcRenderer.removeListener('lectern:update-state', listener); };
  },
  quitPrompt: () => ipcRenderer.invoke('lectern:quitPrompt'),
  onQuitPrompt: callback => {
    const listener = (_: Electron.IpcRendererEvent, prompt: QuitPrompt | null) => callback(prompt);
    ipcRenderer.on('lectern:quit-prompt', listener);
    return () => { ipcRenderer.removeListener('lectern:quit-prompt', listener); };
  },
  quitPromptShown: id => ipcRenderer.invoke('lectern:quitPromptShown', id),
  answerQuit: (id, answer, remember) => ipcRenderer.invoke('lectern:answerQuit', id, answer, remember === true),
  quitPreferences: () => ipcRenderer.invoke('lectern:quitPreferences'),
  setQuitPreferences: preferences => ipcRenderer.invoke('lectern:setQuitPreferences', preferences),
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(api));
