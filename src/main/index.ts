import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeTheme, powerMonitor, session, shell, type MessageBoxOptions } from 'electron';
import { editMenuItems } from './edit-menu';
import { artifactMediaType } from '../backend/artifact-media';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Backend, validateWorkspace, WorkspaceChangedError } from '../backend';
import { HistoryIndexDiskStore } from '../backend/history-index-disk-store';
import { installSilentWindows, silentWindowsRequested } from './silent-windows';
import { installApplicationMenu } from './application-menu';
import { initializeLocale, localeState, setLocalePreference } from './locale';
import { onLocaleChange, t } from '../shared/i18n';
import { Controller } from './controller';
import { SessionViews } from './session-views';
import { WorkspaceStore } from './store';
import { ArtifactAccess } from './artifact-access';
import { SessionSettingsCache } from './session-settings-cache';
import { SessionSettingsDiskStore } from './session-settings-disk-store';
import { attachmentBytes, attachmentPreview, AttachmentThumbnails } from './message-attachment';
import { setupDemo } from './demo';
import { readSshConfigHosts } from './ssh-config-hosts';
import { createUpdates } from './updates';
import { routeExternalLinks } from './external-links';
import { knownUnreachable, QuitFlow, summarizeRunning, quitPromptEnabled, withDeadline, type FolderCheck, type QuitReason } from './quit-guard';
import { QuitSettings } from './quit-settings';
import { quitActivityText, quitAnswers, quitGroups, quitTitle, type QuitAnswer, type QuitPrompt } from '../shared/quit';
import type { MenuAction, RendererDiagnostic, SessionSnapshot, Workspace } from '../shared/types';
import { maxAttachmentBytes } from '../shared/attachments';
import { sshOnly, sshOnlyMessage } from '../shared/supported-targets';
import { configureDiagnostics, diagnostic, errorDetails, getDiagnosticsInfo, setDiagnosticContent, flushDiagnostics, closeDiagnostics } from '../diagnostics';

process.setSourceMapsEnabled?.(true);
app.setName('Lectern');
if (process.platform === 'win32') app.setAppUserModelId('dev.lectern.desktop');

const appIcon = app.isPackaged
  ? path.join(process.resourcesPath, process.platform === 'win32' ? 'lectern.ico' : 'lectern.png')
  : path.join(app.getAppPath(), process.platform === 'win32' ? 'build/lectern.ico' : 'build/icons/512x512.png');

// Finder-launched apps do not inherit interactive shell PATH.
if (process.platform !== 'win32') {
  const additions = ['/opt/homebrew/bin', '/usr/local/bin', path.join(app.getPath('home'), '.local/bin')];
  process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(path.delimiter), ...additions])].join(path.delimiter);
}
const demo = process.argv.includes('--demo');
if (process.env.LECTERN_USER_DATA) app.setPath('userData', process.env.LECTERN_USER_DATA);
// Before `ready`: Chromium takes the language from a command-line switch.
initializeLocale();
const ownsProfile = app.requestSingleInstanceLock();
let controller: Controller;
let controllers: SessionViews;
let artifactAccess: ArtifactAccess;
let window: BrowserWindow | undefined;
let cleanup: (() => Promise<void>) | undefined;
let stopUpdates: (() => Promise<void>) | undefined;
// Quitting: the dialog flow (quit-guard.ts), then cleanup. "done" lets the final app.quit() through.
let quitFlow: QuitFlow | undefined;
let quitSettings: QuitSettings | undefined;
let shutdownState: 'running' | 'cleaning' | 'done' = 'running';
// Logging out or shutting down: never ask, never hold a window open.
let systemEnding = false;
let installerOpenedAt = 0;
let quitAcked = 0, quitShownId = 0;
const quitTimers = new Map<number, ReturnType<typeof setTimeout>>();
const quitCheckMs = 3000;
// Playwright drives the app: quitting asks only when the test sets LECTERN_QUIT_PROMPT=1.
const automatedRun = app.commandLine.hasSwitch('remote-debugging-port') || process.env.LECTERN_SILENT_WINDOWS === '1';
const devUrl = !app.isPackaged ? process.env.LECTERN_DEV_URL : undefined;
let rendererReports = 0;
let rendererReportWindow = 0;
let settingsWrite: Promise<void> = Promise.resolve();

async function initializeDiagnostics() {
  let captureContent = true; // The user explicitly requested original screen/JSONL capture.
  try {
    const settings = JSON.parse(await readFile(path.join(app.getPath('userData'), 'diagnostics-settings.json'), 'utf8'));
    if (typeof settings.captureContent === 'boolean') captureContent = settings.captureContent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not load diagnostic preferences');
  }
  if (process.env.LECTERN_DIAGNOSTIC_CONTENT === '0') captureContent = false;
  if (process.env.LECTERN_DIAGNOSTIC_CONTENT === '1') captureContent = true;
  configureDiagnostics({ directory: process.env.LECTERN_LOG_DIR || path.join(app.getPath('userData'), 'diagnostics'), captureContent });
  diagnostic.event('app.start', {
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    electron: process.versions.electron, node: process.versions.node,
    packaged: app.isPackaged, demo, pid: process.pid, captureContent,
  }, 'info');
}

async function updateDiagnosticContent(enabled: boolean) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid diagnostic capture option');
  const info = setDiagnosticContent(enabled);
  const content = JSON.stringify({ captureContent: enabled }, null, 2);
  settingsWrite = settingsWrite.catch(() => {}).then(async () => {
    const directory = app.getPath('userData');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'diagnostics-settings.json');
    await writeFile(file + '.tmp', content, { mode: 0o600 });
    await rename(file + '.tmp', file);
  });
  await settingsWrite;
  return info;
}

function reportRenderer(value: RendererDiagnostic) {
  if (!value || typeof value !== 'object' || !['error', 'unhandledrejection', 'render', 'action'].includes(value.kind)) throw new Error('Invalid renderer diagnostic');
  const now = Date.now();
  if (now - rendererReportWindow > 1000) { rendererReportWindow = now; rendererReports = 0; }
  if (++rendererReports > 50) {
    if (rendererReports === 51) diagnostic.event('renderer.rate_limited', {}, 'warn');
    return;
  }
  const data: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value.data ?? {}).slice(0, 32)) {
    if (['string', 'number', 'boolean'].includes(typeof item)) data[key.slice(0, 80)] = typeof item === 'string' ? item.slice(0, 2048) : item;
  }
  diagnostic.scope({ workspaceId: String(value.workspaceId ?? '').slice(0, 120), sessionId: String(value.sessionId ?? '').slice(0, 120) }, () => {
    diagnostic.event(`renderer.${value.kind}`, {
      message: String(value.message ?? '').slice(0, 4096), stack: typeof value.stack === 'string' ? value.stack.slice(0, 16384) : undefined, data,
    }, value.kind === 'error' || value.kind === 'unhandledrejection' ? 'error' : 'debug');
  });
}

function captionColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#191a1c', symbolColor: '#f2f2f3' }
    : { color: '#f7f7f8', symbolColor: '#202124' };
}

const silentWindows = silentWindowsRequested();
if (silentWindows) installSilentWindows();

function windowReadable(win?: BrowserWindow) {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
}

function createWindow() {
  window = new BrowserWindow({
    // Automated runs show the window themselves, invisibly and without focus.
    ...(silentWindows && { show: false }),
    width: 1280, height: 880, minWidth: 850, minHeight: 600,
    title: 'Lectern', icon: appIcon, backgroundColor: nativeTheme.shouldUseDarkColors ? '#202123' : '#ffffff',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { titleBarOverlay: { height: 44 }, trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { height: 44, ...captionColors() }, autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false,
    },
  });
  // On macOS a hidden/minimized BrowserWindow can still have a focused DOM
  // document. Native visibility and activation are authoritative for receipts.
  const win = window;
  const publishReadable = () => win.webContents.send('lectern:window-readable', windowReadable(win));
  const publishInactive = () => win.webContents.send('lectern:window-readable', false);
  win.on('blur', publishInactive).on('hide', publishInactive).on('minimize', publishInactive);
  win.on('focus', publishReadable).on('show', publishReadable).on('restore', publishReadable);
  routeExternalLinks(window.webContents, url => {
    shell.openExternal(url).catch(error => diagnostic.event('link.open_failed', { error: errorDetails(error) }, 'warn'));
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Text fields and selected text get the standard edit menu. Rows, messages and
  // files show the app's own menu; the renderer prevents this event for them.
  window.webContents.on('context-menu', (_event, params) => {
    const items = editMenuItems(params);
    if (items.length) Menu.buildFromTemplate(items).popup({ window: window ?? undefined });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostic.event('renderer.process_gone', { ...details }, 'error');
    // The quit dialog lived in that page: ask natively instead.
    const pending = quitFlow?.current;
    if (pending && pending.phase !== 'closing') void nativeQuitPrompt(pending);
  });
  window.webContents.on('did-fail-load', (_event, code, description) => diagnostic.event('renderer.load_failed', { code, description }, 'error'));
  window.webContents.on('did-finish-load', () => diagnostic.event('renderer.loaded', {}, 'info'));
  window.on('unresponsive', () => diagnostic.event('renderer.unresponsive', {}, 'warn'));
  window.on('responsive', () => diagnostic.event('renderer.responsive', {}, 'info'));
  if (silentWindows) { window.show(); window.focus(); }
  // macOS keeps running without windows. Elsewhere closing the last window quits Lectern,
  // so it asks first, in this window, like the app menu's Quit.
  window.on('close', event => {
    if (process.platform === 'darwin' || shutdownState !== 'running' || systemEnding || !quitFlow) return;
    event.preventDefault();
    quitFlow.request(installerRecent() ? 'installer' : 'window');
  });
  // Windows logging off or shutting down: let it end the session without asking.
  window.on('query-session-end', () => { systemEnding = true; });
  window.on('session-end', () => { systemEnding = true; quitFlow?.request('system'); });
  window.on('closed', () => {
    diagnostic.event('window.closed', {}, 'info'); window = undefined; artifactAccess.reset(); controller.backend.completions.reset(); controllers.close();
    // macOS: closing the window while the dialog waits answers it with Cancel.
    const pending = quitFlow?.current;
    if (pending && pending.phase !== 'closing') quitFlow!.answer(pending.id, 'cancel');
  });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  return window;
}

/** The update installer was opened from Lectern a moment ago: it will close the app itself. */
function installerRecent() { return Date.now() - installerOpenedAt < 10 * 60_000; }

function bringForward(win: BrowserWindow) {
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (process.platform === 'darwin' && !silentWindows) app.focus({ steal: true });
}

/** The quit dialog is drawn by the renderer, which lists every conversation. Without a window
 * (macOS) one opens for it. A renderer that does not confirm showing it in time (hung,
 * crashed, still loading) is replaced by the native dialog with the same choices. */
function presentQuit(prompt: QuitPrompt | undefined) {
  if (!prompt) { window?.webContents.send('lectern:quit-prompt', null); return; }
  const fresh = !window, win = window ?? createWindow();
  // Progress updates keep the phase's id: only a new phase brings the window forward.
  if (fresh || prompt.id !== quitShownId) bringForward(win);
  quitShownId = prompt.id;
  win.webContents.send('lectern:quit-prompt', prompt);
  if (prompt.phase === 'closing' || prompt.id <= quitAcked || quitTimers.has(prompt.id)) return;
  quitTimers.set(prompt.id, setTimeout(() => {
    quitTimers.delete(prompt.id);
    if (quitAcked < prompt.id && quitFlow?.current?.id === prompt.id) void nativeQuitPrompt(prompt);
  }, fresh || win.webContents.isLoading() ? 20_000 : 5000));
}

async function nativeQuitPrompt(prompt: QuitPrompt) {
  diagnostic.event('app.quit_native_prompt', { id: prompt.id, phase: prompt.phase }, 'warn');
  const confirm = prompt.phase === 'confirm';
  const lines = quitGroups(prompt).flatMap(group => [
    ...group.sessions.map(session => t('quit.nativeLine', { machine: group.name, folder: session.folder, title: quitTitle(session), state: session.error ?? quitActivityText(session) })),
    ...group.unchecked.map(folder => t('quit.nativeUnchecked', { machine: group.name, error: folder.error })),
  ]);
  const count = confirm ? prompt.sessions.length : prompt.sessions.filter(session => session.close === 'failed').length;
  const options: MessageBoxOptions = {
    type: confirm ? 'question' : 'warning', noLink: true, defaultId: 0, cancelId: 0, title: 'Lectern',
    message: t(confirm ? 'quit.title' : 'quit.failedTitle', { count }),
    detail: [t(confirm ? 'quit.message' : 'quit.failedMessage'), '', ...lines.slice(0, 40), ...(lines.length > 40 ? ['…'] : [])].join('\n'),
    buttons: confirm ? [t('misc.cancel'), t('quit.leave'), t('quit.closeAll')] : [t('misc.cancel'), t('quit.quitAnyway')],
    ...(confirm && { checkboxLabel: t('quit.remember') }),
  };
  const parent = window && !window.isDestroyed() ? window : undefined;
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  const answers: QuitAnswer[] = confirm ? ['cancel', 'leave', 'close'] : ['cancel', 'quit-anyway'];
  quitFlow?.answer(prompt.id, answers[result.response] ?? 'cancel', result.checkboxChecked);
}

/** Running conversations for the quit dialog: what Lectern knows, checked again per folder
 * within quitCheckMs. Folders whose last discovery failed are not asked again. */
async function runningConversations() {
  const workspaces = controller.store.list(), backend = controller.backend;
  const known = new Map(workspaces.map(workspace => [workspace.id, backend.knownRunning(workspace.id)]));
  const checks = new Map<string, FolderCheck>();
  await Promise.all(workspaces.filter(workspace => !knownUnreachable(known.get(workspace.id))).map(async workspace => {
    try {
      const sessions = await withDeadline(backend.runningSessions(workspace), quitCheckMs, () => t('quit.checkTimeout', { seconds: quitCheckMs / 1000 }));
      checks.set(workspace.id, { sessions });
    } catch (error) {
      checks.set(workspace.id, { error: (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300) });
    }
  }));
  return summarizeRunning({ workspaces, known, checks, snapshots: controllers?.liveSnapshots() ?? [] });
}

/** Stop updates, readers, demo fixtures and diagnostics, then quit for real. */
function shutDown() {
  if (shutdownState !== 'running') return;
  shutdownState = 'cleaning';
  for (const timer of quitTimers.values()) clearTimeout(timer);
  void (async () => {
    diagnostic.event('app.stopping', {}, 'info');
    await stopUpdates?.(); await controllers?.dispose(); await cleanup?.(); await settingsWrite; await quitSettings?.flush();
    diagnostic.event('app.stopped', {}, 'info');
    await closeDiagnostics();
  })().catch(error => { diagnostic.event('app.shutdown_failed', { error: errorDetails(error) }, 'error'); return flushDiagnostics(); })
    .finally(() => { shutdownState = 'done'; app.quit(); });
}

async function boot() {
  await initializeDiagnostics();
  if (process.platform !== 'darwin') {
    nativeTheme.on('updated', () => window?.setTitleBarOverlay(captionColors()));
  }
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIcon);
  app.setAboutPanelOptions({ applicationName: 'Lectern', applicationVersion: app.getVersion(), iconPath: appIcon });
  // Renderer cannot fetch remote images, analytics, or arbitrary cloud resources.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    // 正文缩略图使用当前窗口的 blob URL。文件预览沿用 data URL。
    const localImage = details.resourceType === 'image' && details.webContentsId === window?.webContents.id && details.url.startsWith('blob:');
    const inlineMedia = localImage || details.resourceType === 'image' && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,/i.test(details.url)
      || details.resourceType === 'subFrame' && details.url.startsWith('data:application/pdf;base64,');
    const pdfViewer = details.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')
      || details.url.startsWith('chrome://resources/');
    let appAsset = false;
    try {
      if (details.url.startsWith('file:')) {
        const relative = path.relative(path.join(__dirname, '../renderer'), fileURLToPath(details.url));
        appAsset = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      } else if (devUrl && /^(?:https?|wss?):/.test(details.url)) {
        const origin = new URL(details.url.replace(/^ws/, 'http')).origin;
        appAsset = origin === new URL(devUrl).origin;
      }
    } catch { /* Reject malformed resource URLs. */ }
    const allowed = inlineMedia || pdfViewer || appAsset || details.url.startsWith('devtools:');
    callback({ cancel: !allowed });
  });
  if (demo) {
    const fixture = await setupDemo(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'demo/mock-claude.mjs' : undefined);
    controller = new Controller(fixture.store, fixture.backend);
    cleanup = fixture.cleanup;
  } else {
    const store = new WorkspaceStore(app.getPath('userData'));
    await store.load();
    const cache = new SessionSettingsCache(new SessionSettingsDiskStore(app.getPath('userData')));
    controller = new Controller(store, new Backend({ historyIndexStore: new HistoryIndexDiskStore(app.getPath('userData')) }), cache);
  }
  controller.warmModelCatalogs();
  // An open `@` list asks again when a background scan of its folder lands.
  controller.backend.completions.onFilesUpdated(workspaceId => window?.webContents.send('lectern:file-index', workspaceId));
  artifactAccess = new ArtifactAccess(id => controller.store.get(id), controller.backend.artifacts, {
    // Files outside the folder open like its own, without an extra prompt; credentials,
    // Claude configuration and system paths stay refused by the backend.
    allowOutside: async () => true,
    saveAs: async name => {
      // A remote filename is a display suggestion, never a host path.
      const filename = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download';
      const result = await dialog.showSaveDialog(window!, { title: t('menu.downloadTitle'), buttonLabel: t('menu.save'), defaultPath: path.join(app.getPath('downloads'), filename) });
      return result.canceled ? undefined : result.filePath;
    },
  });
  const attachmentThumbnails = new AttachmentThumbnails();
  function openedAttachment(ws: string, sid: string, id: string) {
    // 只允许读取当前会话中已解析的附件。
    const reader = controllers.forSession(ws, sid);
    const attachment = reader.messageAttachment(ws, sid, id);
    const check = () => {
      if (reader.messageAttachment(ws, sid, id) !== attachment) throw new Error(t('main.attachmentChanged'));
    };
    return { attachment, check };
  }
  const sshLogins = new Map<string, { abort: AbortController; prompts: Map<string, (answer: string | null) => void> }>();
  const updates = createUpdates({ window: () => window, automated: silentWindows, demo });
  stopUpdates = updates.stop;
  quitSettings = new QuitSettings(path.join(app.getPath('userData'), 'quit-settings.json'));
  const settings = quitSettings;
  quitFlow = new QuitFlow({
    collect: runningConversations,
    promptEnabled: () => quitPromptEnabled(process.env, automatedRun),
    preference: async () => (await settings.get()).whenRunning,
    remember: async () => { await settings.set({ whenRunning: 'leave' }); },
    present: presentQuit,
    close: session => controller.backend.closeListed(controller.store.get(session.workspaceId), session.sessionId, session.paneId, session.panePid),
    quit: shutDown,
    focus: () => { if (window) bringForward(window); },
    event: (name, data) => diagnostic.event(name, data ?? {}, 'info'),
  });
  // A signal (kill, Ctrl+C in a terminal, the session ending on Linux) and system shutdown
  // quit without asking; the conversations keep running. A second signal kills at once.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => quitFlow?.request('signal'));
  if (process.platform !== 'win32') powerMonitor.on('shutdown', () => { systemEnding = true; quitFlow?.request('system'); });
  // The backend starts with dynamic workflows on; the renderer sends the preference at startup.
  let launchWorkflows = true;
  const methods: Record<string, (...args: any[]) => unknown> = {
    info: () => ({ platform: process.platform, version: app.getVersion(), demo }),
    localeState: () => localeState(),
    setLocalePreference: preference => setLocalePreference(preference),
    windowReadable: () => windowReadable(window),
    setWindowTheme: theme => {
      if (theme !== 'system' && theme !== 'light' && theme !== 'dark') throw new Error('Invalid window theme');
      nativeTheme.themeSource = theme;
    },
    diagnosticsInfo: () => getDiagnosticsInfo(),
    setDiagnosticContent: enabled => updateDiagnosticContent(enabled),
    openDiagnosticsDirectory: async () => {
      await flushDiagnostics();
      const error = await shell.openPath(getDiagnosticsInfo().directory);
      if (error) throw new Error(error);
    },
    markDiagnosticIncident: async note => {
      if (typeof note !== 'string' || note.length > 2000) throw new Error(t('main.incidentNoteTooLong'));
      const incidentId = `incident-${randomUUID()}`;
      diagnostic.event('incident.mark', { incidentId, note }, 'warn');
      await flushDiagnostics();
      return incidentId;
    },
    reportRendererDiagnostic: value => reportRenderer(value),
    listWorkspaces: () => controller.store.list(),
    enableHistoryScan: id => controller.enableHistoryScan(id),
    discoverHistoryProjects: target => {
      if (demo) throw new Error(t('main.demoNoHistoryScan'));
      if (sshOnly(process.platform) && target?.kind !== 'ssh') throw new Error(sshOnlyMessage());
      return controller.backend.discoverHistoryProjects(target);
    },
    copyText: async text => {
      if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error(t('main.copyTooLarge'));
      await clipboard.writeText(text);
    },
    completeComposer: (id, view, request, query) => controller.backend.completions.query(controller.store.get(id), view, request, query, demo),
    cancelComposerCompletion: (view, request) => controller.backend.completions.cancel(view, request),
    prefetchFileIndex: id => {
      if (typeof id !== 'string') return;
      let workspace: Workspace;
      try { workspace = controller.store.get(id); } catch { return; }
      controller.backend.completions.prefetchFiles(workspace);
    },
    copyImage: async png => {
      if (!(png instanceof Uint8Array) || png.byteLength < 33 || png.byteLength > 128 * 1024 * 1024) throw new Error(t('main.copyImageInvalid'));
      const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
      if (artifactMediaType(bytes) !== 'image/png' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(t('main.clipboardNeedsPng'));
      if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 64 * 1024 * 1024) throw new Error(t('main.imageTooLargeToCopy'));
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    },
    gitChanges: (id, explicit) => controller.backend.gitChanges(controller.store.get(id), explicit === true),
    uploadAttachment: async (id, name, data) => {
      if (typeof name !== 'string' || name.length > 1024) throw new Error(t('main.invalidFileName'));
      if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error(t('main.fileEmpty'));
      if (data.byteLength > maxAttachmentBytes) throw new Error(t('main.fileTooLarge'));
      return controller.backend.uploadAttachment(controller.store.get(id), name, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    previewInlineImage: (id, reference) => artifactAccess.previewInlineImage(id, reference),
    previewInlineImageThumbnail: (id, reference) => artifactAccess.previewInlineImageThumbnail(id, reference),
    resolveArtifactReferences: (id, references) => artifactAccess.resolve(id, references),
    listArtifactDirectory: (id, reference, offset) => artifactAccess.list(id, reference, offset),
    previewArtifact: (id, reference) => artifactAccess.preview(id, reference),
    downloadArtifact: (id, reference) => artifactAccess.download(id, reference),
    saveWorkspace: w => {
      if (demo) throw new Error(t('main.demoIsolatedOnly'));
      validateWorkspace(w);
      if (sshOnly(process.platform) && w.kind !== 'ssh') throw new Error(sshOnlyMessage());
      artifactAccess.reset();
      attachmentThumbnails.clear();
      controllers.releaseWorkspace(w.id);
      return controller.saveWorkspace(w);
    },
    removeWorkspace: id => {
      if (demo) throw new Error(t('main.demoFolderManaged'));
      artifactAccess.reset();
      attachmentThumbnails.clear();
      controllers.releaseWorkspace(id);
      return controller.removeWorkspace(id);
    },
    previewMessageAttachment: async (ws, sid, id) => {
      const { attachment, check } = openedAttachment(ws, sid, id);
      const preview = await attachmentPreview(attachment);
      check();
      return preview;
    },
    previewMessageAttachmentThumbnail: async (ws, sid, id) => {
      // An image attached by path is read on the machine it lives on, cached by its stamp there.
      const reader = controllers.forSession(ws, sid), file = reader.attachedImagePath(ws, sid, id);
      if (file !== undefined) {
        const preview = await artifactAccess.attachmentThumbnail(ws, file);
        if (reader.attachedImagePath(ws, sid, id) !== file) throw new Error(t('main.attachmentChanged'));
        return preview;
      }
      const { attachment, check } = openedAttachment(ws, sid, id);
      const preview = await attachmentThumbnails.preview(attachment);
      check();
      return preview;
    },
    downloadMessageAttachment: async (ws, sid, id) => {
      const { attachment, check } = openedAttachment(ws, sid, id);
      const target = await dialog.showSaveDialog(window!, { title: t('menu.saveAttachmentTitle'), buttonLabel: t('menu.save'), defaultPath: attachment.ref.name, properties: ['showOverwriteConfirmation'] });
      if (target.canceled || !target.filePath) return false;
      check();
      const bytes = attachmentBytes(attachment);
      const temp = path.join(path.dirname(target.filePath), '.lectern-' + randomUUID() + '.tmp');
      try {
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
        check();
        await rename(temp, target.filePath);
      } finally {
        await rm(temp, { force: true });
      }
      return true;
    },
    sshLogin: async (loginId, target) => {
      if (demo) throw new Error(t('main.demoNoSshLogin'));
      if (typeof loginId !== 'string' || !/^[\w-]{8,64}$/.test(loginId) || sshLogins.has(loginId)) throw new Error(t('main.invalidLoginRequest'));
      if (!target || typeof target !== 'object') throw new Error(t('main.invalidSshMachine'));
      const login = { abort: new AbortController(), prompts: new Map<string, (answer: string | null) => void>() };
      sshLogins.set(loginId, login);
      try {
        return await controller.backend.sshLogin({ host: target.host, port: target.port }, prompt => new Promise(resolve => {
          if (login.abort.signal.aborted) return resolve(null);
          const promptId = randomUUID();
          // Notices need no reply; OpenSSH continues while the dialog shows them.
          if (prompt.kind === 'info') resolve('');
          else login.prompts.set(promptId, resolve);
          window?.webContents.send('lectern:ssh-login-prompt', { loginId, promptId, ...prompt });
        }), login.abort.signal);
      } finally {
        sshLogins.delete(loginId);
        for (const resolve of login.prompts.values()) resolve(null);
      }
    },
    // Replies are never logged: the IPC wrapper records only the method name.
    answerSshLogin: (loginId, promptId, answer) => {
      const resolve = typeof loginId === 'string' && typeof promptId === 'string' ? sshLogins.get(loginId)?.prompts.get(promptId) : undefined;
      if (!resolve) throw new Error(t('main.loginPromptExpired'));
      if (answer !== null && (typeof answer !== 'string' || answer.length > 4096 || /[\r\n\0]/.test(answer))) throw new Error(t('main.invalidInput'));
      sshLogins.get(loginId)!.prompts.delete(promptId);
      resolve(answer);
    },
    cancelSshLogin: loginId => { if (typeof loginId === 'string') sshLogins.get(loginId)?.abort.abort(); },
    checkSshConnection: target => {
      if (demo) throw new Error(t('main.demoNoSsh'));
      if (!target || typeof target !== 'object') throw new Error(t('main.invalidSshMachine'));
      return controller.backend.checkSshConnection({ host: target.host, port: target.port });
    },
    checkHost: (target, force) => {
      if (!target || typeof target !== 'object') throw new Error(t('main.invalidSshMachine'));
      return controller.backend.checkHost({ kind: target.kind, host: target.host, port: target.port }, force === true);
    },
    listSshConfigHosts: () => readSshConfigHosts(process.env.LECTERN_SSH_CONFIG_HOME || undefined),
    setLaunchPreferences: preferences => {
      const enableWorkflows = preferences?.enableWorkflows !== false;
      if (enableWorkflows === launchWorkflows) return;
      launchWorkflows = enableWorkflows;
      controller.backend.setLaunchPreferences({ enableWorkflows });
      // Ultracode's availability in the model list depends on it.
      controller.refreshModelCatalogs();
    },
    modelCatalog: (id, retry) => controller.modelCatalog(id, retry === true),
    revealWorkspace: async id => {
      const workspace = controller.store.get(id);
      if (workspace.kind !== 'local' || demo) throw new Error(t('main.revealLocalOnly'));
      const opened = await shell.openPath(workspace.cwd.replace(/^~(?=$|\/)/, app.getPath('home')));
      if (opened) throw new Error(opened);
    },
    listWorkspaceDirectories: (target, path, offset) => {
      if (demo) throw new Error(t('main.demoNoBrowse'));
      return controller.backend.listWorkspaceDirectories(target, path, offset);
    },
    discover: async (id, baselines) => {
      const discovery = await controller.discover(id, baselines).catch(error => {
        if (error instanceof WorkspaceChangedError) return undefined;
        throw error;
      });
      if (!discovery) return undefined;
      // Running conversations start reading in the background, so opening one
      // shows its current turn instead of a loading state.
      for (const session of discovery.sessions.filter(s => s.paneId).slice(0, 6)) controllers.prefetch(id, session.id);
      return discovery;
    },
    replaySidebarStatus: () => controllers.replaySidebarStatus(),
    createSession: (id, options) => controller.createSession(id, options ?? {}),
    renameSession: (id, sid, title) => controllers.renameSession(id, sid, title),
    setTerminalVisible: (id, sid, visible, view) => controllers.setTerminalVisible(id, sid, visible, view),
    closeSession: (id, sid, pane, pid) => controllers.forSession(id, sid).closeSession(id, sid, pane, pid),
    resumeSession: (id, sid) => controllers.resumeSession(id, sid),
    forkSession: (id, sid, pane, pid) => controllers.forSession(id, sid).forkSession(id, sid, pane, pid),
    bindSession: (id, sid, pane) => controller.bindSession(id, sid, pane),
    watchSession: (id, sid, view) => controllers.watch(id, sid, view),
    prefetchSession: async (id, sid) => { if (typeof id === 'string' && typeof sid === 'string') controllers.prefetch(id, sid, true); },
    loadEarlierMessages: (id, sid, cursor, sizeMiB) => controllers.forSession(id, sid).loadEarlierMessages(id, sid, cursor, sizeMiB),
    readHandoffHistory: (ws, tip, source, cursor, size, view) => controllers.forSession(ws, tip).readHandoffHistory(ws, tip, source, cursor, size, view),
    releaseHandoffHistory: (ws, tip, view) => controllers.forSession(ws, tip).releaseHandoffHistory(view),
    listSubagents: (id, sid) => controllers.forSession(id, sid).listSubagents(id, sid),
    readSubagent: (id, sid, agent, request, view) => controllers.forSession(id, sid).readSubagent(id, sid, agent, request, view),
    releaseSubagents: async (id, sid, view) => controllers.releaseSubagents(id, sid, view),
    readTaskOutput: (id, sid, tool, request, view) => controllers.forSession(id, sid).readTaskOutput(id, sid, tool, request, view),
    releaseTaskOutputs: async (id, sid, view) => controllers.releaseTaskOutputs(id, sid, view),
    unwatchSession: view => controllers.release(view),
    answerQuestion: (id, sid, pane, pid, token, action) => controllers.forSession(id, sid).answerQuestion(id, sid, pane, pid, token, action),
    answerPermission: (id, sid, pane, pid, token, action) => controllers.forSession(id, sid).answerPermission(id, sid, pane, pid, token, action),
    turnAction: (id, sid, pane, pid, action) => controllers.forSession(id, sid).turnAction(id, sid, pane, pid, action),
    sendMessage: (id, sid, text) => controllers.forSession(id, sid).sendMessage(id, sid, text),
    sendKey: (id, sid, key) => controllers.forSession(id, sid).sendKey(id, sid, key),
    setTerminalControl: (id, sid, enabled, token) => controllers.forSession(id, sid).setTerminalControl(id, sid, enabled, token),
    sendTerminalInput: (id, sid, token, input) => controllers.forSession(id, sid).sendTerminalInput(id, sid, token, input),
    getDirectoryTrust: (id, sid) => controllers.forSession(id, sid).getDirectoryTrust(id, sid),
    respondDirectoryTrust: (id, sid, token, decision) => controllers.forSession(id, sid).respondDirectoryTrust(id, sid, token, decision),
    getSessionSetting: (id, sid, kind) => controllers.forSession(id, sid).getSessionSetting(id, sid, kind),
    setUltracode: (id, sid, on) => controllers.forSession(id, sid).setUltracode(id, sid, on === true),
    setSessionSetting: (id, sid, token, option, mode) => controllers.forSession(id, sid).setSessionSetting(id, sid, token, option, mode === 'menu' ? 'menu' : 'inline'),
    ...updates.methods,
    // Opening the installer: it closes Lectern itself, which then quits without asking.
    openDownloadedUpdate: async () => { await updates.methods.openDownloadedUpdate(); installerOpenedAt = Date.now(); },
    quitPrompt: () => quitFlow?.current ?? null,
    quitPromptShown: id => { if (Number.isSafeInteger(id)) quitAcked = Math.max(quitAcked, id); },
    answerQuit: (id, answer, remember) => {
      if (!Number.isSafeInteger(id) || !quitAnswers.includes(answer)) throw new Error('Invalid quit answer');
      quitFlow?.answer(id, answer, remember === true);
    },
    quitPreferences: () => quitSettings!.get(),
    setQuitPreferences: preferences => quitSettings!.set(preferences),
  };
  for (const [name, handler] of Object.entries(methods)) {
    ipcMain.handle(`lectern:${name}`, (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
      // Record method/context only. Argument bodies may contain prompts or credentials.
      if (name === 'reportRendererDiagnostic') return handler(...args);
      const sessionMethods = new Set(['closeSession', 'resumeSession', 'forkSession', 'renameSession', 'bindSession', 'watchSession', 'loadEarlierMessages', 'readHandoffHistory', 'releaseHandoffHistory', 'listSubagents', 'readSubagent', 'readTaskOutput', 'releaseTaskOutputs', 'releaseSubagents', 'answerQuestion', 'answerPermission', 'turnAction', 'sendMessage', 'sendKey', 'setTerminalControl', 'sendTerminalInput', 'getSessionSetting', 'setSessionSetting', 'getDirectoryTrust', 'respondDirectoryTrust', 'setUltracode']);
      return diagnostic.operation(`ipc.${name}`, {
        workspaceId: typeof args[0] === 'string' && ['discover', 'createSession', 'removeWorkspace', ...sessionMethods].includes(name) ? args[0] : undefined,
        sessionId: sessionMethods.has(name) && typeof args[1] === 'string' ? args[1] : undefined,
      }, async () => handler(...args));
    });
  }
  controllers = new SessionViews(controller, (snapshot: SessionSnapshot) => window?.webContents.send('lectern:snapshot', snapshot),
    frame => window?.webContents.send('lectern:terminal-frame', frame),
    update => window?.webContents.send('lectern:sidebar-status', update));
  const onMenuAction = (action: MenuAction) => {
    if (!window) {
      const opened = createWindow();
      opened.webContents.once('did-finish-load', () => opened.webContents.send('lectern:menu-action', action));
    } else {
      if (window.isMinimized()) window.restore();
      window.show();
      window.webContents.send('lectern:menu-action', action);
    }
  };
  installApplicationMenu(onMenuAction);
  // A language switch applies at once: menu, renderer, and the texts the
  // backend put into open conversations' snapshots.
  onLocaleChange(locale => {
    diagnostic.event('app.locale', { locale }, 'info');
    installApplicationMenu(onMenuAction);
    window?.webContents.send('lectern:locale', localeState());
    try { controllers.relocalize(); }
    catch (error) { diagnostic.event('app.locale_refresh_failed', { error: errorDetails(error) }, 'warn'); }
  });
  createWindow();
}
if (!ownsProfile) app.quit();
else app.whenReady().then(boot).catch(error => {
  diagnostic.event('app.boot_failed', { error: errorDetails(error) }, 'error');
  dialog.showErrorBox(t('menu.startFailed'), error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('activate', () => { if (!window && controller) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// Every quit (app menu, ⌘Q / Ctrl+Q, Dock, the last window on Windows and Linux) asks first
// while Lectern conversations run (quit-guard.ts); cleanup follows in shutDown().
app.on('before-quit', event => {
  if (shutdownState === 'done') return;
  event.preventDefault();
  if (shutdownState === 'cleaning') return;
  if (!quitFlow) return shutDown();
  const reason: QuitReason = systemEnding ? 'system' : installerRecent() ? 'installer' : 'user';
  quitFlow.request(reason);
});
process.on('uncaughtException', error => {
  diagnostic.event('process.uncaught_exception', { error: errorDetails(error) }, 'error');
  void flushDiagnostics().finally(() => app.exit(1));
});
process.on('unhandledRejection', reason => {
  diagnostic.event('process.unhandled_rejection', { error: errorDetails(reason) }, 'error');
  void flushDiagnostics();
});
app.on('child-process-gone', (_event, details) => diagnostic.event('app.child_process_gone', { ...details }, 'error'));
