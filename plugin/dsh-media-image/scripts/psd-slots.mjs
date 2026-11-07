// 把 PSD 模板拆成套版槽位：node scripts/psd-slots.mjs <file.psd> [--pretty]
import { readFileSync } from 'node:fs';
import { psdToTemplate, PsdError } from '../lib/psd.js';

const [, , file, ...flags] = process.argv;
if (!file) {
  console.error('用法: node scripts/psd-slots.mjs <file.psd> [--pretty]');
  process.exit(2);
}
try {
  const template = psdToTemplate(readFileSync(file), { name: file.split(/[\\/]/).pop() });
  console.log(JSON.stringify(flags.includes('--pretty') ? template : {
    name: template.name,
    canvas: template.canvas,
    slotCount: template.slotCount,
    summary: template.summary,
    slots: template.slots.map(slot => ({
      id: slot.id, name: slot.name, type: slot.type, rect: slot.rect,
      visible: slot.visible, opacity: slot.opacity,
      ...(slot.type === 'text' ? { text: slot.text, fontSize: slot.fontSize } : {}),
    })),
  }, null, flags.includes('--pretty') ? 2 : 0));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'PSD_FAILED', message: error.message }, null, 2));
  process.exit(error instanceof PsdError ? 3 : 1);
}
