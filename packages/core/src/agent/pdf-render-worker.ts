import type { PDFParse } from 'pdf-parse'

import { parentPort } from 'node:worker_threads'

import type { PdfRenderRequest, PdfRenderResponse } from './pdf-render-protocol.js'

if (!parentPort && !process.send) throw new Error('PDF render worker requires a parent channel')

let parser: PDFParse | null = null
let queue: Promise<void> = Promise.resolve()

async function handleRequest(request: PdfRenderRequest): Promise<PdfRenderResponse> {
  try {
    if (request.type === 'init') {
      const { PDFParse } = await import('pdf-parse')
      parser = new PDFParse({ data: new Uint8Array(request.data) })
      const info = await parser.getInfo()
      return { id: request.id, ok: true, result: { type: 'init', totalPages: info.total } }
    }
    if (!parser) throw new Error('PDF parser is not initialized')
    if (request.type === 'get-text') {
      const text = await parser.getText({ partial: request.pageNumbers, pageJoiner: '' })
      return {
        id: request.id,
        ok: true,
        result: { type: 'get-text', pages: text.pages.map((page) => ({ num: page.num, text: page.text })) },
      }
    }
    if (request.type === 'render') {
      const info = await parser.getInfo({ partial: [request.pageNumber], parsePageInfo: true })
      const page = info.pages[0]
      if (!page) throw new Error(`PDF page ${request.pageNumber} has no metadata`)
      const targetHeight = Math.ceil((page.height / page.width) * request.desiredWidth)
      if (!Number.isFinite(targetHeight) || targetHeight <= 0) throw new Error('PDF page has invalid dimensions')
      if (request.desiredWidth * targetHeight > request.maxPixels) {
        throw new Error(
          `PDF page ${request.pageNumber} exceeds render pixel limit (${request.desiredWidth}x${targetHeight})`,
        )
      }
      const screenshots = await parser.getScreenshot({
        partial: [request.pageNumber],
        desiredWidth: request.desiredWidth,
        imageDataUrl: false,
        imageBuffer: true,
      })
      const screenshot = screenshots.pages[0]
      if (!screenshot?.data?.length) throw new Error(`PDF page ${request.pageNumber} produced no image data`)
      const bytes = Uint8Array.from(screenshot.data)
      return {
        id: request.id,
        ok: true,
        result: {
          type: 'render',
          pageNumber: request.pageNumber,
          width: screenshot.width,
          height: screenshot.height,
          data: bytes.buffer,
        },
      }
    }
    await parser.destroy().catch(() => {})
    parser = null
    return { id: request.id, ok: true, result: { type: 'destroy' } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { id: request.id, ok: false, error: message }
  }
}

function send(response: PdfRenderResponse): Promise<boolean> {
  if (parentPort) {
    if (response.ok && response.result.type === 'render') parentPort.postMessage(response, [response.result.data])
    else parentPort.postMessage(response)
    return Promise.resolve(true)
  }
  if (!process.send || !process.connected) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    try {
      process.send!(response, (error) => resolve(!error))
    } catch {
      resolve(false)
    }
  })
}

function closeChannel(): void {
  if (parentPort) parentPort.close()
  else if (process.connected) process.disconnect()
}

function onRequest(request: PdfRenderRequest): void {
  queue = queue.then(async () => {
    const response = await handleRequest(request)
    const shouldClose = response.ok && response.result.type === 'destroy'
    const sent = await send(response)
    if (shouldClose || !sent) closeChannel()
  })
}

if (parentPort) parentPort.on('message', onRequest)
else {
  process.once('disconnect', () => process.exit(0))
  process.on('message', (request) => onRequest(request as PdfRenderRequest))
}
