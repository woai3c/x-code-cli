import { type LanguageInput } from 'shiki/core'
import c from 'shiki/dist/langs/c.mjs'
import cpp from 'shiki/dist/langs/cpp.mjs'
import css from 'shiki/dist/langs/css.mjs'
import diff from 'shiki/dist/langs/diff.mjs'
import dockerfile from 'shiki/dist/langs/dockerfile.mjs'
import go from 'shiki/dist/langs/go.mjs'
import graphql from 'shiki/dist/langs/graphql.mjs'
import html from 'shiki/dist/langs/html.mjs'
import ini from 'shiki/dist/langs/ini.mjs'
import java from 'shiki/dist/langs/java.mjs'
import json5 from 'shiki/dist/langs/json5.mjs'
import jsonc from 'shiki/dist/langs/jsonc.mjs'
import jsx from 'shiki/dist/langs/jsx.mjs'
import kotlin from 'shiki/dist/langs/kotlin.mjs'
import less from 'shiki/dist/langs/less.mjs'
import lua from 'shiki/dist/langs/lua.mjs'
import makefile from 'shiki/dist/langs/make.mjs'
import php from 'shiki/dist/langs/php.mjs'
import ruby from 'shiki/dist/langs/ruby.mjs'
import rust from 'shiki/dist/langs/rust.mjs'
import scss from 'shiki/dist/langs/scss.mjs'
import sql from 'shiki/dist/langs/sql.mjs'
import svelte from 'shiki/dist/langs/svelte.mjs'
import swift from 'shiki/dist/langs/swift.mjs'
import toml from 'shiki/dist/langs/toml.mjs'
import tsx from 'shiki/dist/langs/tsx.mjs'
import vue from 'shiki/dist/langs/vue.mjs'
import xml from 'shiki/dist/langs/xml.mjs'

export const languages: Record<string, LanguageInput> = {
  c,
  cpp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  html,
  ini,
  java,
  json5,
  jsonc,
  jsx,
  kotlin,
  less,
  lua,
  makefile,
  php,
  ruby,
  rust,
  scss,
  sql,
  svelte,
  swift,
  toml,
  tsx,
  vue,
  xml,
}
