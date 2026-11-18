// Node 端的贴图桩：info 提取只关心结构，不需要真正解码位图。
// three 的 TextureLoader/ImageLoader 会碰 document（浏览器 API），在 Node 里直接崩；
// 给 LoadingManager 按扩展名注册一个立即返回空 Texture 的 loader，把这条路径挡掉。
// 浏览器（viewer / 截图页）里 inNodeEnvironment() 为 false，什么都不做，贴图照常加载。
import * as THREE from 'three';

const TEXTURE_RE = /\.(png|jpe?g|bmp|tga|webp|tiff?|dds|exr|hdr)$/i;

export function inNodeEnvironment(): boolean {
  return (
    typeof window === 'undefined' &&
    typeof process !== 'undefined' &&
    process.versions !== undefined &&
    process.versions.node !== undefined
  );
}

interface StubLoader {
  path: string;
  setPath(path: string | undefined): StubLoader;
  load(url: string): THREE.Texture;
}

export function stubNodeTextures(manager: THREE.LoadingManager): void {
  if (!inNodeEnvironment()) return;
  const cache = new Map<string, THREE.Texture>();
  const stub: StubLoader = {
    path: '',
    setPath(path) {
      this.path = path ?? '';
      return this;
    },
    load(url) {
      const existing = cache.get(url);
      if (existing !== undefined) return existing;
      const texture = new THREE.Texture();
      texture.name = url.startsWith('blob:') || url.startsWith('data:') ? '(embedded)' : basename(url);
      texture.userData.kinemeshUnresolved = true;
      cache.set(url, texture);
      return texture;
    },
  };
  manager.addHandler(TEXTURE_RE, stub as unknown as THREE.Loader);
}

function basename(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const last = clean.split(/[\\/]/).pop();
  return last === undefined || last === '' ? url : decodeURIComponent(last);
}
