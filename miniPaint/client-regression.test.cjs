// Client-only regression checks. Real native State methods; no browser acceptance claim.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file === 'src/js/core/gui/gui-tools.js' && process.env.TEST_GUI_SOURCE ? process.env.TEST_GUI_SOURCE : file), 'utf8');
function stateFixture() {
  const config = { need_render: false };
  let renderRequests = 0;
  const context = vm.createContext({ config, console,
    Base_layers_class: function () { return { render() { renderRequests++; config.need_render = true; } }; },
    Base_gui_class: function () {}, Helper_class: function () { this.is_input = () => false; },
    document: { addEventListener() {} }, window: {}, app: {}, alertify: { success() {}, error() {} }
  });
  const source = read('src/js/core/base-state.js').replace(/^import .*;\r?\n/gm, '').replace(/export default .*;\s*$/m, '');
  const State = vm.runInContext(source + '\nBase_state_class', context);
  return { state: new State(), config, renders: () => renderRequests };
}
let passed = 0, failed = 0;
async function test(label, run) {
  try { await run(); console.log('PASS: ' + label); passed++; }
  catch (error) { console.error('FAIL: ' + label + '\n' + error.message); failed++; }
}
(async () => {
  for (const [entry, method] of [['undo', 'undo_action'], ['redo', 'redo_action']]) {
    await test(entry + ' exposes the native asynchronous completion Promise', async () => {
      const { state } = stateFixture();
      let release, settled = false;
      const gate = new Promise(resolve => { release = resolve; });
      state[method] = async () => { await gate; settled = true; };
      const completion = state[entry]();
      const awaitable = !!completion && typeof completion.then === 'function';
      release(); await completion;
      assert.equal(awaitable, true, entry + ' must return the queue/native Promise');
      assert.equal(settled, true);
    });
  }
  await test('failed undo retains the history cursor for a retry', async () => {
    const { state } = stateFixture();
    state.action_history = [{ async undo() { throw new Error('native undo failure'); } }];
    state.action_history_index = 1;
    await assert.rejects(state.undo_action(), /native undo failure/);
    assert.equal(state.action_history_index, 1, 'cursor must move only after undo completes');
  });
  await test('undo and redo request canvas refresh only after the action settles', async () => {
    const fixture = stateFixture(), { state } = fixture;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    state.action_history = [{ async undo() { await gate; }, async do() {} }];
    state.action_history_index = 1;
    const completion = state.undo_action();
    assert.equal(fixture.renders(), 0);
    release(); await completion;
    assert.equal(state.action_history_index, 0);
    assert.equal(fixture.renders(), 1, 'undo must request a native canvas render');
    await state.redo_action();
    assert.equal(state.action_history_index, 1);
    assert.equal(fixture.renders(), 2, 'redo must request a native canvas render');
  });
  await test('confirmed dynamic text controls and tool names have Chinese dictionary keys', () => {
    const zh = JSON.parse(read('src/js/languages/zh.json'));
    for (const key of ['Stroke:', 'Stroke size:', 'bold', 'italic', 'Bold', 'Italic', 'Desaturate', 'Increase', 'Decrease']) {
      assert.ok(zh[key] && /[\u3400-\u9fff]/.test(zh[key]), 'missing Chinese translation: ' + key);
    }
  });
  await test('number step buttons expose their existing labels to the translator', () => {
    const source = read('src/js/core/components/number-input.js');
    for (const label of ['Increase', 'Decrease']) {
      assert.match(source, new RegExp('<span class="[^"]*\\btrn\\b[^"]*">' + label + '</span>'));
    }
  });
  await test('text style icon alt labels participate in translation with matching keys', () => {
    const source = read('src/js/core/gui/gui-tools.js');
    assert.match(source, /<img class="trn"[^>]*alt="/);
    const zh = JSON.parse(read('src/js/languages/zh.json'));
    for (const key of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'bold', 'italic', 'underline', 'strikethrough']) {
      assert.ok(zh[key] && /[\u3400-\u9fff]/.test(zh[key]), 'missing icon alt/title translation: ' + key);
    }
  });
  await test('real GUI generator and translator retain attached Chinese icon alt labels on repeated translation', () => {
    const zh = JSON.parse(read('src/js/languages/zh.json'));
    const dictionary = Object.fromEntries(Object.entries(zh).map(([key, value]) => [key, { zh: value, en: key }]));
    function element(tag) {
      const el = { tag, attrs: {}, children: [], addEventListener() {},
        setAttribute(key, value) { this.attrs[key] = String(value); },
        appendChild(child) { this.children.push(child); }
      };
      Object.defineProperty(el, 'attributes', { get() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); } });
      Object.defineProperty(el, 'className', { get() { return this.attrs.class || ''; }, set(value) { this.attrs.class = value; } });
      Object.defineProperty(el, 'title', { get() { return this.attrs.title; }, set(value) { this.attrs.title = value; } });
      Object.defineProperty(el, 'innerHTML', { get() { return this.markup || ''; }, set(value) {
        this.markup = value; this.children = [];
        if (value.startsWith('<img ')) {
          const image = element('img');
          for (const match of value.matchAll(/([\w-]+)="([^"]*)"/g)) image.attrs[match[1]] = match[2];
          this.children.push(image);
        }
      } });
      el.classList = { add(name) { el.className += ' ' + name; }, remove(name) { el.className = el.className.split(/\s+/).filter(value => value !== name).join(' '); } };
      return el;
    }
    const root = element('div');
    function wrapper(items) { this.items = items; }
    wrapper.prototype.find = function () {
      const found = [];
      const visit = el => { for (const child of el.children) { if (child.className.split(/\s+/).includes('trn')) found.push(child); visit(child); } };
      this.items.forEach(visit); return new wrapper(found);
    };
    wrapper.prototype.each = function (callback) { this.items.forEach((el, index) => callback.call(el, index)); return this; };
    wrapper.prototype.attr = function (key, value) { if (value === undefined) return this.items[0].attrs[key]; this.items[0].attrs[key] = value; return this; };
    wrapper.prototype.html = function (value) { if (value === undefined) return this.items[0].innerHTML; this.items[0].innerHTML = value; return this; };
    const $ = el => new wrapper([el]); $.fn = wrapper.prototype; $.extend = Object.assign;
    $.inArray = (value, values) => values.indexOf(value);
    $.each = (values, callback) => values.forEach(value => callback.call(value));
    const context = vm.createContext({ $, jQuery: $, config: { LANG: 'zh', TOOLS: [{ name: 'text', attributes: Object.fromEntries(['bold', 'italic', 'underline', 'strikethrough'].map(key => [key, { value: false, icon: key + '.svg' }])) }] },
      document: { createElement: element, getElementById() { return root; } }, app: {}, alertify: {},
      Helper_class: function () {}, Base_gui_class: function () {},
      Tools_translate_class: function () { this.translate_message = key => zh[key] || key; this.translate = lang => $(root).translate({ lang, t: dictionary }); }
    });
    vm.runInContext(read('src/js/libs/jquery.translate.js'), context);
    const source = read('src/js/core/gui/gui-tools.js').replace(/^import .*;\r?\n/gm, '').replace(/export default .*;\s*$/m, '');
    const GUI = vm.runInContext(source + '\nGUI_tools_class', context);
    const gui = new GUI(); gui.active_tool = 'text'; gui.show_action_attributes();
    gui.Tools_translate.translate('zh');
    const group = root.children[0].children[0];
    for (const button of group.children) {
      const image = button.children[0];
      assert.ok(image, 'icon remains attached');
      assert.equal(image.attrs.alt, zh[button.id[0].toUpperCase() + button.id.slice(1)]);
      assert.equal(button.title, zh[button.id]);
    }
    assert.equal(group.children.length, 4);
  });
  console.log(JSON.stringify({ passed, failed, scope: 'native State async/history/render requests and localization source checks; no browser' }));
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
