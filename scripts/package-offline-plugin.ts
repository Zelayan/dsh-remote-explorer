/**
 * @file 自包含离线插件分发
 * @description 联网构建时内联非宿主依赖，生成纯 JS 插件目录、完整性清单和零包管理器安装器。
 *              不捆绑 DSH 本体，目标仍需匹配宿主；输出目录隔离，拒绝覆盖用户已有产物。
 */

import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildPlugin } from './build-plugin.js';
import { hashPluginFiles } from '../src/provision/offline-plugin.js';
import { parseSemver } from '../src/provision/dsh-installer.js';
import { println } from '../src/cli/output.js';
import type { OfflinePluginManifest } from '../src/provision/offline-plugin.js';

/** 仓库根目录 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 构建并输出离线插件包，已有输出拒绝覆盖。
 * @returns 分发目录及安装器构建完成
 * @throws Error 参数、包元数据、输出位置不合法或构建失败
 */
async function main(): Promise<void> {
  // 1. 在 JSON 边界校验需要用于路径和清单的字段，不传播隐式 any。
  const packagePath = join(REPO_ROOT, 'package.json');
  const packageValue: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
  if (packageValue === null || typeof packageValue !== 'object' || Array.isArray(packageValue)) {
    throw new Error(`项目 package.json 必须是对象：${packagePath}`);
  }
  const pkg = packageValue as Record<string, unknown>;
  if (pkg.name !== 'dsh-remote-explorer' || typeof pkg.version !== 'string' || !parseSemver(pkg.version)) {
    throw new Error(`项目包名或精确版本无效：${packagePath}`);
  }
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const directory = values.output
    ? resolve(values.output)
    : join(REPO_ROOT, 'dist', `dsh-remote-explorer-${pkg.version}-offline-plugin`);
  if (!directory.startsWith(`${join(REPO_ROOT, 'dist')}${sep}`)) {
    throw new Error(`输出目录必须位于仓库 dist 内：${directory}`);
  }
  await mkdir(join(REPO_ROOT, 'dist'), { recursive: true });
  await mkdir(directory);

  // 2. 仅保留插件运行资源，独立 CLI 的 bin/src/tsx 不属于该分发。
  const source = join(directory, 'package');
  await mkdir(source);
  await buildPlugin({ offline: true, outputDirectory: join(source, 'lib') });
  for (const path of ['locale', 'icon.jpg', 'cordis.patch.yml', 'LICENSE']) {
    await cp(join(REPO_ROOT, path), join(source, path), { recursive: true, force: false, errorOnExist: true });
  }
  const { scripts, dependencies, devDependencies, bin, files, ...metadata } = pkg;
  await writeFile(join(source, 'package.json'), `${JSON.stringify({ ...metadata, dependencies: {} }, null, 2)}\n`);
  const manifest: OfflinePluginManifest = {
    format: 1,
    name: 'dsh-remote-explorer',
    version: pkg.version,
    files: await hashPluginFiles(source),
  };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // 3. 安装器也是分发代码，和插件一起通过可信介质移交。
  await build({
    entryPoints: [join(REPO_ROOT, 'scripts', 'install-offline-plugin.ts')],
    outfile: join(directory, 'install.cjs'),
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    bundle: true,
  });
  println(`离线插件目录已生成：${directory}`);
  println('将整个目录压缩并复制到离线机器。安装器自身也是代码，请通过可信介质分发，不要仅依赖包内摘要证明来源。');
}

void main().catch((error: unknown): void => {
  println(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
