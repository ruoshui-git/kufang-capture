import jsQR from 'jsqr'
import { expect, it } from 'vitest'
import { joinQr } from './joinQr'

it.each(['https://capture.kufang.org/join#0H1J-5X82', 'http://127.0.0.1:8123/join#ABCD-1234'])(
  'decodes the QR path displayed by the sign-in sheet: %s',
  (url) => {
    const { size, path } = joinQr(url)
    const scale = 5
    const width = size * scale
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255)
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      const startX = Number(x) * scale
      const startY = Number(y) * scale
      for (let row = startY; row < startY + scale; row++) {
        for (let column = startX; column < startX + scale; column++) {
          const offset = (row * width + column) * 4
          pixels.fill(0, offset, offset + 3)
        }
      }
    }
    expect(jsQR(pixels, width, width)?.data).toBe(url)
  },
)
