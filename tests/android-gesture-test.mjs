import assert from 'node:assert/strict';
import {twoFingerMode,pinchView} from '../android/app/src/main/assets/studio/android-gesture.js';

assert.equal(twoFingerMode(200,200,20),'range');
assert.equal(twoFingerMode(200,160,0),'pinch');
assert.equal(twoFingerMode(200,240,0),'pinch');
assert.equal(twoFingerMode(200,203,3),'');
const limits={min:2,max:1000};
const inward=pinchView(20,200,100,120,100,limits);
const outward=pinchView(20,200,400,120,100,limits);
assert.equal(inward.scale,10);assert.equal(outward.scale,40);
assert.ok(600/inward.scale>600/20);assert.ok(600/outward.scale<600/20);
assert.equal(inward.start+100/inward.scale,120);
assert.equal(outward.start+100/outward.scale,120);
assert.equal(pinchView(20,200,1e6,120,100,limits).scale,1000);
assert.equal(pinchView(20,200,0,120,100,limits).scale,2);
console.log('Android pinch direction, anchor, intent threshold and zoom limits passed');
