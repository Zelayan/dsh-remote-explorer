/**
 * @file 本机离线插件安装器
 * @description 仅使用 Node 文件 API 安装自包含插件，不调用包管理器；保留现有 profile、用户 patch 与所有宿主 peers。
 *              目标宿主必须停止。当前仅支持首次安装，拒绝覆盖现有插件，避免写穿 pnpm 链接。
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** 离线插件文件清单 */
export interface OfflinePluginManifest {
  /** 格式版本 */
  format: 1;
  /** 插件包名 */
  name: 'dsh-remote-explorer';
  /** 插件版本 */
  version: string;
  /** 每个普通文件的 SHA-256 */
  files: Record<string, string>;
}

/**
 * 枚举普通目录中的文件，拒绝链接与特殊文件，不跟随 pnpm store 或外部路径。
 * @param directory - 根目录
 * @param prefix - 递归相对路径
 * @returns POSIX 相对文件路径
 */
export async function listPluginFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listPluginFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`离线插件不接受链接或特殊文件：${relative}`);
  }
  return files.sort();
}

/**
 * 生成纯文件摘要；不把宿主目录或用户配置加入分发包。
 * @param directory - 插件包目录
 * @returns 文件摘要表
 */
export async function hashPluginFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await listPluginFiles(directory)) {
    files[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
  }
  return files;
}

/**
 * 断言目标已存在的路径段都不是链接，避免 mkdir/copy 写穿用户的共享 store。
 * @param path - 本地绝对路径
 * @throws Error 任一路径段为链接或非目录
 */
async function assertPlainDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await assertPlainDirectory(parent);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`目标必须是普通目录：${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * 复制已验证文件集，目标不可预先存在；不用 cp 跟随符号链接。
 * @param source - 可信包目录
 * @param target - 全新目标目录
 * @param files - 已验证的文件列表
 */
async function copyPlugin(source: string, target: string, files: string[]): Promise<void> {
  await mkdir(target);
  for (const file of files) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(source, file), join(target, file), constants.COPYFILE_EXCL);
  }
}

/**
 * 严格本地安装；不联网、不调用 pnpm、不改宿主文件。现有 lockfile 保持不变。
 * @param bundleDirectory - 含 package/ 和 manifest.json 的可信离线目录
 * @param profileDirectory - 已初始化且已停止的 DSH profile 目录
 * @returns 新增插件路径
 * @throws Error 清单不符、已安装、目标路径异常或 profile 格式不支持
 */
export async function installOfflinePlugin(bundleDirectory: string, profileDirectory: string): Promise<string> {
  const source = await realpath(join(bundleDirectory, 'package'));
  // 用户明确选择的 profile 先取真实路径，兼容 macOS /var → /private/var；其下仍拒绝链接。
  const profile = await realpath(resolve(profileDirectory));
  await assertPlainDirectory(profile);
  const manifest = JSON.parse(await readFile(join(bundleDirectory, 'manifest.json'), 'utf8')) as OfflinePluginManifest;
  if (manifest.format !== 1 || manifest.name !== 'dsh-remote-explorer'
    || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)
    || !manifest.files || typeof manifest.files !== 'object') throw new Error('离线插件清单格式无效');
  const hashes = await hashPluginFiles(source);
  if (JSON.stringify(Object.entries(hashes).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) {
    throw new Error('离线插件文件列表或 SHA-256 校验不符');
  }
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== manifest.name || pkg.version !== manifest.version || pkg.type !== 'module'
    || pkg.main !== 'lib/index.js' || Object.keys(pkg.dependencies ?? {}).length > 0
    || Object.keys(pkg.scripts ?? {}).length > 0 || !pkg.dsh?.bundle?.patch) {
    throw new Error('需要自包含的离线插件专用包，不能使用原始源码或 npm 包');
  }
  const manifestPath = join(profile, 'package.json');
  const lock = join(profile, '.remote-offline-install.lock');
  await mkdir(lock);
  const id = randomUUID();
  const nodeModules = join(profile, 'node_modules');
  const sources = join(profile, 'offline-packages');
  const target = join(nodeModules, manifest.name);
  const sourceName = `${manifest.name}-${manifest.version}-${id}`;
  const stableSource = join(sources, sourceName);
  const staging = join(nodeModules, `.remote-offline-${id}`);
  const temporaryManifest = join(profile, `.package-${id}.json`);
  let published = false;
  let committed = false;
  try {
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('profile package.json 必须是普通文件');
    const before = await readFile(manifestPath, 'utf8');
    const current = JSON.parse(before);
    if (!Array.isArray(current.dsh?.profile?.bundles) || !current.dsh.profile.bundles.every((value: unknown) => typeof value === 'string')) {
      throw new Error('目标不是已初始化的 DSH profile；请先启动一次对应的 web/desktop 宿主');
    }
    if (current.dependencies?.[manifest.name] || current.dsh.profile.bundles.includes(manifest.name)) {
      throw new Error('此 profile 已登记插件；当前离线安装器只支持首次安装，请勿覆盖现有版本');
    }
    try {
      await lstat(target);
      throw new Error(`拒绝覆盖已有插件目录或链接：${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await assertPlainDirectory(nodeModules);
    await assertPlainDirectory(sources);
    await mkdir(nodeModules, { recursive: true });
    await mkdir(sources, { recursive: true });
    const files = Object.keys(hashes);
    await copyPlugin(source, stableSource, files);
    await copyPlugin(stableSource, staging, files);
    // 再验一次实际复制结果，防止校验后源目录被更换。
    if (JSON.stringify(await hashPluginFiles(staging)) !== JSON.stringify(hashes)) throw new Error('复制后的离线插件摘要不符');
    current.dependencies = { ...current.dependencies, [manifest.name]: `file:./offline-packages/${sourceName}` };
    current.dsh.profile.bundles.push(manifest.name);
    await writeFile(temporaryManifest, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (await readFile(manifestPath, 'utf8') !== before) throw new Error('安装期间 profile 已被其他进程修改，请停止宿主后重试');
    await writeFile(join(profile, `package.json.offline-backup-${id}`), before, { flag: 'wx', mode: 0o600 });
    await rename(staging, target);
    published = true;
    await rename(temporaryManifest, manifestPath);
    committed = true;
    return target;
  } finally {
    // 仅清理程序生成的唯一目录，绝不递归删除已有用户包。
    await rm(temporaryManifest, { force: true });
    await rm(staging, { recursive: true, force: true });
    if (!committed) {
      if (published) await rm(target, { recursive: true, force: true });
      await rm(stableSource, { recursive: true, force: true });
    }
    await rm(lock, { recursive: true, force: true });
  }
}
