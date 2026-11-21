import { describe, expect, it } from 'vitest';
import { centsToString, findAmountPairs, findArithmetic, findLabeledAmounts, parseAmount, parseChineseInt } from '../../src/core/amount';
import { addDays, findDates, fmtISO, todayTW } from '../../src/core/date';
import { compareCase, findCaseNumbers, canonicalCourt, findCourts } from '../../src/core/court';
import { compareIds, maskId, validateTwId } from '../../src/core/idno';
import { compareAddress, compareNames } from '../../src/core/text';
import { findAttachmentRefs, findDebtorNames, findLabeledNames } from '../../src/core/extract';
import { fakeId } from '../fixtures/builders';

describe('中文／大寫金額', () => {
  it.each([
    ['一萬四千二百七十六', 14276n],
    ['壹萬肆仟貳佰柒拾陸', 14276n],
    ['參萬零捌佰零貳', 30802n],
    ['兩萬', 20000n],
    ['貳拾萬零伍佰', 200500n],
    ['十五', 15n],
    ['一一四', 114n],
    ['〇', 0n],
    ['壹億貳仟萬', 120000000n],
  ])('%s = %s', (s, v) => expect(parseChineseInt(s)).toBe(v));

  it('各種寫法等值比較（以數值，不以字串）', () => {
    const a = parseAmount('參萬零捌佰零貳元整');
    const b = parseAmount('NT$30,802');
    const c = parseAmount('30802');
    expect(a).toBe(3080200n);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(parseAmount('新臺幣壹萬肆仟貳佰柒拾陸元')).toBe(parseAmount('14,276元'));
  });

  it('無法解析回傳 null，不猜測', () => {
    expect(parseAmount('一些錢')).toBeNull();
    expect(parseChineseInt('壹萬X')).toBeNull();
  });

  it('驗算 15,520 - 1,244 = 14,276', () => {
    const r = findArithmetic('計算式：15,520 - 1,244 = 14,276。');
    expect(r).toHaveLength(1);
    expect(r[0].ok).toBe(true);
    const bad = findArithmetic('15,520 - 1,244 = 14,267');
    expect(bad[0].ok).toBe(false);
    expect(centsToString(bad[0].expected)).toBe('14,276');
  });

  it('國字與數字成對比較', () => {
    const p = findAmountPairs('尚欠新臺幣壹萬肆仟貳佰柒拾陸元（14,276元）');
    expect(p).toHaveLength(1);
    expect(p[0].chinese.cents).toBe(p[0].arabic.cents);
  });

  it('依上下文判斷金額性質，不把不同用途金額混為一談', () => {
    const a = findLabeledAmounts('債務人應向債權人清償新臺幣15,520元，並賠償督促程序費用新臺幣500元；扣除已清償1,244元，尚欠14,276元。本期應繳新臺幣999元');
    expect(a.map((x) => x.kind)).toEqual(['principal', 'fee', 'paid', 'balance', 'current-bill']);
  });

  it('案號、日期不會被當作金額', () => {
    expect(findLabeledAmounts('114年度司執字第12345號，114年7月1日')).toHaveLength(0);
  });
});

describe('日期（民國、跨年、閏年、不受時區影響）', () => {
  it('民國與中文數字年份', () => {
    expect(fmtISO(findDates('民國114年7月1日')[0].value)).toBe('2025-07-01');
    expect(fmtISO(findDates('一一四年七月十二日')[0].value)).toBe('2025-07-12');
    expect(fmtISO(findDates('2025/07/01')[0].value)).toBe('2025-07-01');
    expect(fmtISO(findDates('114.7.1')[0].value)).toBe('2025-07-01');
  });
  it('無效日期標示為 invalid', () => {
    expect(findDates('114年2月30日')[0].valid).toBe(false);
    expect(findDates('113年2月29日')[0].valid).toBe(true); // 2024 閏年
    expect(findDates('114年2月29日')[0].valid).toBe(false);
  });
  it('跨年與月底加日', () => {
    expect(fmtISO(addDays({ y: 2025, m: 12, d: 25 }, 11))).toBe('2026-01-05');
    expect(fmtISO(addDays({ y: 2024, m: 2, d: 28 }, 1))).toBe('2024-02-29');
  });
  it('臺灣時區的今天（UTC 16:30 已是隔天）', () => {
    expect(fmtISO(todayTW(new Date('2025-07-01T16:30:00Z')))).toBe('2025-07-02');
  });
});

describe('法院與案號', () => {
  it('司執與司執助為不同字別', () => {
    const [a] = findCaseNumbers('114年度司執字第2345號');
    const [b] = findCaseNumbers('114年度司執助字第2345號');
    expect(a.word).toBe('司執');
    expect(b.word).toBe('司執助');
    expect(compareCase(a, b).equal).toBe(false);
  });
  it('股別與中文年度', () => {
    const [c] = findCaseNumbers('一一四年度北簡字第一二三四號（丁股）');
    expect(c).toMatchObject({ year: 114, word: '北簡', number: 1234, division: '丁' });
  });
  it('發文字號標示為非案件案號', () => {
    const r = findCaseNumbers('發文字號：北院英114年司執字第5號');
    expect(r[0].isDocRef).toBe(true);
  });
  it('法院名稱正規化臺／台與簡稱，但不同法院仍不同', () => {
    expect(canonicalCourt('台灣台北地方法院')).toBe('臺灣臺北地方法院');
    expect(canonicalCourt('臺北地方法院')).toBe('臺灣臺北地方法院');
    expect(canonicalCourt('金門地方法院')).toBe('福建金門地方法院');
    expect(findCourts('臺灣士林地方法院')[0].canonical).not.toBe(canonicalCourt('臺灣臺北地方法院'));
  });
});

describe('身分證與姓名、地址', () => {
  it('檢查碼', () => {
    expect(validateTwId('A123456789')).toBe(true);
    expect(validateTwId('A123456788')).toBe(false);
    expect(validateTwId(fakeId('F', '22334455'))).toBe(true);
  });
  it('遮罩只做部分核對', () => {
    expect(compareIds('A1234*****', 'A123456789')).toBe('partial');
    expect(compareIds('A123456789', 'A123456789')).toBe('full');
    expect(compareIds('A123456789', 'A123456780')).toBe('mismatch');
    expect(maskId('A123456789')).toBe('A1*****789');
  });
  it('姓名：別名、異體字疑慮、不同', () => {
    expect(compareNames('陳美玲即陳美鈴', '陳美玲')).toBe('alias');
    expect(compareNames('王小明', '王小名')).toBe('variant-suspect');
    expect(compareNames('王小明', '李大華')).toBe('different');
  });
  it('姓名抽取不吃到「即」與後續文字', () => {
    expect(findDebtorNames('請陳報債務人陳美玲即陳美鈴之欠費')[0].value).toBe('陳美玲即陳美鈴');
    expect(findDebtorNames('債務人：王小明　身分證')[0].value).toBe('王小明');
    expect(findDebtorNames('債務人應給付債權人')).toHaveLength(0);
    expect(findLabeledNames('姓名：王小明統一編號')[0].value).toBe('王小明');
  });
  it('地址正規化但不把不同樓層視為相同', () => {
    expect(compareAddress('100 台北市中正區重慶南路一段100號5樓', '臺北市中正區重慶南路一段１００號５樓').equal).toBe(true);
    expect(compareAddress('高雄市苓雅區四維三路2號3樓', '高雄市苓雅區四維三路2號5樓').equal).toBe(false);
  });
  it('附件引用與份數', () => {
    const r = findAttachmentRefs('附件一：行動寬頻申請書影本一份\n附件二：帳單影本二份');
    expect(r.map((x) => [x.label, x.name, x.count])).toEqual([
      ['附件一', '行動寬頻申請書', 1],
      ['附件二', '帳單', 2],
    ]);
  });
});
