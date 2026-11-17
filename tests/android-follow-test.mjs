import assert from 'node:assert/strict';
import {followInset,followScroll} from '../android/app/src/main/assets/studio/android-follow.js';

// Positions use actual screen rectangles, including the list's top inset.
const normal={scroll:12000,cardTop:1100,cardHeight:125,viewTop:650,viewHeight:348,maxScroll:100000};
const scroll=followScroll(normal);
assert.ok(Math.abs((normal.cardTop-(scroll-normal.scroll))-(650+41.76))<.001);
assert.ok(scroll>normal.scroll,'An offscreen playing card must move inside the list');
assert.equal(followInset(700,100),48);
assert.equal(followInset(60,125),0,'An oversized card starts at the visible top');
assert.equal(followScroll({...normal,scroll:0,cardTop:655}),0,'The first card cannot scroll above the document');
assert.equal(followScroll({...normal,cardTop:999999,maxScroll:13000}),13000);
const clipped=followScroll({...normal,viewTop:730,viewHeight:180});
assert.ok(Math.abs((normal.cardTop-(clipped-normal.scroll))-(730+21.6))<.001);
console.log('Android phone follow: upper visible anchor, clipped viewport, oversized/first/last bounds passed');
