declare module 'mammoth' {
  interface PathInput {
    path: string
  }
  interface BufferInput {
    buffer: Buffer
  }
  interface Result {
    value: string
    messages: Array<{ type: string; message: string }>
  }

  export function extractRawText(input: PathInput | BufferInput): Promise<Result>
  export function convertToHtml(input: PathInput | BufferInput, options?: Record<string, unknown>): Promise<Result>
}
