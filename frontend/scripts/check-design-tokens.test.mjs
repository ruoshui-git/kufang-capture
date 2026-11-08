import test from 'node:test'
import assert from 'node:assert/strict'
import { scanCss } from './check-design-tokens.mjs'

test('detects each forbidden design value category', () => {
  const findings = scanCss(`.x {
  color: #123456;
  background: rgb(1 2 3);
  border-color: red;
  padding: 7px;
  font-size: 1rem;
  border-radius: 9px;
  z-index: 4;
  box-shadow: 0 3px 8px #000;
  transition-duration: 250ms;
}`)
  assert.equal(findings.length, 11)
  for (const category of [
    'colour literal',
    'colour function',
    'named colour',
    'padding',
    'font-size',
    'border-radius',
    'z-index',
    'box-shadow',
    'transition duration',
  ]) {
    assert.ok(
      findings.some((finding) => finding.includes(category)),
      `missing ${category}`,
    )
  }
})

test('allows tokens, zero, hairlines, media conditions, and documented line exceptions', () => {
  assert.deepEqual(
    scanCss(
      `@media (min-width: 820px) {\n  .x {\n    padding: var(--space-3);\n    border-width: 1px;\n    margin: 0;\n    gap: 7px; /* design-token-exception: legacy browser quirk */\n  }\n}`,
    ),
    [],
  )
})

test('checks every declaration on a line', () => {
  assert.deepEqual(scanCss('.x { padding: var(--space-3); color: blue; }'), [
    'input.css:1: named colour blue',
  ])
})

test('checks each spacing, inset, size, and duration property', () => {
  const findings = scanCss(`.x {
    margin: 6px;
    gap: 10px;
    inset: 3px;
    top: 5px;
    right: 5px;
    bottom: 5px;
    left: 5px;
    transition: opacity 180ms ease;
  }`)
  for (const property of [
    'margin',
    'gap',
    'inset',
    'top',
    'right',
    'bottom',
    'left',
    'transition duration',
  ]) {
    assert.ok(
      findings.some((finding) => finding.includes(property)),
      `missing ${property}`,
    )
  }
})
