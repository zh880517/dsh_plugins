// 单位体检（设计文档 §3.3）：模型单位当米读，真人尺寸的包围盒高度若远超常识，
// 大概率是 FBX 厘米没换算。阈值 10m 来自设计文档「人形 > 10m 报警」。
export function unitWarnings(heightModelUnits: number | null): string[] {
  if (heightModelUnits === null) return [];
  if (heightModelUnits > 10) {
    return [
      `疑似单位错误：包围盒高度 ${trimNumber(heightModelUnits)}（模型单位），像厘米未换算的 FBX（Max/Maya/Mixamo 常见）。` +
        '导出时勾选单位换算（FBX UnitScaleFactor）或给根节点乘 0.01；只做信息分析时可以忽略本提示。',
    ];
  }
  return [];
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
