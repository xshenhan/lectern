import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Square, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '../shared/i18n';
import type { CodexThreadSummary, CodexWorkspace } from '../shared/codex';
import type { Workspace } from '../shared/types';
import type { SidebarSortMode } from './desktop-state';
import './codex-panel.css';

const priority = { waiting: 0, error: 0, working: 1, idle: 2 } satisfies Record<CodexThreadSummary['status'], number>;
const errorText = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);

export function CodexPanel({ workspace, sort, onClose }: { workspace: Workspace; sort: SidebarSortMode; onClose(): void }) {
  const [data, setData] = useState<CodexWorkspace>();
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [readError, setReadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const operation = useRef(false);
  const threads = [...(data?.threads ?? [])].sort((a, b) =>
    (sort === 'priority' ? priority[a.status] - priority[b.status] : 0) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const threadId = selected || threads[0]?.id;
  const thread = data?.thread?.id === threadId ? data?.thread : undefined;
  const active = thread?.status === 'working' || thread?.status === 'waiting';

  useEffect(() => { if (!selected && threadId) setSelected(threadId); }, [selected, threadId]);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      let delay = 3000;
      try {
        const next = await window.desktop.codexWorkspace(workspace.id, threadId);
        if (cancelled) return;
        setData(next);
        setReadError(next.threadError ?? '');
        if (threadId && !next.threads.some(item => item.id === threadId)) {
          setSelected('');
          setDraft('');
        }
        if (next.threads.some(item => item.status === 'working' || item.status === 'waiting')) delay = 700;
      } catch (error) {
        if (!cancelled) setReadError(errorText(error));
      }
      if (!cancelled) timer = setTimeout(read, delay);
    }
    // StrictMode remounts on startup; only the live panel should start a read.
    queueMicrotask(() => { if (!cancelled) void read(); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workspace.id, threadId, refresh]);

  useLayoutEffect(() => {
    follow.current = true;
  }, [threadId]);
  const messages = thread?.messages;
  const latestText = messages?.at(-1)?.text;
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [threadId, messages?.length, latestText]);

  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setActionError('');
    try { await action(); }
    catch (error) { setActionError(errorText(error)); }
    finally {
      operation.current = false;
      setBusy(false);
      setRefresh(value => value + 1);
    }
  }

  function select(id: string) {
    if (id === threadId || operation.current) return;
    setSelected(id);
    setDraft('');
    setActionError('');
    setReadError('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!thread || active || !draft.trim()) return;
    void run(async () => {
      await window.desktop.codexSend(workspace.id, thread.id, draft);
      setDraft('');
      follow.current = true;
    });
  }

  return <dialog ref={dialog} className="modal codex-panel" aria-label={t('codex.chats')} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="modal-header codex-header">
      <h2>Codex</h2><span title={workspace.cwd}>{workspace.name}</span>
      <button type="button" className="icon-button" aria-label={t('codex.close')} onClick={onClose}><X size={18} /></button>
    </header>
    <div className="codex-body">
      <aside className="codex-threads" aria-label={t('codex.chats')}>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(async () => {
          const created = await window.desktop.codexCreate(workspace.id);
          setSelected(created.id);
          setDraft('');
          setReadError('');
          setData(previous => ({ threads: [...(previous?.threads ?? []), created], thread: created }));
        })}><Plus size={15} />{t('codex.newChat')}</button>
        <ul>
          {threads.map(item => <li key={item.id}>
            <button type="button" className="codex-thread" disabled={busy} aria-current={item.id === threadId ? 'true' : undefined}
              title={item.title || t('codex.untitled')} onClick={() => select(item.id)}>
              <span>{item.title || t('codex.untitled')}</span><small data-status={item.status}>{t(`codex.${item.status}`)}</small>
            </button>
          </li>)}
        </ul>
      </aside>
      <section className="codex-conversation" aria-label={thread?.title || t('codex.chats')}>
        <div className="codex-transcript" ref={transcript} onScroll={event => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
        }}>
          {(actionError || readError || thread?.error) && <p className="form-error" role="alert">{actionError || readError || thread?.error}</p>}
          {!readError && (!data || threadId && !thread) && <p className="codex-note" role="status">{t('codex.loading')}</p>}
          {data && !threadId && !readError && <p className="codex-note">{t('codex.empty')}</p>}
          {thread && !thread.messages.length && !active && <p className="codex-note">{t('codex.start')}</p>}
          {messages?.map(message => <div key={message.id} className={`codex-message codex-${message.role}`}>
            <span className="codex-speaker">{message.role === 'assistant' ? 'Codex' : t('codex.you')}</span>
            {message.role === 'assistant' ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={['img']}>{message.text}</ReactMarkdown></div>
              : <div className="codex-user-text">{message.text}</div>}
          </div>)}
        </div>
        {thread && <form className="codex-composer" onSubmit={submit}>
          {thread.approvals.map(approval => <div className="codex-approval" key={approval.id}>
            <strong>{approval.title}</strong><pre>{approval.detail}</pre>
            <div className="codex-approval-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => window.desktop.codexAnswer(workspace.id, thread.id, approval.id, 'decline'))}>{t('codex.decline')}</button>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => window.desktop.codexAnswer(workspace.id, thread.id, approval.id, 'accept'))}>{t('codex.allow')}</button>
            </div>
          </div>)}
          <textarea rows={3} value={draft} onChange={event => setDraft(event.target.value)} readOnly={busy}
            aria-label={t('codex.placeholder')} placeholder={t('codex.placeholder')} />
          <div className="codex-composer-actions">
            <span role="status" data-status={thread.status}>{t(`codex.${thread.status}`)}</span>
            {active ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => window.desktop.codexInterrupt(workspace.id, thread.id))}><Square size={13} />{t('codex.stop')}</button>
              : <button type="submit" className="primary-button" disabled={busy || !draft.trim() || !!readError}>{t('codex.send')}</button>}
          </div>
        </form>}
      </section>
    </div>
  </dialog>;
}
