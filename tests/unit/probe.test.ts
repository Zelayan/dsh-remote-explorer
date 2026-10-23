/**
 * @file provision/probe.ts 单元测试（纯函数部分）
 * @description 覆盖探测脚本输出的解析：Node 列表的路径/版本拆分、dsh 版本
 *              的推断入口路径、DSHBIN/DSH 两行的「存在但不可运行」判定、空值
 *              与无 dsh 行的语义。探测脚本本身是远端 shell 拼接，这里只锁住
 *              「输出 → 结构」的解析契约，真实脚本行为由 doctor 实跑验证
 *              （CLAUDE.md 硬约束）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstalledRuntimes } from '../../src/provision/probe.js';

describe('parseInstalledRuntimes', () => {
  it('解析多条 Node 运行时（路径 + 版本）', () => {
    const output = [
      'HOME=/home/youruser',
      'NODE=/home/youruser/.dsh-remote-explorer/btsd321/node/v24.21.0/bin/node v24.21.0',
      'NODE=/home/youruser/.dsh-remote-explorer/btsd321/node/v24.22.1/bin/node v24.22.1',
      'AVAIL=99999999',
    ].join('\n');

    const { nodes, dsh, dshPresentButUnusable } = parseInstalledRuntimes(output, '/home/youruser');

    assert.deepEqual(nodes, [
      { path: '/home/youruser/.dsh-remote-explorer/btsd321/node/v24.21.0/bin/node', version: 'v24.21.0' },
      { path: '/home/youruser/.dsh-remote-explorer/btsd321/node/v24.22.1/bin/node', version: 'v24.22.1' },
    ]);
    assert.deepEqual(dsh, [], '无 DSH= 行时 dsh 列表为空');
    assert.equal(dshPresentButUnusable, false, '无 DSHBIN 行时不算「存在但不可运行」');
  });

  it('解析 dsh 版本并按安装布局推断入口路径', () => {
    const output = 'HOME=/home/youruser\nDSHBIN=/home/youruser/.dsh-remote-explorer/btsd321/node_modules/.bin/dsh\nDSH=0.2.1-rc.2\nAVAIL=99999999';

    const { dsh, dshPresentButUnusable } = parseInstalledRuntimes(output, '/home/youruser');

    assert.deepEqual(dsh, [
      {
        path: '/home/youruser/.dsh-remote-explorer/btsd321/node_modules/.bin/dsh',
        version: '0.2.1-rc.2',
      },
    ]);
    assert.equal(dshPresentButUnusable, false, '能取到版本就不是「不可运行」');
  });

  it('入口存在但取不到版本 → dshPresentButUnusable = true（损坏/半成品）', () => {
    const output = 'DSHBIN=/home/u/.dsh-remote-explorer/btsd321/node_modules/.bin/dsh\n';

    const { dsh, dshPresentButUnusable } = parseInstalledRuntimes(output, '/home/u');

    assert.deepEqual(dsh, []);
    assert.equal(dshPresentButUnusable, true, '只有 DSHBIN 没有 DSH 时应标记为不可运行');
  });

  it('DSH= 空值不算已安装，但 DSHBIN 仍在时仍算不可运行', () => {
    const result = parseInstalledRuntimes('DSHBIN=/home/u/.dsh/dsh\nDSH=\n', '/home/u');
    assert.deepEqual(result.dsh, []);
    assert.equal(result.dshPresentButUnusable, true);
  });

  it('空输出返回空列表与 false', () => {
    const result = parseInstalledRuntimes('', '/home/youruser');
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.dsh, []);
    assert.equal(result.dshPresentButUnusable, false);
  });

  it('家目录缺失时 dsh 路径退化为根下相对段（仅诊断展示，不影响引导）', () => {
    const { dsh } = parseInstalledRuntimes('DSH=0.2.1-rc.2\n', '');
    assert.equal(dsh[0]?.path, '/.dsh-remote-explorer/btsd321/node_modules/.bin/dsh');
  });

  it('TOOL= 行不被误当 Node/dsh', () => {
    const { nodes, dsh, dshPresentButUnusable } = parseInstalledRuntimes('TOOL=curl\nTOOL=tar\n', '/home/youruser');
    assert.deepEqual(nodes, []);
    assert.deepEqual(dsh, []);
    assert.equal(dshPresentButUnusable, false);
  });
});
