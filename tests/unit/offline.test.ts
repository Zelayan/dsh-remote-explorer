/**
 * @file 离线模式回归测试
 * @description 覆盖清单、路径攻击、纯本地插件安装与离线引导；不读取用户配置或连接生产服务器。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { parseOfflineManifest, validateRuntimeEntry, verifyOfflineBundle, sha256File } from '../../src/provision/offline-bundle.ts';
import { hashPluginFiles, installOfflinePlugin } from '../../src/provision/offline-plugin.ts';
import { provision } from '../../src/provision/provisioner.ts';
import { SessionSupervisor } from '../../src/plugin/supervisor.ts';
import { registerPanelRoutes } from '../../src/plugin/routes.ts';
import { probeAndReadCredentials } from '../../src/session/open-pipeline/probe.ts';
import { DEFAULT_NODE_VERSION } from '../../src/provision/node-installer.ts';
import type { RemoteTransport } from '../../src/transport/types.ts';

test('插件离线配置使 Node/DSH 版本路由零 fetch', async () => {
  const supervisor = new SessionSupervisor({ offline: true, cwd: '', localPort: 0, nodeVersion: '', dshVersion: '', forceRestart: false, refreshMirrors: false });
  const routes: { path: string; fetch: (request: Request) => Promise<Response> }[] = [];
  const context = {
    inject(_names: string[], callback: (inner: unknown) => void) {
      callback({ connection: { fetch: { register(route: typeof routes[number]) { routes.push(route); return async () => {}; } } }, effect() {} });
    },
  };
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('严格离线禁止 fetch'); };
  try {
    registerPanelRoutes(context as unknown as Parameters<typeof registerPanelRoutes>[0], supervisor);
    for (const suffix of ['/node-versions', '/dsh-versions']) {
      const route = routes.find(route => route.path.endsWith(suffix));
      assert.ok(route);
      assert.deepEqual(await (await route.fetch(new Request('http://localhost'))).json(), { versions: [] });
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

/** 合法测试清单 */
const MANIFEST = { format: 1, os: 'linux', arch: 'x64', nodeVersion: 'v24.21.0', dshVersion: '0.2.0-rc.2', sha256: 'a'.repeat(64) };

test('离线清单仅接受明确平台、精确版本与摘要', () => {
  assert.deepEqual(parseOfflineManifest(MANIFEST), MANIFEST);
  for (const patch of [{ format: 2 }, { os: 'windows' }, { arch: 'armv7l' }, { nodeVersion: '../x' }, { dshVersion: 'latest' }, { sha256: 'bad' }]) {
    assert.throws(() => parseOfflineManifest({ ...MANIFEST, ...patch }));
  }
  assert.throws(() => parseOfflineManifest(null));
});

test('归档拒绝穿越、凭据、硬链接与越界符号链接', () => {
  for (const path of ['/etc/passwd', '../package.json', 'node/../../etc/x', 'node\\x', '.credentials.yaml', 'sessions/id/x', 'profiles/web/package.json']) {
    assert.throws(() => validateRuntimeEntry(path, 'File'));
  }
  assert.throws(() => validateRuntimeEntry('node_modules/a', 'Link', 'package.json'));
  assert.throws(() => validateRuntimeEntry('node_modules/a', 'SymbolicLink', '../../outside'));
  assert.throws(() => validateRuntimeEntry('node_modules/a', 'SymbolicLink', '/tmp/x'));
  validateRuntimeEntry('node_modules/.bin/dsh', 'SymbolicLink', '../@deepseek-ai/dsh/bin.mjs');
});

test('归档校验识别缺文件与内容篡改', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-offline-'));
  try {
    const source = join(root, 'source');
    const bundle = join(root, 'bundle');
    await mkdir(source); await mkdir(bundle);
    await writeFile(join(source, 'package.json'), '{}');
    const archive = join(bundle, 'runtime.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: source }, ['package.json']);
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ ...MANIFEST, sha256: await sha256File(archive) }));
    await assert.rejects(verifyOfflineBundle(bundle), /缺少必要资源/);
    await writeFile(archive, 'tampered');
    await assert.rejects(verifyOfflineBundle(bundle), /SHA-256/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('完整归档拒绝链式链接与缺失目标，不因扫描异常挂起', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-links-'));
  try {
    const source = join(root, 'source'); const bundle = join(root, 'bundle');
    await mkdir(join(source, 'node/v24.21.0/bin'), { recursive: true });
    await mkdir(join(source, 'node_modules/@deepseek-ai/dsh'), { recursive: true });
    await mkdir(bundle);
    await writeFile(join(source, 'node/v24.21.0/bin/node'), 'node');
    await writeFile(join(source, 'node_modules/@deepseek-ai/dsh/package.json'), '{}');
    await writeFile(join(source, 'package.json'), '{}');
    await symlink('b', join(source, 'node_modules/a'));
    await symlink('a', join(source, 'node_modules/b'));
    const archive = join(bundle, 'runtime.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: source }, ['node', 'node_modules', 'package.json']);
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ ...MANIFEST, sha256: await sha256File(archive) }));
    await assert.rejects(verifyOfflineBundle(bundle), /链式或循环/);
    await rm(join(source, 'node_modules/b'));
    await tar.c({ gzip: true, file: archive, cwd: source }, ['node', 'node_modules', 'package.json']);
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ ...MANIFEST, sha256: await sha256File(archive) }));
    await assert.rejects(verifyOfflineBundle(bundle), /目标缺失/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** 创建最小的可信插件离线包和已有 profile。 */
async function pluginFixture(root: string): Promise<{ bundle: string; profile: string }> {
  const bundle = join(root, 'bundle');
  const source = join(bundle, 'package');
  const profile = join(root, 'desktop');
  await mkdir(join(source, 'lib'), { recursive: true });
  await mkdir(profile);
  await writeFile(join(source, 'lib', 'index.js'), 'export const name = "test";');
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'dsh-remote-explorer', version: '0.8.4', type: 'module', main: 'lib/index.js',
    dependencies: {}, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  await writeFile(join(source, 'cordis.patch.yml'), '[]');
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({
    format: 1, name: 'dsh-remote-explorer', version: '0.8.4', files: await hashPluginFiles(source),
  }));
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    private: true, dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: ['existing'], custom: 'keep' } },
  }));
  await writeFile(join(profile, 'cordis.patch.yml'), '# 用户配置保持原样\n');
  return { bundle, profile };
}

test('插件纯本地安装保留现有配置、使用稳定 file 源并拒绝覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-plugin-'));
  try {
    const { bundle, profile } = await pluginFixture(root);
    const installed = await installOfflinePlugin(bundle, profile);
    assert.ok((await lstat(installed)).isDirectory());
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, ['existing', 'dsh-remote-explorer']);
    assert.equal(manifest.dependencies.existing, '1.0.0');
    assert.match(manifest.dependencies['dsh-remote-explorer'], /^file:\.\/offline-packages\//);
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '# 用户配置保持原样\n');
    await assert.rejects(installOfflinePlugin(bundle, profile), /已登记插件/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('插件安装拒绝摘要篡改及 node_modules 链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-plugin-'));
  try {
    const { bundle, profile } = await pluginFixture(root);
    await writeFile(join(bundle, 'package', 'lib', 'index.js'), 'bad');
    await assert.rejects(installOfflinePlugin(bundle, profile), /SHA-256/);
    // 重新计算可信清单后仍不能写穿目标链接。
    const m = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
    m.files = await hashPluginFiles(join(bundle, 'package'));
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify(m));
    const outside = join(root, 'outside'); await mkdir(outside);
    await symlink(outside, join(profile, 'node_modules'), 'dir');
    await assert.rejects(installOfflinePlugin(bundle, profile), /普通目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** 用命令白名单模拟传输，任何下载、registry 查询或镜像测速都使测试失败。 */
function offlineTransport(missingNode = false): RemoteTransport {
  return {
    hostAlias: 'myhost', isAlive: true,
    platform: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' },
    async exec(command: string) {
      let stdout = '';
      if (command.includes('printf "HOME=')) stdout = 'HOME=/home/youruser\nTOOL=tar\nAVAIL=99999999\n';
      else if (command.includes('/bin/node') && command.endsWith(' -v')) stdout = missingNode ? '' : DEFAULT_NODE_VERSION;
      else if (command.includes('/.bin/dsh') && command.endsWith(' --version')) stdout = '0.2.0-rc.2';
      else if (command.startsWith('cat ') && command.includes('pnpm/package.json')) stdout = '{"version":"11.7.0"}';
      else if (command.startsWith('cat ') && command.includes('pnpm-workspace.yaml')) stdout = '';
      else if (command.startsWith('test -f ') && command.includes('package.json')) stdout = 'EXISTS';
      else if (command.startsWith('mkdir -p ') || command.startsWith('printf ') || command.startsWith('cat ')) stdout = '';
      else throw new Error(`禁止的离线命令：${command}`);
      return { stdout, stderr: '', exitCode: missingNode && command.endsWith(' -v') ? 127 : 0 };
    },
    async writeRemoteFile() {},
    async readRemoteFile() { throw new Error('ENOENT'); },
  } as unknown as RemoteTransport;
}

test('严格离线引导成功且不要求 curl/wget、不进入任何在线路径', async () => {
  const result = await provision(offlineTransport(), { sessionId: 'test', offline: true, skipStabilityCheck: true });
  assert.equal(result.dsh.version, '0.2.0-rc.2');
  assert.equal(result.node.reused, true);
});

test('完整连接的首轮探测在无下载器时可进入端口分配', async () => {
  const transport = offlineTransport();
  const originalExec = transport.exec.bind(transport);
  transport.exec = async (command, options) => {
    if (command.includes('printf "HOME=')) return originalExec(command, options);
    // 后续凭据/进程只返回未安装状态，不依赖用户真实文件。
    assert.doesNotMatch(command, /curl |wget |npm view|npm install/);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const result = await probeAndReadCredentials(transport, 'test', { hostAlias: 'myhost', remoteCwd: '', offline: true });
  assert.equal(typeof result.webPort, 'number');
  assert.equal(result.secretIsNew, true);
});

test('严格离线缺资源立即失败，不下载；标签和镜像重测被拒绝', async () => {
  await assert.rejects(provision(offlineTransport(true), { sessionId: 'test', offline: true }), /offline-import/);
  await assert.rejects(provision(offlineTransport(), { sessionId: 'test', offline: true, dshVersion: 'latest' }), /不解析 DSH 标签/);
  await assert.rejects(provision(offlineTransport(), { sessionId: 'test', offline: true, refreshMirrors: true }), /refreshMirrors/);
});
