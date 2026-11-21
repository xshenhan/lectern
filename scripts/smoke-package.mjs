import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdtemp, rm, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The argument is the packaged executable, or electron-builder's output directory
// (e.g. test-results/package) in which the unpacked app for this platform is found.
async function executableIn(directory) {
  const { name, productName } = JSON.parse(await readFile('package.json', 'utf8'));
  const entries = await readdir(directory);
  if (process.platform === 'linux') return path.join(directory, 'linux-unpacked', name);
  if (process.platform === 'win32') return path.join(directory, 'win-unpacked', `${productName}.exe`);
  const mac = entries.find(entry => /^mac(?:-arm64|-universal)?$/.test(entry) && (process.arch !== 'arm64' || entry !== 'mac'))
    ?? entries.find(entry => entry.startsWith('mac'));
  if (!mac) throw new Error(`No mac app directory in ${directory}`);
  return path.join(directory, mac, `${productName}.app`, 'Contents', 'MacOS', productName);
}
const argument = process.argv[2];
if (!argument) throw new Error('Usage: node scripts/smoke-package.mjs <app-executable | electron-builder output directory>');
const executablePath = (await stat(argument)).isDirectory() ? await executableIn(path.resolve(argument)) : argument;
console.log(`Smoke test: ${executablePath}`);
// Windows connects only over SSH: its first-run screen has no local-folder actions.
const sshOnly = process.platform === 'win32';
const profile = await mkdtemp(path.join(tmpdir(), 'lectern-package-smoke-'));
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ executablePath, args: [], env });
  const page = await app.firstWindow();
  // A fresh profile opens on the first-run actions.
  await page.getByRole('button', { name: sshOnly ? '添加SSH远程连接' : '添加本机文件夹', exact: true }).waitFor();
  const native = await app.evaluate(({ app, Menu, nativeImage }) => ({
    packaged: app.isPackaged,
    locale: app.getLocale(),
    menus: Menu.getApplicationMenu()?.items.map(item => item.label),
    icon: nativeImage.createFromPath(process.resourcesPath + '/lectern.png').getSize(),
  }));
  assert.equal(native.packaged, true);
  assert.equal(native.locale, 'zh-CN');
  assert.equal(native.icon.width, 512);
  for (const title of ['文件', '编辑', '显示', '窗口', '帮助']) assert.ok(native.menus.includes(title));
  assert.equal(await page.evaluate(() => navigator.language), 'zh-CN');
  await page.waitForFunction(() => document.querySelector('.brand-mark')?.naturalWidth > 0);
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().items.find(item => item.label === '帮助').submenu.items.find(item => item.label === '使用说明').click();
  });
  await page.getByRole('dialog', { name: '使用说明' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await mkdir('test-results', { recursive: true });
  if (!sshOnly) {
    await page.getByRole('button', { name: '添加本机文件夹', exact: true }).click();
    await page.getByRole('textbox', { name: '工作目录', exact: true }).fill('/home/developer/project');
    await page.screenshot({ path: 'test-results/packaged-workspace-dialog.png' });
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: '添加SSH远程连接', exact: true }).click();
  await page.getByRole('dialog', { name: '设置', exact: true }).getByLabel('SSH 主机', { exact: true }).fill('devbox');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  // Do not save or connect: packaging validation must not reach a real machine.
  assert.equal(await page.evaluate(async () => (await window.desktop.listWorkspaces()).length), 0);
  if (process.platform === 'darwin') {
    // The menu remains available after the last window closes on macOS.
    await Promise.all([
      page.waitForEvent('close'),
      app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
        const win = BrowserWindow.getAllWindows()[0];
        win.once('closed', () => resolve());
        win.close();
      })),
    ]);
    const [settingsWindow] = await Promise.all([
      app.waitForEvent('window'),
      app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? [])
          .find(item => item.label === '设置…').click();
      }),
    ]);
    await settingsWindow.locator('dialog.desktop-preferences[open]').waitFor();
  }
  console.log('PASS: packaged Chinese menus, app icon, isolated renderer, onboarding and SSH workspace form.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
