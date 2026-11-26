import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'svelte/compiler'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const latinWord = /[A-Za-z]{2,}/
const looksLikeProse = /^\s*[A-Z]|[A-Za-z]\s+[A-Za-z]/
const uiName = /^(error|message|label|title|text)$|(?:Error|Message|Label|Title|Text)$/
const copyFunction = /^(label|message|text)$|(?:Label|Message|Text)$/

// Accessible text plus the display props used by TextField, Menu, IconButton, Sheet,
// EmptyState and toast actions. Include the corresponding props on feature components.
const visibleAttributes = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'title',
  'placeholder',
  'alt',
  'label',
  'description',
  'message',
  'actionLabel',
  'confirmLabel',
  'cancelLabel',
  'loadingLabel',
  'emptyLabel',
  'emptyText',
  'helperText',
  'hint',
  'caption',
  'summary',
  'text',
])
const englishOutputs = new Set([
  'src/lib/export/build.ts',
  'src/lib/export/paths.ts',
  'src/lib/export/zip.ts',
  'src/lib/export/csv.ts',
  'src/lib/dev/sampleData.ts',
])
const diagnosticPage = 'src/routes/diagnostics/DiagnosticsPage.svelte'

function within(file, path) {
  return file === path || file.startsWith(path + '/')
}

function isButtonValue(name, attributes) {
  return (
    name === 'input' &&
    attributes.some(
      (attr) => attr.name === 'type' && /^(button|submit|reset)$/.test(attr.value?.[0]?.data ?? ''),
    )
  )
}

export function checkSource(source, file) {
  const findings = new Set()
  const ignored = new Set()
  const lines = source.split('\n')
  lines.forEach((line, index) => {
    const html = /(<!--)\s*i18n-ignore:\s*(.*?)\s*-->/.exec(line)
    const script = /(\/\/)\s*i18n-ignore:\s*(.*?)\s*$/.exec(line)
    const match = html ?? script
    if (!match) return
    if (!match[2]) findings.add(`${file}:${index + 1}: i18n-ignore requires a reason`)
    else ignored.add(line.slice(0, match.index).trim() ? index : index + 1)
  })

  function note(text, position, where, test = latinWord) {
    const startLine = source.slice(0, position).split('\n').length - 1
    text.split('\n').forEach((line, offset) => {
      const lineNumber = startLine + offset
      if (test.test(line) && latinWord.test(line) && !ignored.has(lineNumber))
        findings.add(`${file}:${lineNumber + 1}: ${where}: ${JSON.stringify(line.trim())}`)
    })
  }

  function scanScript(code, offset) {
    const script = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const nameOf = (node) => node && (ts.isPropertyAccessExpression(node) ? node.name.text : node.text)

    function checkValue(value, where) {
      if (!value) return
      if (ts.isStringLiteralLike(value)) {
        note(value.text, offset + value.getStart(script), where, looksLikeProse)
      } else if (ts.isTemplateExpression(value)) {
        const parts = [value.head, ...value.templateSpans.map((span) => span.literal)]
        const text = parts.map((part) => part.text).join(' ')
        if (looksLikeProse.test(text)) {
          for (const part of parts) note(part.text, offset + part.getStart(script), where)
        }
      } else if (ts.isConditionalExpression(value)) {
        checkValue(value.whenTrue, where)
        checkValue(value.whenFalse, where)
      } else if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)) {
        checkValue(value.expression, where)
      } else if (ts.isCallExpression(value) && nameOf(value.expression) === '$state') {
        checkValue(value.arguments[0], where)
      } else if (ts.isBinaryExpression(value)) {
        const op = value.operatorToken.kind
        if (
          [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
            op,
          )
        ) {
          checkValue(value.left, where)
          checkValue(value.right, where)
        }
      }
    }

    function visit(node, functionName = '') {
      if (ts.isFunctionLike(node)) functionName = nameOf(node.name) ?? nameOf(node.parent.name) ?? ''
      if (
        (ts.isNewExpression(node) && /^(?:\w*Error|DOMException)$/.test(nameOf(node.expression) ?? '')) ||
        (ts.isCallExpression(node) && nameOf(node.expression) === 'showToast')
      ) {
        checkValue(node.arguments?.[0], nameOf(node.expression))
      }
      if (!englishOutputs.has(file)) {
        if (
          ts.isVariableDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isBindingElement(node) ||
          ts.isParameter(node)
        ) {
          const name = nameOf(node.name)
          if (uiName.test(name ?? '')) checkValue(node.initializer, name)
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const name = nameOf(node.left)
          if (uiName.test(name ?? '') && !(file === diagnosticPage && name === 'reportText'))
            checkValue(node.right, name)
        } else if (ts.isReturnStatement(node) && copyFunction.test(functionName)) {
          checkValue(node.expression, functionName)
        } else if (ts.isArrowFunction(node) && copyFunction.test(functionName) && !ts.isBlock(node.body)) {
          checkValue(node.body, functionName)
        }
      }
      ts.forEachChild(node, (child) => visit(child, functionName))
    }
    visit(script)
  }

  if (file.endsWith('.svelte')) {
    const ast = parse(source, { modern: true, filename: file })
    for (const script of [ast.instance, ast.module]) {
      if (script) scanScript(source.slice(script.content.start, script.content.end), script.content.start)
    }
    function visitTemplate(node) {
      if (!node || typeof node !== 'object') return
      if (node.type === 'Text') note(node.data, node.start, 'template text')
      const attributes = node.attributes ?? []
      for (const attr of attributes) {
        if (
          attr.type !== 'Attribute' ||
          (!visibleAttributes.has(attr.name) &&
            !(attr.name === 'value' && isButtonValue(node.name, attributes)))
        )
          continue
        const parts = Array.isArray(attr.value) ? attr.value : [attr.value]
        for (const part of parts) {
          if (part.type === 'Text') note(part.data, part.start, attr.name)
          else if (part.type === 'ExpressionTag' && typeof part.expression?.value === 'string')
            note(part.expression.value, part.start, attr.name)
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (['attributes', 'expression', 'loc', 'metadata'].includes(key)) continue
        if (Array.isArray(child)) child.forEach(visitTemplate)
        else visitTemplate(child)
      }
    }
    visitTemplate(ast.fragment)
  } else {
    scanScript(source, 0)
  }
  return [...findings]
}

async function checkPaths(args) {
  const pending = args.length
    ? []
    : JSON.parse(await readFile(join(root, 'scripts/i18n-pending.json'), 'utf8'))
  const excluded = (file) =>
    within(file, 'src/lib/paraglide') || /(?:^|\/)test\/|\.test\.|\.spec\.|\.d\.ts$/.test(file)
  const files = new Set()
  async function walk(path) {
    const file = relative(root, path)
    if (excluded(file) || pending.some((skip) => within(file, skip))) return
    const entry = await stat(path)
    if (entry.isDirectory()) {
      for (const child of await readdir(path)) await walk(join(path, child))
    } else if (
      file.endsWith('.svelte') ||
      (file.endsWith('.ts') && (args.length || within(file, 'src/lib')))
    ) {
      files.add(path)
    }
  }
  for (const path of args.length ? args : [join(root, 'src')]) await walk(resolve(path))

  const findings = await Promise.all(
    [...files].map(async (path) => checkSource(await readFile(path, 'utf8'), relative(root, path))),
  )
  if (findings.some((items) => items.length)) {
    console.error(findings.flat().join('\n'))
    process.exitCode = 1
  } else {
    console.log(`i18n check passed (${files.size} files).`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkPaths(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
