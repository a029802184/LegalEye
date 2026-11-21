// 下載／分享工具。瀏覽器只能「下載新檔案」，不會覆寫使用者電腦上的原始檔。

export function download(filename: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 手機／平板：若瀏覽器支援系統分享（含檔案），讓使用者選擇儲存位置 */
export function canShareFiles(): boolean {
  try {
    const f = new File(['x'], 'x.txt', { type: 'text/plain' });
    return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}

export async function shareFile(filename: string, data: BlobPart, mime: string): Promise<boolean> {
  try {
    const file = new File([data], filename, { type: mime });
    if (!navigator.canShare?.({ files: [file] })) return false;
    await navigator.share({ files: [file], title: filename });
    return true;
  } catch (e) {
    return (e as Error).name === 'AbortError';
  }
}

export async function readFileBytes(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 依記憶體與螢幕判斷是否為資源較少的行動裝置 */
export function isLowMemoryDevice(): boolean {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return (mem !== undefined && mem <= 4) || (coarse && window.innerWidth < 900);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
