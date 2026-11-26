// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkSource } from './check-i18n.mjs'

describe('i18n checker', () => {
  it('reports template text and visible attributes but ignores expression and machine attributes', () => {
    const findings = checkSource(
      `<input type="submit" value="Save">
<Button confirmLabel="Delete item" data-testid="fixed-id">Confirm {label}</Button>
<img alt="Stock photo" title="More info" src="/images/example.jpg" />
<input aria-label="Quantity" placeholder="Enter amount" />`,
      'example.svelte',
    )
    expect(findings).toHaveLength(7)
    expect(findings).toEqual(
      expect.arrayContaining([
        'example.svelte:1: value: "Save"',
        'example.svelte:2: confirmLabel: "Delete item"',
        'example.svelte:2: template text: "Confirm"',
        'example.svelte:3: alt: "Stock photo"',
        'example.svelte:3: title: "More info"',
        'example.svelte:4: aria-label: "Quantity"',
        'example.svelte:4: placeholder: "Enter amount"',
      ]),
    )
  })

  it('checks script copy sinks with correct source offsets', () => {
    const findings = checkSource(
      `<script lang="ts">
  let error = $state('')
  error = cause?.message ?? 'Try again.'
  let label = enabled ? 'On' : m.off()
  showToast({ message: 'Some copy', actionLabel: 'Undo' })
  throw new Error(\`Missing \${id} again\`)
  const statusText = () => 'Still working'
</script>
<p>{m.status()}</p>`,
      'example.svelte',
    )
    expect(findings).toEqual([
      'example.svelte:3: error: "Try again."',
      'example.svelte:4: label: "On"',
      'example.svelte:5: message: "Some copy"',
      'example.svelte:5: actionLabel: "Undo"',
      'example.svelte:6: Error: "Missing"',
      'example.svelte:6: Error: "again"',
      'example.svelte:7: statusText: "Still working"',
    ])
  })

  it('honors only one line per reasoned exemption and reports blank reasons', () => {
    expect(
      checkSource(
        `<!-- i18n-ignore: The product name is shared. -->
<p>Capture</p>
<p>Save a copy</p><!-- i18n-ignore: -->
<p>English</p>`,
        'example.svelte',
      ),
    ).toEqual([
      'example.svelte:3: i18n-ignore requires a reason',
      'example.svelte:3: template text: "Save a copy"',
      'example.svelte:4: template text: "English"',
    ])
    expect(
      checkSource(
        `const error = 'Capture' // i18n-ignore: stable protocol value
let title = 'Translate me'`,
        'src/lib/example.ts',
      ),
    ).toEqual(['src/lib/example.ts:2: title: "Translate me"'])
  })

  it('preserves English archive and diagnostics output while still checking UI errors', () => {
    expect(
      checkSource(
        `const entry = { title: 'Entry title' }
throw new Error('Export failed')`,
        'src/lib/export/build.ts',
      ),
    ).toEqual(['src/lib/export/build.ts:2: Error: "Export failed"'])
    expect(
      checkSource(
        `<script>
let reportText = ''
reportText = 'Kufang Capture camera diagnostics'
let error = 'Try again'
</script>
<p>{m.status()}</p>`,
        'src/routes/diagnostics/DiagnosticsPage.svelte',
      ),
    ).toEqual(['src/routes/diagnostics/DiagnosticsPage.svelte:4: error: "Try again"'])
  })

  it('accepts translated text and props and ignores code identifiers', () => {
    expect(
      checkSource(
        `<script>
const method = 'POST'
let error = m.tryAgain()
function submit() { showToast({ message: m.saved() }) }
</script>
<button onclick={submit} aria-label={m.save()}>保存</button>`,
        'example.svelte',
      ),
    ).toEqual([])
  })
})
