/**
 * @file 自包含离线插件分发
 * @description 联网构建时内联非宿主依赖，生成纯 JS 跨平台插件目录、完整性清单和零包管理器安装器。
 *              不捆绑 DSH 本体；目标机器仍需已有匹配版本 DSH 和可执行安装器的 Node。
 */

import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildPlugin } from './build-plugin.js';
import { hashPluginFiles, type OfflinePluginManifest } from '../src/provision/offline-plugin.js';
import { println } from '../src/cli/output.js';

/** 仓库根目录 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 构建并输出离线插件包，已有输出拒绝覆盖。 */
async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const directory = values.output ? resolve(values.output) : join(ROOT, 'dist', `dsh-remote-explorer-${pkg.version}-offline-plugin`);
  if (!directory.startsWith(`${join(ROOT, 'dist')}${sep}`)) throw new Error('输出目录必须位于仓库 dist 内');
  await mkdir(join(ROOT, 'dist'), { recursive: true });
  await mkdir(directory);
  {
    const source = join(directory, 'package');
    await mkdir(source);
    await buildPlugin({ offline: true, outputDirectory: join(source, 'lib') });
    for (const path of ['locale', 'icon.jpg', 'cordis.patch.yml', 'LICENSE']) {
      await cp(join(ROOT, path), join(source, path), { recursive: true, force: false, errorOnExist: true });
    }
    // 独立 CLI 的 bin/src/tsx 不属于插件运行时；真实宿主 peers 保留，避免 Cordis 双实例。
    const { scripts, dependencies, devDependencies, bin, files, ...metadata } = pkg;
    await writeFile(join(source, 'package.json'), `${JSON.stringify({ ...metadata, dependencies: {} }, null, 2)}\n`);
    const manifest: OfflinePluginManifest = {
      format: 1, name: 'dsh-remote-explorer', version: pkg.version, files: await hashPluginFiles(source),
    };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await build({
      entryPoints: [join(ROOT, 'scripts', 'install-offline-plugin.ts')],
      outfile: join(directory, 'install.cjs'), format: 'cjs', platform: 'node', target: 'node20', bundle: true,
    });
    println(`离线插件目录已生成：${directory}`);
    println('将整个目录压缩并复制到离线机器。安装器自身也是代码，请通过可信介质分发，不要仅依赖包内摘要证明来源。');
  }
}
void main().catch(error => { println(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
