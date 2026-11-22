import { expect, type Page } from '@playwright/test';

type Download = { name: string; size: number; text: string };
type DownloadWindow = Window & { __dl: Download[] };

// Edge 無頭下載可能自動開啟空白頁。直接驗證使用者會取得的檔名與 Blob。
export async function captureDownloads(page: Page) {
  await page.addInitScript(() => {
    const app = window as unknown as DownloadWindow;
    app.__dl = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download && this.href.startsWith('blob:')) {
        const name = this.download;
        void fetch(this.href).then((r) => r.blob()).then(async (blob) => {
          app.__dl.push({ name, size: blob.size, text: /\.(html|csv)$/.test(name) ? await blob.text() : '' });
        });
        return;
      }
      click.call(this);
    };
  });
}

export async function nextDownload(page: Page, re: RegExp): Promise<Download> {
  let match: Download | undefined;
  await expect.poll(async () => {
    match = await page.evaluate(({ source, flags }) => (window as unknown as DownloadWindow).__dl.find((entry) => new RegExp(source, flags).test(entry.name)), { source: re.source, flags: re.flags });
    return !!match;
  }).toBe(true);
  return match!;
}
