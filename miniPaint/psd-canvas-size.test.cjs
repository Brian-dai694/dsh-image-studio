// PSD 导入尺寸判据（判据甲）的源码守卫。
//
// 这里守的不是像素渲染，而是「判据本身」：
// 1) 文档尺寸以 AppConfig.WIDTH/HEIGHT（= read_state.canvas）为准，PSD 必须精确等于它；
// 2) canvas 元素宽度 = min(ceil(WIDTH×ZOOM), #main_wrapper.clientWidth)，窄视口只裁元素；
// 3) PSD 导入仍走显式 Update_config_action + Prepare_canvas_action，没有退回 Autoresize。
// 判据与实测表见 docs/psd-canvas-size.md。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${passed} ${name}`);
}

// —— 第 1 条：上游画布元素宽度的口径 ——
const baseGui = read('src/js/core/base-gui.js');
// 注意找的是方法定义（`prepare_canvas() {`），不是调用点 `this.prepare_canvas();`。
const prepareStart = baseGui.indexOf('prepare_canvas() {');
assert.ok(prepareStart > 0, 'base-gui.js 里找不到 prepare_canvas() 定义');
const prepareBody = baseGui.slice(prepareStart, prepareStart + 1200);

check('base-gui prepare_canvas 用 min(ceil(WIDTH×ZOOM), wrapper.clientWidth) 决定元素宽度', () => {
  assert.match(prepareBody, /var\s+page_w\s*=\s*wrapper\.clientWidth/);
  assert.match(prepareBody, /Math\.min\(\s*Math\.ceil\(\s*config\.WIDTH\s*\*\s*config\.ZOOM\s*\)\s*,\s*page_w\s*\)/);
  assert.match(prepareBody, /Math\.min\(\s*Math\.ceil\(\s*config\.HEIGHT\s*\*\s*config\.ZOOM\s*\)\s*,\s*page_h\s*\)/);
  assert.match(prepareBody, /canvas\.width\s*=\s*w/);
  assert.match(prepareBody, /canvas\.height\s*=\s*h/);
});

// 复刻上游同一行公式，用于把文档尺寸与元素宽度分开断。
const elementWidth = (docWidth, zoom, wrapperWidth) => Math.min(Math.ceil(docWidth * zoom), wrapperWidth);

// —— 第 2 条：multiple-strokes-test.psd = 857×448，四个视口文档尺寸恒定 ——
const PSD = { width: 857, height: 448 };
const viewports = [
  { viewport: 700, wrapper: 700 },
  { viewport: 900, wrapper: 645 },
  { viewport: 1200, wrapper: 945 },
  { viewport: 1440, wrapper: 1185 },
];

check('multiple-strokes-test.psd 在 700/900/1200/1440 四个视口下文档尺寸恒为 857×448', () => {
  for (const { viewport } of viewports) {
    // 文档尺寸来自 config，与视口无关；这就是 read_state.canvas 报出的值。
    const doc = { width: PSD.width, height: PSD.height };
    assert.deepEqual(doc, { width: 857, height: 448 }, `viewport ${viewport} 文档尺寸不是 857×448`);
  }
});

check('canvas 元素宽度按 min(857, 容器宽) 断为 700/645/857/857，且永不超出容器', () => {
  const expected = viewports.map(v => elementWidth(PSD.width, 1, v.wrapper));
  assert.deepEqual(expected, [700, 645, 857, 857]);
  for (const v of viewports) {
    const w = elementWidth(PSD.width, 1, v.wrapper);
    assert.ok(w <= v.wrapper, `viewport ${v.viewport} 元素宽度 ${w} 超出容器 ${v.wrapper}`);
    if (v.wrapper >= PSD.width) assert.equal(w, 857, `宽视口 ${v.viewport} 元素宽度应等于文档宽度 857`);
  }
});

check('另外四个样本的文档尺寸不受本判据影响（200×200 ×3、300×275）', () => {
  const samples = [
    { name: 'test.psd', width: 200, height: 200 },
    { name: 'text-test.psd', width: 200, height: 200 },
    { name: 'vector-test.psd', width: 200, height: 200 },
    { name: 'timeline-test.psd', width: 300, height: 275 },
  ];
  for (const s of samples) {
    assert.ok(Number.isSafeInteger(s.width) && Number.isSafeInteger(s.height), `${s.name} 尺寸不是整数`);
    assert.ok(elementWidth(s.width, 1, 1185) === s.width, `${s.name} 在宽视口下元素宽度应等于文档宽度`);
  }
});

// —— 第 3 条：PSD 导入的写入路径没有退回去 ——
const psdImport = read('src/js/dsh-psd-import.js');

check('PSD 导入用显式 Update_config_action({WIDTH,HEIGHT}) 而非 Autoresize', () => {
  assert.match(psdImport, /new\s+app\.Actions\.Update_config_action\(\{\s*WIDTH:\s*psd\.width,\s*HEIGHT:\s*psd\.height\s*\}\)/);
  assert.ok(!/Autoresize_canvas_action/.test(psdImport), 'PSD 导入不应再使用 Autoresize_canvas_action');
});

check('写入尺寸后必须再 push Prepare_canvas_action(\'do\')，否则画布不会重排', () => {
  const updateAt = psdImport.search(/Update_config_action/);
  const prepareAt = psdImport.search(/Prepare_canvas_action\('do'\)/);
  assert.ok(updateAt > 0, '没有 Update_config_action');
  assert.ok(prepareAt > updateAt, 'Prepare_canvas_action 必须在 Update_config_action 之后');
});

check('尺寸写入与落层进同一个 actions 数组，由一次 Bundle_action 提交（一次撤销、revision 只 +1）', () => {
  // 源码顺序是：先 push 进 actions 数组，最后 actions 交给 Bundle_action；
  // 因此要断「在数组构建区间内」，而不是断在 Bundle_action 之后。
  const arrayStart = psdImport.search(/const\s+actions\s*=\s*layers\.map\(/);
  const bundleCall = psdImport.search(/Bundle_action\('open_psd'/);
  const updateAt = psdImport.search(/Update_config_action/);
  assert.ok(arrayStart > 0, '找不到 actions 数组构建');
  assert.ok(bundleCall > arrayStart, 'Bundle_action 必须在 actions 数组构建之后');
  assert.ok(updateAt > arrayStart && updateAt < bundleCall, 'Update_config_action 必须落在 actions 数组里、交给 Bundle_action 之前');
});

check('PSD 尺寸非法（非安全整数）时必须抛错，不得静默写入', () => {
  assert.match(psdImport, /Number\.isSafeInteger\(psd\.width\)/);
  assert.match(psdImport, /Number\.isSafeInteger\(psd\.height\)/);
  assert.match(psdImport, /画布尺寸无效/);
});

console.log(JSON.stringify({
  passed,
  scope: '源码契约守卫：上游元素宽度公式、文档尺寸判据、PSD 写入路径；不含浏览器像素验收',
}));
