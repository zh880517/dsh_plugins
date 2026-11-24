// 打包「给第三方 Agent 的工具包」：dist/<id>-<version>.zip
//   <id>-<version>/
//     SKILL.md            技能说明（Claude Skills / 任意支持 SKILL 的 Agent 直接放进去）
//     cli/<id>.cjs        单文件 CLI（three + viewer 全内联，render 也自包含）
//     mcp/<id>-mcp.js     stdio MCP server（同样自包含）
//     README.md           这个包是什么、怎么用、依赖什么
//     VERSION             版本号
// 依赖只有：Node ≥ 18（info/analyze 无依赖；render 需要目标工程里装 playwright + chromium）。
// 用自带的 store-only ZIP 写入器（不引依赖、跨平台）；Windows 双击/Expand-Archive、macOS unzip 都可解。
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectPlugins } from './plugins.mjs';

const repo = path.resolve(import.meta.dirname, '..');

/** 需要打进的产物（相对插件目录） */
const PAYLOADS = [
  { from: 'skill/SKILL.md', to: 'SKILL.md' },
  { from: 'skill/cli', to: 'cli', dir: true },
  { from: 'mcp', to: 'mcp', dir: true },
];

async function main() {
  const plugins = selectPlugins();
  const targets = plugins.filter((plugin) => plugin.id === 'kinemesh');
  if (targets.length === 0) {
    console.error('没有可打包的插件（当前只支持 kinemesh：它有 Skill/CLI/MCP 三出口）。');
    return 1;
  }
  for (const plugin of targets) {
    const version = plugin.pkg.version;
    const entries = [];
    for (const payload of PAYLOADS) {
      const source = path.join(plugin.dir, payload.from);
      if (payload.dir === true) {
        const files = await listFiles(source);
        for (const file of files) {
          const relative = path.relative(plugin.dir, file).split(path.sep).join('/');
          const target = `${payload.to}/${path.relative(source, file).split(path.sep).join('/')}`;
          entries.push({ name: `${plugin.id}-${version}/${target}`, data: await readFile(file), source: relative });
        }
      } else {
        entries.push({ name: `${plugin.id}-${version}/${payload.to}`, data: await readFile(source), source: payload.from });
      }
    }
    entries.push({ name: `${plugin.id}-${version}/VERSION`, data: Buffer.from(`${version}\n`, 'utf8'), source: '(generated)' });
    entries.push({
      name: `${plugin.id}-${version}/README.md`,
      data: Buffer.from(packageReadme(plugin.id, version), 'utf8'),
      source: '(generated)',
    });
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));

    const outDir = path.join(repo, 'dist');
    await mkdir(outDir, { recursive: true });
    const target = path.join(outDir, `${plugin.id}-${version}.zip`);
    await writeFile(target, buildZip(entries));
    const size = (await stat(target)).size;
    console.log(`packed ${path.relative(repo, target)}（${entries.length} 个文件，${(size / 1024 / 1024).toFixed(1)} MiB）`);
    for (const entry of entries) console.log(`  ${entry.name}`);
  }
  return 0;
}

/** 递归列文件（只列普通文件） */
async function listFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  const items = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const item of items.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...(await listFiles(full)));
    else if (item.isFile()) files.push(full);
  }
  return files;
}

/** 包内 README：这个 zip 是什么、怎么用 */
function packageReadme(id, version) {
  const cli = `cli/${id}.cjs`;
  const mcp = `mcp/${id}-mcp.js`;
  const config = {
    mcpServers: { [id]: { command: 'node', args: [`<解压目录>/${mcp}`] } },
  };
  return [
    `# ${id} ${version} — 第三方 Agent 工具包`,
    '',
    '本包面向 DSH 之外的 Agent 工具，三个东西同源（同一套核心算法）：',
    '',
    `- \`SKILL.md\`：技能说明（Claude Skills / 支持 SKILL 的 Agent 直接把整个目录当技能放进去）；`,
    `- \`${cli}\`：单文件 CLI（\`node ${cli} --help\`）；three.js 与 viewer 全内联，`,
    '  info / analyze / skeleton 零依赖；render 需要目标工程里装 playwright + chromium：',
    '  `npm i playwright && npx playwright install chromium`；',
    `- \`${mcp}\`：stdio MCP server，配置示例（任意 MCP 客户端）：`,
    '',
    '```json',
    JSON.stringify(config, null, 2),
    '```',
    '',
    '要求：Node ≥ 18。产物（截图 / 分析中间文件）缺省写到**当前工作目录**下的',
    '`.kinemeshtmp/run-<时间戳>-<pid>/`（`KINEMESH_TMP_DIR` 可覆盖）。',
    '',
    `版本：\`node ${cli} --version\` → ${version}`,
    '',
  ].join('\n');
}

// ———————— 最小 store-only ZIP 写入器（不引依赖；2～4 个文件足够） ————————

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

/** @param {Array<{ name: string, data: Buffer }>} entries */
function buildZip(entries) {
  const { time, date } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, entry.data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4); // version made by
    directory.writeUInt16LE(20, 6); // version needed
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10); // store
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(entry.data.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

const code = await main();
if (code !== 0) process.exit(code);
