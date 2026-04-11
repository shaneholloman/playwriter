// Toolbar injected into the page's MAIN world via chrome.scripting.executeScript({ func }).
//
// CRITICAL: This function must be entirely self-contained. It is serialized via
// Function.prototype.toString() and executed in the page context, so:
//   - No external imports or module-level variable references allowed inside the body
//   - All helpers must be defined as inner functions
//   - All constants (SVGs, CSS) must be defined inside the function body
//   - TypeScript type annotations are stripped at compile time — they are safe to use
//
// The function uses window.__playwriterPinCount as a shared MAIN-world counter so the
// toolbar and the right-click context menu flow never assign conflicting element names.

// Augment the global Window interface with Playwriter's injected properties.
// declare global is module-level and stripped at compile time — not serialized into the func.
declare global {
  interface Window {
    __playwriterToolbarInstalled?: boolean
    __playwriterToolbarDestroy?: () => void
    __playwriterPinCount?: number
    // Template literal index for pinned element globals (playwriterPinnedElem1, etc.)
    [key: `playwriterPinnedElem${number}`]: Element | undefined
  }
}

export function initPlaywriterToolbar(): void {
  // Guard: don't inject twice in the same page context (survives SPA route changes)
  if (window.__playwriterToolbarInstalled) return
  window.__playwriterToolbarInstalled = true

  // Only inject in the top-level frame — never in iframes
  try {
    if (window !== window.top) return
  } catch {
    // Cross-origin window.top access throws — we're inside a cross-origin iframe, skip
    return
  }

  // ── Declare all mutable state up front so inner functions can close over them ──

  let pinModeActive = false
  let pinCount = 0
  let toastTimer: number | null = null
  let overlayEl: HTMLDivElement | null = null
  // pinBtn is assigned in the DOM-building section below; declared here so
  // setPinMode (a hoisted function declaration) can reference it safely at call time
  let pinBtn!: HTMLButtonElement

  // ── Create shadow-DOM host ─────────────────────────────────────────────────

  const host = document.createElement('div')
  host.setAttribute('data-playwriter-toolbar', '1')
  // pointer-events:none on the host so the shadow-DOM children (pointer-events:all)
  // control interactivity without the host element itself blocking page events
  host.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;font-size:0;line-height:0;'

  // Closed shadow root: page scripts cannot access our toolbar DOM
  const shadow = host.attachShadow({ mode: 'closed' })

  const styleEl = document.createElement('style')
  // Toolbar styles mirror mesurer's toolbar.tsx:
  //   - white bg, rounded-[12px], p-1
  //   - shadow: 0px 0px .5px rgba(0,0,0,.18), 0px 3px 8px rgba(0,0,0,.1), 0px 1px 3px rgba(0,0,0,.1)
  //   - active button: #0d99ff background, white text
  //   - inactive hover: bg-black/4 (rgba(0,0,0,0.04))
  styleEl.textContent = `
    *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 1px;
      padding: 2px;
      background: #fff;
      border-radius: 8px;
      pointer-events: all;
      user-select: none;
      box-shadow: 0px 0px 0.5px rgba(0,0,0,0.18), 0px 3px 8px rgba(0,0,0,0.1), 0px 1px 3px rgba(0,0,0,0.1);
    }
    .divider {
      width: 1px;
      height: 10px;
      background: rgba(0, 0, 0, 0.08);
      margin: 0 1px;
      flex-shrink: 0;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #000;
      cursor: pointer;
      transition: background 0.1s;
      padding: 0;
      flex-shrink: 0;
      outline: none;
    }
    .btn:hover {
      background: rgba(0, 0, 0, 0.04);
    }
    .btn.active {
      background: #0d99ff;
      color: #fff;
    }
    .btn.active:hover {
      background: #0d99ff;
      filter: brightness(1.05);
    }
    /* When active, the logo inner cursor path needs to match the blue bg
       so it appears as a "cutout" through the white outer shape */
    .btn.active .logo-inner { fill: #0d99ff; }
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #0f172a;
      border-radius: 8px;
      padding: 9px 18px;
      color: rgba(255, 255, 255, 0.85);
      font-size: 11px;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      pointer-events: none;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      white-space: nowrap;
      z-index: 1;
      animation: fadein 0.15s ease;
    }
    @keyframes fadein {
      from { opacity: 0; transform: translateX(-50%) translateY(4px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `

  const toolbarEl = document.createElement('div')
  toolbarEl.className = 'toolbar'
  toolbarEl.setAttribute('role', 'toolbar')
  toolbarEl.setAttribute('aria-label', 'Playwriter tools')

  shadow.appendChild(styleEl)
  shadow.appendChild(toolbarEl)

  // ── Helper: toast notification ─────────────────────────────────────────────

  function showToast(msg: string): void {
    shadow.querySelectorAll('.toast').forEach((el) => {
      el.remove()
    })
    if (toastTimer !== null) clearTimeout(toastTimer)
    const toastEl = document.createElement('div')
    toastEl.className = 'toast'
    toastEl.textContent = msg
    shadow.appendChild(toastEl)
    toastTimer = window.setTimeout(() => {
      toastEl.remove()
    }, 1900)
  }

  // ── Helper: hover overlay (shown under cursor in pin mode) ─────────────────
  //
  // Matches mesurer's rendering exactly: four 1px-thin edge divs as the border,
  // plus a very subtle fill background. Colors from mesurer's measurement-box.tsx:
  //   outlineColor = color-mix(in oklch, oklch(0.62 0.18 255) 80%, transparent)
  //   fillColor    = color-mix(in oklch, oklch(0.62 0.18 255) 8%,  transparent)
  // This is thinner and cleaner than a CSS outline/border.

  function getOverlay(): HTMLDivElement {
    if (!overlayEl) {
      const EDGE = 'color-mix(in oklch, oklch(0.62 0.18 255) 80%, transparent)'
      const FILL = 'color-mix(in oklch, oklch(0.62 0.18 255) 8%, transparent)'

      const container = document.createElement('div')
      container.setAttribute('data-playwriter-overlay', '1')
      container.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        `background:${FILL}`,
        'display:none',
      ].join(';')

      // Four 1px edge divs — same technique as mesurer measurement-box
      const edgeTop = document.createElement('div')
      edgeTop.style.cssText = `position:absolute;top:0;left:0;width:100%;height:1px;background:${EDGE};`

      const edgeRight = document.createElement('div')
      edgeRight.style.cssText = `position:absolute;top:0;right:0;width:1px;height:100%;background:${EDGE};`

      const edgeBottom = document.createElement('div')
      edgeBottom.style.cssText = `position:absolute;bottom:0;left:0;width:100%;height:1px;background:${EDGE};`

      const edgeLeft = document.createElement('div')
      edgeLeft.style.cssText = `position:absolute;top:0;left:0;width:1px;height:100%;background:${EDGE};`

      container.appendChild(edgeTop)
      container.appendChild(edgeRight)
      container.appendChild(edgeBottom)
      container.appendChild(edgeLeft)

      document.documentElement.appendChild(container)
      overlayEl = container
    }
    return overlayEl
  }

  function positionOverlay(target: Element): void {
    const rect = target.getBoundingClientRect()
    if (!rect.width && !rect.height) return
    const overlay = getOverlay()
    overlay.style.display = 'block'
    overlay.style.top = rect.top + 'px'
    overlay.style.left = rect.left + 'px'
    overlay.style.width = rect.width + 'px'
    overlay.style.height = rect.height + 'px'
  }

  function hideOverlay(): void {
    if (overlayEl) overlayEl.style.display = 'none'
  }

  function removeOverlay(): void {
    if (overlayEl) {
      overlayEl.remove()
      overlayEl = null
    }
  }

  // ── Helper: find element at point, skipping our own injected DOM ───────────

  function getTargetAt(x: number, y: number): Element | null {
    // pointer-events:none elements are excluded from elementsFromPoint per spec,
    // so the overlay is already filtered. We still skip our toolbar host explicitly.
    const els = document.elementsFromPoint(x, y)
    return (
      els.find(
        (el) =>
          !el.hasAttribute('data-playwriter-overlay') &&
          !el.hasAttribute('data-playwriter-toolbar') &&
          el !== document.documentElement &&
          el !== document.body,
      ) ?? null
    )
  }

  // composedPath with a closed shadow root still includes the host element,
  // so this correctly detects clicks/moves that land on our toolbar
  function isOverToolbar(e: MouseEvent): boolean {
    return e.composedPath().some((node) => node === host)
  }

  // ── Helper: flash green outline on a pinned element ────────────────────────

  function flashElement(el: Element): void {
    const s = (el as HTMLElement).style
    if (!s) return
    const prevOutline = s.outline
    const prevOffset = s.outlineOffset
    s.outline = '1px solid #22c55e'
    s.outlineOffset = '2px'
    window.setTimeout(() => {
      s.outline = prevOutline
      s.outlineOffset = prevOffset
    }, 350)
  }

  // ── Helper: copy text to clipboard with execCommand fallback ───────────────

  function copyText(text: string): void {
    navigator.clipboard.writeText(text).catch(() => {
      // Fallback for pages where the Clipboard API is blocked by Permissions-Policy
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        ta.remove()
      } catch {}
    })
  }

  // ── Pin mode: allocate the next reference name ─────────────────────────────

  function allocatePinName(): `playwriterPinnedElem${number}` {
    // Sync with the shared MAIN-world counter so right-click and toolbar
    // pins never produce conflicting globalThis.playwriterPinnedElemN names
    const shared = window.__playwriterPinCount
    if (typeof shared === 'number' && shared > pinCount) pinCount = shared
    pinCount++
    window.__playwriterPinCount = pinCount
    return `playwriterPinnedElem${pinCount}`
  }

  // ── Pin mode event handlers ────────────────────────────────────────────────

  function onMouseMove(e: MouseEvent): void {
    if (isOverToolbar(e)) {
      hideOverlay()
      return
    }
    const target = getTargetAt(e.clientX, e.clientY)
    if (target) positionOverlay(target)
    else hideOverlay()
  }

  function onClick(e: MouseEvent): void {
    if (isOverToolbar(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()

    const target = getTargetAt(e.clientX, e.clientY)
    if (!target) return

    const name = allocatePinName()
    window[name] = target

    flashElement(target)

    const ref = `globalThis.${name}`
    // Prefix tells both the user and any AI agent what this string is for
    const clipboardText = `see playwriter reference: ${ref}`
    copyText(clipboardText)
    showToast(`Copied: ${ref}`)
    setPinMode(false)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') setPinMode(false)
  }

  // ── Pin mode toggle ────────────────────────────────────────────────────────

  function setPinMode(on: boolean): void {
    pinModeActive = on
    // pinBtn is declared above and assigned below; safe to reference here
    // because setPinMode is only called from event listeners that fire after
    // all setup code has run
    pinBtn.classList.toggle('active', on)

    if (on) {
      document.documentElement.style.cursor = 'crosshair'
      getOverlay() // ensure overlay element exists in DOM
      document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true })
      document.addEventListener('click', onClick, true)
      document.addEventListener('keydown', onKeyDown, true)
    } else {
      document.documentElement.style.cursor = ''
      hideOverlay()
      document.removeEventListener('mousemove', onMouseMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }

  // ── SVG icon strings (defined inside function — required for func injection) ─

  // Playwriter logo-square icon (inlined from website/public/logo-square.svg)
  const CLIPBOARD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 424 424" aria-hidden="true"><path d="M 0 212 C 0 112.063 0 62.095 31.037 31.037 C 62.116 0 112.063 0 212 0 C 311.937 0 361.905 0 392.942 31.037 C 424 62.116 424 112.063 424 212 C 424 311.937 424 361.905 392.942 392.942 C 361.926 424 311.937 424 212 424 C 112.063 424 62.095 424 31.037 392.942 C 0 361.926 0 311.937 0 212" fill="currentColor"/><path class="logo-inner" d="M 225.732 260.521 L 277.905 312.673 C 283.311 318.1 286.003 320.793 289.014 322.043 C 293.042 323.718 297.557 323.718 301.585 322.043 C 304.596 320.793 307.309 318.1 312.694 312.694 C 318.1 307.288 320.793 304.596 322.043 301.585 C 323.722 297.563 323.722 293.036 322.043 289.014 C 320.793 286.003 318.1 283.29 312.694 277.905 L 260.521 225.732 L 276.442 209.789 C 292.766 193.465 300.907 185.325 298.999 176.548 C 297.07 167.792 286.237 163.785 264.591 155.814 L 192.384 129.208 C 149.2 113.308 127.618 105.358 116.488 116.488 C 105.358 127.618 113.308 149.2 129.208 192.384 L 155.814 264.591 C 163.785 286.237 167.792 297.07 176.548 298.999 C 185.303 300.928 193.465 292.766 209.789 276.442 Z" fill="white"/></svg>`

  // Lucide x icon
  const CLOSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`

  // ── Build toolbar buttons ──────────────────────────────────────────────────

  // Clipboard / pin element button
  pinBtn = document.createElement('button')
  pinBtn.className = 'btn'
  pinBtn.setAttribute('aria-label', 'Pin element — click any element to copy its Playwriter reference')
  pinBtn.setAttribute('title', 'Pin element (click to copy reference)')
  pinBtn.innerHTML = CLIPBOARD_SVG
  pinBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation()
    setPinMode(!pinModeActive)
  })

  const dividerEl = document.createElement('div')
  dividerEl.className = 'divider'
  dividerEl.setAttribute('aria-hidden', 'true')

  // Close button
  const closeBtn = document.createElement('button')
  closeBtn.className = 'btn'
  closeBtn.setAttribute('aria-label', 'Close Playwriter toolbar')
  closeBtn.setAttribute('title', 'Close toolbar')
  closeBtn.innerHTML = CLOSE_SVG
  closeBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation()
    setPinMode(false)
    host.style.display = 'none'
  })

  toolbarEl.appendChild(pinBtn)
  toolbarEl.appendChild(dividerEl)
  toolbarEl.appendChild(closeBtn)

  // Attach host to the document (appended to <html> so it survives body rewrites)
  document.documentElement.appendChild(host)

  // ── Cleanup hook called by background.ts on tab disconnect ─────────────────

  window.__playwriterToolbarDestroy = function (): void {
    setPinMode(false)
    removeOverlay()
    host.remove()
    delete window.__playwriterToolbarInstalled
    delete window.__playwriterToolbarDestroy
    delete window.__playwriterPinCount
  }
}
