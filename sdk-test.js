// โหลดหน้าจริงในเบราว์เซอร์จริง (headless) แล้วดูว่า Firebase ตั้งต้นได้ครบไหม
// เทียบ main กับ branch ทีละตัวด้วยไฟล์เดียวกันทุกอย่างยกเว้นเวอร์ชัน SDK
const http = require('http'), { execSync } = require('child_process'), puppeteer = require('puppeteer');

const REPO = __dirname;
const targets = [
  { name: 'main', ref: 'main' },
  { name: 'HEAD', ref: 'HEAD' },
];

async function run(ref, label) {
  const html = execSync(`git -C ${REPO} show ${ref}:index.html`, { maxBuffer: 64e6 }).toString();
  const server = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html) });
  await new Promise(r => server.listen(5199, r));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [], warnings = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/favicon|net::ERR/.test(t)) errors.push('CONSOLE: ' + t);
    if (m.type() === 'warning') warnings.push(t.slice(0, 90));
  });

  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));   // ให้ SDK ตั้งต้นและ onAuthStateChanged ยิงก่อน

  const probe = await page.evaluate(() => ({
    sdk: (window.firebase && firebase.SDK_VERSION) || null,
    appReady: !!(window.firebase && firebase.apps && firebase.apps.length),
    // auth/db ประกาศด้วย const จึงไม่ขึ้นไปอยู่บน window ต้องอ้างชื่อตรง ๆ
    authReady: typeof auth !== 'undefined' && typeof auth.onAuthStateChanged === 'function',
    dbReady: typeof db !== 'undefined' && typeof db.collection === 'function',
    persistence: typeof db !== 'undefined' && typeof db.enablePersistence === 'function',
    serverTs: !!(window.firebase && firebase.firestore && firebase.firestore.FieldValue &&
      typeof firebase.firestore.FieldValue.serverTimestamp === 'function'),
    provider: !!(window.firebase && firebase.auth && typeof firebase.auth.GoogleAuthProvider === 'function'),
    // ฟังก์ชันเหล่านี้ถูกประกาศ "หลัง" บรรทัด enablePersistence ในสคริปต์เดียวกัน
    // ถ้าบรรทัดนั้นโยน ทั้งชุดจะหายไปพร้อมกัน — เป็นตัวชี้ว่าสคริปต์รันจบจริง
    fns: ['saveDB', 'loadFromCloud', 'forceSync', 'mergeDB', 'restoreMerge', 'autoBackup', 'checkSize']
      .filter(f => typeof window[f] !== 'function'),
    badge: (document.getElementById('syncText') || {}).textContent,
    tabs: document.querySelectorAll('.tab-content').length,
  }));

  await browser.close();
  await new Promise(r => server.close(r));
  return { label, errors, warnings, probe };
}

(async () => {
  const out = [];
  for (const t of targets) out.push(await run(t.ref, t.name));

  let bad = 0;
  for (const r of out) {
    console.log('\n=== ' + r.label + ' ===');
    console.log('  firebase.SDK_VERSION   ' + r.probe.sdk);
    console.log('  initializeApp          ' + (r.probe.appReady ? 'ok' : 'FAIL'));
    console.log('  auth พร้อม              ' + (r.probe.authReady ? 'ok' : 'FAIL'));
    console.log('  firestore พร้อม         ' + (r.probe.dbReady ? 'ok' : 'FAIL'));
    console.log('  enablePersistence      ' + (r.probe.persistence ? 'ยังมี' : 'ไม่มีแล้ว (guard ทำงาน)'));
    console.log('  serverTimestamp        ' + (r.probe.serverTs ? 'ok' : 'FAIL'));
    console.log('  GoogleAuthProvider     ' + (r.probe.provider ? 'ok' : 'FAIL'));
    console.log('  ฟังก์ชันที่หายไป          ' + (r.probe.fns.length ? r.probe.fns.join(', ') : 'ไม่มี — สคริปต์รันจบ'));
    console.log('  ป้ายสถานะ               ' + JSON.stringify(r.probe.badge));
    console.log('  แท็บที่วาดได้            ' + r.probe.tabs);
    if (r.errors.length) { console.log('  ERROR:'); r.errors.forEach(e => console.log('    ' + e)); }
    else console.log('  ไม่มี error');
    const ok = r.probe.appReady && r.probe.authReady && r.probe.dbReady && r.probe.serverTs &&
      r.probe.provider && !r.probe.fns.length && !r.errors.length && r.probe.tabs > 0;
    if (!ok) bad++;
    console.log('  ผล                     ' + (ok ? 'ผ่าน' : 'ไม่ผ่าน'));
  }
  console.log('\n' + (bad ? bad + ' เป้าหมายไม่ผ่าน' : 'ผ่านทั้งสองเวอร์ชัน'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1) });
