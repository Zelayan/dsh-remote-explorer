/**
 * @file 离线包清单与归档校验
 * @description 只接受运行时白名单；导入前检查摘要、资源上限、每个归档条目与链接边界。
 */

import * as tar from 'tar';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix, join } from 'node:path';
import { parseSemver } from './dsh-installer.js';

/** 当前传输接口整包读取，压缩包最多允许 1 GiB；导出与导入共用这一限制。 */
export const MAX_OFFLINE_ARCHIVE_BYTES = 1024 ** 3;
/** 防止压缩炸弹占满目标磁盘，展开总量最多允许 8 GiB。 */
const MAX_EXPANDED_BYTES = 8 * 1024 ** 3;
/** 限制归档扫描的内存与路径检查开销。 */
const MAX_ARCHIVE_ENTRIES = 200_000;

/** 离线包版本化清单；摘要用于传输完整性，不替代来源认证。 */
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
 * @returns 只包含已验证字段的清单
 * @throws Error 字段不合法或格式版本不支持
 */
export function parseOfflineManifest(value: unknown): OfflineManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('离线包清单必须是对象');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== 1
    || (manifest.os !== 'linux' && manifest.os !== 'darwin')
    || (manifest.arch !== 'x64' && manifest.arch !== 'arm64')
    || typeof manifest.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion)
    || typeof manifest.dshVersion !== 'string' || !parseSemver(manifest.dshVersion)
    || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('离线包清单字段无效：需要格式 1、linux/darwin、x64/arm64、精确版本与 SHA-256');
  }
  return {
    format: 1,
    os: manifest.os,
    arch: manifest.arch,
    nodeVersion: manifest.nodeVersion,
    dshVersion: manifest.dshVersion,
    sha256: manifest.sha256,
  };
}

/**
 * 判断归档路径是否属于运行时白名单，禁止用户配置和运行状态混入。
 * @param path - POSIX 归档路径
 * @returns 是否允许
 */
function isRuntimePath(path: string): boolean {
  return path === 'node' || path.startsWith('node/')
    || path === 'node_modules' || path.startsWith('node_modules/')
    || path === 'package.json' || path === 'package-lock.json';
}

/**
 * 校验归档成员及符号链接；硬链接与设备文件拒绝，避免远端 tar 行为差异。
 * @param path - 条目路径
 * @param type - tar 条目类型
 * @param linkpath - 链接目标
 * @returns 无返回值；非法成员会抛错
 * @throws Error 路径越界、非白名单或不支持的成员类型
 */
export function validateRuntimeEntry(path: string, type: string, linkpath = ''): void {
  const clean = path.replace(/\/$/, '');
  if (!clean || clean.includes('\\') || /[:\x00-\x1f\x7f]/.test(clean) || posix.isAbsolute(clean)
    || clean.split('/').some(part => part === '..' || part === '.' || part === '')
    || !isRuntimePath(clean)) {
    throw new Error(`离线包包含非法路径：${path}`);
  }
  if (!['File', 'Directory', 'SymbolicLink'].includes(type)) {
    throw new Error(`离线包包含不支持的成员类型：${path} (${type})`);
  }
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
 * @throws Error 文件无法读取
 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * 验证离线包完整性及归档布局，必须在上传或解包前调用。
 * @param directory - 含 manifest.json 和 runtime.tar.gz 的本地目录
 * @returns 清单
 * @throws Error 摘要不符、缺资源或归档不安全
 */
export async function verifyOfflineBundle(directory: string): Promise<OfflineManifest> {
  const manifestValue: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const manifest = parseOfflineManifest(manifestValue);
  const archive = join(directory, 'runtime.tar.gz');
  const archiveInfo = await stat(archive);
  if (!archiveInfo.isFile() || archiveInfo.size > MAX_OFFLINE_ARCHIVE_BYTES) {
    throw new Error(`离线归档必须是普通文件且不超过 1 GiB：${archive}`);
  }
  if (await sha256File(archive) !== manifest.sha256) {
    throw new Error(`离线包 runtime.tar.gz 的 SHA-256 不符：${archive}`);
  }

  // 1. 流式扫描并在失败时立即中断，避免继续解压不可信大包。
  const seen = new Set<string>();
  const links = new Map<string, string>();
  let totalBytes = 0;
  let failure: Error | undefined;
  const input = createReadStream(archive);
  const parser = new tar.Parser({
    strict: true,
    onReadEntry: (entry): void => {
      try {
        validateRuntimeEntry(entry.path, entry.type, entry.linkpath);
        const clean = entry.path.replace(/\/$/, '');
        const nodeRoot = `node/${manifest.nodeVersion}`;
        if (clean.startsWith('node/') && clean !== nodeRoot && !clean.startsWith(`${nodeRoot}/`)) {
          throw new Error(`离线包包含清单以外的 Node 版本：${clean}`);
        }
        if (seen.has(clean)) {
          throw new Error(`离线包包含重复条目：${clean}`);
        }
        seen.add(clean);
        totalBytes += entry.size;
        if (totalBytes > MAX_EXPANDED_BYTES || seen.size > MAX_ARCHIVE_ENTRIES) {
          throw new Error(`离线包展开超过 8 GiB 或 ${MAX_ARCHIVE_ENTRIES} 个条目：${archive}`);
        }
        if (entry.type === 'SymbolicLink') {
          links.set(clean, entry.linkpath ?? '');
        }
        entry.resume();
      } catch (error: unknown) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        parser.abort(failure);
      }
    },
  });
  await new Promise<void>((resolve, reject) => {
    /** 成功和失败都解除管道、关闭文件句柄并成对移除监听器。 */
    const cleanup = (): void => {
      input.unpipe(parser);
      input.destroy();
      input.off('error', onError);
      parser.off('error', onError);
      parser.off('end', onEnd);
    };
    /** 归档完整结束后释放扫描资源。 */
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    /** 输入或解析失败都归一到同一个拒绝路径。 */
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    parser.once('end', onEnd);
    parser.once('error', onError);
    input.once('error', onError);
    input.pipe(parser);
  });
  if (failure) {
    throw failure;
  }

  // 2. 禁止先创建链接再经该链接写成员，即使单个条目属于白名单。
  for (const path of seen) {
    let ancestor = posix.dirname(path);
    while (ancestor !== '.') {
      if (links.has(ancestor)) {
        throw new Error(`离线包成员穿过符号链接：${path}`);
      }
      ancestor = posix.dirname(ancestor);
    }
  }
  for (const [path, target] of links) {
    // 先逐段检查，不能 normalize 后丢失 a/../ 中 a 实际是链接的信息。
    const segments = [...posix.dirname(path).split('/'), ...target.split('/')];
    const parts: string[] = [];
    for (const segment of segments) {
      if (segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
      if (links.has(parts.join('/'))) {
        throw new Error(`离线包不接受链式或循环符号链接：${path}`);
      }
    }
    if (!seen.has(parts.join('/'))) {
      throw new Error(`离线包链接目标缺失：${path}`);
    }
  }

  // 3. 至少具有运行 Node、辨识 DSH 和根安装所需的文件。
  const requiredFiles = [`node/${manifest.nodeVersion}/bin/node`, 'node_modules/@deepseek-ai/dsh/package.json', 'package.json'];
  for (const required of requiredFiles) {
    if (!seen.has(required)) {
      throw new Error(`离线包缺少必要资源：${required}`);
    }
  }
  return manifest;
}
