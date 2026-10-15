/**
 * @file 离线包导入导出集成回归
 * @description 在隔离 HOME 执行真实 POSIX shell 与 tar，以最小运行时替身验证迁移流程，不下载外网资源。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportOfflineBundle, importOfflineBundle } from '../../src/provision/offline-transfer.ts';
import { createRemotePaths } from '../../src/provision/remote-paths.ts';
import { DEFAULT_NODE_VERSION } from '../../src/provision/node-installer.ts';
import type { ExecOptions, RemoteTransport } from '../../src/transport/types.ts';

/** 子进程承载真实 shell，隔离 HOME/PATH，不实现网络。 */
const exec = promisify(execFile);

/** 创建离线运行时替身，含 Node 与 DSH 可执行脚本及相对符号链接。 */
async function fixture(home: string): Promise<void> {
  const paths = createRemotePaths(home);
  await mkdir(paths.nodeBinDir(DEFAULT_NODE_VERSION), { recursive: true });
  await mkdir(join(paths.nodeDir(DEFAULT_NODE_VERSION), 'lib/node_modules/pnpm'), { recursive: true });
  await mkdir(join(paths.base, 'node_modules/@deepseek-ai/dsh'), { recursive: true });
  await mkdir(join(paths.base, 'node_modules/.bin'));
  await writeFile(paths.nodeBin(DEFAULT_NODE_VERSION), `#!/bin/sh\nif [ "$1" = "-v" ]; then echo ${DEFAULT_NODE_VERSION}; fi\nexit 0\n`, { mode: 0o755 });
  await writeFile(join(paths.nodeDir(DEFAULT_NODE_VERSION), 'lib/node_modules/pnpm/package.json'), '{"version":"11.7.0"}');
  await writeFile(join(paths.base, 'node_modules/@deepseek-ai/dsh/package.json'), '{"version":"0.2.0-rc.2"}');
  await writeFile(join(paths.base, 'node_modules/@deepseek-ai/dsh/bin.sh'), '#!/bin/sh\necho 0.2.0-rc.2\n', { mode: 0o755 });
  await symlink('../@deepseek-ai/dsh/bin.sh', paths.dshBin);
  await writeFile(join(paths.base, 'package.json'), '{"private":true}');
  await writeFile(paths.credentialsFile, 'DO-NOT-EXPORT');
}

/** 在普通目录模拟上传、读取与 exec，Linux flock 的互斥本身由独立机制测试负责。 */
function transport(home: string, tools: string): RemoteTransport {
  return {
    hostAlias: 'myhost', isAlive: true,
    platform: { os: 'darwin', arch: 'arm64', rawOs: 'Darwin', rawArch: 'arm64' },
    async exec(command: string, options: ExecOptions = {}) {
      try {
        const result = await exec('/bin/sh', ['-c', command], {
          env: { ...process.env, HOME: home, ...options.env, PATH: `${options.pathPrefix ? `${options.pathPrefix}:` : ''}${tools}:${process.env.PATH}` },
          timeout: options.timeoutMs ?? 30_000,
        });
        return { ...result, exitCode: 0 };
      } catch (error) {
        if (!options.allowNonZeroExit) throw error;
        const e = error as Error & { stdout: string; stderr: string; code: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
      }
    },
    async uploadFile(local: string, remote: string) { await copyFile(local, remote); },
    async readRemoteFile(path: string) { return await readFile(path); },
  } as unknown as RemoteTransport;
}

test('纯运行包导出→全新主机导入，凭据不迁移且拒绝覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-transfer-'));
  try {
    const tools = join(root, 'tools'); await mkdir(tools);
    // macOS 没有 flock；此测试只替代互斥包装，不替代被测 tar、shell、文件传输。
    await writeFile(join(tools, 'flock'), '#!/bin/sh\nshift 4\nexec /bin/sh -c "$1"\n', { mode: 0o755 });
    const source = join(root, 'source'); const destination = join(root, 'destination');
    await mkdir(source); await mkdir(destination); await fixture(source);
    const bundle = join(root, 'bundle');
    const exported = await exportOfflineBundle(transport(source, tools), bundle, DEFAULT_NODE_VERSION);
    const paths = createRemotePaths(destination);
    // 错版本在暂存阶段失败，不得发布任何运行时。
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ ...exported, dshVersion: '0.2.1' }));
    await assert.rejects(importOfflineBundle(transport(destination, tools), bundle), /版本不符/);
    await assert.rejects(lstat(paths.nodeDir(DEFAULT_NODE_VERSION)), /ENOENT/);
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify(exported));
    // 第二个 mv 失败应回滚第一个，随后可以正常重试。
    await writeFile(join(tools, 'mv'), '#!/bin/sh\ncase "$1" in */node_modules) exit 42;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
    await assert.rejects(importOfflineBundle(transport(destination, tools), bundle));
    await assert.rejects(lstat(paths.nodeDir(DEFAULT_NODE_VERSION)), /ENOENT/);
    await rm(join(tools, 'mv'));
    const imported = await importOfflineBundle(transport(destination, tools), bundle);
    assert.deepEqual(imported, exported);
    assert.ok((await lstat(paths.nodeBin(DEFAULT_NODE_VERSION))).isFile());
    await assert.rejects(readFile(paths.credentialsFile), /ENOENT/);
    await assert.rejects(importOfflineBundle(transport(destination, tools), bundle), /拒绝覆盖已有安装/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
