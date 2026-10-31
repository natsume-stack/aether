/**
 * 生成文件下载链接并触发下载，需要在click事件中调用。
 * @param blob 文件Blob对象
 * @param fileName 下载时的文件名
 */
export function downloadFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');

  anchor.href = url;

  anchor.download = fileName;

  anchor.click();

  URL.revokeObjectURL(url);
}
