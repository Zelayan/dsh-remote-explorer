/**
 * @file provision/dsh-installer.ts 单元测试
 * @description 覆盖 dsh 版本策略的纯函数侧与安装降级链：
 *              - `maxPublishedVersion` 的 semver 完整优先级比较——数值段、
 *                prerelease 有无、点分标识符的数值/字典序/长短规则，以及
 *                非法条目忽略与空输入语义。registry 快照用例锚定 dist-tag
 *                `latest` 滞后实测（lessons 6c）
 *              - `selectDshCandidates` 的分层排序——稳定版降序在前、rc 降序
 *                在后、alpha/beta 一律排除；首项即首选
 *              - `selectDefaultDshVersion` 的首选语义（= 候选序列首项）
 *              - `buildDshCleanCommand` 的路径形状约束（绝不退化成删 base）
 *              - `ensureDsh` 安装/降级边界——首选失败时退到次新候选；版本
 *                一致直接复用；失败清理只删 dsh 树、绝不删 base 根目录
 *
 * 不覆盖 resolveDshCandidates / resolveDshVersion 的远端交互
 * （npm view + JSON 解析）——那是 provision 命令的实跑范畴
 * （CLAUDE.md：改动引导逻辑后必须真实验证）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDshCleanCommand,
  ensureDsh,
  maxPublishedVersion,
  selectDefaultDshVersion,
  selectDshCandidates,
} from '../../src/provision/dsh-installer.js';
import { createRemotePaths } from '../../src/provision/remote-paths.js';
import type { RemoteContext } from '../../src/provision/remote-context.js';
import type { RemoteTransport } from '../../src/transport/types.js';

// ─── maxPublishedVersion ─────────────────────────────────────────────────

describe('maxPublishedVersion', () => {
  describe('major/minor/patch 数值比较', () => {
    it('minor 段数值大者胜（0.2.0-rc.1 > 0.1.7-rc.2）', () => {
      assert.equal(maxPublishedVersion(['0.1.7-rc.2', '0.2.0-rc.1']), '0.2.0-rc.1');
    });

    it('major 段数值大者胜（1.0.0 > 0.9.9）', () => {
      assert.equal(maxPublishedVersion(['0.9.9', '1.0.0']), '1.0.0');
    });

    it('patch 段数值大者胜（0.2.1 > 0.2.0）', () => {
      assert.equal(maxPublishedVersion(['0.2.0', '0.2.1']), '0.2.1');
    });
  });

  describe('prerelease 优先级', () => {
    it('无 prerelease 大于同名有 prerelease（0.2.0 > 0.2.0-rc.2）', () => {
      assert.equal(maxPublishedVersion(['0.2.0-rc.2', '0.2.0']), '0.2.0');
    });

    it('同前缀 prerelease 逐段比较（0.2.0-rc.2 > 0.2.0-rc.1）', () => {
      assert.equal(maxPublishedVersion(['0.2.0-rc.1', '0.2.0-rc.2']), '0.2.0-rc.2');
    });

    it('纯数字标识符按数值而非字典序（0.2.0-rc.10 > 0.2.0-rc.2）', () => {
      assert.equal(maxPublishedVersion(['0.2.0-rc.2', '0.2.0-rc.10']), '0.2.0-rc.10');
    });

    it('纯数字标识符小于非数字标识符（1.0.0-1 < 1.0.0-alpha）', () => {
      assert.equal(maxPublishedVersion(['1.0.0-1', '1.0.0-alpha']), '1.0.0-alpha');
    });
  });

  describe('semver 规范用例（规范第 11 条升序链）', () => {
    it('1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0', () => {
      const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0'];
      // 每个前缀子链的最大值都应是链上最后一位
      for (let i = 1; i < chain.length; i++) {
        assert.equal(maxPublishedVersion(chain.slice(0, i + 1)), chain[i]);
      }
      // 与输入顺序无关
      assert.equal(maxPublishedVersion([...chain].reverse()), '1.0.0');
    });
  });

  describe('垃圾条目忽略', () => {
    it('非法条目不参与比较也不报错（列表混入脏数据）', () => {
      assert.equal(
        maxPublishedVersion(['garbage', '0.1.7-rc.2', '', 'v0.2.0', '0.2.0-rc.2', '1.02.0']),
        '0.2.0-rc.2',
      );
    });

    it('全部非法时返回 undefined（标签、缺段、前导零都不可判读）', () => {
      assert.equal(maxPublishedVersion(['not-a-version', 'latest', '0.1']), undefined);
    });
  });

  describe('空输入', () => {
    it('空数组返回 undefined', () => {
      assert.equal(maxPublishedVersion([]), undefined);
    });
  });

  describe('registry 快照（dist-tag latest 滞后实测）', () => {
    it("['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2'] → '0.2.0-rc.2'", () => {
      // latest 停在 0.1.7-rc.2 时已发布最大值已是 0.2.0-rc.2——默认
      // 策略取版本列表最大值而非任何标签的实证锚点
      assert.equal(
        maxPublishedVersion(['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2']),
        '0.2.0-rc.2',
      );
    });
  });
});

// ─── selectDefaultDshVersion ─────────────────────────────────────────────

describe('selectDefaultDshVersion', () => {
  it('优先最大稳定版，即使有更新的 rc（0.2.1 稳定版 > 0.2.2-rc.1）', () => {
    // 稳定版是正式发布通道：有稳定版时不看任何 rc
    assert.equal(
      selectDefaultDshVersion(['0.2.2-rc.1', '0.2.1', '0.1.9']),
      '0.2.1',
    );
  });

  it('稳定版之间取最大（0.2.2 > 0.2.1 > 0.1.9）', () => {
    assert.equal(
      selectDefaultDshVersion(['0.2.1', '0.1.9', '0.2.2']),
      '0.2.2',
    );
  });

  it('无稳定版时回退最新 rc，alpha 落在更高 minor 上时也必须排除', () => {
    // 关键用例：alpha 与 rc 同 base 时 semver 本身已让 rc 胜出（alpha < rc），
    // 排除逻辑只有在 alpha 落在更高 minor/patch 线上才真正起作用——
    // `0.2.1-alpha.5 > 0.1.9-rc.9`，若不排除会选中 alpha。
    assert.equal(
      selectDefaultDshVersion(['0.2.1-alpha.5', '0.1.9-rc.9']),
      '0.1.9-rc.9',
    );
  });

  it('无稳定版时 rc 之间按 semver 数值比较（rc.10 > rc.2，不走字典序）', () => {
    assert.equal(
      selectDefaultDshVersion(['0.2.1-rc.2', '0.2.1-rc.10', '0.2.1-rc.1']),
      '0.2.1-rc.10',
    );
  });

  it('无稳定版时跨 minor 选 rc 里最大的（0.2.0-rc.2 > 0.1.9-rc.9）', () => {
    assert.equal(
      selectDefaultDshVersion(['0.1.9-rc.9', '0.2.0-rc.1', '0.2.0-rc.2']),
      '0.2.0-rc.2',
    );
  });

  it('beta/nightly 在更高 minor 上时同样不选', () => {
    assert.equal(
      selectDefaultDshVersion(['0.3.0-beta.1', '0.2.1-rc.2']),
      '0.2.1-rc.2',
    );
  });

  it('只有 alpha（无稳定版与 rc）时返回 undefined（交由兜底地板）', () => {
    assert.equal(
      selectDefaultDshVersion(['0.2.1-alpha.5', '0.2.1-alpha.1']),
      undefined,
    );
  });

  it('空输入返回 undefined', () => {
    assert.equal(selectDefaultDshVersion([]), undefined);
  });

  it('非法条目忽略，不让脏值掀翻解析', () => {
    assert.equal(
      selectDefaultDshVersion(['garbage', '0.2.0-rc.2', 'v0.2.0', '0.1']),
      '0.2.0-rc.2',
    );
  });

  it('registry 快照：无稳定版时取最新 rc，跳过 alpha', () => {
    // 锚定 dsh 当前 registry 形态：只有 rc 与 alpha，尚无稳定版
    assert.equal(
      selectDefaultDshVersion(['0.2.1-rc.2', '0.2.1-alpha.5', '0.2.0-rc.2']),
      '0.2.1-rc.2',
    );
  });
});

// ─── selectDshCandidates（降级候选排序） ──────────────────────────────────

describe('selectDshCandidates', () => {
  it('稳定版降序在前，rc 降序在后（跨层排序）', () => {
    assert.deepEqual(
      selectDshCandidates(['0.2.1-rc.1', '0.2.0', '0.1.9', '0.2.1']),
      ['0.2.1', '0.2.0', '0.1.9', '0.2.1-rc.1'],
    );
  });

  it('同层内按 semver 数值降序（rc.10 > rc.2，不走字典序）', () => {
    assert.deepEqual(
      selectDshCandidates(['0.2.1-rc.2', '0.2.1-rc.10', '0.2.1-rc.1']),
      ['0.2.1-rc.10', '0.2.1-rc.2', '0.2.1-rc.1'],
    );
  });

  it('alpha/beta 一律不进候选序列', () => {
    assert.deepEqual(
      selectDshCandidates(['0.3.0-beta.1', '0.2.1-alpha.5', '0.2.1-rc.2', '0.2.0']),
      ['0.2.0', '0.2.1-rc.2'],
    );
  });

  it('首项就是 selectDefaultDshVersion 的首选', () => {
    const versions = ['0.2.2-rc.1', '0.2.1', '0.1.9', '0.2.1-rc.2'];
    assert.equal(selectDshCandidates(versions)[0], selectDefaultDshVersion(versions));
  });

  it('只有 rc 时候选全是 rc 降序', () => {
    assert.deepEqual(
      selectDshCandidates(['0.2.1-rc.1', '0.2.1-rc.3', '0.2.0-rc.2']),
      ['0.2.1-rc.3', '0.2.1-rc.1', '0.2.0-rc.2'],
    );
  });

  it('非法条目忽略', () => {
    assert.deepEqual(
      selectDshCandidates(['garbage', '0.2.1-rc.2', 'v0.2.0', '0.1']),
      ['0.2.1-rc.2'],
    );
  });

  it('空输入或无可用候选返回空数组', () => {
    assert.deepEqual(selectDshCandidates([]), []);
    assert.deepEqual(selectDshCandidates(['0.2.1-alpha.1']), []);
  });
});

// ─── buildDshCleanCommand ────────────────────────────────────────────────

describe('buildDshCleanCommand', () => {
  it('正常路径产出清空 base/node_modules 与 lock 的命令', () => {
    assert.equal(
      buildDshCleanCommand('/home/u/.dsh-remote-explorer/btsd321'),
      'rm -rf /home/u/.dsh-remote-explorer/btsd321/node_modules'
        + ' /home/u/.dsh-remote-explorer/btsd321/package-lock.json',
    );
  });

  it('清理目标永远是 base 的子树，绝不等于 base 本身', () => {
    const base = '/home/u/.dsh-remote-explorer/btsd321';
    const command = buildDshCleanCommand(base);
    assert.ok(command.includes(` ${base}/node_modules `), '应删 base/node_modules');
    assert.ok(!command.includes(` ${base} `), '不得直接删 base 根目录');
  });

  it('installDir 为空时抛错（拒绝不可预期的 rm 目标）', () => {
    assert.throws(() => buildDshCleanCommand(''), /必须是绝对路径/);
  });

  it('installDir 为相对路径时抛错', () => {
    assert.throws(() => buildDshCleanCommand('base/node_modules'), /必须是绝对路径/);
  });
});

// ─── ensureDsh 安装 / 清理边界 ───────────────────────────────────────────

describe('ensureDsh 安装 / 降级边界', () => {
  /**
   * 记录型假传输：`--version` 探针返回「当前已装版本」；含 `npm install` 的
   * 命令视为安装命令——`failInstallFor` 命中的版本抛错模拟装不上，其余视为
   * 成功并把「已装版本」更新为该候选。所有命令记入 {@link options.commands}。
   */
  function recordingTransport(options: {
    /** 安装前的 `dsh --version` 输出版本 */
    probeVersion: string;
    /** 记录所有执行的命令 */
    commands: string[];
    /** 这些版本的 npm install 模拟失败（降级链的核心用例） */
    failInstallFor?: readonly string[];
  }): RemoteTransport {
    let installed = options.probeVersion;
    return {
      hostAlias: 'myhost',
      isAlive: true,
      platform: { os: 'linux', arch: 'x64', rawOs: 'Linux', rawArch: 'x86_64' },
      async exec(command: string) {
        options.commands.push(command);
        if (command.includes('--version')) {
          return { stdout: `${installed}\n`, stderr: '', exitCode: 0 };
        }
        if (command.includes('npm install')) {
          const match = /@deepseek-ai\/dsh@([^\s'"]+)/.exec(command);
          const candidate = match?.[1] ?? '';
          if (options.failInstallFor?.includes(candidate)) {
            throw new Error(`模拟 npm install ${candidate} 失败`);
          }
          installed = candidate;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeRemoteFile() {},
      async readRemoteFile() { throw new Error('ENOENT'); },
      async connect() {},
      async dispose() {},
      async upload() {},
      async download() {},
      async openChannel() { throw new Error('本用例不涉及通道'); },
    } as unknown as RemoteTransport;
  }

  it('版本一致时直接复用，不触发任何安装命令', async () => {
    const commands: string[] = [];
    const transport = recordingTransport({ probeVersion: '0.2.1', commands });
    const ctx: RemoteContext = { transport, paths: createRemotePaths('/home/youruser') };

    const result = await ensureDsh(ctx, {
      version: '0.2.1',
      registryUrl: 'https://registry.example',
      nodeBinDir: '/bin',
    });

    assert.equal(result.reused, true);
    assert.equal(result.version, '0.2.1');
    assert.equal(result.installDir, ctx.paths.dshDir);
    assert.deepEqual(
      commands,
      [expectVersionProbe(ctx.paths.dshBin)],
      '复用路径应只跑一次 --version 探针',
    );
  });

  it('首选版本装不上时沿候选序列退到次新并实际安装它', async () => {
    const commands: string[] = [];
    // 未装任何 dsh；首选 rc.3 装不上（模拟镜像缺包），候选链退到 rc.2 并安装
    const transport = recordingTransport({
      probeVersion: '',
      commands,
      failInstallFor: ['0.2.1-rc.3'],
    });
    const ctx: RemoteContext = { transport, paths: createRemotePaths('/home/youruser') };

    const result = await ensureDsh(ctx, {
      version: '0.2.1-rc.3',
      candidates: ['0.2.1-rc.3', '0.2.1-rc.2'],
      registryUrl: 'https://registry.example',
      nodeBinDir: '/bin',
    });

    assert.equal(result.version, '0.2.1-rc.2', '应退到次新候选');
    assert.equal(result.reused, false, '次新候选未装，应实际安装');

    const installCommands = commands.filter(c => c.includes('npm install'));
    assert.equal(installCommands.length, 2, '首选与次新各装一次');
    assert.ok(installCommands[0]?.includes('@deepseek-ai/dsh@0.2.1-rc.3'), '首选应为 rc.3');
    assert.ok(installCommands[1]?.includes('@deepseek-ai/dsh@0.2.1-rc.2'), '退到 rc.2');
  });

  it('首选版本装不上但次新候选已装时直接复用，不重复安装', async () => {
    const commands: string[] = [];
    // 已装 rc.2；首选 rc.3 装不上，候选链退到已装的 rc.2 → 复用
    const transport = recordingTransport({
      probeVersion: '0.2.1-rc.2',
      commands,
      failInstallFor: ['0.2.1-rc.3'],
    });
    const ctx: RemoteContext = { transport, paths: createRemotePaths('/home/youruser') };

    const result = await ensureDsh(ctx, {
      version: '0.2.1-rc.3',
      candidates: ['0.2.1-rc.3', '0.2.1-rc.2'],
      registryUrl: 'https://registry.example',
      nodeBinDir: '/bin',
    });

    assert.equal(result.version, '0.2.1-rc.2', '应退到次新候选');
    assert.equal(result.reused, true, '次新候选已装，应复用而非重装');

    const installCommands = commands.filter(c => c.includes('npm install'));
    assert.equal(installCommands.length, 1, '只尝试了首选 rc.3 一次');
    assert.ok(installCommands[0]?.includes('@deepseek-ai/dsh@0.2.1-rc.3'), '应是首选 rc.3');
  });

  it('候选全部装不上时报已尝试清单，清理只删 dsh 树绝不碰 base 根', async () => {
    const commands: string[] = [];
    const transport = recordingTransport({
      probeVersion: '0.1.0',
      commands,
      failInstallFor: ['0.2.1-rc.3', '0.2.1-rc.2', '0.2.0-rc.2'],
    });
    const ctx: RemoteContext = { transport, paths: createRemotePaths('/home/youruser') };
    const base = ctx.paths.base;

    await assert.rejects(
      ensureDsh(ctx, {
        version: '0.2.1-rc.3',
        candidates: ['0.2.1-rc.3', '0.2.1-rc.2', '0.2.0-rc.2'],
        registryUrl: 'https://registry.example',
        nodeBinDir: '/bin',
      }),
      /安装 dsh 失败，已尝试候选：0\.2\.1-rc\.3、0\.2\.1-rc\.2、0\.2\.0-rc\.2/,
    );

    const installCommands = commands.filter(c => c.includes('npm install'));
    assert.equal(installCommands.length, 3, '三个候选各尝试一次');
    for (const install of installCommands) {
      assert.ok(install.includes(`rm -rf ${base}/node_modules`), '安装前应清空 dsh 安装树');
    }
    const rmCommands = commands.filter(c => c.startsWith('rm -rf'));
    for (const command of rmCommands) {
      assert.ok(!command.includes(` ${base} `), `清理命令不得直接删 base：${command}`);
    }
  });

  it('候选链最多尝试 3 个（防止无限退到远古版本）', async () => {
    const commands: string[] = [];
    const transport = recordingTransport({
      probeVersion: '0.1.0',
      commands,
      failInstallFor: ['a', 'b', 'c', 'd', 'e'],
    });
    const ctx: RemoteContext = { transport, paths: createRemotePaths('/home/youruser') };

    await assert.rejects(
      ensureDsh(ctx, {
        version: 'a',
        candidates: ['a', 'b', 'c', 'd', 'e'],
        registryUrl: 'https://registry.example',
        nodeBinDir: '/bin',
      }),
      /安装 dsh 失败/,
    );

    assert.equal(
      commands.filter(c => c.includes('npm install')).length,
      3,
      '应只尝试前 3 个候选',
    );
  });
});

/** 构造 `ensureDsh` 复用检查用到的 `--version` 探针命令 */
function expectVersionProbe(dshBin: string): string {
  return `${dshBin} --version 2>/dev/null || true`;
}
