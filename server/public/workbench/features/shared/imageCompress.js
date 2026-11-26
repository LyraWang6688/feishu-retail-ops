/**
 * 上传前压缩图片（2026-11-26）。
 *
 * 背景：hm 站点的 Nginx 曾用默认 1MB 限制，iPhone 原图 2–5MB 直接 413；
 * 服务器已放宽到 20m，这里再加一道客户端压缩：超过 1MB 的图压到最长边 1600、JPEG 0.8。
 * 压缩失败或压缩后反而更大 ⇒ 回退原文件（不阻断上传）；真正的兜底是 413 的人话提示。
 */
export async function compressImageFile(file, {
  maxEdge = 1600, quality = 0.8, skipBelow = 1_000_000,
} = {}) {
  if (!file || typeof Blob === 'undefined' || !(file instanceof Blob)) return file;
  if (Number(file.size) > 0 && Number(file.size) <= skipBelow) return file;
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const sourceWidth = Number(bitmap.width) || 1;
    const sourceHeight = Number(bitmap.height) || 1;
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    const name = String(file.name || 'sample').replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
