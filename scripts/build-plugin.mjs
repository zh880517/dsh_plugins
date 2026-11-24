// 单插件构建：把 shared/ 与插件 src 打成自包含产物。
//   index.js           —— Host 半，Node ESM，只外置 node: 内建模块
//   client.js          —— Client 半，套上宿主的 __ModuleLoader__ 懒加载 factory 外壳
//   viewer.js          —— 约定产物：src/viewer-page.ts 存在时额外构建（IIFE 全内联，浏览器独立可跑，
//                         用途：kinemesh 的截图页）；没有该入口的插件不受影响。
//   skill/cli/<id>.cjs —— 约定产物：src/cli.ts 存在时额外构建（单文件 CJS + shebang，three.js 全内联，
//                         playwright 保持外部依赖），与 skill/SKILL.md 组成自包含技能目录（M4）。
//   mcp/<id>-mcp.js    —— 约定产物：src/mcp-server.ts 存在时额外构建（单文件 ESM，MCP SDK 内联，
//                         playwright 保持外部依赖；stdio），配置进任意 MCP 客户端（M5）。
//
// 所有插件共用这一份构建；插件差异只允许来自它自己的 package.json 与源码。
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { repo } from './plugins.mjs';

const sharedSrc = path.join(repo, 'shared', 'src');
const jsxShim = path.join(repo, 'scripts', 'jsx-runtime-shim.ts');

const sharedAlias = [
  // 第三方预编译包自带 jsx-runtime 会引入第二份 React 身份（React #31），改接到宿主 React
  { find: /^react\/jsx-runtime$/, replacement: jsxShim },
  { find: /^react\/jsx-dev-runtime$/, replacement: jsxShim },
  { find: /^@shared\/index\.js$/, replacement: path.join(sharedSrc, 'index.ts') },
  { find: /^@shared\/(.*)\.js$/, replacement: path.join(sharedSrc, '$1.ts') },
  { find: '@shared', replacement: sharedSrc },
];

/** Host 半：ESM，node: 内建外置；**playwright 也必须外置**。
 *
 * 教训（0.8.0）：宿主半里 `await import('playwright')` 若被内联，rollup 会把它拆成懒加载 chunk
 * （如 `./playwright-XXXX.js`），而构建只拷出 index.js 单文件 → 运行时报
 * `Cannot find module ...\playwright-BLPky7o0.js`，DSH 插件里的 kinemesh_render 直接不可用
 * （真实会话 session-cd962a54 就是这样掉到 CLI 的）。外置后保持运行时真动态 import，
 * 由 Node 从插件所在位置向上解析（仓库 node_modules / 安装环境自带），缺了才走友好报错。
 * 下面的 assertNoLostChunks 会兜住以后再有别的包被内联成懒 chunk。 */
async function buildHost(plugin, work) {
  await build({
    configFile: false,
    root: repo,
    logLevel: 'warn',
    resolve: { alias: sharedAlias },
    build: {
      lib: { entry: path.join(plugin.dir, 'src/host.ts'), formats: ['es'], fileName: () => 'index.js' },
      outDir: path.join(work, 'host'),
      emptyOutDir: true,
      minify: false,
      target: 'node22',
      rollupOptions: { external: [/^node:/, 'playwright'] },
    },
  });
  await assertNoLostChunks(path.join(work, 'host', 'index.js'), plugin.id);
}

/** 产物里若出现 `import("./xxx.js")` / `from"./xxx.js"` 这类懒 chunk 引用，说明有依赖被拆到了
 *  不存在的文件里（构建只拷 index.js）——直接报错，别等运行时报 Cannot find module。 */
async function assertNoLostChunks(file, pluginId) {
  const body = await readFile(file, 'utf8');
  const lost = [...body.matchAll(/(?:import\(|from\s*)"\.\/([A-Za-z0-9._-]+\.js)"/g)].map((match) => match[1]);
  if (lost.length > 0) {
    throw new Error(
      `[${pluginId}] index.js 里出现懒加载 chunk 引用（${[...new Set(lost)].join(', ')}），但构建只输出了单文件 index.js。` +
        ' 把对应依赖加进 buildHost 的 rollupOptions.external（参考 playwright）。',
    );
  }
}

/** Client 半：CJS，React 走宿主模块表 */
async function buildClient(plugin, work) {
  await build({
    configFile: false,
    root: repo,
    logLevel: 'warn',
    resolve: { alias: sharedAlias },
    esbuild: { jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' },
    // React Flow 预编译产物用 jsx-runtime 并读 process.env.NODE_ENV；浏览器里没有 process，
    // 必须在构建期折叠掉，否则整个插件模块在 materialize 时抛错、所有插槽都注册不上。
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      lib: { entry: path.join(plugin.dir, 'src/client.tsx'), formats: ['cjs'], fileName: () => 'client.bundle.cjs' },
      outDir: path.join(work, 'client'),
      emptyOutDir: true,
      minify: false,
      target: 'es2022',
      // 只外置 React 本体：jsx-runtime 打进来但内部仍 require('react')，保证只有一份 React 身份
      rollupOptions: { external: ['react', 'react-dom', 'react-dom/client'] },
    },
  });
}

function wrapClient(body, packageName) {
  return `// 由 scripts/build-plugin.mjs 生成，勿手改。源码见 src/。
window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports, require) {
${body}
    })(module, module.exports, require);
    return module.exports;
  },
});
`;
}

/** 约定第三产物：src/viewer-page.ts → viewer.js（IIFE，全内联；kinemesh 截图页用） */
async function buildViewer(plugin, work) {
  const entry = path.join(plugin.dir, 'src', 'viewer-page.ts');
  if (!existsSync(entry)) return null;
  await build({
    configFile: false,
    root: repo,
    logLevel: 'warn',
    resolve: { alias: sharedAlias },
    build: {
      lib: { entry, formats: ['iife'], name: `${plugin.id}Viewer`, fileName: () => 'viewer.js' },
      outDir: path.join(work, 'viewer'),
      emptyOutDir: true,
      minify: false,
      target: 'es2022',
    },
  });
  const code = stripRegionPaths(await readFile(path.join(work, 'viewer', 'viewer.js'), 'utf8'));
  await writeFile(path.join(plugin.dir, 'viewer.js'), code, 'utf8');
  return code.length;
}

/** 约定第四产物：src/cli.ts → skill/cli/<id>.cjs（单文件 CJS + shebang；playwright 保持外部依赖）。
 *  用 .cjs 而不是 .js：技能目录会被拷进任意工程，宿主 package.json 的 "type":"module" 不会把它当 ESM。 */
async function buildCli(plugin, work) {
  const entry = path.join(plugin.dir, 'src', 'cli.ts');
  if (!existsSync(entry)) return null;
  await build({
    configFile: false,
    root: repo,
    logLevel: 'warn',
    resolve: { alias: sharedAlias },
    build: {
      lib: { entry, formats: ['cjs'], fileName: () => 'cli.cjs' },
      outDir: path.join(work, 'cli'),
      emptyOutDir: true,
      minify: false,
      target: 'node18',
      // node: 内建必须外置（否则 vite 会给它们注入 browser 桩，path/fs 全变成空壳）；playwright 由用户环境提供
      rollupOptions: { external: [/^node:/, 'playwright'] },
    },
  });
  const body = stripRegionPaths(await readFile(path.join(work, 'cli', 'cli.cjs'), 'utf8'));
  const out = path.join(plugin.dir, 'skill', 'cli', `${plugin.id}.cjs`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `#!/usr/bin/env node\n${body}`, 'utf8');
  return body.length;
}

/** 约定第五产物：src/mcp-server.ts → mcp/<id>-mcp.js（单文件 ESM；stdio；playwright 保持外部依赖） */
async function buildMcp(plugin, work) {
  const entry = path.join(plugin.dir, 'src', 'mcp-server.ts');
  if (!existsSync(entry)) return null;
  await build({
    configFile: false,
    root: repo,
    logLevel: 'warn',
    resolve: { alias: sharedAlias },
    build: {
      lib: { entry, formats: ['es'], fileName: () => `${plugin.id}-mcp.js` },
      outDir: path.join(work, 'mcp'),
      emptyOutDir: true,
      minify: false,
      target: 'node18',
      rollupOptions: { external: [/^node:/, 'playwright'] },
    },
  });
  const body = stripRegionPaths(await readFile(path.join(work, 'mcp', `${plugin.id}-mcp.js`), 'utf8'));
  const out = path.join(plugin.dir, 'mcp', `${plugin.id}-mcp.js`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, body, 'utf8');
  return body.length;
}

/** Host 产物里的 import 只应剩 node: 内建；其余说明打包没闭合 */
function assertSelfContained(code, label) {
  const imports = [...code.matchAll(/(?:^|\n)\s*import\s+[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  const bad = imports.filter((specifier) => specifier !== undefined && !specifier.startsWith('node:'));
  if (bad.length > 0) throw new Error(`${label} 仍有外部依赖：${bad.join(', ')}`);
}

/** Rolldown 的 //#region 注释会写依赖的物理路径（junction/pnpm 布局下是绝对路径）：
 *  去掉路径只保留标记，保证不同 node_modules 布局构建出的产物字节一致。 */
function stripRegionPaths(code) {
  return code.replace(/^\/\/#region .+$/gm, '//#region');
}

/**
 * 构建一个插件，产物写回插件目录。
 * @param {{ id: string, dir: string, pkg: { name: string } }} plugin
 * @returns {Promise<{ id: string, hostKiB: string, clientKiB: string }>}
 */
export async function buildPlugin(plugin) {
  const work = path.join(plugin.dir, '.build');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const viewerKiB = await buildViewer(plugin, work);
  const cliKiB = await buildCli(plugin, work);
  const mcpKiB = await buildMcp(plugin, work);
  await Promise.all([buildHost(plugin, work), buildClient(plugin, work)]);

  const hostCode = stripRegionPaths(await readFile(path.join(work, 'host', 'index.js'), 'utf8'));
  assertSelfContained(hostCode, `${plugin.id}/index.js`);
  await writeFile(path.join(plugin.dir, 'index.js'), hostCode, 'utf8');

  const clientCode = stripRegionPaths(await readFile(path.join(work, 'client', 'client.bundle.cjs'), 'utf8'));
  if (clientCode.includes('require("react/jsx-runtime")')) {
    throw new Error(`${plugin.id}: client 包引用了 react/jsx-runtime；宿主只提供 React 本体，检查 JSX 转换设置`);
  }
  await writeFile(path.join(plugin.dir, 'client.js'), wrapClient(clientCode.trimEnd(), plugin.pkg.name), 'utf8');

  await rm(work, { recursive: true, force: true });
  return {
    id: plugin.id,
    hostKiB: (hostCode.length / 1024).toFixed(1),
    clientKiB: (clientCode.length / 1024).toFixed(1),
    viewerKiB: viewerKiB === null ? null : (viewerKiB / 1024).toFixed(1),
    cliKiB: cliKiB === null ? null : (cliKiB / 1024).toFixed(1),
    mcpKiB: mcpKiB === null ? null : (mcpKiB / 1024).toFixed(1),
  };
}
