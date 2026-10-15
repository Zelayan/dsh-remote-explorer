/**
 * @file 离线插件本地安装命令
 * @description 可打包为单文件 CJS，运行时只用 Node，不启动 pnpm 或 DSH。
 */

import { parseArgs } from 'node:util';
import { installOfflinePlugin } from '../src/provision/offline-plugin.js';
import { println } from '../src/cli/output.js';

/** 解析参数并执行纯本地安装。 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    bundle: { type: 'string' },
    profile: { type: 'string' },
    'host-stopped': { type: 'boolean' },
  } });
  if (!values.bundle || !values.profile || !values['host-stopped']) {
    throw new Error('先完全退出目标 DSH，再运行 node install.cjs --bundle <离线包目录> --profile <已有profile目录> --host-stopped');
  }
  const installed = await installOfflinePlugin(values.bundle, values.profile);
  println(`离线插件已安装：${installed}`);
  println('请重启目标 DSH。未修改 pnpm 锁文件；以后执行包管理器操作可能重排安装，请保留 offline-packages 本地源。');
}
void main().catch(error => { println(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
