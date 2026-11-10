// XMP 预设解析：重点验证"能还原的映射"与"还原不了的如实上报"两件事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmp, mapToMiniPaint, planPresetFromXmp, buildGrade, UNMAPPED_KEYS } from '../lib/xmp-preset.js';

// Lightroom 导出的典型写法：rdf:Description 上的属性。
const ATTRIBUTE_STYLE = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:PresetType="Normal"
    crs:Name="Cinematic Teal"
    crs:Exposure2012="+0.30"
    crs:Contrast2012="+18"
    crs:Highlights2012="-40"
    crs:Shadows2012="+25"
    crs:Temperature="-12"
    crs:Tint="+4"
    crs:Vibrance="+15"
    crs:Saturation="-5"
    crs:Clarity2012="+20"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

// 另一种写法：子元素文本（旧版或第三方导出）。
const ELEMENT_STYLE = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
   <crs:Exposure2012>1.20</crs:Exposure2012>
   <crs:Contrast2012>-30</crs:Contrast2012>
   <crs:SplitToningHighlightHue>45</crs:SplitToningHighlightHue>
   <crs:GrainAmount>25</crs:GrainAmount>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

test('属性写法与子元素写法都能解析出 crs 参数', () => {
  const a = parseXmp(ATTRIBUTE_STYLE);
  assert.equal(a.params.Exposure2012, '+0.30');
  assert.equal(a.params.Contrast2012, '+18');
  assert.equal(a.params.Temperature, '-12');
  assert.equal(a.raw.Highlights2012, '-40', '已知字段要进 raw');

  const b = parseXmp(ELEMENT_STYLE);
  assert.equal(b.params.Exposure2012, '1.20');
  assert.equal(b.params.Contrast2012, '-30');
  assert.equal(b.params.GrainAmount, '25');
});

test('非 Camera Raw 文件与空内容要明确报错，而不是返回空方案', () => {
  assert.throws(() => parseXmp(''), { code: 'XMP_EMPTY' });
  assert.throws(() => parseXmp('<x:xmpmeta><dc:title>x</dc:title></x:xmpmeta>'), { code: 'XMP_NO_CRS' });
});

test('曝光/对比/饱和度映射成 effects，并写明是近似', () => {
  const { raw } = parseXmp(ATTRIBUTE_STYLE);
  const plan = mapToMiniPaint(raw);
  assert.equal(plan.effects.brightness, 1.054, '0.30 EV → 1+0.3*0.18=1.054');
  assert.equal(plan.effects.contrast, 1.09, '+18 → 1+0.18*0.5');
  // 饱和 -5 + 自然饱和 +15*0.5 = 2.5 → 1.025
  assert.equal(plan.effects.saturate, 1.025);
  assert.ok(plan.assumptions.some(line => line.includes('非线性等值')), '必须写明这是近似');
  // 色温为负 → 冷色叠加
  const overlay = plan.overlays.find(item => item.color === '#6bb4ff');
  assert.ok(overlay, JSON.stringify(plan.overlays));
  assert.ok(overlay.opacity > 0 && overlay.opacity <= 0.35);
});

test('高光/阴影/分离色调现在走像素分级，不再列进 unmapped', () => {
  const { raw } = parseXmp(ATTRIBUTE_STYLE);
  const plan = mapToMiniPaint(raw);
  const keys = plan.unmapped.map(item => item.key);
  // 这三项已经能真算了，必须从"做不到"名单里消失
  for (const key of ['Highlights2012', 'Shadows2012', 'SplitToningHighlightHue']) {
    assert.equal(keys.includes(key), false, `${key} 已可分级，不该再报做不到`);
  }
  // 真正做不到的仍然要报
  assert.ok(keys.includes('Clarity2012'), JSON.stringify(keys));
  assert.equal(typeof plan.unmapped.find(item => item.key === 'Clarity2012').reason, 'string');
});

test('曲线与 8 色 HSL 被解析成 grade（真像素路径）', () => {
  const withCurve = `<x:xmpmeta><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Exposure2012="0.5"
    crs:HueAdjustmentRed="10" crs:SaturationAdjustmentRed="20" crs:LuminanceAdjustmentRed="15"
    crs:HueAdjustmentBlue="-8" crs:SaturationAdjustmentBlue="-12"
    crs:SplitToningHighlightHue="40" crs:SplitToningHighlightSaturation="25"
    crs:SplitToningShadowHue="210" crs:SplitToningShadowSaturation="30">
   <crs:ToneCurvePV2012>
    <rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>64, 80</rdf:li><rdf:li>128, 130</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq>
   </crs:ToneCurvePV2012>
  </rdf:Description></rdf:RDF></x:xmpmeta>`;
  const plan = planPresetFromXmp(withCurve);
  assert.ok(plan.grade, JSON.stringify(plan));
  assert.equal(plan.grade.exposure, 0.5);
  // 主曲线点被解析出来（顺序按 x 升序）
  assert.equal(plan.grade.curve.length, 4);
  assert.deepEqual(plan.grade.curve[1], { x: 64, y: 80 });
  // 分区 HSL：红色带三个通道、蓝色带两个
  assert.deepEqual(plan.grade.hsl.red, { hue: 10, sat: 20, lum: 15 });
  assert.deepEqual(plan.grade.hsl.blue, { hue: -8, sat: -12 });
  // 分离色调
  assert.deepEqual(plan.grade.splitTone, { highlightHue: 40, highlightSat: 25, shadowHue: 210, shadowSat: 30 });
  assert.equal(plan.executable, true);
  assert.match(plan.note, /像素分级/);
  assert.match(plan.note, /色相带 HSL/);
});

test('全是不可还原字段时，明确说不要假装套用', () => {
  // 只剩清晰度/去雾/纹理/锐化/颗粒/暗角——这些确实没有实现
  const onlyUnmappable = `<x:xmpmeta><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Clarity2012="30" crs:Dehaze="20" crs:Texture="15" crs:SharpenAmount="40"
    crs:GrainAmount="25" crs:VignetteAmount="-30"/>
  </rdf:RDF></x:xmpmeta>`;
  const plan = planPresetFromXmp(onlyUnmappable);
  assert.equal(plan.grade, null, '这些字段不该产出 grade');
  assert.equal(plan.executable, false, JSON.stringify(plan));
  assert.match(plan.note, /都还原不了/);
  assert.ok(plan.unmapped.length >= 5, JSON.stringify(plan.unmapped));
});

test('effects 数值落在编辑器允许的区间内（否则会被 validate 拒绝）', () => {
  const extreme = {
    Exposure2012: '20', Contrast2012: '-200', Saturation: '300', Vibrance: '100',
  };
  const plan = mapToMiniPaint(extreme);
  assert.ok(plan.effects.brightness >= 0.2 && plan.effects.brightness <= 3, String(plan.effects.brightness));
  assert.ok(plan.effects.contrast >= 0.5 && plan.effects.contrast <= 3, String(plan.effects.contrast));
  assert.ok(plan.effects.saturate >= 0.2 && plan.effects.saturate <= 3, String(plan.effects.saturate));
});

test('每个"还原不了"的字段都有原因文本（防以后加字段忘记写理由）', () => {
  for (const [key, reason] of Object.entries(UNMAPPED_KEYS)) {
    assert.equal(typeof reason, 'string', key);
    assert.ok(reason.length >= 6, `${key} 的原因太短`);
  }
});
