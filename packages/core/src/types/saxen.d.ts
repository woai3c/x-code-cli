declare module 'saxen' {
  type ContextGetter = () => { line: number; column: number }
  type AttributeGetter = () => Record<string, string> | false
  type DecodeEntities = (value: string) => string

  export class Parser {
    constructor(options?: { proxy?: boolean })
    on(
      event: 'openTag',
      callback: (
        name: string,
        getAttributes: AttributeGetter,
        decodeEntities: DecodeEntities,
        selfClosing: boolean,
        getContext: ContextGetter,
      ) => void,
    ): this
    on(
      event: 'closeTag',
      callback: (name: string, decodeEntities: DecodeEntities, selfClosing: boolean, getContext: ContextGetter) => void,
    ): this
    on(event: 'error' | 'warn', callback: (error: Error | string, getContext: ContextGetter) => void): this
    on(
      event: 'attention',
      callback: (value: string, decodeEntities: DecodeEntities, getContext: ContextGetter) => void,
    ): this
    write(xml: string): this
    end(): Error | null
  }
}
