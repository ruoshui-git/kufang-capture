import qrcode from 'qrcode-generator'

/** Four light modules on every side form the QR quiet zone. */
export function joinQr(url: string) {
  const qr = qrcode(0, 'M')
  qr.addData(url, 'Byte')
  qr.make()
  const modules = qr.getModuleCount()
  let path = ''
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (qr.isDark(row, column)) path += `M${column + 4} ${row + 4}h1v1h-1z`
    }
  }
  return { size: modules + 8, path }
}
