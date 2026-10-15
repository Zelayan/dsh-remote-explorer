/**
 * @file 离线运行时检查
 * @description 能力层的严格离线分支：只执行本机资源检查，绝不进入镜像、registry 或安装器。
 */

import { parseSemver } from './dsh-installer.js';
import { assertNodeStable, checkNodeStability } from './probe.js';
import { parsePnpmPackageJson, pnpmMajorAccepted } from './pnpm-installer.js';
import { quote } from '../util/shell-quote.js';
import type { RemoteContext } from './remote-context.js';
import type { NodeInstallResult } from './node-installer.js';
import type { DshInstallResult } from './dsh-installer.js';

/** 离线模式下经过实际执行验证的运行时 */
export interface OfflineRuntime {
  /** Node 安装结果 */
  node: NodeInstallResult;
  /** DSH 安装结果 */
  dsh: DshInstallResult;
}

/**
 * 检查已有安装；任何缺失均立即报错，不尝试修复或联网。
 * @param ctx - 已连接的远端上下文
 * @param options - 明确版本与稳定性检查选项
 * @returns 可复用的运行时
 * @throws Error 资源缺失、损坏或版本不符
 */
export async function inspectOfflineRuntime(ctx: RemoteContext, options: {
  /** 必须使用的 Node 版本 */
  nodeVersion: string;
  /** 可选的精确 DSH 版本，不接受 dist-tag */
  dshVersion?: string;
  /** 跳过稳定性检查，仅测试和只读检查使用 */
  skipStabilityCheck?: boolean;
  /** 取消信号 */
  signal?: AbortSignal;
}): Promise<OfflineRuntime> {
  const { paths, transport } = ctx;
  const { nodeVersion, signal } = options;
  signal?.throwIfAborted();
  if (!/^v\d+\.\d+\.\d+$/.test(nodeVersion)) {
    throw new Error(`主机 ${transport.hostAlias} 的离线 Node 版本必须为 vX.Y.Z，实际为 ${nodeVersion}`);
  }
  if (options.dshVersion !== undefined && !parseSemver(options.dshVersion)) {
    throw new Error(`离线模式不解析 DSH 标签，请指定精确版本：${options.dshVersion}`);
  }
  const nodeBin = paths.nodeBin(nodeVersion);
  const binDir = paths.nodeBinDir(nodeVersion);
  const execOptions = { allowNonZeroExit: true, ...(signal ? { signal } : {}) };
  const nodeCheck = await transport.exec(`${quote(nodeBin)} -v`, execOptions);
  if (nodeCheck.exitCode !== 0 || nodeCheck.stdout.trim() !== nodeVersion) {
    throw new Error(`主机 ${transport.hostAlias} 缺少可用 Node ${nodeVersion}：${nodeBin}。请先 offline-import 导入离线包`);
  }
  const dshCheck = await transport.exec(`${quote(paths.dshBin)} --version`, {
    ...execOptions, pathPrefix: binDir, env: { DSH_HOME: paths.base },
  });
  const version = dshCheck.stdout.trim();
  if (dshCheck.exitCode !== 0 || !parseSemver(version)
    || (options.dshVersion !== undefined && version !== options.dshVersion)) {
    throw new Error(`主机 ${transport.hostAlias} 的 DSH 缺失、损坏或版本不符：${paths.dshBin}，期望 ${options.dshVersion ?? '有效版本'}，实际 ${version || '(无输出)'}。请先 offline-import`);
  }
  const pnpmCheck = await transport.exec(
    `cat ${quote(`${paths.nodeDir(nodeVersion)}/lib/node_modules/pnpm/package.json`)}`, execOptions,
  );
  const pnpmVersion = parsePnpmPackageJson(pnpmCheck.stdout);
  if (pnpmCheck.exitCode !== 0 || pnpmVersion === undefined || !pnpmMajorAccepted(pnpmVersion)) {
    throw new Error(`主机 ${transport.hostAlias} 的离线包缺少兼容 pnpm：${binDir}，请重新制作完整运行包`);
  }
  if (!options.skipStabilityCheck) {
    assertNodeStable(await checkNodeStability(transport, nodeBin, undefined, signal), transport.hostAlias, nodeVersion);
  }
  return {
    node: { version: nodeVersion, nodeBin, binDir, reused: true },
    dsh: { version, dshBin: paths.dshBin, installDir: paths.dshDir, reused: true },
  };
}

/**
 * 收口 CLI 与插件共用的离线开关；环境变量适用于完全隔离的整个宿主进程。
 * @param explicit - 单次连接的显式开关
 * @returns 是否禁止引导联网
 */
export function isOfflineMode(explicit?: boolean): boolean {
  return explicit === true || process.env.DSH_REMOTE_OFFLINE === '1';
}
