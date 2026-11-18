// kinemesh 的合成样例资产（测试用）：glTF / GLB / OBJ / 二进制 FBX / ASCII FBX。
// 全部内存生成、确定性输出，仓库不提交二进制样例（真实样例见 tests/fixtures/kinemesh/，
// 不在时相关用例跳过 —— 设计文档 §10 的样例资产清单另定）。

const KTIME_PER_SECOND = 46_186_158_000;

// ———————————————————— glTF ————————————————————

/** 一个带骨骼 + 动画 + 蒙皮标记的最小 cube 场景（纯 JSON 快速路径的完整覆盖） */
export function buildAnimatedCubeGltf(): Record<string, unknown> {
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, // front
    4, 5, 6, 4, 6, 7, // back
    0, 4, 7, 0, 7, 3, // left
    1, 2, 6, 1, 6, 5, // right
    0, 1, 5, 0, 5, 4, // bottom
    3, 2, 6, 3, 6, 7, // top
  ]);
  const ibm = new Float32Array(32); // 2 个单位 MAT4（快速路径不读数值，只要 accessor 存在）
  for (let matrix = 0; matrix < 2; matrix += 1) ibm[matrix * 16] = 1;
  const walkTimes = new Float32Array([0, 0.5]);
  const rigTranslation = new Float32Array([0, 0, 0, 2, 0, 0]); // 净位移 2 → rootMotion
  const boneTimes = new Float32Array([0, 0.5]);
  const boneRotation = new Float32Array([0, 0, 0, 1, 0, 0.2588, 0, 0.9659]);

  const layout = packSections([
    positions, indices, ibm, walkTimes, rigTranslation, boneTimes, boneRotation,
  ]);
  const [pos, idx, matrices, timesA, trans, timesB, rot] = layout.sections;

  const json = {
    asset: { version: '2.0', generator: 'kinemesh-fixtures' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0, 3] }],
    nodes: [
      { name: 'rig', children: [1] },
      { name: 'bone_a', children: [2] },
      { name: 'bone_b' },
      { name: 'cube', mesh: 0, skin: 0 },
    ],
    meshes: [
      {
        name: 'Body',
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
      },
    ],
    materials: [{ name: 'BodyMat', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1] } }],
    skins: [{ name: 'Armature', joints: [1, 2], inverseBindMatrices: 2 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'MAT4' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [0.5] },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [2, 0, 0] },
      { bufferView: 5, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [0.5] },
      { bufferView: 6, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: pos.offset, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: idx.offset, byteLength: idx.byteLength },
      { buffer: 0, byteOffset: matrices.offset, byteLength: matrices.byteLength },
      { buffer: 0, byteOffset: timesA.offset, byteLength: timesA.byteLength },
      { buffer: 0, byteOffset: trans.offset, byteLength: trans.byteLength },
      { buffer: 0, byteOffset: timesB.offset, byteLength: timesB.byteLength },
      { buffer: 0, byteOffset: rot.offset, byteLength: rot.byteLength },
    ],
    buffers: [{ byteLength: layout.byteLength, uri: dataUri(layout.bytes) }],
    animations: [
      {
        name: 'Walk',
        samplers: [
          { input: 3, output: 4 },
          { input: 5, output: 6 },
        ],
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 1, target: { node: 1, path: 'rotation' } },
        ],
      },
    ],
  };
  return json;
}

/** 把 [0, 0.5] 内的位移动画去掉，得到静态 cube（验证「无动画 → 提示」分支） */
export function buildStaticCubeGltf(): Record<string, unknown> {
  const full = buildAnimatedCubeGltf() as Record<string, unknown>;
  const clone = structuredClone(full);
  delete clone.animations;
  delete clone.skins;
  (clone.nodes as Array<Record<string, unknown>>)[3] = { name: 'cube', mesh: 0 };
  return clone;
}

export function encodeGltfBytes(json: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 原样编码文本（OBJ / 畸形输入用），不做 JSON 序列化 */
export function encodeText(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** GLB 容器：12 字节头 + JSON chunk（空格补齐到 4 字节） */
export function encodeGlb(json: unknown): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = jsonBytes.byteLength + (4 - (jsonBytes.byteLength % 4)) % 4;
  const total = 12 + 8 + padded;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  bytes.set([0x67, 0x6c, 0x54, 0x46], 0); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  bytes.set(jsonBytes, 20);
  for (let index = jsonBytes.byteLength; index < padded; index += 1) bytes[20 + index] = 0x20;
  return out;
}

// ———————————————————— OBJ ————————————————————

export function buildCubeObj(): string {
  return [
    '# kinemesh fixture cube',
    'mtllib cube.mtl',
    'o cube',
    'v -0.5 -0.5 -0.5',
    'v 0.5 -0.5 -0.5',
    'v 0.5 0.5 -0.5',
    'v -0.5 0.5 -0.5',
    'v -0.5 -0.5 0.5',
    'v 0.5 -0.5 0.5',
    'v 0.5 0.5 0.5',
    'v -0.5 0.5 0.5',
    'usemtl body',
    'f 1 3 2',
    'f 1 4 3',
    'f 5 6 7',
    'f 5 7 8',
    'f 1 5 8',
    'f 1 8 4',
    'f 2 3 7',
    'f 2 7 6',
    'f 1 2 6',
    'f 1 6 5',
    'f 4 8 7',
    'f 4 7 3',
  ].join('\n');
}

// ———————————————————— FBX（二进制） ————————————————————

type FbxProp =
  | { t: 'I'; v: number }
  | { t: 'L'; v: number }
  | { t: 'D'; v: number }
  | { t: 'F'; v: number }
  | { t: 'S'; v: string }
  | { t: 'C'; v: boolean }
  | { t: 'd'; v: number[] }
  | { t: 'f'; v: number[] }
  | { t: 'i'; v: number[] }
  | { t: 'l'; v: number[] };

interface FbxNode {
  name: string;
  props: FbxProp[];
  children: FbxNode[];
}

function node(name: string, props: FbxProp[] = [], children: FbxNode[] = []): FbxNode {
  return { name, props, children };
}

const S = (v: string): FbxProp => ({ t: 'S', v });
const I = (v: number): FbxProp => ({ t: 'I', v });
const L = (v: number): FbxProp => ({ t: 'L', v });
const D = (v: number): FbxProp => ({ t: 'D', v });
const dArr = (v: number[]): FbxProp => ({ t: 'd', v });
const fArr = (v: number[]): FbxProp => ({ t: 'f', v });
const iArr = (v: number[]): FbxProp => ({ t: 'i', v });
const lArr = (v: number[]): FbxProp => ({ t: 'l', v });

const p = (name: string, type1: string, type2: string, flag: string, ...values: FbxProp[]): FbxNode =>
  node('P', [S(name), S(type1), S(type2), S(flag), ...values]);

const CUBE_VERTICES = [
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
];
// 前后两个 quad，每个面按「从外侧看逆时针」的 FBX 约定排顶点（末位按 FBX 取反）。
// 注意绕向：反面朝内时 FrontSide 裁剪会让整个网格在正面视角下不可见。
const CUBE_POLY_INDEX = [4, 5, -7, 4, 6, -7, 1, 0, -4, 1, 3, -4];

/** 最小二进制 FBX：cube 网格 + 材质 + 一条 2 秒的位移动画（Take 001） */
export function buildBinaryFbx(): ArrayBuffer {
  const kTime = (seconds: number): number => Math.round(seconds * KTIME_PER_SECOND);
  const keyTimes = [0, kTime(1), kTime(2)];
  const axisCurveChildren = (values: number[]): FbxNode[] => [
    node('Default', [D(0)]),
    node('KeyVer', [I(4008)]),
    node('KeyTime', [lArr(keyTimes)]),
    node('KeyValueFloat', [fArr(values)]),
    node('KeyAttrFlags', [iArr([24836])]),
    node('KeyAttrDataFloat', [fArr([0, 0, 0, 0])]),
    node('KeyAttrRefCount', [iArr([values.length])]),
  ];

  const objects: FbxNode[] = [
    node('Geometry', [L(1_000_000), S('cube'), S('Mesh')], [
      node('Vertices', [dArr(CUBE_VERTICES)]),
      node('PolygonVertexIndex', [iArr(CUBE_POLY_INDEX)]),
      node('GeometryVersion', [I(124)]),
    ]),
    node('Model', [L(2_000_000), S('cube'), S('Mesh')], [
      node('Version', [I(232)]),
      node('Properties70', [], [
        p('Lcl Translation', 'Lcl Translation', '', 'A', D(0), D(0), D(0)),
      ]),
    ]),
    node('Material', [L(4_000_000), S('mat'), S('')], [
      node('Version', [I(102)]),
      node('ShadingModel', [S('phong')]),
      node('MultiLayer', [I(0)]),
    ]),
    node('AnimationStack', [L(3_000_000), S('Take 001'), S('')], [
      node('Properties70', [], [
        p('LocalStop', 'KTime', 'Time', '', L(kTime(2))),
        p('ReferenceStop', 'KTime', 'Time', '', L(kTime(2))),
      ]),
    ]),
    node('AnimationLayer', [L(3_000_001), S('BaseLayer'), S('')], []),
    node('AnimationCurveNode', [L(3_000_002), S('T'), S('')], [
      node('Properties70', [], [
        p('d|X', 'Number', '', 'A', D(0)),
        p('d|Y', 'Number', '', 'A', D(0)),
        p('d|Z', 'Number', '', 'A', D(0)),
      ]),
    ]),
    node('AnimationCurve', [L(3_000_003), S(''), S('')], axisCurveChildren([0, 0.5, 1])),
    node('AnimationCurve', [L(3_000_004), S(''), S('')], axisCurveChildren([0, 0.25, 0])),
    node('AnimationCurve', [L(3_000_005), S(''), S('')], axisCurveChildren([0, 0, 0])),
  ];

  const connections: FbxNode[] = [
    node('C', [S('OO'), L(1_000_000), L(2_000_000)]),
    node('C', [S('OO'), L(2_000_000), L(0)]),
    node('C', [S('OO'), L(4_000_000), L(2_000_000)]),
    node('C', [S('OO'), L(3_000_000), L(0)]),
    node('C', [S('OO'), L(3_000_001), L(3_000_000)]),
    node('C', [S('OO'), L(3_000_002), L(3_000_001)]),
    node('C', [S('OP'), L(3_000_002), L(2_000_000), S('Lcl Translation')]),
    node('C', [S('OP'), L(3_000_003), L(3_000_002), S('d|X')]),
    node('C', [S('OP'), L(3_000_004), L(3_000_002), S('d|Y')]),
    node('C', [S('OP'), L(3_000_005), L(3_000_002), S('d|Z')]),
  ];

  const rootNodes: FbxNode[] = [
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [I(1003)]),
      node('FBXVersion', [I(7400)]),
      node('Creator', [S('kinemesh-fixtures')]),
    ]),
    node('GlobalSettings', [I(1000)], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        p('UpAxis', 'int', 'Integer', '', I(1)),
        p('UpAxisSign', 'int', 'Integer', '', I(1)),
        p('FrontAxis', 'int', 'Integer', '', I(2)),
        p('FrontAxisSign', 'int', 'Integer', '', I(1)),
        p('UnitScaleFactor', 'double', 'Number', '', D(1)),
      ]),
    ]),
    node('Definitions', [I(100)], [
      node('Version', [I(100)]),
      node('Count', [I(10)]),
      node('ObjectType', [S('Model')], [node('Count', [I(1)])]),
      node('ObjectType', [S('Geometry')], [node('Count', [I(1)])]),
      node('ObjectType', [S('Material')], [node('Count', [I(1)])]),
      node('ObjectType', [S('AnimationStack')], [node('Count', [I(1)])]),
      node('ObjectType', [S('AnimationLayer')], [node('Count', [I(1)])]),
      node('ObjectType', [S('AnimationCurveNode')], [node('Count', [I(1)])]),
      node('ObjectType', [S('AnimationCurve')], [node('Count', [I(3)])]),
    ]),
    node('Objects', [], objects),
    node('Connections', [], connections),
  ];

  return encodeFbxBinary(7400, rootNodes);
}

/** FBX binary 7.4：header(23B) + version(u32) + 节点记录 + null 结束记录 */
function encodeFbxBinary(version: number, rootNodes: FbxNode[]): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const header = new TextEncoder().encode('Kaydara FBX Binary  \x00\x1a\x00');
  chunks.push(header);
  const versionBytes = new Uint8Array(4);
  new DataView(versionBytes.buffer).setUint32(0, version, true);
  chunks.push(versionBytes);

  let offset = header.byteLength + 4;
  for (const rootNode of rootNodes) {
    const encoded = encodeFbxNode(rootNode, offset);
    chunks.push(encoded.bytes);
    offset += encoded.bytes.byteLength;
  }
  chunks.push(new Uint8Array(13)); // null record：3×u32 + 1×u8 全零
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

interface EncodedNode {
  bytes: Uint8Array;
}

/** base 是本节点在文件里的绝对起始位置 */
function encodeFbxNode(tree: FbxNode, base: number): EncodedNode {
  const nameBytes = new TextEncoder().encode(tree.name);
  const propsBytes = concatBytes(tree.props.map((prop) => encodeProp(prop)));
  const childrenBytesList: Uint8Array[] = [];
  let childCursor = base + 13 + nameBytes.byteLength + propsBytes.byteLength;
  for (const child of tree.children) {
    const encoded = encodeFbxNode(child, childCursor);
    childrenBytesList.push(encoded.bytes);
    childCursor += encoded.bytes.byteLength;
  }
  const childrenBytes = concatBytes(childrenBytesList);
  const endOffset = base + 13 + nameBytes.byteLength + propsBytes.byteLength + childrenBytes.byteLength;

  const head = new Uint8Array(13 + nameBytes.byteLength);
  const view = new DataView(head.buffer);
  view.setUint32(0, endOffset, true);
  // 注意：FBX 二进制节点头第二个 u32 是「属性数量」（不是子节点数——子节点靠 endOffset 截断），
  // FBXLoader（与真实 FBX 文件）都按这个语义读。
  view.setUint32(4, tree.props.length, true);
  view.setUint32(8, propsBytes.byteLength, true);
  view.setUint8(12, nameBytes.byteLength);
  head.set(nameBytes, 13);
  return { bytes: concatBytes([head, propsBytes, childrenBytes]) };
}

function encodeProp(prop: FbxProp): Uint8Array {
  const view = new DataView(new ArrayBuffer(8));
  const bytes = (write: (dataView: DataView) => void, length: number): Uint8Array => {
    write(view);
    return new Uint8Array(view.buffer, 0, length);
  };
  switch (prop.t) {
    case 'I':
      return concatBytes([Uint8Array.of(prop.t.charCodeAt(0)), bytes((dv) => dv.setInt32(0, prop.v, true), 4)]);
    case 'L': {
      const low = prop.v % 0x100000000;
      const high = Math.floor(prop.v / 0x100000000);
      return concatBytes([
        Uint8Array.of(prop.t.charCodeAt(0)),
        bytes((dv) => {
          dv.setUint32(0, low, true);
          dv.setUint32(4, high, true);
        }, 8),
      ]);
    }
    case 'D':
      return concatBytes([Uint8Array.of(prop.t.charCodeAt(0)), bytes((dv) => dv.setFloat64(0, prop.v, true), 8)]);
    case 'F':
      return concatBytes([Uint8Array.of(prop.t.charCodeAt(0)), bytes((dv) => dv.setFloat32(0, prop.v, true), 4)]);
    case 'C':
      return Uint8Array.of(prop.t.charCodeAt(0), prop.v ? 1 : 0);
    case 'S': {
      const encoded = new TextEncoder().encode(prop.v);
      const lengthBytes = new Uint8Array(4);
      new DataView(lengthBytes.buffer).setUint32(0, encoded.byteLength, true);
      return concatBytes([Uint8Array.of(prop.t.charCodeAt(0)), lengthBytes, encoded]);
    }
    case 'd':
    case 'f':
    case 'i':
    case 'l': {
      const perElement = prop.t === 'd' || prop.t === 'l' ? 8 : 4;
      const payload = new Uint8Array(prop.v.length * perElement);
      const dataView = new DataView(payload.buffer);
      prop.v.forEach((value, index) => {
        const at = index * perElement;
        if (prop.t === 'd') dataView.setFloat64(at, value, true);
        else if (prop.t === 'f') dataView.setFloat32(at, value, true);
        else if (prop.t === 'i') dataView.setInt32(at, value, true);
        else {
          dataView.setUint32(at, value % 0x100000000, true);
          dataView.setUint32(at + 4, Math.floor(value / 0x100000000), true);
        }
      });
      const head = new Uint8Array(12); // 3 × u32：length / encoding / compressedLength
      const headView = new DataView(head.buffer);
      headView.setUint32(0, prop.v.length, true);
      headView.setUint32(4, 0, true); // encoding：不压缩
      headView.setUint32(8, payload.byteLength, true);
      return concatBytes([Uint8Array.of(prop.t.charCodeAt(0)), head, payload]);
    }
  }
}

function concatBytes(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of list) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

// ———————————————————— FBX（ASCII） ————————————————————

/** 与 buildBinaryFbx 同构的 ASCII 版本（ASCII ≥7.0 路径） */
export function buildAsciiFbx(): string {
  const vertices = CUBE_VERTICES.join(',');
  const polyIndex = CUBE_POLY_INDEX.join(',');
  const keyTimes = `0,${Math.round(KTIME_PER_SECOND)},${Math.round(2 * KTIME_PER_SECOND)}`;
  // 头注释必须满足两个约束：
  // 1) 不以裸文本开头（TextParser 会把不认识的行当数组续行）；
  // 2) FBXLoader 的 isFbxFormatASCII 会在三角数位置（0,1,3,6,10,…）上比对 'Kaydara\FBX\Binary\\'，
  //    任意一位命中就误判成二进制。固定长度的分隔注释让这些位置都落在安全字符上。
  return `; FBX 7.4.0 project file ${'-'.repeat(35)}
FBXHeaderExtension: 1003 {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreator: "kinemesh-fixtures"
}
GlobalSettings: 1000 {
\tVersion: 1000
\tProperties70: {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}
Objects:  {
\tGeometry: 1000000, "cube", "Mesh" {
\t\tVertices: *24 {
\t\t\ta: ${vertices}
\t\t}
\t\tPolygonVertexIndex: *6 {
\t\t\ta: ${polyIndex}
\t\t}
\t\tGeometryVersion: 124
\t}
\tModel: 2000000, "cube", "Mesh" {
\t\tVersion: 232
\t\tProperties70: {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
\t\t}
\t}
\tMaterial: 4000000, "mat", "" {
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tMultiLayer: 0
\t}
\tAnimationStack: 3000000, "Take 001", "" {
\t\tProperties70: {
\t\t\tP: "LocalStop", "KTime", "Time", "",${Math.round(2 * KTIME_PER_SECOND)}
\t\t\tP: "ReferenceStop", "KTime", "Time", "",${Math.round(2 * KTIME_PER_SECOND)}
\t\t}
\t}
\tAnimationLayer: 3000001, "BaseLayer", "" {
\t}
\tAnimationCurveNode: 3000002, "T", "" {
\t\tProperties70: {
\t\t\tP: "d|X", "Number", "", "A",0
\t\t\tP: "d|Y", "Number", "", "A",0
\t\t\tP: "d|Z", "Number", "", "A",0
\t\t}
\t}
\tAnimationCurve: 3000003, "", "" {
\t\tDefault: 0
\t\tKeyVer: 4008
\t\tKeyTime: *3 {
\t\t\ta: ${keyTimes}
\t\t}
\t\tKeyValueFloat: *3 {
\t\t\ta: 0,0.5,1
\t\t}
\t\tKeyAttrFlags: *1 {
\t\t\ta: 24836
\t\t}
\t\tKeyAttrDataFloat: *4 {
\t\t\ta: 0,0,0,0
\t\t}
\t\tKeyAttrRefCount: *1 {
\t\t\ta: 3
\t\t}
\t}
}
Connections:  {
\tC: "OO",1000000,2000000
\tC: "OO",2000000,0
\tC: "OO",4000000,2000000
\tC: "OO",3000000,0
\tC: "OO",3000001,3000000
\tC: "OO",3000002,3000001
\tC: "OP",3000002,2000000, "Lcl Translation"
\tC: "OP",3000003,3000002, "d|X"
}
`;
}

// ———————————————————— 小工具 ————————————————————

interface PackedSections {
  sections: Array<{ offset: number; byteLength: number }>;
  bytes: Uint8Array;
  byteLength: number;
}

/** 把各段 Float32/Uint16 数据按 4 字节对齐打包进一块连续内存 */
function packSections(parts: Array<Float32Array | Uint16Array>): PackedSections {
  const sections: Array<{ offset: number; byteLength: number }> = [];
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const part of parts) {
    const view = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    sections.push({ offset: cursor, byteLength: part.byteLength });
    chunks.push(view);
    cursor += part.byteLength;
    const padding = (4 - (cursor % 4)) % 4;
    if (padding !== 0) {
      chunks.push(new Uint8Array(padding));
      cursor += padding;
    }
  }
  const bytes = concatBytes(chunks);
  return { sections, bytes, byteLength: bytes.byteLength };
}

function dataUri(bytes: Uint8Array): string {
  // Buffer 在 Node/vitest 环境可用；fixture 只在测试里用
  const base64 = Buffer.from(bytes).toString('base64');
  return `data:application/octet-stream;base64,${base64}`;
}
