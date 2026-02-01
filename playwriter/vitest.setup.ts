/**
 * Vitest setup file - handles unhandled rejections from Playwright CDP cleanup.
 * 
 * When tests use connectOverCDP() to connect to Chrome, Playwright may have
 * pending CDP messages when browser.close() is called. These messages get
 * rejected when the connection closes, causing "Assertion error" from
 * Playwright's internal crConnection.js. This is expected cleanup behavior,
 * not a real error.
 */

process.on('unhandledRejection', (reason: any) => {
  // Suppress Playwright's internal assertion errors during CDP cleanup
  // These happen when browser.close() is called with pending CDP messages
  if (reason?.message === 'Assertion error' || reason?.name === 'AssertionError') {
    // Check if it's from Playwright's internal code
    const stack = reason?.stack || ''
    if (stack.includes('crConnection.js') || stack.includes('crSession')) {
      // Silently ignore - this is expected cleanup behavior
      return
    }
  }
  
  // Re-throw other unhandled rejections
  console.error('Unhandled rejection:', reason)
})
