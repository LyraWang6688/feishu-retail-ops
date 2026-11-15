'use strict';

/** 最小 PDF 写出器：一页一张 40×30mm 标签（详见原 artifact 注释）。 */
const MM_TO_PT = 72 / 25.4;
const mmToPt = (mm) => Number((Number(mm) * MM_TO_PT).toFixed(4));

function buildPdf(pages, options = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter(Boolean);
  if (!list.length) throw new Error('buildPdf 至少需要一页');
  const objects = new Map();
  let nextId = 1;
  const alloc = () => { const id = nextId; nextId += 1; objects.set(id, null); return id; };
  const catalogId = alloc();
  const pagesId = alloc();
  const pageIds = list.map(() => ({ pageId: alloc(), contentId: alloc(), imageId: alloc() }));
  const title = String(options.title || '');
  const infoId = title ? alloc() : null;
  const kids = pageIds.map((entry) => `${entry.pageId} 0 R`).join(' ');
  objects.set(catalogId, Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));
  objects.set(pagesId, Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`));
  if (infoId) {
    const safeTitle = title.replace(/([()\\])/g, '\\$1');
    objects.set(infoId, Buffer.from(`<< /Title (${safeTitle}) /Producer (feishu-retail-ops labelPrintArtifactService) >>`));
  }
  list.forEach((page, index) => {
    const { pageId, contentId, imageId } = pageIds[index];
    const wPt = mmToPt(page.widthMm);
    const hPt = mmToPt(page.heightMm);
    const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
    const jpeg = Buffer.isBuffer(page.jpeg) ? page.jpeg : Buffer.from(page.jpeg || '');
    objects.set(pageId, Buffer.from(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${wPt} ${hPt}] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
    objects.set(contentId, Buffer.from(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ));
    const imageHead = Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    );
    objects.set(imageId, Buffer.concat([imageHead, jpeg, Buffer.from('\nendstream')]));
  });
  const chunks = [];
  let offset = 0;
  const push = (buffer) => { chunks.push(buffer); offset += buffer.length; };
  push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary'));
  const offsets = new Map();
  const ids = [...objects.keys()].sort((left, right) => left - right);
  for (const id of ids) {
    const body = objects.get(id);
    if (!body) continue;
    offsets.set(id, offset);
    push(Buffer.from(`${id} 0 obj\n`));
    push(body);
    push(Buffer.from('\nendobj\n'));
  }
  const xrefOffset = offset;
  const maxId = ids[ids.length - 1];
  const lines = ['xref', `0 ${maxId + 1}`, '0000000000 65535 f '];
  for (let id = 1; id <= maxId; id += 1) {
    const at = offsets.get(id);
    lines.push(at === undefined ? '0000000000 65535 f ' : `${String(at).padStart(10, '0')} 00000 n `);
  }
  push(Buffer.from(`${lines.join('\n')}\n`));
  push(Buffer.from(
    `trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\n`
    + `startxref\n${xrefOffset}\n%%EOF\n`,
  ));
  return Buffer.concat(chunks);
}

module.exports = { buildPdf };
