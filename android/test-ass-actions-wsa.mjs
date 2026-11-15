import {connect} from './cdp.mjs';import assert from 'node:assert/strict';import {assFixture} from './ass-fixture.mjs';
const c=await connect();const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function menu(label){await c.evaluate(`[...document.querySelectorAll('#android-more button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);await wait(160);}
try{
const original=await c.evaluate('__dbg.state.project.id');
await menu('拆分字幕');assert.ok(await c.evaluate('!!document.querySelector(".android-split-dialog[open]")'));await c.evaluate('document.querySelector(".android-split-dialog button").click()');await wait(200);assert.equal(await c.evaluate('__dbg.state.items.length'),3);
await c.evaluate('__dbg.selectItem(__dbg.state.items[1],false)');await menu('合并上一句');await wait(150);assert.equal(await c.evaluate('__dbg.state.items.length'),2);
await menu('添加字幕');await c.evaluate(`(()=>{const ed=__dbg.panel.editorEl;ed.querySelector('.ie-l1').textContent='新增字幕验收';ed.querySelector('.ie-l2').textContent='New sentence.';__dbg.panel.commitEdit()})()`);await wait(120);await c.evaluate('__subfabricFlushSave()');assert.equal(await c.evaluate('__dbg.state.items.length'),3);
console.log('Touch-accessible split / merge / add actions: passed');
const header=assFixture.slice(0,assFixture.indexOf('Comment:'));
const empty=await c.evaluate(`androidStudio.create('空 ASS 验收',${JSON.stringify(header)},'empty.ass')`);await c.evaluate(`location.hash='#/project/${empty.id}'`);await wait(500);assert.equal(await c.evaluate('__dbg.state.project.id'),empty.id);assert.equal(await c.evaluate('__dbg.state.items.length'),0);
await menu('添加字幕');await wait(500);assert.equal(await c.evaluate('__dbg.state.project.id'),empty.id);assert.ok(await c.evaluate('__dbg.state.items.length>0'));console.log('Empty ASS reopen and add first event without save conflict: passed');
await c.evaluate(`location.hash='#/project/${original}'`);
}finally{c.close();}
