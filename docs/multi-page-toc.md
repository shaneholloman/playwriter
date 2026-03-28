---
title: Multi-Page Table of Contents
description: |
  Spec for extending the website TOC sidebar to support multiple pages
  in a unified tree with depth-capped nesting.
prompt: |
  Explain how the table of contents is generated and plan for multi-page
  support. Pages become root-level tree nodes, headings nest under them.
  href becomes /page#id instead of just #id. Nesting capped at 4 visual
  levels -- when page depth is already deep, headings flatten to a single
  level. Source files: website/src/components/markdown.tsx (TocItem,
  PreparedTocItem, TableOfContents component),
  website/src/pages/index.tsx (generateToc, slugify, groupBySections),
  website/src/components/search.ts (SearchEntry, buildSearchEntries,
  searchToc).
---

## Current state

Single-page TOC. `TocItem = { label, href: "#slug", level?: 1|2|3 }`.
Generated from mdast headings. Rendered as 2-tier groups (level-1
parents with level-2/3 children). Search via Orama full-text DB.
Active heading tracked with IntersectionObserver.

## Goal

Support multiple pages in the TOC sidebar. Pages are tree nodes that
contain heading entries. The same tree rendering, search, and expand/
collapse behavior applies. Nesting is capped at 4 visual levels
(0-3) so the sidebar never gets too wide.

## Types

### TocTreeNode (recursive, source of truth)

```ts
type TocNodeType = 'page' | 'heading'

type TocTreeNode = {
  label: string
  href: string            // "/page" for pages, "/page#slug" for headings
  type: TocNodeType
  children: TocTreeNode[] // pages can contain pages or headings
}
```

Pages can nest inside pages (like docs sections). Headings are always
leaf-level within a page -- they don't contain sub-pages.

### FlatTocItem (flattened for rendering)

```ts
// max visual depth is 4 levels (0, 1, 2, 3)
type VisualLevel = 0 | 1 | 2 | 3

type FlatTocItem = {
  label: string
  href: string
  type: TocNodeType
  visualLevel: VisualLevel
  prefix: string          // ASCII tree art: "├─ ", "└─ ", "│  ", etc.
  parentHref: string | null
  pageHref: string        // nearest ancestor page's href
}
```

This replaces both `PreparedTocItem` and `SearchEntry` -- one flat
list drives rendering, search, and active tracking.

## Flattening algorithm

```
flattenTree(node, pageDepth = 0, parentHref = null, pageHref = node.href):
  for each child of node:
    if child.type === 'page':
      depth = pageDepth + 1
      visualLevel = min(depth, 3)
      emit { ...child, visualLevel, parentHref: node.href, pageHref: child.href }
      flattenTree(child, depth, node.href, child.href)

    if child.type === 'heading':
      headingLevel = child's heading level (1, 2, 3)
      rawDepth = pageDepth + headingLevel
      visualLevel = min(rawDepth, 3)    ← clamp to max
      emit { ...child, visualLevel, parentHref, pageHref }
      // headings with children (sub-headings) recurse too
```

When `rawDepth > 3`, all deeper headings collapse to `visualLevel: 3`.
They become visual siblings -- the tree structure is still in the data
(`parentHref`) but the rendering treats them as same-level items.

### Examples

**Shallow (1 page level, full heading hierarchy):**

```
pageDepth=0 → headings get levels 1,2,3

Page A                    visualLevel 0
├─ ## Getting Started     visualLevel 1  (0 + 1)
│  ├─ ### Install         visualLevel 2  (0 + 2)
│  └─ ### Config          visualLevel 2  (0 + 2)
└─ ## API                 visualLevel 1  (0 + 1)
   └─ ### Methods         visualLevel 2  (0 + 2)
```

**Deep (3 page levels, headings flattened):**

```
pageDepth=2 → all headings clamp to 3

Docs                      visualLevel 0
├─ Guides                 visualLevel 1  (page depth 1)
│  └─ Auth                visualLevel 2  (page depth 2)
│     ├─ ## Overview      visualLevel 3  (2+1=3, ok)
│     ├─ ### OAuth        visualLevel 3  (2+2=4→3, clamped)
│     └─ ### JWT          visualLevel 3  (2+2=4→3, clamped)
└─ Reference              visualLevel 1  (page depth 1)
```

## Prerequisites checklist

### 1. Multi-page data source

Currently `index.tsx` parses a single MDX file. Need a data source
that provides `{ path: string, title: string, mdast: Root }[]` for
all pages. Could be:
- Multiple MDX files in a directory
- A manifest/config that lists pages
- Dynamic route-based loading

### 2. Refactor TocItem → TocTreeNode

Replace the flat `TocItem[]` with recursive `TocTreeNode[]` as the
source data. `generateToc()` returns headings for one page; a new
`buildTocTree()` combines multiple pages into the tree.

### 3. Flatten + prepare for rendering

New `flattenTocTree()` replaces `prepareTocItems()`. Produces
`FlatTocItem[]` with visual levels, ASCII prefixes, and parent
tracking. The prefix generation logic from `prepareTocItems()` works
the same way but uses `visualLevel` instead of `HeadingLevel`.

### 4. Recursive expand/collapse

Current: 2-tier TocGroup (parent + flat children).
New: recursive rendering. Each node with children is expandable.
The expand state tracks which hrefs are open. Auto-expand follows
the active page + heading.

### 5. Route-aware active tracking

- Active **page** determined by current URL pathname
- Active **heading** determined by IntersectionObserver (only for
  headings on the current page)
- Other pages' headings can't be scroll-tracked -- they're not in
  the DOM. Only the page node is marked active.

### 6. Navigation behavior

- Same-page heading links: hash navigation + smooth scroll (current)
- Cross-page links: full navigation (or SPA transition if using a
  router). The `scrollLockRef` logic only applies to same-page.

### 7. Search updates

`buildSearchEntries()` already works with flat data. Replace with
`FlatTocItem[]` directly -- it already has `parentHref` and can
derive `groupIndex` from page boundaries. Search results that point
to a different page trigger navigation instead of hash change.

## Rendering approach

Only expand headings for the **active page** by default. Other
pages show as collapsed single-line entries. This keeps the sidebar
clean even with many pages. User can manually expand any page.

```
Active page expanded, others collapsed:

Page A                    ← collapsed (clickable, navigates)
Page B                    ← active page, auto-expanded
├─ ## Introduction
│  └─ ### Background      ← active heading (highlighted)
└─ ## Setup
Page C                    ← collapsed
```

## Implementation status

All foundational refactoring is complete. The old `TocItem` /
`PreparedTocItem` / `TocGroup` / `SearchEntry` types have been
removed and replaced with the tree-based pipeline:

1. **Types** — `TocTreeNode`, `FlatTocItem`, `VisualLevel`,
   `TocNodeType` in `markdown.tsx`
2. **flattenTocTree()** — recursive walk with depth clamping and
   ASCII prefix generation in `markdown.tsx`
3. **TableOfContents** — accepts `FlatTocItem[]`, flat rendering
   with visibility filtering (expand/collapse at any depth)
4. **search.ts** — operates on `FlatTocItem[]` directly, walks
   parent chain for ancestor expansion on matches
5. **index.tsx** — `generateTocTree()` builds nested `TocTreeNode[]`
   from mdast, then `flattenTocTree()` produces the flat list

### Remaining for multi-page

- Multi-page data source (multiple MDX files / manifest)
- Route-aware active tracking (pathname for page, observer for
  headings on current page only)
- Cross-page navigation (SPA or full page load for links to
  other pages)
