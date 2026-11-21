import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { version } from '../../package.json';
import { t } from '../shared/i18n';
import { spawn } from './child-fds';

export type CodexObject = Record<string, unknown>;
export type RequestId = string | number;
export const object = (value: unknown): CodexObject => value && typeof value === 'object' && !Array.isArray(value) ? value as CodexObject : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const requestId = (value: unknown): value is RequestId => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));

export class CodexRpcError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

export interface CodexProcessOptions { executable?: string; args?: string[] }
type ClientRequest = { resolve(value: CodexObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type CodexChild = ChildProcessByStdio<Writable, Readable, null>;
const maxFrame = 32 * 1024 * 1024;

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

async function command(options: CodexProcessOptions) {
  const args = [...(options.args ?? []), 'app-server', '--listen', 'stdio://'];
  if (options.executable) return { executable: options.executable, args };
  const path = process.env.PATH ?? '';
  const windows = process.platform === 'win32';
  const name = windows ? 'codex.exe' : 'codex';
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const executable = join(directory, name);
    if (await executableFile(executable)) return { executable, args };
    if (windows) {
      // npm on Windows exposes a .cmd shim. Invoke its installed JS entrypoint
      // directly to keep command-line arguments out of cmd.exe entirely.
      const npmEntry = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (await executableFile(npmEntry)) return { executable: 'node.exe', args: [npmEntry, ...args] };
    }
  }
  if (!windows) {
    const versions = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node');
    const candidates = await readdir(versions).catch(() => []);
    const binaries = (await Promise.all(candidates.map(async version => {
      const executable = join(versions, version, 'bin', name);
      return await executableFile(executable) ? executable : undefined;
    }))).filter((candidate): candidate is string => !!candidate);
    if (binaries.length === 1) return {
      executable: binaries[0], args, env: { ...process.env, PATH: dirname(binaries[0]) + delimiter + path },
    };
    if (binaries.length > 1) throw new Error(t('codex.cliAmbiguous'));
  }
  throw new Error(t('codex.cliMissing'));
}

/** Owns only the subprocess and its stdio connection. Server and client request IDs have separate namespaces. */
export class CodexAppServer {
  private child?: CodexChild;
  private closed?: Error;
  private fragment = '';
  private nextId = 0;
  private readonly pending = new Map<number, ClientRequest>();

  constructor(
    private readonly options: CodexProcessOptions,
    private readonly receive: (method: string, params: CodexObject, id?: RequestId) => void,
    private readonly disconnected: (error: Error) => void,
  ) {}

  async connect(): Promise<void> {
    const { executable, args, env } = await command(this.options);
    if (this.closed) throw this.closed;
    // A workspace is passed to Codex via the protocol only. The process must
    // never resolve a project-local executable or inherit a shell command.
    const child = spawn(executable, args, { cwd: homedir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    child.on('error', error => this.close(error));
    child.on('close', () => this.close(new Error('Codex App Server disconnected.')));
    child.stdin.on('error', () => this.close(new Error('Could not write to Codex App Server.')));
    child.stdout.on('error', () => this.close(new Error('Could not read from Codex App Server.')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    await this.request('initialize', { clientInfo: { name: 'lectern', title: 'Lectern', version } });
    await this.write({ method: 'initialized' });
  }

  request(method: string, params: CodexObject): Promise<CodexObject> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server timed out (${method}).`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(error => this.close(error));
    });
  }

  result(id: RequestId, result: CodexObject): Promise<void> { return this.write({ id, result }); }

  reject(id: RequestId): Promise<void> {
    return this.write({ id, error: { code: -32601, message: 'This Codex request is not supported by Lectern.' } });
  }

  private write(value: CodexObject): Promise<void> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(this.closed ?? new Error('Codex App Server is unavailable.'));
    return new Promise((resolve, reject) => child.stdin.write(JSON.stringify(value) + '\n', error => {
      if (error) reject(error); else resolve();
    }));
  }

  private read(chunk: string): void {
    let offset = 0;
    while (offset < chunk.length && !this.closed) {
      const end = chunk.indexOf('\n', offset);
      const part = chunk.slice(offset, end < 0 ? undefined : end);
      if (this.fragment.length + part.length > maxFrame) {
        this.close(new Error('Codex App Server sent an oversized message.'));
        return;
      }
      if (end < 0) { this.fragment += part; return; }
      const line = this.fragment + part;
      this.fragment = '';
      offset = end + 1;
      if (!line.trim()) continue;
      let frame: CodexObject;
      try { frame = object(JSON.parse(line)); }
      catch { this.close(new Error('Codex App Server sent invalid JSON.')); return; }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: CodexObject): void {
    const { id, method } = frame;
    if (typeof method === 'string') {
      this.receive(method, object(frame.params), requestId(id) ? id : undefined);
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = object(frame.error);
    if (typeof error.code === 'number') pending.reject(new CodexRpcError(string(error.message).slice(0, 4_000) || 'Codex request failed.', error.code));
    else pending.resolve(object(frame.result));
  }

  close(error = new Error('Codex App Server closed.')): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.fragment = '';
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // EOF lets Codex finish its own cleanup. Bound shutdown if the subprocess stalls.
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 1_000);
      timeout.unref();
      child.once('close', () => clearTimeout(timeout));
    }
    this.disconnected(error);
  }
}
