// 独立预览页「打开过的模型」层级列表（0.10.1）：进程内记录 + 网格根/动作子节点 + 删除。
// 纯内存 store（client.tsx 内模块级），不走 jsdom。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearOpenedAssets,
  openedAssetList,
  openedAssetNodes,
  recordOpenedAsset,
  removeOpenedAsset,
} from '../../plugins/kinemesh/src/client.js';

describe('打开过的模型记录（openedAssets）', () => {
  beforeEach(() => {
    clearOpenedAssets();
  });

  it('带 mesh+动画的文件记成独立条目（无子节点）', () => {
    recordOpenedAsset({ path: 'D:/assets/hero.fbx', hasMesh: true, animated: true, clips: ['Idle', 'Run'] });
    const nodes = openedAssetNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.asset).toMatchObject({ name: 'hero.fbx', kind: 'independent', hasMesh: true, animated: true });
    expect(nodes[0]!.asset.clips).toEqual(['Idle', 'Run']);
    expect(nodes[0]!.children).toEqual([]);
  });

  it('动作-only 文件：网格记录为根、动作作为子节点（先记动作也能补出根）', () => {
    recordOpenedAsset({
      path: 'D:/assets/hero/hit/attack.fbx',
      hasMesh: false,
      animated: true,
      clips: ['Attack01'],
      meshPath: 'D:/assets/hero/basic/hero.fbx',
    });
    const nodes = openedAssetNodes();
    expect(nodes).toHaveLength(1); // 根是网格，不是动作
    expect(nodes[0]!.asset).toMatchObject({ name: 'hero.fbx', kind: 'mesh', hasMesh: true });
    expect(nodes[0]!.children).toHaveLength(1);
    expect(nodes[0]!.children[0]).toMatchObject({
      name: 'attack.fbx',
      kind: 'animation',
      meshPath: 'D:/assets/hero/basic/hero.fbx',
      clips: ['Attack01'],
    });
  });

  it('只有网格的文件记成网格根；重复打开同一路径只更新、不重复计条目', () => {
    recordOpenedAsset({ path: 'D:/assets/hero/basic/hero.fbx', hasMesh: true, animated: false });
    recordOpenedAsset({ path: 'D:/assets/hero/basic/hero.fbx', hasMesh: true, animated: false });
    expect(openedAssetList()).toHaveLength(1);
    expect(openedAssetNodes()[0]!.asset.kind).toBe('mesh');
  });

  it('同一网格下的多个动作按打开顺序排列；重复打开动作不重复', () => {
    const meshPath = 'D:/assets/hero/basic/hero.fbx';
    recordOpenedAsset({ path: 'D:/a/idle.fbx', hasMesh: false, animated: true, clips: ['Idle'], meshPath });
    recordOpenedAsset({ path: 'D:/a/run.fbx', hasMesh: false, animated: true, clips: ['Run'], meshPath });
    recordOpenedAsset({ path: 'D:/a/idle.fbx', hasMesh: false, animated: true, clips: ['Idle'], meshPath });
    const nodes = openedAssetNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.children.map((child) => child.name)).toEqual(['idle.fbx', 'run.fbx']);
  });

  it('删除网格根会连同其关联动作一起删；删除单个动作只删那条', () => {
    const meshPath = 'D:/assets/hero/basic/hero.fbx';
    recordOpenedAsset({ path: 'D:/a/idle.fbx', hasMesh: false, animated: true, clips: ['Idle'], meshPath });
    recordOpenedAsset({ path: 'D:/a/run.fbx', hasMesh: false, animated: true, clips: ['Run'], meshPath });
    expect(removeOpenedAsset('D:/a/idle.fbx')).toBe(1);
    expect(openedAssetNodes()[0]!.children.map((child) => child.name)).toEqual(['run.fbx']);
    expect(removeOpenedAsset(meshPath)).toBe(2); // 网格根 + 剩余动作
    expect(openedAssetNodes()).toEqual([]);
    expect(removeOpenedAsset('D:/not-there.fbx')).toBe(0);
  });

  it('清空记录（进程内存复位）', () => {
    recordOpenedAsset({ path: 'D:/a.fbx', hasMesh: true, animated: false });
    clearOpenedAssets();
    expect(openedAssetList()).toEqual([]);
    expect(openedAssetNodes()).toEqual([]);
  });
});
