/**
 * @file 离线包命令入口
 * @description 复用 SSH 密码与主机解析，实现准备机导出和隔离机导入；连接始终在 finally 中释放。
 */

import { SshTransport } from '../../transport/ssh-transport.js';
import { exportOfflineBundle, importOfflineBundle } from '../../provision/offline-transfer.js';
import { DEFAULT_NODE_VERSION } from '../../provision/node-installer.js';
import { prepareHostAuth } from '../host-auth.js';
import { println } from '../output.js';

/**
 * 执行离线资源导入导出，不启动服务，不修改已有安装。
 * @param options - 命令、主机及本地包目录
 * @returns 退出码
 */
export async function runOfflineTransfer(options: {
  /** 导出或导入 */
  command: 'offline-export' | 'offline-import';
  /** SSH 别名 */
  alias: string;
  /** 本地离线包目录 */
  directory: string;
  /** 导出的 Node 精确版本 */
  nodeVersion?: string;
  /** 私钥覆盖 */
  privateKey?: string;
  /** 仅内存中保存的密码 */
  password?: string;
}): Promise<number> {
  const { resolved, passwords } = prepareHostAuth(options.alias, options);
  const transport = new SshTransport(options.alias, resolved, {
    getPassword: (key, label, attempt) => passwords.get(key, label, attempt),
  });
  try {
    await transport.connect();
    const manifest = options.command === 'offline-export'
      ? await exportOfflineBundle(transport, options.directory, options.nodeVersion ?? DEFAULT_NODE_VERSION)
      : await importOfflineBundle(transport, options.directory);
    println(`离线包${options.command === 'offline-export' ? '导出' : '导入'}完成：${manifest.os}/${manifest.arch}，Node ${manifest.nodeVersion}，DSH ${manifest.dshVersion}`);
    println(`后续连接请使用 --offline --node-version ${manifest.nodeVersion} --dsh-version ${manifest.dshVersion}`);
    return 0;
  } finally {
    await transport.dispose();
    passwords.clear();
  }
}
