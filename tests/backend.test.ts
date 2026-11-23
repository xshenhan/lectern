import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, appendFile, chmod, mkdir, rm, symlink, rename, realpath, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Backend, commandInvocation, foregroundClaudePids, isClaudeForeground, projectSlug, quoteShell, runCommand, validateWorkspace, WorkspaceChangedError } from '../src/backend/index';
import { Transport } from '../src/backend/transport';
import type { Workspace, WorkspaceEndpoint } from '../src/shared/types';

const workspace: Workspace = { id: 'test', name: 'Test', kind: 'local', cwd: '/tmp' };
test('shell quoting preserves apostrophes, substitutions, Unicode, and newlines', { skip: process.platform === 'win32' ? 'POSIX shell behavior; Windows runs no local commands' : false }, async () => {
  const value = "a'b $(echo never) `printf nope`\n你好; \\";
  const result = await runCommand(workspace, `printf '%s' ${quoteShell(value)}`);
  assert.equal(result.stdout.toString(), value);
  assert.throws(() => quoteShell('a\0b'));
});

test('workspace directory browsing preserves logical paths and lists only accessible child directories', { skip: process.platform === 'win32' }, async () => {
  const backend = new Backend(), target = { kind: 'local' } as const;
  const root = await mkdtemp(join(tmpdir(), 'lectern-directories-'));
  const folder = "项目 ' \" $(printenv) [1] ", alias = join(root, 'linked folder');
  const physical = join(root, 'physical'), denied = join(physical, 'denied');
  try {
    await mkdir(join(physical, folder, 'nested'), { recursive: true });
    await mkdir(join(physical, '.hidden'));
    await mkdir(join(physical, '..also-hidden'));
    await mkdir(denied);
    await writeFile(join(physical, 'regular'), '');
    await symlink(physical, alias);
    await symlink(folder, join(physical, 'directory link'));
    await symlink('regular', join(physical, 'file link'));
    await symlink('missing', join(physical, 'broken link'));
    await symlink('denied', join(physical, 'restricted link'));
    await chmod(denied, 0);
    const expected = ['..also-hidden', '.hidden', 'directory link', folder];
    if (process.getuid?.() === 0) expected.push('denied', 'restricted link');
    else await assert.rejects(backend.listWorkspaceDirectories(target, denied));
    const listed = await backend.listWorkspaceDirectories(target, alias);
    assert.equal(listed.path, alias);
    assert.deepEqual(listed.directories.sort(), expected.sort());
    assert.equal(listed.nextOffset, undefined);
    const linkedChild = join(alias, 'directory link');
    assert.deepEqual(await backend.listWorkspaceDirectories(target, linkedChild), { path: linkedChild, directories: ['nested'] });
    const tildePath = '~/' + posix.relative(homedir(), join(alias, folder));
    assert.deepEqual(await backend.listWorkspaceDirectories(target, tildePath), { path: join(alias, folder), directories: ['nested'] });
    for (const path of ['', '~']) assert.equal((await backend.listWorkspaceDirectories(target, path)).path, homedir());
    for (const name of ['regular', 'missing', 'broken link']) await assert.rejects(backend.listWorkspaceDirectories(target, join(alias, name)));
  } finally {
    await backend.dispose();
    await chmod(denied, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace directory pages list visible directories before hidden ones and detect an exact final page', { skip: process.platform === 'win32' }, async () => {
  const backend = new Backend(), target = { kind: 'local' } as const;
  const root = await mkdtemp(join(tmpdir(), 'lectern-directory-page-'));
  const visible = Array.from({ length: 249 }, (_, i) => `dir-${String(i).padStart(3, '0')}`);
  const names = [...visible, '..hidden-a', '.hidden-b'];
  try {
    await Promise.all(names.map(name => mkdir(join(root, name))));
    await writeFile(join(root, 'dir-010-file'), '');
    const first = await backend.listWorkspaceDirectories(target, root);
    assert.deepEqual(first, { path: root, directories: names.slice(0, 250), nextOffset: 250 });
    assert.deepEqual(await backend.listWorkspaceDirectories(target, root, first.nextOffset), { path: root, directories: names.slice(250) });
    assert.deepEqual(await backend.listWorkspaceDirectories(target, root, 1), { path: root, directories: names.slice(1) });
    assert.deepEqual(await backend.listWorkspaceDirectories(target, root, 251), { path: root, directories: [] });
  } finally { await backend.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('workspace directory browsing validates paths, offsets and endpoints before routing to the SSH machine', async t => {
  const backend = new Backend();
  const transport = t.mock.method(Transport.prototype, 'run', async (workspace: Workspace, script: string) => {
    const invocation = commandInvocation(workspace, script);
    assert.equal(invocation.file, 'ssh');
    assert.deepEqual(invocation.args.slice(-4), ['-p', '2222', 'dev', 'exec sh -s']);
    return { stdout: Buffer.from('/home/test\0child\0'), stderr: '' };
  });
  try {
    const local = { kind: 'local' } as const;
    for (const path of ['relative', '~other', '/tmp/a\nb', '/tmp/a\0b', 'C:\\work', '/tmp/|~lectern~|']) {
      await assert.rejects(backend.listWorkspaceDirectories(local, path), /absolute POSIX/);
    }
    for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(backend.listWorkspaceDirectories(local, '/', offset), /页码/);
    }
    const invalid = [{ kind: 'other' }, { kind: 'ssh', host: '-bad' }, { kind: 'ssh', host: 'dev', port: 0 }];
    for (const endpoint of invalid) await assert.rejects(backend.listWorkspaceDirectories(endpoint as WorkspaceEndpoint, '/'));
    assert.equal(transport.mock.callCount(), 0);
    assert.deepEqual(await backend.listWorkspaceDirectories({ kind: 'ssh', host: 'dev', port: 2222 }, '~'), { path: '/home/test', directories: ['child'] });
    assert.equal(transport.mock.callCount(), 1);
  } finally { await backend.dispose(); }
});

test('workspace validation preserves a target basename and limits custom labels to 120 characters', () => {
  for (const name of [' project ', '  ', 'é'.repeat(127) + ' ']) {
    const saved = validateWorkspace({ ...workspace, cwd: `/tmp/${name}/`, name });
    assert.equal(saved.name, name);
    assert.equal(validateWorkspace(JSON.parse(JSON.stringify(saved))).name, name);
  }
  const oversized = 'é'.repeat(128);
  assert.throws(() => validateWorkspace({ ...workspace, name: oversized, cwd: `/tmp/${oversized}` }), /Workspace name/);
  assert.throws(() => validateWorkspace({ ...workspace, name: 'A'.repeat(121) }), /Workspace name/);
  assert.throws(() => validateWorkspace({ ...workspace, name: ' ' }), /Workspace name/);
  assert.equal(validateWorkspace({ ...workspace, name: ' Custom label ' }).name, 'Custom label');
});

test('discovery reconciles history and current explicit tmux bindings without ghosts or stale cache', { timeout: 30_000 }, async t => {
  try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux is not installed'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-discovery-')));
  const cwd = join(root, 'project'), claudeDir = join(root, 'claude'), childCwd = join(cwd, 'subdirectory');
  const alias = join(root, 'logical-project');
  await mkdir(childCwd, { recursive: true }); await symlink(cwd, alias);
  const project = join(claudeDir, 'projects', projectSlug(cwd));
  const aliasProject = join(claudeDir, 'projects', projectSlug(alias));
  await mkdir(project, { recursive: true }); await mkdir(aliasProject, { recursive: true });
  const historyId = randomUUID(), aliasId = randomUUID();
  const historical = (id: string, dir: string, text: string) => JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: dir, message: { role: 'user', content: text } }) + '\n';
  const historyPath = join(project, `${historyId}.jsonl`);
  await writeFile(historyPath, historical(historyId, cwd, 'Original directory') + historical(historyId, childCwd, 'Later cwd changed'));
  await writeFile(join(aliasProject, `${aliasId}.jsonl`), historical(aliasId, alias, 'Started through a symlink'));
  const mock = join(root, 'mock.mjs');
  await writeFile(mock, `import fs from 'node:fs'; import path from 'node:path';
process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('Ready\\n');
process.stdin.on('data', data => { if(data.includes(3)) process.exit(0); });
setInterval(() => { const trigger=path.join(process.env.CLAUDE_CONFIG_DIR,'move-cwd'); if(fs.existsSync(trigger)) { process.chdir(fs.readFileSync(trigger,'utf8')); } }, 30);
`);
  const socket = `lectern-discovery-${randomUUID().slice(0, 8)}`;
  const target: Workspace = { ...workspace, id: randomUUID(), cwd: alias, claudeDir };
  const options = { tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [mock] };
  const backend = new Backend(options);
  const tmux = async (...args: string[]) => (await runCommand(target, ['tmux', '-L', socket, ...args].map(quoteShell).join(' '))).stdout.toString().trim();
  const waitReady = async (id: string) => {
    for (let i = 0; i < 30; i++) { const read = await backend.readSession(target, id); if (read.active && read.screen.includes('Ready')) return; await new Promise(r => setTimeout(r, 30)); }
    assert.fail('Fixture pane did not become ready');
  };
  const delayNextRead = (client: Backend, matches: (script: string) => boolean) => {
    const transport = (client as any).transport;
    const original = transport.run.bind(transport);
    let started!: () => void, release!: () => void, armed = true;
    const captured = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    transport.run = async (...args: any[]) => {
      const hold = armed && matches(args[1]); if (hold) armed = false;
      const result = await original(...args);
      if (hold) { started(); await gate; }
      return result;
    };
    return { captured, release: () => { transport.run = original; release(); } };
  };
  try {
    const historyOnly = await backend.discover(target);
    assert.deepEqual(new Set(historyOnly.sessions.map(s => s.id)), new Set([historyId, aliasId]));
    assert.ok(historyOnly.sessions.every(s => !s.paneId && s.mapping === 'unbound'));

    const oldScan = delayNextRead(backend, script => script.includes('count=0'));
    const obsoleteDiscovery = assert.rejects(backend.discover(target), WorkspaceChangedError);
    await oldScan.captured;
    const pending = await backend.createSession(target);
    oldScan.release();
    await obsoleteDiscovery;
    assert.equal((backend as any).sessions.get(`${target.id}:${pending.id}`)?.paneId, pending.paneId, 'a pre-launch scan cannot erase the new session cache');
    assert.equal(backend.knownRunning(target.id).failedAt, undefined, 'superseded scans do not mark the folder unreachable');
    await waitReady(pending.id);
    const activeOnly = await backend.discover(target);
    assert.equal(activeOnly.sessions.find(s => s.id === pending.id)?.paneId, pending.paneId);
    assert.equal(activeOnly.sessions.find(s => s.id === pending.id)?.path, undefined, 'live explicitly mapped sessions exist before JSONL');
    const invalidatedScan = delayNextRead(backend, script => script.includes('count=0'));
    const obsoleteAfterEdit = assert.rejects(backend.discover(target), /Workspace changed/);
    await invalidatedScan.captured;
    backend.invalidateWorkspace(target.id);
    invalidatedScan.release();
    await obsoleteAfterEdit;
    assert.equal((backend as any).sessions.size, 0, 'an invalidated in-flight scan cannot repopulate the cache');
    await backend.discover(target);

    const staleLocator = new Backend(options);
    const delayedLocate = delayNextRead(staleLocator, script => script.includes('pwd -P'));
    const obsoleteLocation = assert.rejects(staleLocator.discover(target), /Workspace changed/);
    await delayedLocate.captured;
    staleLocator.invalidateWorkspace(target.id);
    delayedLocate.release();
    await obsoleteLocation;
    assert.equal((staleLocator as any).locations.size, 0, 'an invalidated directory lookup cannot repopulate location state');
    await staleLocator.dispose();
    await tmux('set-option', '-p', '-t', pending.paneId!, 'remain-on-exit', 'on');
    await backend.sendKey(target, pending.id, 'C-c');
    await new Promise(r => setTimeout(r, 80));
    assert.equal((await backend.discover(target)).sessions.some(s => s.id === pending.id), false, 'dead no-file panes do not create ghost conversations');
    await assert.rejects(() => backend.readSession(target, pending.id), /does not belong/);

    const live = await backend.resumeSession(target, historyId);
    await waitReady(historyId);
    const combined = await backend.discover(target);
    assert.equal(combined.sessions.filter(s => s.id === historyId).length, 1, 'JSONL and active pane become one session');
    assert.equal(combined.sessions.find(s => s.id === historyId)?.paneId, live.paneId);
    const reloaded = new Backend(options);
    assert.equal((await reloaded.discover(target)).sessions.find(s => s.id === historyId)?.paneId, live.paneId, 'mapping survives a client restart');
    await reloaded.dispose();

    await writeFile(join(claudeDir, 'move-cwd'), childCwd);
    await new Promise(r => setTimeout(r, 80));
    const moved = await backend.discover(target);
    const seen = () => JSON.stringify(moved.panes.map(({ id, cwd, sessionId, active, command }) => ({ id, cwd, sessionId, active, command })));
    assert.equal(moved.panes.find(p => p.id === live.paneId)?.cwd, childCwd, `pane ${live.paneId} after its process changed directory; panes seen: ${seen()}`);
    assert.equal(moved.sessions.find(s => s.id === historyId)?.paneId, live.paneId, 'initial project metadata survives live cwd changes');
    await rm(join(claudeDir, 'move-cwd'));

    // Simulate another client resuming/rebinding the same UUID after this pane exits.
    await backend.sendKey(target, historyId, 'C-c');
    await new Promise(r => setTimeout(r, 80));
    const otherClient = new Backend(options);
    const rebound = await otherClient.resumeSession(target, historyId);
    await waitReady(historyId);
    assert.notEqual(rebound.paneId, live.paneId);
    assert.equal((await backend.readSession(target, historyId)).session.paneId, rebound.paneId, 'reads follow current explicit UUID binding, not stale cached pane IDs');
    await backend.sendKey(target, historyId, 'Tab');
    await otherClient.dispose();

    const duplicate = await backend.createSession(target);
    await waitReady(duplicate.id);
    await tmux('set-option', '-p', '-t', duplicate.paneId!, '@lectern_session_id', historyId);
    const conflict = await backend.discover(target);
    assert.equal(conflict.sessions.find(s => s.id === historyId)?.paneId, undefined);
    assert.equal(conflict.sessions.find(s => s.id === historyId)?.status, 'error');
    assert.match(conflict.diagnostic!, /多个/);
    await assert.rejects(() => backend.readSession(target, historyId), { name: 'SessionMappingError', message: /Multiple live/ });
    await assert.rejects(() => backend.sendMessage(target, historyId, 'never route ambiguously'), /Multiple live/);
    await assert.rejects(() => backend.resumeSession(target, historyId), /Multiple live/);
    await tmux('kill-pane', '-t', duplicate.paneId!);

    await backend.sendKey(target, historyId, 'C-c');
    await new Promise(r => setTimeout(r, 80));
    const exited = await backend.discover(target);
    assert.equal(exited.sessions.find(s => s.id === historyId)?.paneId, undefined);
    assert.equal(exited.sessions.find(s => s.id === historyId)?.path, historyPath, 'exiting removes the live link but retains JSONL history');
    await rm(historyPath);
    const removed = await backend.discover(target);
    assert.equal(removed.sessions.some(s => s.id === historyId), false);
    await assert.rejects(() => backend.readSession(target, historyId), /does not belong/, 'refresh evicts deleted cached sessions');
  } finally {
    await backend.dispose();
    await runCommand(target, `tmux -L ${quoteShell(socket)} kill-server 2>/dev/null || true`);
    await rm(root, { recursive: true, force: true });
  }
});
test('workspace validation rejects SSH argument injection and non-POSIX working paths', () => {
  for (const host of ['-oProxyCommand=bad', 'user@host;touch /tmp/bad', 'host\nanything', 'ssh://host']) assert.throws(() => validateWorkspace({ ...workspace, kind: 'ssh', host }));
  assert.throws(() => validateWorkspace({ ...workspace, cwd: 'C:\\work' }));
  assert.throws(() => validateWorkspace({ ...workspace, kind: 'ssh', host: 'dev', port: 0 }));
  const invocation = commandInvocation({ ...workspace, kind: 'ssh', host: 'dev-alias' }, 'printf ok');
  assert.equal(invocation.file, 'ssh');
  assert.ok(invocation.args.includes('BatchMode=yes'));
  assert.ok(invocation.args.includes('StrictHostKeyChecking=yes'));
  assert.equal(invocation.args.at(-2), 'dev-alias');
});

test('default launches preserve Claude config environment while explicit directories override it', { timeout: 30_000 }, async t => {
  try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux is not installed'); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-config-env-')));
  const cwd = join(root, 'workspace'), inherited = join(root, 'inherited-config'), explicit = join(root, 'explicit-config');
  await mkdir(cwd);
  const mock = join(root, 'config-fixture.mjs');
  await writeFile(mock, `import fs from 'node:fs'; import path from 'node:path';
const output=process.argv[2], id=process.argv.at(-1), config=process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(path.join(output,id+'.json'),JSON.stringify({present:Object.hasOwn(process.env,'CLAUDE_CONFIG_DIR'),value:config}));
if(config){const dir=path.join(config,'projects',process.cwd().replace(/[^A-Za-z0-9]/g,'-'));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,id+'.jsonl'),JSON.stringify({type:'user',uuid:'fixture',sessionId:id,cwd:process.cwd(),message:{role:'user',content:'config fixture'}})+'\\n');}
process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('Ready\\n');
`);
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    for (const scenario of [
      { name: 'default-unset', inherited: undefined, configured: undefined, expected: undefined },
      { name: 'default-inherited', inherited, configured: undefined, expected: inherited },
      { name: 'explicit-override', inherited, configured: explicit, expected: explicit },
    ]) {
      if (scenario.inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = scenario.inherited;
      const socket = `lectern-env-${randomUUID().slice(0, 8)}`;
      const target: Workspace = { ...workspace, id: randomUUID(), cwd, claudeDir: scenario.configured };
      const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [mock, root] });
      try {
        const session = await backend.createSession(target);
        let captured: { present: boolean; value?: string } | undefined;
        for (let i = 0; i < 40; i++) {
          try { captured = JSON.parse(await readFile(join(root, `${session.id}.json`), 'utf8')); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        assert.ok(captured, scenario.name);
        assert.equal(captured.present, scenario.expected !== undefined, scenario.name);
        assert.equal(captured.value, scenario.expected, scenario.name);
        const found = (await backend.discover(target)).sessions.find(s => s.id === session.id);
        assert.ok(found?.paneId, scenario.name);
        if (scenario.expected) assert.equal(found?.path, join(scenario.expected, 'projects', projectSlug(cwd), `${session.id}.jsonl`), 'history follows the same selected/inherited configuration');
      } finally {
        await backend.dispose();
        await runCommand(target, `tmux -L ${quoteShell(socket)} kill-server 2>/dev/null || true`);
      }
    }
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
test('foreground guard rejects shells, unrelated node processes, and background Claude', () => {
  const row = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, args: '/bin/zsh' };
  assert.equal(isClaudeForeground(100, [row]), false);
  assert.equal(isClaudeForeground(100, [{ ...row, args: 'node /tmp/server.js' }]), false);
  assert.equal(isClaudeForeground(100, [row, { ...row, pid: 101, ppid: 100, pgid: 101, tpgid: 100, args: 'claude' }]), false);
  assert.equal(isClaudeForeground(100, [row, { ...row, pid: 101, ppid: 100, pgid: 101, tpgid: 101, args: 'claude --resume abc' }]), true);
  assert.equal(isClaudeForeground(100, [{ ...row, args: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' }]), true);
  assert.equal(isClaudeForeground(100, [{ ...row, args: '/usr/bin/node /tmp/mock.mjs' }], { claudeCommand: '/usr/bin/node', claudeArgs: ['/tmp/mock.mjs'] }), true);
});

test('a helper Claude Code forks (still named claude before exec) is not a second session', () => {
  // Sampled with the compatibility matrix (Claude Code 2.1.300): the pane's sh execs
  // claude, which forks git, rg and its statusLine command in the same process group.
  const rows = [
    { pid: 50, ppid: 1, pgid: 50, tpgid: 60, args: 'sh -c exec claude' },
    { pid: 60, ppid: 50, pgid: 60, tpgid: 60, args: 'claude' },
    { pid: 61, ppid: 60, pgid: 60, tpgid: 60, args: 'claude' },
    { pid: 62, ppid: 61, pgid: 60, tpgid: 60, args: 'claude' },
    { pid: 63, ppid: 60, pgid: 60, tpgid: 60, args: 'rg --files' },
  ];
  assert.deepEqual(foregroundClaudePids(50, rows), [60]);
  // Two Claudes side by side in the foreground still conflict.
  assert.deepEqual(foregroundClaudePids(50, [...rows, { pid: 70, ppid: 50, pgid: 60, tpgid: 60, args: '/usr/local/bin/claude --resume abc' }]), [60, 70]);
});

test('real tmux: launch, exact mapping, literal multiline input, JSONL offsets, restart discovery, shell guard', { timeout: 30_000 }, async t => {
  try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux is not installed'); return; }
  const root = await mkdtemp(join(tmpdir(), 'lectern-backend-'));
  const cwd = join(root, "project with space's");
  const claudeDir = join(root, 'claude');
  await mkdir(cwd); await mkdir(claudeDir);
  const mock = join(root, 'mock-claude.mjs');
  await writeFile(mock, `import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), id=args[args.length-1];
const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^A-Za-z0-9]/g,'-')); fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,id+'.jsonl');
process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\x1b[?2004hReady\\n');
let text='',paste=false;
process.stdin.on('data', chunk=>{const s=chunk.toString(); for(let i=0;i<s.length;i++){if(s.startsWith('\\x1b[200~',i)){paste=true;i+=5;continue;}if(s.startsWith('\\x1b[201~',i)){paste=false;i+=5;continue;}const c=s[i];if(c==='\\x03')process.exit();if(c==='\\r'&&!paste){fs.appendFileSync(file,JSON.stringify({type:'user',uuid:'u-'+Date.now(),sessionId:id,cwd:process.cwd(),timestamp:new Date().toISOString(),message:{role:'user',content:text}})+'\\n');process.stdout.write('\\r\\nreceived: '+text+'\\r\\n');text='';}else text+=c;}});
`);
  const socket = `lectern-test-${randomUUID().slice(0, 8)}`;
  const target: Workspace = { ...workspace, id: randomUUID(), cwd, claudeDir };
  const options = { tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [mock] };
  const backend = new Backend(options);
  try {
    const session = await backend.createSession(target);
    assert.match(session.paneId!, /^%\d+$/);
    for (let i = 0; i < 20; i++) { const initial = await backend.readSession(target, session.id); if (initial.active && initial.screen.includes('Ready')) break; await new Promise(r => setTimeout(r, 50)); }
    // A named Space must be delivered as one space, not the literal key name.
    await backend.sendTerminalInput(target, session.id, { type: 'key', key: 'Space' }, session.paneId!);
    assert.equal((await backend.readSession(target, session.id)).jsonl.length, 0, 'Space alone does not submit the draft');
    const characters = 's1中🧭$;-👨‍👩‍👧‍👦';
    await backend.sendTerminalInput(target, session.id, { type: 'literal', text: characters }, session.paneId!);
    await assert.rejects(backend.sendMessage(target, session.id, 'must not overwrite the existing native draft', session.paneId!), /输入框或绑定已变化/);
    assert.equal((await backend.readSession(target, session.id)).jsonl.length, 0, 'A recovery send must recheck the live composer before pasting or submitting');
    const frame = (await backend.readSession(target, session.id, true, [], false, true)).terminalFrame;
    assert.ok(frame && frame.paneId === session.paneId && frame.ansi.includes('Ready') && frame.ansi.split('\n').length === frame.rows);
    assert.ok(frame.cursorX < frame.cols && frame.cursorY < frame.rows);
    await assert.rejects(backend.sendTerminalInput(target, session.id, { type: 'key', key: 'Enter' }, session.paneId!, { panePid: -1 }), /process changed/);
    for (const text of ['', '\r', '\n', '\x1b', '\x85', '\ud800']) {
      await assert.rejects(backend.sendTerminalInput(target, session.id, { type: 'literal', text }, session.paneId!), /printable/);
    }
    const suffix = " first line\n第二行 $(touch /tmp/not-executed) ' quoted";
    const text = ' ' + characters + suffix;
    await backend.sendMessage(target, session.id, suffix);
    await new Promise(r => setTimeout(r, 80));
    backend.resetRead(target.id, session.id);
    const read = await backend.readSession(target, session.id);
    assert.equal(read.reset, true);
    assert.ok(read.jsonl.length, JSON.stringify(read));
    assert.equal(JSON.parse(read.jsonl.toString()).message.content, text);
    assert.equal((await backend.readSession(target, session.id)).jsonl.length, 0);
    assert.match(read.screen, /received:/);
    const restarted = new Backend(options);
    const discovery = await restarted.discover(target);
    assert.equal(discovery.sessions[0].id, session.id);
    assert.equal(discovery.sessions[0].mapping, 'exact');
    assert.equal(discovery.sessions[0].paneId, session.paneId);
    assert.equal((await restarted.resumeSession(target, session.id)).paneId, session.paneId);
    await restarted.dispose();
    const transcript = discovery.sessions[0].path!;
    const hugeRecord = JSON.stringify({ type: 'assistant', uuid: 'large', cwd: discovery.workspace.cwd, message: { role: 'assistant', content: [{ type: 'text', text: '中文🙂'.repeat(90_000) }] } }) + '\n';
    await appendFile(transcript, hugeRecord);
    const chunks: Buffer[] = [];
    let more = true;
    while (more) { const page = await backend.readSession(target, session.id); chunks.push(page.jsonl); more = page.hasMore; }
    assert.ok(chunks.length > 1, 'large records are transferred with bounded reads');
    assert.equal(Buffer.concat(chunks).toString('utf8'), hugeRecord);
    const replacement = JSON.stringify({ type: 'user', uuid: 'replacement', cwd: discovery.workspace.cwd, message: { content: 'replacement' } }) + '\n';
    await writeFile(transcript, replacement);
    const truncated = await backend.readSession(target, session.id);
    assert.equal(truncated.reset, true);
    assert.equal(truncated.jsonl.toString(), replacement);
    await writeFile(transcript + '.new', replacement);
    await rename(transcript + '.new', transcript);
    assert.equal((await backend.readSession(target, session.id)).reset, true, 'inode rotation resets the decoder');
    // History scans do not follow arbitrary .jsonl symlinks outside project history.
    await writeFile(join(root, 'unrelated-file'), replacement);
    await symlink(join(root, 'unrelated-file'), join(transcript, '..', `${randomUUID()}.jsonl`));
    await writeFile(join(transcript, '..', `${randomUUID()}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'unknown cwd' } }) + '\n');
    await writeFile(join(transcript, '..', `${randomUUID()}.jsonl`), JSON.stringify({ type: 'user', cwd: '/a/different/project', message: { content: 'slug collision' } }) + '\n');
    const safeDiscovery = await backend.discover(target);
    assert.equal(safeDiscovery.sessions.length, 1);
    assert.match(safeDiscovery.diagnostic!, /无法.*确认工作目录/);
    // A separately existing shell is deliberately marked to simulate a Claude process exiting.
    const shell = await runCommand(target, `tmux -L ${quoteShell(socket)} split-window -d -P -F '#{pane_id}' -t ${quoteShell(session.paneId!)} /bin/sh`);
    const shellId = shell.stdout.toString().trim();
    await assert.rejects(() => backend.bindSession(target, session.id, shellId), /live Claude pane/);
    await backend.sendKey(target, session.id, 'C-c');
    await new Promise(r => setTimeout(r, 100));
    await assert.rejects(() => backend.sendMessage(target, session.id, 'echo should never execute'), /not running/);
    // Transcript is still discoverable after Claude exits.
    assert.equal((await backend.discover(target)).sessions[0].id, session.id);
    assert.equal(projectSlug(cwd).includes('/'), false);
  } finally {
    await backend.dispose();
    await runCommand(target, `tmux -L ${quoteShell(socket)} kill-server 2>/dev/null || true`);
    await rm(root, { recursive: true, force: true });
  }
});
