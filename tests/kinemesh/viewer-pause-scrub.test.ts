// 「暂停后跳转不刷新」的根因回归（0.7.5）：three 的 AnimationAction.paused 会让
// AnimationMixer.setTime() 失效——它把 _effectiveTimeScale 归零，setTime 内 `deltaTime *= scale`
// 变成 0，action 时间停在 setTime 刚重置的 0 上 → 姿势永远回到第 0 帧。
// 这条测试直接对着 three 的行为钉住它，避免以后又在 pause 里写 `paused = true`。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

/** 造一条 1 秒的位移动画：t=0 → x=0，t=1 → x=10 */
function makeRig(): { root: THREE.Object3D; mixer: THREE.AnimationMixer; action: THREE.AnimationAction } {
  const root = new THREE.Object3D();
  const clip = new THREE.AnimationClip('walk', 1, [
    new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 10, 0, 0]),
  ]);
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  return { root, mixer, action };
}

describe('暂停与 scrub 的关系（0.7.5 根因）', () => {
  it('正常状态下 mixer.setTime(0.5) 把姿势拱到 0.5s（x=5）', () => {
    const { root, mixer } = makeRig();
    mixer.setTime(0.5);
    expect(root.position.x).toBeCloseTo(5, 5);
  });

  it('action.paused = true 后 mixer.setTime 完全失效：姿势停在第 0 帧（x=0）', () => {
    const { root, mixer, action } = makeRig();
    action.paused = true;
    mixer.setTime(0.5);
    expect(root.position.x).toBeCloseTo(0, 5); // 不是 5 —— 这就是「3D 画面不动」
    mixer.setTime(0.9);
    expect(root.position.x).toBeCloseTo(0, 5); // 所有跳转都一模一样
  });

  it('把 paused 解开后 scrub 立刻恢复（viewer.seekFrame 每次都会做这一步）', () => {
    const { root, mixer, action } = makeRig();
    action.paused = true;
    mixer.setTime(0.5);
    expect(root.position.x).toBeCloseTo(0, 5);
    action.paused = false;
    mixer.setTime(0.9);
    expect(root.position.x).toBeCloseTo(9, 5);
  });

  it('只清 playing 标志（不设 paused）时，暂停后 scrub 仍生效', () => {
    const { root, mixer, action } = makeRig();
    const playing = false; // 等价于 viewer 的 pauseInternal：只清 playing
    expect(playing).toBe(false);
    expect(action.paused).toBe(false);
    mixer.setTime(0.8);
    expect(root.position.x).toBeCloseTo(8, 5);
  });
});
