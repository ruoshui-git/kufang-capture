export function installKeyboardShortcuts(onNew: () => void) {
  const handler = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName))
    )
      return
    event.preventDefault()
    onNew()
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
