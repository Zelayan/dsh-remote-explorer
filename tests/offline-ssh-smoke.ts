/**
 * @file 严格离线 doctor 的真实 SSH 冒烟
 * @description 在回环地址启动 ssh2 测试服务器，执行真实远端 shell 探针；HOME 隔离到临时目录，绝不连接生产主机。
 */

import ssh2 from 'ssh2';
const { Server } = ssh2;
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runDoctor } from '../src/cli/commands/doctor.ts';
import { DEFAULT_NODE_VERSION } from '../src/provision/node-installer.ts';
import { createRemotePaths } from '../src/provision/remote-paths.ts';

/** 在隔离 HOME 下执行 doctor，验证 SSH 探测并跳过所有网络测速。 */
async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'remote-ssh-offline-'));
  const paths = createRemotePaths(home);
  // 使用 ssh2 支持的传统 RSA PEM 作为回环测试主机密钥。
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set<import('ssh2').Connection>();
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('error', () => { /* 测试退出时通道可能已关闭，不向生产服务传播。 */ });
    client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.method === 'password' && context.password === 'offline-test-only') context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const child = spawn('/bin/sh', ['-c', info.command], { env: { ...process.env, HOME: home } });
        child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false });
        child.on('error', () => { stream.exit(1); stream.end(); });
        child.on('close', code => { stream.exit(code ?? 1); stream.end(); });
        stream.on('close', () => { if (child.exitCode === null) child.kill(); });
      });
      session.on('sftp', acceptSftp => { acceptSftp(); });
    }));
  });
  const previous = process.env.DSH_REMOTE_OFFLINE;
  try {
    await mkdir(paths.nodeBinDir(DEFAULT_NODE_VERSION), { recursive: true });
    await writeFile(paths.nodeBin(DEFAULT_NODE_VERSION), `#!/bin/sh\nif [ "$1" = "-v" ]; then echo ${DEFAULT_NODE_VERSION}; fi\nexit 0\n`, { mode: 0o755 });
    process.env.DSH_REMOTE_OFFLINE = '1';
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(await runDoctor({ alias: `youruser@127.0.0.1:${address.port}`, password: 'offline-test-only', refreshMirrors: false }), 0);
  } finally {
    if (previous === undefined) delete process.env.DSH_REMOTE_OFFLINE;
    else process.env.DSH_REMOTE_OFFLINE = previous;
    for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
