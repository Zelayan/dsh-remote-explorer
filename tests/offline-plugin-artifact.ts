/**
 * @file 离线插件分发包冒烟
 * @description 使用真实 install.cjs 及完整 package/ 安装到临时 profile；预加载器禁止网络和子进程。
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

/** 执行真实分发安装器，不初始化或读取用户 DSH_HOME。 */
async function main(): Promise<void> {
  const bundle = resolve(process.argv[2] ?? 'dist/dsh-remote-explorer-0.8.4-offline-final');
  const root = await mkdtemp(join(tmpdir(), 'offline-artifact-'));
  try {
    const profile = join(root, 'desktop'); await mkdir(profile);
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const guard = join(root, 'deny-network.cjs');
    await writeFile(guard, `const deny = () => { throw new Error('离线安装器禁止网络或子进程'); };
for (const [name, keys] of Object.entries({ 'node:http': ['request', 'get'], 'node:https': ['request', 'get'], 'node:net': ['connect', 'createConnection'], 'node:tls': ['connect'], 'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] })) {
  const mod = require(name); for (const key of keys) mod[key] = deny;
}
globalThis.fetch = deny;
`);
    const result = spawnSync(process.execPath, ['--require', guard, join(bundle, 'install.cjs'), '--bundle', bundle, '--profile', profile, '--host-stopped'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, DSH_HOME: root },
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    const installed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(installed.dsh.profile.bundles, ['dsh-remote-explorer']);
    assert.ok((await readFile(join(profile, 'node_modules/dsh-remote-explorer/lib/index.js'))).length > 1000);
    process.stdout.write('真实离线插件包安装成功；网络与子进程均被禁止，原有用户 profile 未接触。\n');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
