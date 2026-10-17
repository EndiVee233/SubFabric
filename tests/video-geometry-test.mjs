import assert from 'node:assert/strict';
import { VideoCueEditor } from './jsmod/videoedit.js';

const editor = Object.create(VideoCueEditor.prototype);
editor._mctx = {
  font: '',
  measureText(value) {
    const text = String(value);
    return { width: text.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
  }
};
editor.api = { styleOf: () => ({ fontname: 'Test Sans', fontsize: 50, bold: -1, italic: -1, scalex: 120, scaley: 110, spacing: 2, alignment: 2, marginl: 40, marginr: 40, marginv: 20 }), playResY: () => 1000 };
const layout = editor._layoutAss({ plain: 'abcd' }, { left: 0, top: 0, width: 1920, height: 1080 });

assert.match(editor._mctx.font, /italic 700 54\.00px "Test Sans"/i, 'ASS geometry uses the declared family, bold and italic style');
assert.ok(Math.abs(layout.adv.at(-1) - 54.48) < 0.001, 'character advances include horizontal scale and letter spacing');
assert.ok(Math.abs(layout.x0 - (1920 - 54.48) / 2) < 0.001, 'center alignment uses measured styled width');
assert.ok(layout.lineH > 50, 'line height accounts for font metrics and vertical scale');
console.log('Video subtitle geometry: ASS font family, weight, italic, scale and spacing feed hit-box calculations');
