// 安全 ZIP 解壓縮（本機瀏覽器執行）。
// 先自行讀取中央目錄檢查：檔案數、宣告大小、壓縮比、加密、ZIP64、路徑穿越、重複路徑；
// 再以串流方式解壓，實際位元組超過上限立即中止（防止宣告大小造假的 ZIP Bomb）。

import JSZip from 'jszip';

export interface ZipLimits {
  maxZipBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** 單檔壓縮比上限（只在檔案大於 1MB 時判斷） */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxZipBytes: 200 * 1024 * 1024,
  maxEntries: 1000,
  maxEntryBytes: 80 * 1024 * 1024,
  maxTotalBytes: 400 * 1024 * 1024,
  maxRatio: 120,
};

export const SUPPORTED_EXT = ['pdf', 'docx', 'xlsx', 'txt', 'csv'];

export interface UnzippedFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface UnzipResult {
  files: UnzippedFile[];
  skipped: SkippedEntry[];
  /** 樹狀顯示用：所有資料夾 */
  folders: string[];
}

export class ZipError extends Error {}

interface CdEntry {
  rawName: Uint8Array;
  utf8: boolean;
  encrypted: boolean;
  method: number;
  compSize: number;
  size: number;
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Windows 繁體中文環境建立的 ZIP 多半為 Big5（CP950）檔名
    try {
      return new TextDecoder('big5').decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
}

function readCentralDirectory(data: Uint8Array): CdEntry[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const min = Math.max(0, data.length - 65557);
  let eocd = -1;
  for (let i = data.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('不是有效的 ZIP 檔，或檔案已損毀。');
  const total = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError('此 ZIP 使用 ZIP64 超大格式，基於安全與效能考量不支援，請分批壓縮。');
  }
  if (cdOffset + cdSize > data.length) throw new ZipError('ZIP 中央目錄超出檔案範圍，檔案可能損毀。');
  const out: CdEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > data.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('ZIP 目錄結構損毀。');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const rawName = data.slice(p + 46, p + 46 + nameLen);
    out.push({ rawName, utf8: (flags & 0x800) !== 0, encrypted: (flags & 1) !== 0, method, compSize, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 回傳安全的相對路徑；不安全則回傳 null */
export function sanitizeZipPath(name: string): string | null {
  const s = name.replace(/\\/g, '/');
  // 控制字元
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split('/').filter((x) => x !== '' && x !== '.');
  if (parts.some((x) => x === '..')) return null;
  return parts.join('/');
}

function ext(path: string): string {
  const m = /\.([^./]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

function isJunk(path: string): boolean {
  return /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(path) || /(^|\/)~\$/.test(path);
}

export interface UnzipOptions {
  limits?: Partial<ZipLimits>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, path: string) => void;
}

export async function safeUnzip(data: Uint8Array, opts: UnzipOptions = {}): Promise<UnzipResult> {
  const L = { ...DEFAULT_ZIP_LIMITS, ...opts.limits };
  if (data.length > L.maxZipBytes) throw new ZipError(`ZIP 檔超過 ${Math.round(L.maxZipBytes / 1048576)} MB 上限。`);
  const cd = readCentralDirectory(data);
  if (cd.length > L.maxEntries) throw new ZipError(`ZIP 內含 ${cd.length} 個項目，超過 ${L.maxEntries} 個上限。`);
  if (cd.some((e) => e.encrypted)) throw new ZipError('ZIP 有密碼保護（加密），請先以公司核准的工具解密後再匯入。');

  const skipped: SkippedEntry[] = [];
  const folders = new Set<string>();
  const accepted = new Map<string, { entry: CdEntry; decoded: string }>();
  const seen = new Set<string>();
  let declaredTotal = 0;

  for (const e of cd) {
    const decoded = decodeName(e.rawName, e.utf8);
    const isDir = decoded.endsWith('/') || decoded.endsWith('\\');
    const safe = sanitizeZipPath(decoded);
    if (safe === null) {
      skipped.push({ path: decoded, reason: '不安全的路徑（絕對路徑或包含 ..），已拒絕' });
      continue;
    }
    if (isDir) {
      if (safe) folders.add(safe);
      continue;
    }
    if (isJunk(safe)) continue;
    const key = safe.normalize('NFC').toLowerCase();
    if (seen.has(key)) {
      skipped.push({ path: safe, reason: '重複的路徑，僅保留第一個' });
      continue;
    }
    seen.add(key);
    const x = ext(safe);
    if (x === 'zip') {
      skipped.push({ path: safe, reason: '不支援巢狀 ZIP，請先解壓後再匯入' });
      continue;
    }
    if (x === 'doc' || x === 'xls') {
      skipped.push({ path: safe, reason: `舊版 .${x} 格式不支援，請另存為 .${x}x` });
      continue;
    }
    if (!SUPPORTED_EXT.includes(x)) {
      skipped.push({ path: safe, reason: `不支援的檔案類型 .${x || '（無副檔名）'}` });
      continue;
    }
    if (e.size > L.maxEntryBytes) {
      skipped.push({ path: safe, reason: `解壓後 ${Math.round(e.size / 1048576)} MB，超過單檔上限` });
      continue;
    }
    if (e.size > 1024 * 1024 && e.compSize > 0 && e.size / e.compSize > L.maxRatio) {
      skipped.push({ path: safe, reason: '壓縮比異常（疑似 ZIP Bomb），已拒絕' });
      continue;
    }
    declaredTotal += e.size;
    if (declaredTotal > L.maxTotalBytes) throw new ZipError('解壓後總大小超過上限，請分批處理。');
    const parts = safe.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    accepted.set(decoded.replace(/\\/g, '/'), { entry: e, decoded: safe });
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, {
      checkCRC32: true,
      decodeFileName: (bytes: string[] | Uint8Array | Buffer) => decodeName(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as unknown as number[]), false),
    });
  } catch (err) {
    throw new ZipError('ZIP 檔無法讀取，可能已損毀：' + (err as Error).message);
  }

  const files: UnzippedFile[] = [];
  let actualTotal = 0;
  let done = 0;
  const list = [...accepted.entries()];
  for (const [zipName, { entry, decoded }] of list) {
    if (opts.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const obj = zip.file(zipName) ?? zip.file(decoded);
    if (!obj) {
      skipped.push({ path: decoded, reason: '無法在壓縮檔中找到此項目（檔名編碼可能異常）' });
      continue;
    }
    try {
      const bytes = await streamWithLimit(obj, Math.min(L.maxEntryBytes, entry.size + 1024 * 64));
      actualTotal += bytes.length;
      if (actualTotal > L.maxTotalBytes) throw new ZipError('實際解壓總大小超過上限，已中止。');
      files.push({ path: decoded, name: decoded.split('/').pop() ?? decoded, data: bytes });
    } catch (err) {
      if (err instanceof ZipError) throw err;
      skipped.push({ path: decoded, reason: '解壓失敗：' + (err as Error).message });
    }
    done++;
    opts.onProgress?.(done, list.length, decoded);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { files, skipped, folders: [...folders].sort() };
}

function streamWithLimit(obj: JSZip.JSZipObject, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let stopped = false;
    // internalStream 為 JSZip 公開 API，但型別定義檔未收錄
    interface StreamHelper {
      on(ev: 'data', cb: (c: Uint8Array) => void): StreamHelper;
      on(ev: 'error', cb: (e: Error) => void): StreamHelper;
      on(ev: 'end', cb: () => void): StreamHelper;
      pause(): StreamHelper;
      resume(): StreamHelper;
    }
    const helper = (obj as unknown as { internalStream(t: 'uint8array'): StreamHelper }).internalStream('uint8array');
    helper
      .on('data', (chunk: Uint8Array) => {
        if (stopped) return;
        size += chunk.length;
        if (size > limit) {
          stopped = true;
          helper.pause();
          reject(new Error('實際解壓大小超過宣告值或上限（疑似 ZIP Bomb）'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (e: Error) => {
        if (!stopped) reject(e);
      })
      .on('end', () => {
        if (stopped) return;
        const out = new Uint8Array(size);
        let p = 0;
        for (const c of chunks) {
          out.set(c, p);
          p += c.length;
        }
        resolve(out);
      })
      .resume();
  });
}
