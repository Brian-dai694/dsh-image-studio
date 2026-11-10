// XMP 预设解析：重点验证"能还原的映射"与"还原不了的如实上报"两件事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmp, mapToMiniPaint, planPresetFromXmp, UNMAPPED_KEYS } from '../lib/xmp-preset.js';

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

test('还原不了的字段必须逐条上报，并带上原因', () => {
  const { raw } = parseXmp(ATTRIBUTE_STYLE);
  const plan = mapToMiniPaint(raw);
  const keys = plan.unmapped.map(item => item.key);
  for (const key of ['Highlights2012', 'Shadows2012', 'Clarity2012']) {
    assert.ok(keys.includes(key), `${key} 应被登记为还原不了`);
    assert.equal(typeof plan.unmapped.find(item => item.key === key).reason, 'string');
  }
  // 值为 0 或缺失的不登记（避免噪声）
  assert.equal(keys.includes('Dehaze'), false);
});

test('全是不可还原字段时，明确说不要假装套用', () => {
  const plan = planPresetFromXmp(ELEMENT_STYLE.replace('<crs:Exposure2012>1.20</crs:Exposure2012>', '')
    .replace('<crs:Contrast2012>-30</crs:Contrast2012>', ''));
  assert.equal(plan.executable, false, JSON.stringify(plan));
  assert.match(plan.note, /都还原不了/);
  assert.ok(plan.unmapped.length >= 2);
  assert.ok(plan.unmapped.some(item => item.key === 'GrainAmount'));
  assert.ok(plan.unmapped.some(item => item.key === 'SplitToningHighlightHue'));
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
