import { type LanguageInput } from 'shiki/core'
import bash from 'shiki/dist/langs/bash.mjs'
import javascript from 'shiki/dist/langs/javascript.mjs'
import json from 'shiki/dist/langs/json.mjs'
import markdown from 'shiki/dist/langs/markdown.mjs'
import python from 'shiki/dist/langs/python.mjs'
import typescript from 'shiki/dist/langs/typescript.mjs'
import yaml from 'shiki/dist/langs/yaml.mjs'
import githubLight from 'shiki/dist/themes/github-light.mjs'
import monokai from 'shiki/dist/themes/monokai.mjs'
import oneDarkPro from 'shiki/dist/themes/one-dark-pro.mjs'
import * as wasm from 'shiki/wasm'

export const languages: Record<string, LanguageInput> = {
  bash,
  javascript,
  json,
  markdown,
  python,
  typescript,
  yaml,
}

export const themes = [oneDarkPro, monokai, githubLight]
export { wasm }
