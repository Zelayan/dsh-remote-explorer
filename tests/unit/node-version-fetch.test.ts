/**
 * @file provision/node-version-fetch.ts 单元测试（纯函数部分）
 * @description 覆盖「取指定主版本最新稳定版」的判定：主版本过滤、预发布排除、
 *              非法条目忽略、无命中返回 undefined。这些是引导默认 Node 版本的
 *              决策核心，必须与 semver 优先级严格一致。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectLatestStableVersion } from '../../src/provision/node-version-fetch.ts';

describe('selectLatestStableVersion', () => {
  it('取指定主版本的最新稳定版，忽略其他主版本', () => {
    const versions = [
      'v24.9.0',
      'v22.23.2',
      'v24.11.1',
      'v25.0.0',
      'v24.0.0',
    ];
    assert.equal(selectLatestStableVersion(versions, 24), 'v24.11.1');
  });

  it('排除预发布版本，取稳定版', () => {
    const versions = ['v24.0.0-rc.1', 'v24.0.0-alpha.0', 'v24.0.0'];
    assert.equal(selectLatestStableVersion(versions, 24), 'v24.0.0');
  });

  it('预发布不会被同版本号的稳定版之外的更旧稳定版误取', () => {
    // v24.5.0-rc.1 的优先级高于 v24.4.0，但预发布被排除后应取 v24.4.0
    const versions = ['v24.5.0-rc.1', 'v24.4.0'];
    assert.equal(selectLatestStableVersion(versions, 24), 'v24.4.0');
  });

  it('按 semver 数值比较而非字典序（24.10.0 > 24.9.0）', () => {
    const versions = ['v24.10.0', 'v24.9.0'];
    assert.equal(selectLatestStableVersion(versions, 24), 'v24.10.0');
  });

  it('无命中返回 undefined', () => {
    assert.equal(selectLatestStableVersion(['v22.23.2', 'v25.0.0'], 24), undefined);
  });

  it('空列表返回 undefined', () => {
    assert.equal(selectLatestStableVersion([], 24), undefined);
  });

  it('忽略非法条目，不让脏值掀翻解析', () => {
    const versions = ['v24.not-a-version', 'garbage', 'v24.3.0'];
    assert.equal(selectLatestStableVersion(versions, 24), 'v24.3.0');
  });

  it('同时有多个主版本时只取目标主版本', () => {
    const versions = ['v24.1.0', 'v23.9.0', 'v26.0.0'];
    assert.equal(selectLatestStableVersion(versions, 24), 'v24.1.0');
  });
});
