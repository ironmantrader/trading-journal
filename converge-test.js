// จำลอง Mac + PC คุยกับ cloud ก้อนเดียว แล้วดูว่าจบลงที่ข้อมูลชุดเดียวกันจริงไหม
const fs = require('fs'), vm = require('vm');
const REPO = __dirname + '/index.html';
const html = fs.readFileSync(REPO, 'utf8');
const src = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];

// ดึงเฉพาะฟังก์ชันที่ตัดสินเรื่องการรวมข้อมูล ออกมารันนอก DOM
function grab(name, kind) {
  const re = new RegExp('^' + kind + ' ' + name + '\\b[\\s\\S]*?^}', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('extract failed: ' + name);
  return m[0];
}
const pieces = [
  /^const LISTS=.*$/m.exec(src)[0],
  grab('recordCount', 'function'),
  grab('recSig', 'function'),
  grab('dataSig', 'function'),
  grab('stampChanges', 'function'),
  grab('mergeDB', 'function'),
  grab('restoreMerge', 'function'),
];
const ctx = { DB: null, console };
vm.createContext(ctx);
// const ไม่กลายเป็น property ของ context เอง ต้องยกออกมาให้เอง
pieces.push('globalThis.LISTS=LISTS;');
new vm.Script(pieces.join('\n')).runInContext(ctx);

// เครื่องหนึ่งเครื่อง = localStorage ของตัวเอง + นาฬิกาของตัวเอง
function Device(name, skewMs) {
  return {
    name,
    local: { trades: [], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 0 },
    // saveDB(): ประทับ ut ให้เฉพาะที่เปลี่ยน แล้วเขียนลงเครื่อง
    save(mutate) {
      const prev = JSON.parse(JSON.stringify(this.local));
      ctx.DB = this.local;
      mutate(ctx.DB);
      const realNow = Date.now;
      Date.now = () => realNow() + skewMs;   // นาฬิกาเครื่องนี้เดินคลาด
      try { ctx.stampChanges(prev); } finally { Date.now = realNow; }
      ctx.DB.updatedAt = Date.now() + skewMs;
      this.local = ctx.DB;
    },
    // loadFromCloud(): merge cloud เข้ากับ local แล้วดันกลับขึ้นไปถ้าต่างกัน
    sync(cloud) {
      const merged = ctx.mergeDB(cloud.doc, this.local);
      merged.updatedAt = Math.max(cloud.doc.updatedAt || 0, this.local.updatedAt || 0);
      this.local = merged;
      if (ctx.dataSig(merged) !== ctx.dataSig(cloud.doc)) cloud.doc = JSON.parse(JSON.stringify(merged));
      return merged;
    },
  };
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '\n       ' + extra : '')); }
}
const ids = o => ctx.LISTS.flatMap(k => (o[k] || []).map(r => r.id)).sort();

console.log('\n1) ต่างเครื่องเพิ่มคนละรายการตอนออฟไลน์ แล้วค่อยซิงค์');
{
  const cloud = { doc: { trades: [], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 0 } };
  const mac = Device('mac', 0), pc = Device('pc', -180000); // PC ช้ากว่า 3 นาที
  mac.save(d => d.trades.push({ id: 'A', d: '2026-08-16', pnl: 100 }));
  pc.save(d => d.trades.push({ id: 'B', d: '2026-08-16', pnl: -50 }));
  mac.sync(cloud); pc.sync(cloud); mac.sync(cloud);
  check('ทั้งสองเครื่องมีครบทั้ง A และ B', JSON.stringify(ids(mac.local)) === JSON.stringify(['A', 'B']) && JSON.stringify(ids(pc.local)) === JSON.stringify(['A', 'B']),
    'mac=' + ids(mac.local) + '  pc=' + ids(pc.local));
  check('ข้อมูลสองเครื่องตรงกันเป๊ะ', ctx.dataSig(mac.local) === ctx.dataSig(pc.local));
  check('cloud ตรงกับเครื่อง', ctx.dataSig(cloud.doc) === ctx.dataSig(mac.local));
}

console.log('\n2) แก้รายการเดียวกันคนละเครื่อง โดยเครื่องที่แก้ทีหลังมีนาฬิกาช้ากว่า');
{
  const cloud = { doc: { trades: [{ id: 'A', d: '2026-08-16', pnl: 100 }], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 1 } };
  const mac = Device('mac', 0), pc = Device('pc', -180000);
  mac.sync(cloud); pc.sync(cloud);
  mac.save(d => { d.trades[0].pnl = 200; });
  mac.sync(cloud);
  pc.sync(cloud);                        // PC รับของใหม่มาก่อน
  pc.save(d => { d.trades[0].pnl = 999; }); // แล้วค่อยแก้ทับ ทั้งที่นาฬิกาช้ากว่า
  pc.sync(cloud); mac.sync(cloud);
  check('การแก้ครั้งหลังสุดชนะ แม้นาฬิกาเครื่องนั้นช้ากว่า', mac.local.trades[0].pnl === 999, 'ได้ pnl=' + mac.local.trades[0].pnl);
  check('สองเครื่องตรงกัน', ctx.dataSig(mac.local) === ctx.dataSig(pc.local));
}

console.log('\n3) ลบที่เครื่องหนึ่ง ต้องไม่ฟื้นกลับมาจากอีกเครื่อง');
{
  const cloud = { doc: { trades: [{ id: 'A', d: '2026-08-16', pnl: 100 }, { id: 'B', d: '2026-08-16', pnl: 5 }], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 1 } };
  const mac = Device('mac', 0), pc = Device('pc', 0);
  mac.sync(cloud); pc.sync(cloud);
  mac.save(d => { d.trades = d.trades.filter(r => r.id !== 'A'); });
  mac.sync(cloud); pc.sync(cloud); mac.sync(cloud);
  check('A ไม่ฟื้นกลับมาที่เครื่องไหนเลย', !ids(mac.local).includes('A') && !ids(pc.local).includes('A'),
    'mac=' + ids(mac.local) + '  pc=' + ids(pc.local));
  check('B ยังอยู่ครบ', ids(pc.local).includes('B'));
}

console.log('\n4) ซิงค์ซ้ำ ๆ โดยไม่มีใครแก้อะไร ต้องนิ่ง (ไม่เขียนวน)');
{
  const cloud = { doc: { trades: [{ id: 'A', d: '2026-08-16', pnl: 1, ut: 5 }], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 9 } };
  const mac = Device('mac', 0);
  mac.sync(cloud);
  const before = ctx.dataSig(cloud.doc);
  for (let i = 0; i < 5; i++) mac.sync(cloud);
  check('cloud ไม่ถูกเขียนซ้ำโดยไม่จำเป็น', ctx.dataSig(cloud.doc) === before);
}

console.log('\n5) เครื่องใหม่ที่ยังไม่เคยมีข้อมูล เปิดครั้งแรกต้องได้ของครบ');
{
  const cloud = { doc: { trades: [{ id: 'A', ut: 3 }, { id: 'B', ut: 4 }], postTrade: [], tradelog: [], diary: [], portfolio: { capital: 1000 }, portfolioTs: 7, deleted: {}, updatedAt: 9 } };
  const fresh = Device('new-pc', 0);
  fresh.sync(cloud);
  check('ได้ทุกรายการจาก cloud', JSON.stringify(ids(fresh.local)) === JSON.stringify(['A', 'B']), 'ได้ ' + ids(fresh.local));
  check('ได้ portfolio มาด้วย', fresh.local.portfolio.capital === 1000);
}

console.log('\n6) รูป Mascot ต้องตามไปอีกเครื่อง และตัวที่เปลี่ยนทีหลังต้องชนะ');
{
  const cloud = { doc: { trades: [], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 0 } };
  const mac = Device('mac', 0), pc = Device('pc', 0);
  mac.save(d => { d.mascot = 'data:image/webp;base64,AAAA'; });
  mac.sync(cloud); pc.sync(cloud);
  check('PC ได้รูปจาก Mac', pc.local.mascot === 'data:image/webp;base64,AAAA', 'ได้ ' + pc.local.mascot);
  check('การเปลี่ยนรูปทำให้ลายเซ็นต่างจริง', ctx.dataSig({ mascotTs: 1 }) !== ctx.dataSig({ mascotTs: 2 }));
  pc.save(d => { d.mascot = 'data:image/webp;base64,BBBB'; });
  pc.sync(cloud); mac.sync(cloud);
  check('รูปที่เปลี่ยนทีหลังชนะทั้งสองเครื่อง', mac.local.mascot === 'data:image/webp;base64,BBBB' && pc.local.mascot === mac.local.mascot,
    'mac=' + mac.local.mascot);
}

console.log('\n7) ไม่มีรูปเลย ต้องไม่กลายเป็น undefined (Firestore เขียน undefined ไม่ได้)');
{
  const cloud = { doc: { trades: [{ id: 'A', ut: 1 }], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 1 } };
  const mac = Device('mac', 0);
  const merged = mac.sync(cloud);
  check('mascot เป็น string เสมอ', typeof merged.mascot === 'string', 'ได้ ' + typeof merged.mascot);
  check('ไม่มี undefined หลงอยู่ในก้อนที่จะเขียนขึ้น cloud',
    !JSON.stringify(Object.entries(merged).map(([k, v]) => [k, v === undefined])).includes('true'));
}

console.log('\n8) แก้แผน Portfolio รัว ๆ จากเครื่องที่นาฬิกาช้ากว่า ของใหม่ต้องไม่แพ้ของเก่า');
{
  const cloud = { doc: { trades: [], postTrade: [], tradelog: [], diary: [], portfolio: {}, deleted: {}, updatedAt: 0 } };
  const mac = Device('mac', 0), pc = Device('pc', -180000);
  mac.save(d => { d.portfolio = { capital: 1000, risk: 1 }; });
  mac.sync(cloud); pc.sync(cloud);
  pc.save(d => { d.portfolio = { capital: 2000, risk: 2 }; }); // นาฬิกาช้ากว่า 3 นาที
  pc.sync(cloud); mac.sync(cloud);
  check('แผนที่แก้ทีหลังชนะทั้งสองเครื่อง', mac.local.portfolio.capital === 2000 && pc.local.portfolio.capital === 2000,
    'mac=' + JSON.stringify(mac.local.portfolio) + ' pc=' + JSON.stringify(pc.local.portfolio));
  const t1 = mac.local.portfolioTs;
  mac.save(d => { d.portfolio = { capital: 3000, risk: 3 }; }); // แก้ซ้ำในมิลลิวินาทีเดียวกัน
  check('แก้ซ้ำติดกันได้ ts ที่เดินหน้าเสมอ', mac.local.portfolioTs > t1, t1 + ' -> ' + mac.local.portfolioTs);
}

console.log('\n9) กู้คืนสำเนาหลังเผลอลบทิ้ง — เคสที่ต้องใช้สำเนาจริง ๆ');
{
  const mac = Device('mac', 0);
  mac.save(d => { d.trades.push({ id: 'A', d: '2026-08-10', pnl: 100 }, { id: 'B', d: '2026-08-11', pnl: 50 }); });
  const backup = JSON.parse(JSON.stringify(mac.local));   // สำเนาของเมื่อวาน
  mac.save(d => { d.trades.push({ id: 'C', d: '2026-08-16', pnl: 20 }); }); // จดเพิ่มวันนี้
  mac.save(d => { d.trades = d.trades.filter(r => r.id === 'C'); });        // เผลอลบ A กับ B
  check('ก่อนกู้: A กับ B หายไปจริง', !ids(mac.local).includes('A') && !ids(mac.local).includes('B'));

  ctx.DB = mac.local;
  const restored = ctx.restoreMerge(backup, mac.local);
  check('กู้แล้ว A กับ B กลับมา', ids(restored).includes('A') && ids(restored).includes('B'), 'ได้ ' + ids(restored));
  check('ของที่จดหลังสำเนา (C) ยังอยู่', ids(restored).includes('C'));
  check('tombstone ถูกปลดแล้ว ไม่ลบซ้ำอีกรอบ', !(restored.deleted || {}).A && !(restored.deleted || {}).B);

  // ต้องอยู่รอดข้ามการซิงค์รอบถัดไป ไม่ใช่กลับมาแล้วโดนอีกเครื่องลบซ้ำ
  const cloud = { doc: JSON.parse(JSON.stringify(mac.local)) };
  mac.local = restored;
  mac.sync(cloud);
  check('ซิงค์ต่อแล้วยังอยู่ ไม่โดน tombstone เก่าลบซ้ำ', ids(mac.local).includes('A') && ids(mac.local).includes('B'),
    'ได้ ' + ids(mac.local));
}

console.log('\n10) สำเนาเก่าต้องไม่ลากของที่จดหลังจากนั้นหายไปด้วย');
{
  const mac = Device('mac', 0);
  mac.save(d => { d.trades.push({ id: 'A', d: '2026-08-10' }, { id: 'X', d: '2026-08-10' }); });
  mac.save(d => { d.trades = d.trades.filter(r => r.id !== 'X'); });  // ลบ X ทิ้งอย่างตั้งใจ
  const backup = JSON.parse(JSON.stringify(mac.local));               // สำเนามี tombstone ของ X
  mac.save(d => { d.trades.push({ id: 'X', d: '2026-08-16' }); });    // ภายหลังจด X ใหม่
  ctx.DB = mac.local;
  const restored = ctx.restoreMerge(backup, mac.local);
  check('X ที่จดใหม่ไม่ถูก tombstone ในสำเนาลบทิ้ง', ids(restored).includes('X'), 'ได้ ' + ids(restored));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'ผ่านหมด ' + pass + ' ข้อ'));
process.exit(fail ? 1 : 0);
