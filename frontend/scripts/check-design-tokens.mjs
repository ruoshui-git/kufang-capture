import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const ignored = join(root, 'styles', 'tokens.css')
const lengthProperties =
  /^(padding(?:-.+)?|margin(?:-.+)?|gap|row-gap|column-gap|inset(?:-.+)?|top|right|bottom|left|font-size|font|border-radius|z-index|box-shadow|transition(?:-.+)?)$/i
const colorFunctions = /\b(?:rgba?|hsla?)\s*\(/i
const rawLength = /(?<![\w.-])(-?(?:\d+\.?\d*|\.\d+))(px|rem)\b/gi
const rawDuration = /(?<![\w.-])(\d+(?:\.\d+)?)(ms|s)\b/gi
const namedColors = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  ),
)

function exception(line) {
  return /\/\*\s*design-token-exception:\s*[^*]+\*\//i.test(line)
}

export function scanCss(source, file = 'input.css', lineOffset = 0) {
  const findings = []
  const lines = source.split('\n')
  lines.forEach((line, index) => {
    if (exception(line)) return
    const lineNumber = index + 1 + lineOffset
    const stripped = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
    const declarations = [...stripped.matchAll(/(?:^|[;{]\s*)\s*([\w-]+)\s*:\s*([^;{}]+)/g)]
    for (const m of stripped.matchAll(/#[\da-f]{3,8}\b/gi))
      findings.push(`${file}:${lineNumber}: colour literal ${m[0]}`)
    if (colorFunctions.test(stripped))
      findings.push(`${file}:${lineNumber}: colour function ${stripped.match(colorFunctions)?.[0]}`)
    for (const declaration of declarations) {
      const property = declaration[1]
      const value = declaration[2]
      for (const m of value.matchAll(/\b([a-z]+)\b/gi)) {
        if (namedColors.has(m[1].toLowerCase())) findings.push(`${file}:${lineNumber}: named colour ${m[1]}`)
      }
      if (!lengthProperties.test(property)) continue
      for (const m of value.matchAll(rawLength)) {
        if (Number(m[1]) === 0 || (m[1] === '1' && m[2].toLowerCase() === 'px')) continue
        findings.push(`${file}:${lineNumber}: off-scale ${property} value ${m[0]}`)
      }
      if (property.toLowerCase() === 'z-index' && /^\d+$/.test(value.trim()) && value.trim() !== '0') {
        findings.push(`${file}:${lineNumber}: off-scale z-index value ${value.trim()}`)
      }
      if (/^transition(?:-.+)?$/i.test(property)) {
        for (const m of value.matchAll(rawDuration)) {
          if (Number(m[1]) !== 0)
            findings.push(`${file}:${lineNumber}: off-scale transition duration ${m[0]}`)
        }
      }
    }
  })
  return findings
}

async function walk(dir) {
  const found = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) found.push(...(await walk(path)))
    else if (/\.(css|svelte)$/.test(item.name) && path !== ignored) found.push(path)
  }
  return found
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await walk(root)
  const all = []
  for (const path of files) {
    const text = await readFile(path, 'utf8')
    const name = relative(root, path)
    if (path.endsWith('.css')) all.push(...scanCss(text, name))
    else {
      const re = /<style\b[^>]*>([\s\S]*?)<\/style>|\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/g
      for (const match of text.matchAll(re)) {
        const start = text.slice(0, match.index).split('\n').length - 1
        all.push(...scanCss(match[1] ?? match[2] ?? match[3] ?? '', name, start))
      }
    }
  }
  if (all.length) {
    process.stderr.write(`${all.join('\n')}\n`)
    process.exitCode = 1
  } else process.stdout.write(`Design token check passed (${files.length} files).\n`)
}
