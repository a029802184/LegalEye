// 固定合成樣本，從 Git 還原 V2 實作並與目前工作區比較。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const localRequire = createRequire(import.meta.url);
const baseline = '225dc7a';

function loader(revision) {
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path).exports;
    const source = revision ? execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`, 'show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' })
      : readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    cache.set(path, module);
    const require = (specifier) => specifier.startsWith('.') ? load(posix.join(dirname(path).replaceAll('\\', '/'), specifier) + '.ts') : localRequire(specifier);
    new Function('module', 'exports', 'require', code)(module, module.exports, require);
    return module.exports;
  }
  return load;
}

const syntheticId = 'Y100000019';
const addr = '新北市甲區甲里20鄰甲路98巷3號5樓';
const names = ['林甲', '林測試', '陳測試'];
const addressCases = [
  [addr.replace('20鄰', '020鄰'), false, 'match'],
  [`241 ${addr}`, false, 'match'],
  [addr.replace('20鄰', '二十鄰').replace('5樓', '五樓'), false, 'match'],
  [addr.replace('98巷', '93巷'), true, 'needs-review'],
  [addr.replace('98巷', '89巷'), false, 'mismatch'],
  [addr.replace('5樓', '3樓'), false, 'mismatch'],
];

const doc = (id, role, text, scanned = false) => ({
  file: { id, name: `${id}.pdf`, path: `${id}.pdf`, kind: 'pdf' }, role, fullText: text, status: 'ok', warnings: [],
  pages: [{ page: 1, method: scanned ? 'ocr' : 'pdf-text', text, confidence: scanned ? 0.77 : 1 }],
});
const register = (name, text) => `戶籍謄本\n戶籍地址：${text}\n姓名：${name}國民身分證統一編號：${syntheticId}`;
const filed = doc('聲請狀', 'payment-order-petition', `支付命令聲請狀\n債務人：林測試\n身分證字號：${syntheticId}\n住所：${addr}`);

const v4 = process.argv.includes('--v4');
for (const [version, revision] of v4 ? [['V3', '6166d59'], ['V4', undefined]] : [['V2', baseline], ['目前版本', undefined]]) {
  const load = loader(revision);
  const { findLabeledNames } = load('src/core/extract.ts');
  const { DEFAULT_SETTINGS: settings } = load('src/core/rules.ts');
  const { runFlowC } = load('src/flows/flowC.ts');
  const results = addressCases.map(([address, scan, expected], i) => {
    const source = doc(`戶籍${i}`, 'household-register', register('林測試', address), scan);
    const result = runFlowC([filed, source], { settings });
    return { expected, actual: result.units[0].items.find((row) => row.field.startsWith('地址')).status };
  });
  const nameCases = names.map((name) => [register(name, addr), name]);
  if (v4) {
    nameCases.push(
      [`姓名：\n 林 甲 國 民\n身 份 証 統 一 編 號：${syntheticId}`, '林甲'],
      [`姓名：陳測試國 民\n戶籍地址：${addr}`, '陳測試'],
      [`姓名：王範例　身 份 証 統一編號：${syntheticId}`, '王範例'],
    );
    const wrapped = addr.replace('甲路98巷', '甲路\n 98巷');
    const combined = register('王範例', addr.replace('98巷', '89巷')).replace(syntheticId, 'Y100000028') + '\n' + register('林測試', addr);
    for (const [id, text] of [['換行地址', register('林測試', wrapped)], ['同頁兩人', combined]]) {
      const source = doc(id, 'household-register', text);
      const actual = runFlowC([filed, source], { settings }).units[0].items.find((row) => row.field.startsWith('地址')).status;
      results.push({ expected: 'match', actual });
    }
  }
  console.log(version, JSON.stringify({
    extractedNames: nameCases.filter(([text, name]) => findLabeledNames(text)[0]?.value === name).length,
    totalNames: nameCases.length,
    consistent: results.filter((r) => r.actual === 'match').length,
    review: results.filter((r) => r.actual === 'needs-review').length,
    unreadable: results.filter((r) => r.actual === 'unreadable').length,
    trueMismatch: results.filter((r) => r.actual === 'mismatch' && r.expected === 'mismatch').length,
    falseMismatch: results.filter((r) => r.actual === 'mismatch' && r.expected !== 'mismatch').length,
    statusAccuracy: results.filter((r) => r.actual === r.expected).length,
    totalAddresses: results.length,
  }));
}
