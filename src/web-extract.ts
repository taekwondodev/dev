import { isProbablyReaderable, Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import type { DocumentLink } from './web-documents.ts'

export interface Extracted {
  readonly title: string | undefined
  readonly text: string
  readonly links: readonly DocumentLink[]
}

const COLLECTED_LINKS = 500
const SNIFF_BYTES = 2048

const decoderFor = (label: string | undefined): TextDecoder => {
  if (label !== undefined)
    try {
      return new TextDecoder(label)
    } catch {}
  return new TextDecoder('utf-8')
}

export const decodeBody = (
  body: Uint8Array,
  charset: string | undefined,
  contentType: string | undefined
): string => {
  let label = charset
  if (label === undefined && (contentType === undefined || contentType.includes('html'))) {
    const head = new TextDecoder('latin1').decode(body.subarray(0, SNIFF_BYTES))
    const meta =
      head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i) ??
      head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i)
    label = meta?.[1]?.toLowerCase()
  }
  return decoderFor(label)
    .decode(body)
    .replace(/^\uFEFF/, '')
}

const absolute = (href: string, base: string): string | undefined => {
  try {
    const url = new URL(href, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

class LinkCollector {
  readonly links: DocumentLink[] = []
  private readonly seen = new Set<string>()
  add(text: string, href: string, base: string): string | undefined {
    const url = absolute(href, base)
    if (url === undefined) return undefined
    if (!this.seen.has(url) && this.links.length < COLLECTED_LINKS) {
      this.seen.add(url)
      this.links.push({ text: text.replace(/\s+/g, ' ').trim(), url })
    }
    return url
  }
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const BARE_URL = /https?:\/\/[^\s<>()"']+/g

export const extractMarkdown = (text: string, base: string): Extracted => {
  const collector = new LinkCollector()
  for (const match of text.matchAll(MARKDOWN_LINK))
    collector.add(match[1] ?? '', match[2] ?? '', base)
  const heading = text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim()
  return { title: heading, text: text.trim(), links: collector.links }
}

export const extractText = (text: string, base: string): Extracted => {
  const collector = new LinkCollector()
  for (const match of text.matchAll(BARE_URL)) collector.add('', match[0], base)
  return { title: undefined, text: text.trim(), links: collector.links }
}

interface DomNode {
  readonly nodeType: number
  readonly textContent: string | null
  readonly tagName: string
  readonly childNodes: Iterable<DomNode>
  readonly children: Iterable<DomNode>
  readonly firstElementChild: DomNode | null
  getAttribute(name: string): string | null
  querySelectorAll(selector: string): Iterable<DomNode>
}
const asDomNode = (node: unknown): DomNode => node as DomNode

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hgroup',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
  'tbody',
  'thead',
  'tfoot',
  'tr',
])
const DROPPED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'button',
  'input',
  'select',
  'textarea',
  'nav',
  'header',
  'footer',
  'aside',
])

const languageOf = (element: DomNode): string => {
  const className = `${element.getAttribute('class') ?? ''} ${element.firstElementChild?.getAttribute('class') ?? ''}`
  const match = className.match(/(?:language|lang)-([\w+#-]+)/)
  return match?.[1] ?? ''
}

class MarkdownWriter {
  private readonly out: string[] = []
  private readonly base: string
  private readonly collector: LinkCollector
  private readonly dropped: ReadonlySet<string>
  constructor(base: string, collector: LinkCollector, dropped: ReadonlySet<string>) {
    this.base = base
    this.collector = collector
    this.dropped = dropped
  }

  render(root: DomNode): string {
    for (const child of root.childNodes) this.block(child, '')
    return this.out
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  private trailingNewlines = 0
  private empty = true

  private append(text: string): void {
    if (text === '') return
    this.out.push(text)
    this.empty = false
    const match = text.match(/\n*$/)
    const trailing = match === null ? 0 : match[0].length
    this.trailingNewlines = trailing === text.length ? this.trailingNewlines + trailing : trailing
  }

  private ensureBlank(): void {
    if (this.empty || this.trailingNewlines >= 2) return
    this.append(this.trailingNewlines === 1 ? '\n' : '\n\n')
  }

  private inline(node: DomNode): string {
    if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ')
    if (node.nodeType !== 1) return ''
    const tag = node.tagName.toLowerCase()
    if (this.dropped.has(tag)) return ''
    const children = () => [...node.childNodes].map(child => this.inline(child)).join('')
    switch (tag) {
      case 'br':
        return '\n'
      case 'code':
      case 'kbd':
      case 'samp': {
        const code = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
        return code === '' ? '' : `\`${code.replaceAll('`', '\\`')}\``
      }
      case 'strong':
      case 'b': {
        const inner = children().trim()
        return inner === '' ? '' : `**${inner}**`
      }
      case 'em':
      case 'i': {
        const inner = children().trim()
        return inner === '' ? '' : `*${inner}*`
      }
      case 'a': {
        const inner = children().replace(/\s+/g, ' ').trim()
        const href = node.getAttribute('href')
        if (href === null || href === '' || href.startsWith('#')) return inner
        const url = this.collector.add(inner, href, this.base)
        if (url === undefined) return inner
        return inner === '' ? `<${url}>` : `[${inner}](${url})`
      }
      case 'img': {
        const alt = (node.getAttribute('alt') ?? '').trim()
        const src = node.getAttribute('src')
        const url = src === null ? undefined : absolute(src, this.base)
        return url === undefined ? alt : `![${alt}](${url})`
      }
      default:
        return BLOCK_TAGS.has(tag) ? `\n${children()}\n` : children()
    }
  }

  private block(node: DomNode, listIndent: string): void {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ')
      if (text.trim() !== '') this.append(text)
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.tagName.toLowerCase()
    if (this.dropped.has(tag)) return
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = this.inline(node).replace(/\s+/g, ' ').trim()
        if (text === '') return
        this.ensureBlank()
        this.append(`${'#'.repeat(Number(tag[1]))} ${text}\n\n`)
        return
      }
      case 'p': {
        const text = this.inline(node).trim()
        if (text === '') return
        this.ensureBlank()
        this.append(`${text}\n\n`)
        return
      }
      case 'pre': {
        const code = (node.textContent ?? '').replace(/\n$/, '')
        if (code.trim() === '') return
        this.ensureBlank()
        const fence = code.includes('```') ? '````' : '```'
        this.append(`${fence}${languageOf(node)}\n${code}\n${fence}\n\n`)
        return
      }
      case 'blockquote': {
        const inner = new MarkdownWriter(this.base, this.collector, this.dropped).render(node)
        if (inner === '') return
        this.ensureBlank()
        this.append(
          `${inner
            .split('\n')
            .map(line => `> ${line}`.trimEnd())
            .join('\n')}\n\n`
        )
        return
      }
      case 'ul':
      case 'ol': {
        const items = [...node.children].filter(child => child.tagName.toLowerCase() === 'li')
        if (items.length === 0) return
        this.ensureBlank()
        items.forEach((item, index) => {
          const marker = tag === 'ol' ? `${index + 1}. ` : '- '
          const inner = new MarkdownWriter(this.base, this.collector, this.dropped)
            .render(item)
            .split('\n')
            .map((line, lineIndex) =>
              lineIndex === 0 ? line : `${' '.repeat(marker.length)}${line}`.trimEnd()
            )
            .join('\n')
          if (inner.trim() !== '') this.append(`${listIndent}${marker}${inner}\n`)
        })
        this.append('\n')
        return
      }
      case 'table': {
        const rows = [...node.querySelectorAll('tr')]
        if (rows.length === 0) return
        this.ensureBlank()
        rows.forEach((row, index) => {
          const cells = [...row.children].map(cell =>
            this.inline(cell)
              .replace(/\s+/g, ' ')
              .replaceAll('|', String.raw`\|`)
              .trim()
          )
          this.append(`| ${cells.join(' | ')} |\n`)
          if (index === 0) this.append(`| ${cells.map(() => '---').join(' | ')} |\n`)
        })
        this.append('\n')
        return
      }
      case 'hr':
        this.ensureBlank()
        this.append('---\n\n')
        return
      case 'dt': {
        const text = this.inline(node).trim()
        if (text !== '') {
          this.ensureBlank()
          this.append(`**${text}**\n`)
        }
        return
      }
      case 'dd': {
        const text = this.inline(node).trim()
        if (text !== '') this.append(`: ${text}\n\n`)
        return
      }
      default: {
        if (
          BLOCK_TAGS.has(tag) ||
          tag === 'body' ||
          tag === 'html' ||
          tag === 'span' ||
          tag === 'div'
        ) {
          const hasBlockChildren = [...node.children].some(
            child =>
              BLOCK_TAGS.has(child.tagName.toLowerCase()) ||
              /^h[1-6]$/.test(child.tagName.toLowerCase()) ||
              child.tagName.toLowerCase() === 'hr'
          )
          if (hasBlockChildren || tag === 'body' || tag === 'html') {
            for (const child of node.childNodes) this.block(child, listIndent)
            return
          }
          const text = this.inline(node).trim()
          if (text === '') return
          this.ensureBlank()
          this.append(`${text}\n\n`)
          return
        }
        const text = this.inline(node)
        if (text.trim() !== '') this.append(text)
      }
    }
  }
}

const titleOf = (document: ReturnType<typeof parseHTML>['document']): string | undefined => {
  const candidates = [
    document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
    document.querySelector('title')?.textContent,
    document.querySelector('h1')?.textContent,
  ]
  for (const candidate of candidates) {
    const text = candidate?.replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return undefined
}

const MIN_SEMANTIC_CHARS = 200

export const extractHtml = (html: string, base: string): Extracted => {
  const { document } = parseHTML(html)
  if (document.querySelector('base[href]') === null) {
    const baseElement = document.createElement('base')
    baseElement.setAttribute('href', base)
    const head = document.querySelector('head') ?? document.documentElement
    head?.insertBefore(baseElement, head.firstChild)
  }
  const title = titleOf(document)
  const collector = new LinkCollector()
  const semantic = document.querySelector('main, [role="main"], article') ?? undefined
  if (semantic !== undefined && (semantic.textContent ?? '').trim().length >= MIN_SEMANTIC_CHARS) {
    const text = new MarkdownWriter(base, collector, DROPPED_TAGS).render(asDomNode(semantic))
    if (text.length >= MIN_SEMANTIC_CHARS) return { title, text, links: collector.links }
  }
  if (isProbablyReaderable(document, { minContentLength: 60, minScore: 10 })) {
    const article = new Readability<DomNode>(document.cloneNode(true) as typeof document, {
      serializer: asDomNode,
      keepClasses: true,
    }).parse()
    if (article?.content) {
      const text = new MarkdownWriter(
        base,
        collector,
        new Set(['script', 'style', 'noscript', 'template', 'svg'])
      ).render(article.content)
      if (text.length > 0)
        return { title: article.title?.trim() || title, text, links: collector.links }
    }
  }
  const body = document.body ?? document.documentElement
  const text =
    body === null ? '' : new MarkdownWriter(base, collector, DROPPED_TAGS).render(asDomNode(body))
  return { title, text, links: collector.links }
}

const THIN_TEXT_CHARS = 200
const NOSCRIPT = /<noscript[\s>][\s\S]*?(javascript|enable|browser)[\s\S]*?<\/noscript>/i
const BLOCKED_STATUSES = new Set([401, 403, 429, 503])

export const needsRendering = (html: string, extractedText: string, status: number): boolean => {
  const thin = extractedText.trim().length < THIN_TEXT_CHARS
  if (BLOCKED_STATUSES.has(status)) return true
  if (!thin) return false
  return /<script[\s>]/i.test(html) || NOSCRIPT.test(html)
}
