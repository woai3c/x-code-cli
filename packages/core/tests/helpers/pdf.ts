function escapePdfText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1').replace(/[\r\n]+/g, ' ')
}

export function makePdfBuffer(pages: Array<{ text?: string; width?: number; height?: number }>): Buffer {
  const objects: string[] = []
  const pageIds = pages.map((_, index) => 3 + index * 2)
  const fontId = 3 + pages.length * 2
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`

  pages.forEach((page, index) => {
    const pageId = pageIds[index]!
    const contentId = pageId + 1
    const width = page.width ?? 612
    const height = page.height ?? 792
    const content = page.text
      ? page.text
          .split(/\r?\n/)
          .map(
            (line, lineIndex) =>
              `BT /F1 12 Tf 72 ${Math.max(20, height - 72 - lineIndex * 16)} Td (${escapePdfText(line)}) Tj ET`,
          )
          .join('\n')
      : ''
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId - 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  })
  objects[fontId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let document = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(document, 'latin1')
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(document, 'latin1')
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(document, 'latin1')
}
