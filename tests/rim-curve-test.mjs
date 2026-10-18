import assert from 'node:assert/strict';
import { RIM_DEFAULTS, RIM_SELECTOR, rimActive, rimParams, rimMap, makeField, sampleField } from './jsmod/rim-curve.js';

let count = 0;
const check = fn => { fn(); count++; };

const tokens = {
  '--accent': '#5789dc',
  '--tertiary-container': '#e4d7ea',
  '--secondary-container': '#d9dae8',
  '--on-container': '#182539',
  '--accent-soft': '#d3dded'
};

check(() => assert.equal(RIM_SELECTOR, '.sf-choice-menu,.sf-rim-sample', '只有二级弹层和实时预览挂环'));
check(() => assert.equal(rimActive('material-you'), true));
check(() => assert.equal(rimActive('material-you', false), false));
check(() => assert.equal(rimActive('studio'), false));
check(() => assert.equal(rimActive('material-you-custom'), false));

const defaults = rimParams({});
check(() => assert.deepEqual(defaults, RIM_DEFAULTS));
check(() => assert.deepEqual(rimParams({ rimSatLow: 0, rimBriGain: 99, rimSpecBase: 0, rimPower: 99 }),
  { rimSatLow: 0.70, rimBriGain: 0.80, rimSpecBase: 0.45, rimPower: 2.20 }));
check(() => assert.deepEqual(rimParams({ rimSatLow: 2, rimBriGain: -1, rimSpecBase: 2, rimPower: 0 }),
  { rimSatLow: 1.00, rimBriGain: 0.30, rimSpecBase: 0.75, rimPower: 1.00 }));

const low = rimMap(defaults, 0, 0.5);
const high = rimMap(defaults, 1, 0.5);
check(() => assert.ok(Math.abs(low.kSat - 1.10) < 1e-9));
check(() => assert.ok(Math.abs(high.kSat - 0.85) < 1e-9));
check(() => assert.ok(low.kBri < high.kBri));
check(() => assert.ok(low.kSpec < high.kSpec));

const samples = [0, 0.2, 0.4, 0.6, 0.8, 1].map(s => rimMap(defaults, s, 0.5));
for (let i = 1; i < samples.length; i++) {
  check(() => assert.ok(samples[i].kSat < samples[i - 1].kSat, 'kSat must fall as S rises'));
  check(() => assert.ok(samples[i].kBri > samples[i - 1].kBri, 'kBri must rise as S rises'));
}
for (const s of [0.6, 0.8, 1]) {
  check(() => assert.ok(s * rimMap(defaults, s, 0.5).kSat <= s + 1e-9, 'high-S border must not gain saturation'));
}
check(() => assert.ok(rimMap(defaults, 1, 0).kBri >= rimMap(defaults, 1, 1).kBri, 'dark field gets more lift'));

const lightField = makeField(tokens, false);
const darkField = makeField(tokens, true);
check(() => assert.ok(lightField.css.includes('radial-gradient')));
check(() => assert.ok(darkField.css.includes('linear-gradient')));
const light = sampleField(lightField, 0.22 * 1440, 0.22 * 900, 1440, 900);
const dark = sampleField(darkField, 0.22 * 1440, 0.22 * 900, 1440, 900);
check(() => assert.ok(light.s > 0.25 && light.s <= 1));
check(() => assert.ok(light.v >= 0 && light.v <= 1));
check(() => assert.ok(dark.v > light.v, 'light surface uses a darker field'));
check(() => assert.deepEqual(sampleField(null, 0, 0, 1, 1), { s: 0, v: 0 }));

check(() => assert.ok(rimMap(defaults, -1, -1).kSat <= 1.10));
check(() => assert.ok(rimMap(defaults, 2, 2).kSat >= 0.85));

console.log(`rim-curve-test: ${count} assertions passed`);
