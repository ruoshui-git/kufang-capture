import { describe, expect, it } from 'vitest'
import { placeMenu } from './menuPlacement'

describe('placeMenu', () => {
  it('aligns to the trigger and clamps a menu at the left edge', () => {
    expect(
      placeMenu(
        { left: 4, right: 48, top: 80, bottom: 124 },
        { width: 240, height: 160 },
        { width: 320, height: 640 },
      ),
    ).toEqual({ left: 16, top: 132, opensUp: false })
  })

  it('opens upward when the menu would cover the bottom gutter', () => {
    expect(
      placeMenu(
        { left: 300, right: 344, top: 700, bottom: 744 },
        { width: 240, height: 180 },
        { width: 390, height: 844 },
      ),
    ).toEqual({ left: 104, top: 512, opensUp: true })
  })

  it('clamps a menu wider than the available viewport area', () => {
    expect(
      placeMenu(
        { left: 10, right: 54, top: 10, bottom: 54 },
        { width: 500, height: 700 },
        { width: 320, height: 640 },
      ),
    ).toEqual({ left: 16, top: 16, opensUp: false })
  })
})
