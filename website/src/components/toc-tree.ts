/**
 * Pure functions for building TocTreeNode[] from mdast headings.
 * Extracted from index.tsx so they can be tested without side effects.
 */

import type { Root, Heading, PhrasingContent } from 'mdast'
import type { TocTreeNode, TocNodeType } from './markdown.js'

/** Slugify heading text for anchor IDs */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

/** Extract plain text from mdast phrasing content */
export function extractText(children: PhrasingContent[]): string {
  return children
    .map((child) => {
      if (child.type === 'text') {
        return child.value
      }
      if ('children' in child) {
        return extractText(child.children as PhrasingContent[])
      }
      return ''
    })
    .join('')
}

/** Build a nested TocTreeNode[] from mdast headings. Headings at lower
 *  depth become children of headings at higher depth, forming a tree
 *  that matches the document outline (## → ### → ####). The heading
 *  level is encoded in the type field (h2, h3, h4) so skipped levels
 *  render at the correct visual depth. */
export function generateTocTree(mdast: Root): TocTreeNode[] {
  const headings = mdast.children
    .filter((node): node is Heading => {
      return node.type === 'heading'
    })
    .map((heading) => {
      const text = extractText(heading.children)
      const id = slugify(text)
      return { label: text, href: `#${id}`, depth: heading.depth }
    })

  const result: TocTreeNode[] = []
  const stack: { node: TocTreeNode; depth: number }[] = []

  for (const h of headings) {
    const node: TocTreeNode = {
      label: h.label,
      href: h.href,
      type: `h${h.depth}` as TocNodeType,
      children: [],
    }

    /* Pop stack until we find a parent with lower depth */
    while (stack.length > 0 && stack[stack.length - 1].depth >= h.depth) {
      stack.pop()
    }

    if (stack.length === 0) {
      result.push(node)
    } else {
      stack[stack.length - 1].node.children.push(node)
    }

    stack.push({ node, depth: h.depth })
  }

  return result
}
