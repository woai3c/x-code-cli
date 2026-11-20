export type PdfRenderRequest =
  | { id: number; type: 'init'; data: ArrayBuffer }
  | { id: number; type: 'get-text'; pageNumbers: number[] }
  | { id: number; type: 'render'; pageNumber: number; desiredWidth: number; maxPixels: number }
  | { id: number; type: 'destroy' }

export type PdfRenderResult =
  | { type: 'init'; totalPages: number }
  | { type: 'get-text'; pages: Array<{ num: number; text: string }> }
  | {
      type: 'render'
      pageNumber: number
      width: number
      height: number
      data: ArrayBuffer
    }
  | { type: 'destroy' }

export type PdfRenderResponse =
  | { id: number; ok: true; result: PdfRenderResult }
  | { id: number; ok: false; error: string }
