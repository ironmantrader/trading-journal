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

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'ผ่านหมด ' + pass + ' ข้อ'));
process.exit(fail ? 1 : 0);
