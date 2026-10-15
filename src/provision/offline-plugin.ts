/**
 * @file 本机离线插件安装器
 * @description 仅使用 Node 文件 API 安装自包含插件，不调用包管理器；保留 profile、patch 与宿主 peers。
 *              宿主必须停止。只支持首次安装，拒绝覆盖已有插件，避免写穿 pnpm 链接。
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** 离线插件文件清单。 */
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

/** 安装器需要合并的最小 profile 结构；其余 JSON 字段保持原样。 */
interface ProfileManifest {
  /** 既有依赖，不允许用非字符串值掩盖安装冲突。 */
  dependencies?: Record<string, string>;
  /** DSH profile 配置 */
  dsh: {
    /** 当前 profile 的插件登记 */
    profile: {
      /** 有序 bundle 包名列表 */
      bundles: string[];
    };
  };
}

/**
 * 收窄 JSON 对象，排除 null 和数组后才允许读取未知字段。
 * @param value - 不可信解析值
 * @returns 是否为记录对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验插件清单，摘要的每个值都必须是明确的 SHA-256。
 * @param value - 不可信清单 JSON
 * @param path - 用于错误定位的清单路径
 * @returns 已验证的插件清单
 * @throws Error 清单字段无效
 */
function parsePluginManifest(value: unknown, path: string): OfflinePluginManifest {
  if (!isRecord(value) || value.format !== 1 || value.name !== 'dsh-remote-explorer'
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version)
    || !isRecord(value.files)
    || !Object.values(value.files).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error(`离线插件清单格式无效：${path}`);
  }
  // Record 值已经逐项检查；只复制校验后的字段，不携带未知顶层配置。
  const files: Record<string, string> = {};
  for (const [file, hash] of Object.entries(value.files)) {
    if (typeof hash === 'string') files[file] = hash;
  }
  return { format: 1, name: value.name, version: value.version, files };
}

/**
 * 验证专用包元数据，不把 JSON.parse 的隐式 any 传播到安装流程。
 * @param value - package.json 解析值
 * @param manifest - 已验证的分发清单
 * @param path - 元数据路径
 * @returns 无返回值；不满足自包含约束时抛错
 * @throws Error 包含安装依赖、脚本或错误的 DSH 入口
 */
function assertSelfContainedPackage(value: unknown, manifest: OfflinePluginManifest, path: string): void {
  if (!isRecord(value) || value.name !== manifest.name || value.version !== manifest.version
    || value.type !== 'module' || value.main !== 'lib/index.js'
    || (value.dependencies !== undefined && (!isRecord(value.dependencies) || Object.keys(value.dependencies).length > 0))
    || (value.scripts !== undefined && (!isRecord(value.scripts) || Object.keys(value.scripts).length > 0))
    || !isRecord(value.dsh) || !isRecord(value.dsh.bundle)
    || typeof value.dsh.bundle.patch !== 'string' || value.dsh.bundle.patch.length === 0) {
    throw new Error(`需要自包含的离线插件专用包，不能使用原始源码或 npm 包：${path}`);
  }
}

/**
 * 收窄需要合并的 profile，未知字段不删除，损坏的结构不做隐式修复。
 * @param value - profile package.json 解析值
 * @param path - profile manifest 路径
 * @returns 无返回值；成功后收窄为可合并的 profile
 * @throws Error profile 未初始化或依赖结构不合法
 */
function assertProfileManifest(value: unknown, path: string): asserts value is ProfileManifest {
  if (!isRecord(value) || !isRecord(value.dsh) || !isRecord(value.dsh.profile)
    || !Array.isArray(value.dsh.profile.bundles)
    || !value.dsh.profile.bundles.every((bundle: unknown) => typeof bundle === 'string')
    || (value.dependencies !== undefined && (!isRecord(value.dependencies)
      || !Object.values(value.dependencies).every(dependency => typeof dependency === 'string')))) {
    throw new Error(`目标不是已初始化的 DSH profile：${path}；请先启动一次对应的 web/desktop 宿主`);
  }
}

/**
 * 枚举普通文件，拒绝链接与特殊文件，不跟随 pnpm store 或外部路径。
 * @param directory - 根目录
 * @param prefix - 递归相对路径
 * @returns POSIX 相对文件路径
 * @throws Error 发现链接、特殊文件或目录不可读
 */
async function listPluginFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listPluginFiles(directory, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`离线插件不接受链接或特殊文件：${join(directory, relative)}`);
    }
  }
  return files.sort();
}

/**
 * 生成纯文件摘要，不把宿主目录或用户配置加入分发包。
 * @param directory - 插件包目录
 * @returns 文件摘要表
 * @throws Error 包含非法文件或无法读取
 */
export async function hashPluginFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await listPluginFiles(directory)) {
    files[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
  }
  return files;
}

/**
 * 断言已存在的路径段都不是链接，避免 mkdir/copy 写穿共享 store。
 * @param path - 本地绝对路径
 * @returns 无返回值；发现非法目录则抛错
 * @throws Error 任一路径段为链接或非目录
 */
async function assertPlainDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await assertPlainDirectory(parent);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`目标必须是普通目录：${path}`);
    }
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
}

/**
 * 复制已验证文件集，目标不可预先存在，不用 cp 跟随符号链接。
 * @param source - 可信包目录
 * @param target - 全新目标目录
 * @param files - 已验证的文件列表
 * @returns 文件全部复制完成
 * @throws Error 目标存在、目录不可写或复制失败
 */
async function copyPlugin(source: string, target: string, files: string[]): Promise<void> {
  await mkdir(target);
  for (const file of files) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(source, file), join(target, file), constants.COPYFILE_EXCL);
  }
}

/**
 * 严格本地安装，不联网、不调用 pnpm、不改宿主文件；现有 lockfile 保持不变。
 * @param bundleDirectory - 含 package/ 和 manifest.json 的可信目录
 * @param profileDirectory - 已初始化且已停止的 DSH profile 目录
 * @returns 新增插件路径
 * @throws Error 清单不符、已安装、目标路径异常或 profile 格式不支持
 */
export async function installOfflinePlugin(bundleDirectory: string, profileDirectory: string): Promise<string> {
  // 1. 用户明确选择的 profile 先取真实路径，兼容 macOS /var → /private/var。
  const source = await realpath(join(bundleDirectory, 'package'));
  const profile = await realpath(resolve(profileDirectory));
  await assertPlainDirectory(profile);
  const bundleManifestPath = join(bundleDirectory, 'manifest.json');
  const manifestValue: unknown = JSON.parse(await readFile(bundleManifestPath, 'utf8'));
  const manifest = parsePluginManifest(manifestValue, bundleManifestPath);
  const hashes = await hashPluginFiles(source);
  if (JSON.stringify(Object.entries(hashes).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) {
    throw new Error(`离线插件文件列表或 SHA-256 校验不符：${source}`);
  }
  const packagePath = join(source, 'package.json');
  const packageValue: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
  assertSelfContainedPackage(packageValue, manifest, packagePath);

  // 2. 独占 profile 安装锁；所有待发布与待清理路径均在其下、由本次 UUID 生成。
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
  let isPublished = false;
  let isCommitted = false;
  try {
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error(`profile package.json 必须是普通文件：${manifestPath}`);
    }
    const before = await readFile(manifestPath, 'utf8');
    const current: unknown = JSON.parse(before);
    assertProfileManifest(current, manifestPath);
    if (current.dependencies?.[manifest.name] || current.dsh.profile.bundles.includes(manifest.name)) {
      throw new Error(`此 profile 已登记插件：${profile}；当前离线安装器只支持首次安装，请勿覆盖现有版本`);
    }
    try {
      await lstat(target);
      throw new Error(`拒绝覆盖已有插件目录或链接：${target}`);
    } catch (error: unknown) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
    await assertPlainDirectory(nodeModules);
    await assertPlainDirectory(sources);
    await mkdir(nodeModules, { recursive: true });
    await mkdir(sources, { recursive: true });
    const files = Object.keys(hashes);
    await copyPlugin(source, stableSource, files);
    await copyPlugin(stableSource, staging, files);

    // 3. 复验实际复制内容后再发布；用户配置有并发写入时立即失败。
    if (JSON.stringify(await hashPluginFiles(staging)) !== JSON.stringify(hashes)) {
      throw new Error(`复制后的离线插件摘要不符：${staging}`);
    }
    current.dependencies = { ...current.dependencies, [manifest.name]: `file:./offline-packages/${sourceName}` };
    current.dsh.profile.bundles.push(manifest.name);
    await writeFile(temporaryManifest, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (await readFile(manifestPath, 'utf8') !== before) {
      throw new Error(`安装期间 profile 已被其他进程修改：${manifestPath}；请停止宿主后重试`);
    }
    await writeFile(join(profile, `package.json.offline-backup-${id}`), before, { flag: 'wx', mode: 0o600 });
    await rename(staging, target);
    isPublished = true;
    await rename(temporaryManifest, manifestPath);
    isCommitted = true;
    return target;
  } finally {
    // 仅清理程序生成的唯一目录，绝不递归删除已有用户包。
    await rm(temporaryManifest, { force: true });
    await rm(staging, { recursive: true, force: true });
    if (!isCommitted) {
      if (isPublished) await rm(target, { recursive: true, force: true });
      await rm(stableSource, { recursive: true, force: true });
    }
    await rm(lock, { recursive: true, force: true });
  }
}
