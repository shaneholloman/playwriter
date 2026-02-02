/**
 * Browser-side accessibility snapshot code.
 * Bundled and injected into page context via CDP.
 * Uses dom-accessibility-api for spec-compliant accessible name computation.
 */

import { computeAccessibleName, getRole } from 'dom-accessibility-api'

// ============================================================================
// Types
// ============================================================================

export interface A11yElement {
  ref: string
  role: string
  name: string
  element: Element
}

export interface A11ySnapshotResult {
  snapshot: string
  labelCount: number
  refs: Array<{ ref: string; role: string; name: string }>
}

export interface ComputeSnapshotOptions {
  root: Element
  interactiveOnly: boolean
  renderLabels: boolean
}

// ============================================================================
// Constants
// ============================================================================

const LABELS_CONTAINER_ID = '__playwriter_labels__'
const LABELS_TIMER_KEY = '__playwriter_labels_timer__'

// Interactive roles - elements users can click, type into, or interact with
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'searchbox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  // Media elements
  'img',
  'video',
  'audio',
])


// CSS selectors for interactive elements
const INTERACTIVE_SELECTORS = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="treeitem"]',
  'img[alt]',
  'img[aria-label]',
  '[role="img"]',
  'video',
  'audio',
  // Contenteditable
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(', ')

// Color scheme for labels by role
const ROLE_COLORS: Record<string, [string, string, string]> = {
  link: ['#FFF785', '#FFC542', '#E3BE23'],
  button: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  textbox: ['#FFCDD2', '#EF9A9A', '#E57373'],
  combobox: ['#FFCDD2', '#EF9A9A', '#E57373'],
  searchbox: ['#FFCDD2', '#EF9A9A', '#E57373'],
  spinbutton: ['#FFCDD2', '#EF9A9A', '#E57373'],
  checkbox: ['#F8BBD0', '#F48FB1', '#EC407A'],
  radio: ['#F8BBD0', '#F48FB1', '#EC407A'],
  switch: ['#F8BBD0', '#F48FB1', '#EC407A'],
  slider: ['#FFCCBC', '#FFAB91', '#FF8A65'],
  menuitem: ['#FFAB91', '#FF8A65', '#FF7043'],
  menuitemcheckbox: ['#FFAB91', '#FF8A65', '#FF7043'],
  menuitemradio: ['#FFAB91', '#FF8A65', '#FF7043'],
  tab: ['#FFE082', '#FFD54F', '#FFC107'],
  option: ['#FFE082', '#FFD54F', '#FFC107'],
  treeitem: ['#FFE082', '#FFD54F', '#FFC107'],
  img: ['#B3E5FC', '#81D4FA', '#4FC3F7'],
  video: ['#B3E5FC', '#81D4FA', '#4FC3F7'],
  audio: ['#B3E5FC', '#81D4FA', '#4FC3F7'],
}
const DEFAULT_COLORS: [string, string, string] = ['#FFF785', '#FFC542', '#E3BE23']

// ============================================================================
// Ref Generation - Prefer stable test IDs
// ============================================================================

// Test ID attributes to check, in priority order
const TEST_ID_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy', // Cypress
  'data-pw', // Playwright
]

function getStableRef(element: Element): { value: string; attr: string } | null {
  const id = element.getAttribute('id')
  if (id) {
    return { value: id, attr: 'id' }
  }
  // Check test ID attributes
  for (const attr of TEST_ID_ATTRS) {
    const value = element.getAttribute(attr)
    if (value && value.length > 0) {
      return { value, attr }
    }
  }

  return null
}

function escapeLocatorValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildLocatorFromStable(stable: { value: string; attr: string }): string {
  const escaped = escapeLocatorValue(stable.value)
  return `[${stable.attr}="${escaped}"]`
}

function buildBaseLocator({ role, name, stable }: { role: string; name: string; stable: { value: string; attr: string } | null }): string {
  if (stable) {
    return buildLocatorFromStable(stable)
  }
  const trimmedName = name.trim()
  if (trimmedName.length > 0) {
    const escapedName = escapeLocatorValue(trimmedName)
    return `role=${role}[name="${escapedName}"]`
  }
  return `role=${role}`
}

// ============================================================================
// Role Computation
// ============================================================================

function computeRole(element: Element): string {
  // First try dom-accessibility-api
  const computedRole = getRole(element)
  if (computedRole) {
    return computedRole
  }

  // Fallback for common elements
  const tagName = element.tagName.toLowerCase()
  const type = (element as HTMLInputElement).type?.toLowerCase() || ''

  const roleMap: Record<string, string | Record<string, string>> = {
    a: (element as HTMLAnchorElement).href ? 'link' : 'generic',
    button: 'button',
    input: {
      button: 'button',
      submit: 'button',
      reset: 'button',
      checkbox: 'checkbox',
      radio: 'radio',
      text: 'textbox',
      email: 'textbox',
      password: 'textbox',
      search: 'searchbox',
      tel: 'textbox',
      url: 'textbox',
      number: 'spinbutton',
      range: 'slider',
    },
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    video: 'video',
    audio: 'audio',
  }

  const mapping = roleMap[tagName]
  if (typeof mapping === 'string') {
    return mapping
  }
  if (typeof mapping === 'object' && type in mapping) {
    return mapping[type]
  }
  if (tagName === 'input') {
    return 'textbox'
  }

  return 'generic'
}

// ============================================================================
// Visibility Checks
// ============================================================================

function isElementVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect()

  // Skip elements with no size
  if (rect.width === 0 || rect.height === 0) {
    return false
  }

  // Skip elements outside viewport
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    return false
  }
  if (rect.right < 0 || rect.left > window.innerWidth) {
    return false
  }

  // Check computed style
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }

  return true
}

function isElementCovered(element: Element, rect: DOMRect): boolean {
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2

  const stack = document.elementsFromPoint(centerX, centerY)

  // Find our element in the stack
  let targetIndex = -1
  for (let i = 0; i < stack.length; i++) {
    if (element.contains(stack[i]) || stack[i].contains(element) || stack[i] === element) {
      targetIndex = i
      break
    }
  }

  if (targetIndex === -1) {
    return true // Not found = covered
  }

  // Check if any opaque element is above our target
  for (let i = 0; i < targetIndex; i++) {
    const el = stack[i]
    if ((el as HTMLElement).id === LABELS_CONTAINER_ID) {
      continue
    }
    const elStyle = window.getComputedStyle(el)
    if (elStyle.pointerEvents === 'none') {
      continue
    }
    // Check if element has opaque background
    const bgAlpha = parseColorAlpha(elStyle.backgroundColor)
    if (bgAlpha > 0.1) {
      return true
    }
    if (elStyle.backgroundImage !== 'none') {
      return true
    }
  }

  return false
}

function parseColorAlpha(color: string): number {
  if (color === 'transparent') {
    return 0
  }
  const match = color.match(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (match) {
    return match[1] !== undefined ? parseFloat(match[1]) : 1
  }
  return 1
}

// ============================================================================
// Label Rendering
// ============================================================================

function renderLabels(elements: A11yElement[]): number {
  const doc = document
  const win = window as any

  // Cancel any pending auto-hide timer
  if (win[LABELS_TIMER_KEY]) {
    win.clearTimeout(win[LABELS_TIMER_KEY])
    win[LABELS_TIMER_KEY] = null
  }

  // Remove existing labels
  doc.getElementById(LABELS_CONTAINER_ID)?.remove()

  // Create container
  const container = doc.createElement('div')
  container.id = LABELS_CONTAINER_ID
  container.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none;'

  // Inject styles
  const style = doc.createElement('style')
  style.textContent = `
    .__pw_label__ {
      position: absolute;
      font: bold 12px Helvetica, Arial, sans-serif;
      padding: 1px 4px;
      border-radius: 3px;
      color: black;
      text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6);
      white-space: nowrap;
    }
  `
  container.appendChild(style)

  // Create SVG for connector lines
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible;'
  svg.setAttribute('width', `${doc.documentElement.scrollWidth}`)
  svg.setAttribute('height', `${doc.documentElement.scrollHeight}`)

  // Arrow markers
  const defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs')
  svg.appendChild(defs)
  const markerCache: Record<string, string> = {}

  function getArrowMarkerId(color: string): string {
    if (markerCache[color]) {
      return markerCache[color]
    }
    const markerId = `arrow-${color.replace('#', '')}`
    const marker = doc.createElementNS('http://www.w3.org/2000/svg', 'marker')
    marker.setAttribute('id', markerId)
    marker.setAttribute('viewBox', '0 0 10 10')
    marker.setAttribute('refX', '9')
    marker.setAttribute('refY', '5')
    marker.setAttribute('markerWidth', '6')
    marker.setAttribute('markerHeight', '6')
    marker.setAttribute('orient', 'auto-start-reverse')
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z')
    path.setAttribute('fill', color)
    marker.appendChild(path)
    defs.appendChild(marker)
    markerCache[color] = markerId
    return markerId
  }

  container.appendChild(svg)

  // Track placed labels for overlap detection
  const placedLabels: Array<{ left: number; top: number; right: number; bottom: number }> = []
  const LABEL_HEIGHT = 17
  const LABEL_CHAR_WIDTH = 7

  let count = 0
  for (const { ref, role, element } of elements) {
    const rect = element.getBoundingClientRect()

    // Skip if covered
    if (isElementCovered(element, rect)) {
      continue
    }

    // Calculate label position
    const labelWidth = ref.length * LABEL_CHAR_WIDTH + 8
    const labelLeft = rect.left
    const labelTop = Math.max(0, rect.top - LABEL_HEIGHT)
    const labelRect = {
      left: labelLeft,
      top: labelTop,
      right: labelLeft + labelWidth,
      bottom: labelTop + LABEL_HEIGHT,
    }

    // Check overlap
    let overlaps = false
    for (const placed of placedLabels) {
      if (
        labelRect.left < placed.right &&
        labelRect.right > placed.left &&
        labelRect.top < placed.bottom &&
        labelRect.bottom > placed.top
      ) {
        overlaps = true
        break
      }
    }
    if (overlaps) {
      continue
    }

    // Get colors
    const [gradTop, gradBottom, border] = ROLE_COLORS[role] || DEFAULT_COLORS

    // Create label
    const label = doc.createElement('div')
    label.className = '__pw_label__'
    label.textContent = ref
    label.style.background = `linear-gradient(to bottom, ${gradTop} 0%, ${gradBottom} 100%)`
    label.style.border = `1px solid ${border}`
    label.style.left = `${win.scrollX + labelLeft}px`
    label.style.top = `${win.scrollY + labelTop}px`
    container.appendChild(label)

    // Draw connector line
    const line = doc.createElementNS('http://www.w3.org/2000/svg', 'line')
    const labelCenterX = win.scrollX + labelLeft + labelWidth / 2
    const labelBottomY = win.scrollY + labelTop + LABEL_HEIGHT
    const elementCenterX = win.scrollX + rect.left + rect.width / 2
    const elementCenterY = win.scrollY + rect.top + rect.height / 2
    line.setAttribute('x1', `${labelCenterX}`)
    line.setAttribute('y1', `${labelBottomY}`)
    line.setAttribute('x2', `${elementCenterX}`)
    line.setAttribute('y2', `${elementCenterY}`)
    line.setAttribute('stroke', border)
    line.setAttribute('stroke-width', '1.5')
    line.setAttribute('marker-end', `url(#${getArrowMarkerId(border)})`)
    svg.appendChild(line)

    placedLabels.push(labelRect)
    count++
  }

  doc.documentElement.appendChild(container)

  // Auto-hide after 30 seconds
  win[LABELS_TIMER_KEY] = win.setTimeout(() => {
    doc.getElementById(LABELS_CONTAINER_ID)?.remove()
    win[LABELS_TIMER_KEY] = null
  }, 30000)

  return count
}

// ============================================================================
// Snapshot Generation
// ============================================================================

function buildSnapshotLine(role: string, name: string, locator: string | null): string {
  let line = `- ${role}`
  if (name) {
    const escapedName = name.replace(/"/g, '\\"')
    line += ` "${escapedName}"`
  }
  if (locator) {
    line += ` ${locator}`
  }
  return line
}

// ============================================================================
// Main Entry Point
// ============================================================================

export function computeA11ySnapshot(options: ComputeSnapshotOptions): A11ySnapshotResult {
  const { root, interactiveOnly, renderLabels: shouldRenderLabels } = options

  // Track refs for deduplication
  const refCounts = new Map<string, number>()
  const a11yElements: A11yElement[] = []
  const refs: Array<{ ref: string; role: string; name: string }> = []
  let fallbackCounter = 0

  const getAccessibleName = (element: Element): string => {
    try {
      return computeAccessibleName(element) || ''
    } catch {
      return (
        element.getAttribute('aria-label') ||
        element.getAttribute('alt') ||
        element.getAttribute('title') ||
        (element.textContent || '').trim().slice(0, 100) ||
        ''
      )
    }
  }

  const createRefForElement = (element: Element): { ref: string; stable: { value: string; attr: string } | null } => {
    const stable = getStableRef(element)
    let baseRef = stable?.value
    if (!baseRef) {
      fallbackCounter++
      baseRef = `e${fallbackCounter}`
    }

    const count = refCounts.get(baseRef) || 0
    refCounts.set(baseRef, count + 1)
    const ref = count === 0 ? baseRef : `${baseRef}-${count + 1}`

    return { ref, stable }
  }

  const cssSelector = interactiveOnly ? INTERACTIVE_SELECTORS : '*'
  const elements = root.matches(cssSelector)
    ? [root, ...Array.from(root.querySelectorAll(cssSelector))]
    : Array.from(root.querySelectorAll(cssSelector))

  const baseLocatorByElement = new WeakMap<Element, string>()

  const includedElements = elements.reduce<Array<{ element: Element; role: string; name: string; isInteractive: boolean }>>((acc, element) => {
    if (!isElementVisible(element)) {
      return acc
    }

    const role = computeRole(element)
    const name = getAccessibleName(element)
    const hasName = name.trim().length > 0
    const isInteractive = INTERACTIVE_ROLES.has(role)
    const shouldInclude = interactiveOnly
      ? isInteractive
      : isInteractive || hasName

    if (!shouldInclude) {
      return acc
    }

    if (isInteractive) {
      const { ref, stable } = createRefForElement(element)
      const baseLocator = buildBaseLocator({ role, name, stable })
      baseLocatorByElement.set(element, baseLocator)
      a11yElements.push({ ref, role, name, element })
      refs.push({ ref, role, name })
    }

    acc.push({ element, role, name, isInteractive })
    return acc
  }, [])

  const locatorCounts = includedElements.reduce<Map<string, number>>((acc, entry) => {
    if (!entry.isInteractive) {
      return acc
    }
    const baseLocator = baseLocatorByElement.get(entry.element)
    if (!baseLocator) {
      return acc
    }
    acc.set(baseLocator, (acc.get(baseLocator) ?? 0) + 1)
    return acc
  }, new Map<string, number>())

  const locatorIndices = new Map<string, number>()
  const snapshotLines = includedElements.map((entry) => {
    let locator: string | null = null
    if (entry.isInteractive) {
      const baseLocator = baseLocatorByElement.get(entry.element)
      if (baseLocator) {
        const count = locatorCounts.get(baseLocator) ?? 0
        const index = locatorIndices.get(baseLocator) ?? 0
        locatorIndices.set(baseLocator, index + 1)
        locator = count > 1 ? `${baseLocator} >> nth=${index}` : baseLocator
      }
    }

    return buildSnapshotLine(entry.role, entry.name, locator)
  })

  const snapshot = snapshotLines.join('\n')

  let labelCount = 0
  if (shouldRenderLabels) {
    labelCount = renderLabels(a11yElements)
  }

  return { snapshot, labelCount, refs }
}

// ============================================================================
// Hide Labels
// ============================================================================

export function hideA11yLabels(): void {
  const win = window as any
  if (win[LABELS_TIMER_KEY]) {
    win.clearTimeout(win[LABELS_TIMER_KEY])
    win[LABELS_TIMER_KEY] = null
  }
  document.getElementById(LABELS_CONTAINER_ID)?.remove()
}

// ============================================================================
// Expose on globalThis for injection
// ============================================================================

;(globalThis as any).__a11y = {
  computeA11ySnapshot,
  hideA11yLabels,
}
