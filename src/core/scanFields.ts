import { findAddresses, findIds, findLabeledNames, isLabeledId } from './extract';
import { compareIds } from './idno';
import { compareAddress, stripSpaces } from './text';

export function householdScanFields(text: string) {
  const head = stripSpaces(text);
  const current = text.normalize('NFKC').split(/(?:地址變更|戶址變更|遷徙記事|全戶動態記事|個人記事)/)[0];
  if (!/戶籍謄本|戶籍資料|戶籍地址/.test(head) || !/姓名|身[分份][證証]/.test(head)) return undefined;
  const names = findLabeledNames(current);
  const ids = findIds(current).filter((hit) => isLabeledId(current, hit.index));
  const addresses = findAddresses(current).filter((hit) => /^戶\s*籍\s*地/.test(hit.raw));
  if (names.length > 1 || ids.length > 1 || addresses.length > 1) return undefined;
  return { name: names[0]?.value, id: ids[0]?.value, address: addresses[0]?.value };
}

export function gainsHouseholdFields(first: string, second: string): boolean {
  const before = householdScanFields(first);
  const after = householdScanFields(second);
  if (!before || !after) return false;
  if (before.name && before.name !== after.name) return false;
  if (before.id && (!after.id || compareIds(before.id, after.id) !== 'full')) return false;
  if (before.address && (!after.address || !compareAddress(before.address, after.address).equal)) return false;
  const identityMatches = (before.name && before.name === after.name) || (before.id && after.id && compareIds(before.id, after.id) === 'full');
  return !!identityMatches && ((!before.name && !!after.name) || (!before.id && !!after.id) || (!before.address && !!after.address));
}
