export type MenuPlacement = { left: number; top: number; opensUp: boolean }

export function placeMenu(
  trigger: { left: number; right: number; top: number; bottom: number },
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  gutter = 16,
  gap = 8,
): MenuPlacement {
  const maxLeft = Math.max(gutter, viewport.width - gutter - popover.width)
  const rightAligned = trigger.right - popover.width
  const leftAligned = trigger.left
  const preferredLeft = rightAligned >= gutter ? rightAligned : leftAligned
  const left = Math.min(maxLeft, Math.max(gutter, preferredLeft))
  const below = trigger.bottom + gap
  const opensUp =
    below + popover.height > viewport.height - gutter && trigger.top - gap - popover.height >= gutter
  const top = opensUp
    ? trigger.top - gap - popover.height
    : Math.min(below, Math.max(gutter, viewport.height - gutter - popover.height))
  return { left, top, opensUp }
}
