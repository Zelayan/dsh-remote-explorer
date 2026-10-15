/**
 * @file 离线包清单与归档校验
 * @description 只打包运行时白名单，不携带凭据、会话、用户配置；导入前检查每个归档条目与链接边界。
 */

import * as tar from 'tar';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix, join } from 'node:path';
import { parseSemver } from './dsh-installer.js';

/** 离线包版本化清单；摘要用于传输完整性，不替代来源认证 */
export interface OfflineManifest {
  /** 格式版本 */
  format: 1;
  /** 远端操作系统 */
  os: 'linux' | 'darwin';
  /** CPU 架构 */
  arch: 'x64' | 'arm64';
  /** Node 精确版本 */
  nodeVersion: string;
  /** DSH 精确版本 */
  dshVersion: string;
  /** 运行时归档 SHA-256 */
  sha256: string;
}

/**
 * 校验外部清单；不能信任类型断言或任意版本作为路径段。
 * @param value - JSON 解析结果
 * @returns 经过校验的清单
 * @throws Error 字段不合法或格式版本不支持
 */
export function parseOfflineManifest(value: unknown): OfflineManifest {
  if (value === null || typeof value !== 'object') throw new Error('离线包清单必须是对象');
  const m = value as Record<string, unknown>;
  if (m.format !== 1 || !['linux', 'darwin'].includes(String(m.os))
    || !['x64', 'arm64'].includes(String(m.arch))
    || typeof m.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(m.nodeVersion)
    || typeof m.dshVersion !== 'string' || !parseSemver(m.dshVersion)
    || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)) {
    throw new Error('离线包清单字段无效：需要格式 1、linux/darwin、x64/arm64、精确版本与 SHA-256');
  }
  return m as unknown as OfflineManifest;
}

/**
 * 判断归档路径是否属于运行时白名单；禁止用户配置和运行状态混入。
 * @param path - POSIX 归档路径
 * @returns 是否允许
 */
function isRuntimePath(path: string): boolean {
  return path === 'node' || path.startsWith('node/')
    || path === 'node_modules' || path.startsWith('node_modules/')
    || path === 'package.json' || path === 'package-lock.json';
}

/**
 * 校验归档成员及符号链接。硬链接与设备文件拒绝，避免远端 tar 行为差异。
 * @param path - 条目路径
 * @param type - tar 条目类型
 * @param linkpath - 链接目标
 * @throws Error 路径越界、非白名单或不支持的成员类型
 */
export function validateRuntimeEntry(path: string, type: string, linkpath = ''): void {
  const clean = path.replace(/\/$/, '');
  if (!clean || clean.includes('\\') || /[:\x00-\x1f\x7f]/.test(clean) || posix.isAbsolute(clean)
    || clean.split('/').some(part => part === '..' || part === '.' || part === '')
    || !isRuntimePath(clean)) throw new Error(`离线包包含非法路径：${path}`);
  if (!['File', 'Directory', 'SymbolicLink'].includes(type)) throw new Error(`离线包包含不支持的成员类型：${path} (${type})`);
  if (type === 'SymbolicLink') {
    const target = posix.normalize(posix.join(posix.dirname(clean), linkpath));
    if (!linkpath || posix.isAbsolute(linkpath) || linkpath.includes('\\') || !isRuntimePath(target)) {
      throw new Error(`离线包链接越界：${path}`);
    }
  }
}

/**
 * 流式计算归档摘要，避免把整个 DSH 安装读入内存。
 * @param file - 本地文件路径
 * @returns SHA-256
 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 验证离线包完整性及归档布局；必须在上传或解包前调用。
 * @param directory - 含 manifest.json 和 runtime.tar.gz 的本地目录
 * @returns 清单
 * @throws Error 摘要不符、缺资源或归档不安全
 */
export async function verifyOfflineBundle(directory: string): Promise<OfflineManifest> {
  const manifest = parseOfflineManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
  const archive = join(directory, 'runtime.tar.gz');
  const archiveInfo = await stat(archive);
  if (!archiveInfo.isFile() || archiveInfo.size > 1024 ** 3) throw new Error('离线归档必须是普通文件且不超过 1 GiB');
  if (await sha256File(archive) !== manifest.sha256) throw new Error('离线包 runtime.tar.gz 的 SHA-256 不符');
  const seen = new Set<string>();
  const links = new Map<string, string>();
  let totalBytes = 0;
  let failure: Error | undefined;
  const input = createReadStream(archive);
  const parser = new tar.Parser({ strict: true, onReadEntry: entry => {
    try {
      validateRuntimeEntry(entry.path, entry.type, entry.linkpath);
      const clean = entry.path.replace(/\/$/, '');
      const nodeRoot = `node/${manifest.nodeVersion}`;
      if (clean.startsWith('node/') && clean !== nodeRoot && !clean.startsWith(`${nodeRoot}/`)) {
        throw new Error(`离线包包含清单以外的 Node 版本：${clean}`);
      }
      if (seen.has(clean)) throw new Error(`离线包包含重复条目：${clean}`);
      seen.add(clean);
      totalBytes += entry.size;
      if (totalBytes > 8 * 1024 ** 3 || seen.size > 200_000) throw new Error('离线包展开超过 8 GiB 或 200000 个条目');
      if (entry.type === 'SymbolicLink') links.set(clean, entry.linkpath ?? '');
      entry.resume();
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
      parser.abort(failure);
    }
  } });
  await new Promise<void>((resolve, reject) => {
    parser.once('end', resolve);
    parser.on('error', (error: Error) => { input.destroy(); reject(error); });
    input.once('error', reject);
    input.pipe(parser);
  });
  if (failure) throw failure;
  // 禁止先创建链接再经该链接写成员，即使每个条目单独看都在白名单内。
  for (const path of seen) {
    let ancestor = posix.dirname(path);
    while (ancestor !== '.') {
      if (links.has(ancestor)) throw new Error(`离线包成员穿过符号链接：${path}`);
      ancestor = posix.dirname(ancestor);
    }
  }
  for (const [path, target] of links) {
    // 逐段解析前检查，不能先 normalize 再忽略 a/../ 中 a 实际为链接的情况。
    const segments = [...posix.dirname(path).split('/'), ...target.split('/')];
    const parts: string[] = [];
    for (const segment of segments) {
      if (segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
      const current = parts.join('/');
      if (links.has(current)) throw new Error(`离线包不接受链式或循环符号链接：${path}`);
    }
    if (!seen.has(parts.join('/'))) throw new Error(`离线包链接目标缺失：${path}`);
  }
  for (const required of [`node/${manifest.nodeVersion}/bin/node`, 'node_modules/@deepseek-ai/dsh/package.json', 'package.json']) {
    if (!seen.has(required)) throw new Error(`离线包缺少必要资源：${required}`);
  }
  return manifest;
}
