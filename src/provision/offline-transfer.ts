/**
 * @file 离线运行包传输
 * @description 从同平台联网准备主机导出纯运行时，在隔离主机的全新安装目录导入；不迁移凭据与会话。
 *              不覆盖已有安装，防止破坏活进程；导入前先验证摘要、平台、归档路径和链接。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseSemver } from './dsh-installer.js';
import { probeRemote } from './probe.js';
import { createRemotePaths } from './remote-paths.js';
import { inspectOfflineRuntime } from './offline-runtime.js';
import { sha256File, verifyOfflineBundle, type OfflineManifest } from './offline-bundle.js';
import { lockInstallCommand } from './install-lock.js';
import { quote } from '../util/shell-quote.js';
import type { RemoteTransport } from '../transport/types.js';

/** 归档传输超时，覆盖慢速内网 */
const TRANSFER_TIMEOUT_MS = 900_000;
/** 当前传输接口整包读回，超过 1 GiB 时明确拒绝而不是耗尽内存 */
const MAX_ARCHIVE_BYTES = 1024 ** 3;

/**
 * 从已经完成 provision 的准备机导出；输出目录必须不存在，避免覆盖用户数据。
 * @param transport - 准备机连接
 * @param directory - 本机输出目录
 * @param nodeVersion - 需要携带的 Node 精确版本
 * @returns 已验证的清单
 */
export async function exportOfflineBundle(transport: RemoteTransport, directory: string, nodeVersion: string): Promise<OfflineManifest> {
  const probe = await probeRemote(transport, undefined, true);
  const paths = createRemotePaths(probe.homeDir);
  const runtime = await inspectOfflineRuntime({ transport, paths }, { nodeVersion });
  if (probe.platform.arch === 'armv7l') throw new Error('离线包暂只支持 x64 / arm64');
  await mkdir(directory);
  const temporary = paths.tmpDir(process.pid, `offline-${randomUUID()}`);
  const archive = `${temporary}/runtime.tar.gz`;
  await transport.exec(`mkdir -p ${quote(temporary)}`);
  try {
    // 白名单而非排除列表：不会顺手导出 .credentials.yaml、profiles、sessions 或 skills。
    await transport.exec(lockInstallCommand(paths, [
      'set -eu',
      `cd ${quote(paths.base)}`,
      `${quote(paths.dshBin)} --version > ${quote(`${temporary}/dsh-version`)}`,
      `COPYFILE_DISABLE=1 tar -czf ${quote(archive)} ${quote(`node/${nodeVersion}`)} node_modules package.json`,
    ].join('\n')), { timeoutMs: TRANSFER_TIMEOUT_MS, pathPrefix: runtime.node.binDir, env: { DSH_HOME: paths.base } });
    const snapshotVersion = (await transport.exec(`cat ${quote(`${temporary}/dsh-version`)}`)).stdout.trim();
    if (!parseSemver(snapshotVersion)) throw new Error('导出快照的 DSH 版本无效');
    const size = await transport.exec(`wc -c < ${quote(archive)}`);
    const bytes = Number(size.stdout.trim());
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARCHIVE_BYTES) {
      throw new Error(`离线归档大小 ${bytes} 不受支持，当前上限为 1 GiB`);
    }
    const localArchive = join(directory, 'runtime.tar.gz');
    await writeFile(localArchive, await transport.readRemoteFile(archive, { timeoutMs: TRANSFER_TIMEOUT_MS }));
    const manifest: OfflineManifest = {
      format: 1, os: probe.platform.os, arch: probe.platform.arch,
      nodeVersion, dshVersion: snapshotVersion, sha256: await sha256File(localArchive),
    };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return await verifyOfflineBundle(directory);
  } finally {
    // temporary 来自已验证家目录与程序生成 UUID，不接受外部删除路径。
    await transport.exec(`rm -rf ${quote(temporary)}`, { allowNonZeroExit: true });
  }
}

/**
 * 导入到没有运行时的主机；已存在的安装一律拒绝，不做隐式覆盖和升级。
 * @param transport - 隔离主机连接
 * @param directory - 本地已复制的离线包目录
 * @returns 导入包清单
 * @throws Error 平台不匹配、包不安全、已有安装或运行时校验失败
 */
export async function importOfflineBundle(transport: RemoteTransport, directory: string): Promise<OfflineManifest> {
  const manifest = await verifyOfflineBundle(directory);
  const { platform } = transport;
  if (platform.os !== manifest.os || platform.arch !== manifest.arch) {
    throw new Error(`离线包平台 ${manifest.os}/${manifest.arch} 与主机 ${transport.hostAlias} 的 ${platform.os}/${platform.arch} 不符`);
  }
  const probe = await probeRemote(transport, undefined, true);
  const paths = createRemotePaths(probe.homeDir);
  const temporary = paths.tmpDir(process.pid, `offline-${randomUUID()}`);
  await transport.exec(`mkdir -p ${quote(temporary)}`);
  try {
    const remoteArchive = `${temporary}/runtime.tar.gz`;
    await transport.uploadFile(join(directory, 'runtime.tar.gz'), remoteArchive);
    // 本地与远端再比一次，防止传输损坏后交给 tar；摘要可用任一平台自带工具。
    const checksum = await transport.exec(
      `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quote(remoteArchive)}; else shasum -a 256 ${quote(remoteArchive)}; fi`,
    );
    if (checksum.stdout.trim().split(/\s+/)[0] !== manifest.sha256) throw new Error('远端离线包 SHA-256 校验失败');
    const staged = createRemotePaths(`${temporary}/stage-home`);
    await transport.exec(`mkdir -p ${quote(staged.base)} && tar -xzf ${quote(remoteArchive)} -C ${quote(staged.base)}`, { timeoutMs: TRANSFER_TIMEOUT_MS });
    // 在发布到安装目录之前验证二进制及系统库兼容性，失败时只清理临时目录。
    await inspectOfflineRuntime({ transport, paths: staged }, { nodeVersion: manifest.nodeVersion, dshVersion: manifest.dshVersion });
    await transport.exec(lockInstallCommand(paths, [
      'set -eu',
      `for p in ${quote(paths.dshBin)} ${quote(`${paths.base}/node_modules`)} ${quote(`${paths.base}/package.json`)} ${quote(paths.nodeDir(manifest.nodeVersion))}; do`,
      '  if [ -e "$p" ] || [ -L "$p" ]; then printf "拒绝覆盖已有安装：%s\\n" "$p" >&2; exit 1; fi',
      'done',
      'node_moved=0; modules_moved=0; package_moved=0',
      `rollback() { code=$?; trap - EXIT HUP INT TERM; if [ "$code" -ne 0 ]; then`,
      `  if [ "$package_moved" -eq 1 ]; then mv ${quote(`${paths.base}/package.json`)} ${quote(`${staged.base}/package.json`)}; fi`,
      `  if [ "$modules_moved" -eq 1 ]; then mv ${quote(`${paths.base}/node_modules`)} ${quote(`${staged.base}/node_modules`)}; fi`,
      `  if [ "$node_moved" -eq 1 ]; then mv ${quote(paths.nodeDir(manifest.nodeVersion))} ${quote(staged.nodeDir(manifest.nodeVersion))}; fi`,
      'fi; exit "$code"; }',
      'trap rollback EXIT; trap "exit 130" HUP INT TERM',
      `mkdir -p ${quote(`${paths.base}/node`)}`,
      `mv ${quote(staged.nodeDir(manifest.nodeVersion))} ${quote(paths.nodeDir(manifest.nodeVersion))}; node_moved=1`,
      `mv ${quote(`${staged.base}/node_modules`)} ${quote(`${paths.base}/node_modules`)}; modules_moved=1`,
      `mv ${quote(`${staged.base}/package.json`)} ${quote(`${paths.base}/package.json`)}; package_moved=1`,
      `test "$(${quote(paths.dshBin)} --version)" = ${quote(manifest.dshVersion)}`,
      'trap - EXIT HUP INT TERM',
    ].join('\n')), { timeoutMs: TRANSFER_TIMEOUT_MS, pathPrefix: paths.nodeBinDir(manifest.nodeVersion), env: { DSH_HOME: paths.base } });
    return manifest;
  } finally {
    await transport.exec(`rm -rf ${quote(temporary)}`, { allowNonZeroExit: true });
  }
}
