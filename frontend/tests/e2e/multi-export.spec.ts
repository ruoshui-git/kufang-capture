import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openLocalCollection } from './helpers/local'

test('selects two collections and exports both in one ZIP', async ({ page }, testInfo) => {
  const suffix = Date.now().toString(36)
  const names = [`Multi export A ${suffix}`, `Multi export B ${suffix}`]
  await openLocalCollection(page, names[0]!)
  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill(names[1]!)
  await page.getByRole('radio', { name: /Local Only/ }).check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByRole('heading', { name: names[1]! })).toBeVisible()
  await page.goto('/')

  await page.getByRole('button', { name: 'Select' }).click()
  await page.getByRole('checkbox', { name: names[0]! }).check()
  await page.getByRole('checkbox', { name: names[1]! }).check()
  await expect(page.getByRole('region', { name: 'Export selected collections' })).toContainText('2 selected')
  await page.getByRole('button', { name: 'Export ZIP' }).click()
  await expect(page.getByRole('dialog', { name: 'Export 2 collections' })).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('dialog').getByRole('button', { name: 'Export ZIP' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^kufang-capture-2-collections-/)
  const zipPath = join(testInfo.outputDir, download.suggestedFilename())
  await download.saveAs(zipPath)
  const output = execFileSync(
    'python3',
    [
      '-c',
      'import sys,zipfile,csv,io; z=zipfile.ZipFile(sys.argv[1]); rows=list(csv.DictReader(io.StringIO(z.read("capture-export/collections.csv").decode("utf-8-sig")))); print("\\n".join(row["name"] for row in rows))',
      zipPath,
    ],
    { encoding: 'utf8' },
  )
  for (const name of names) expect(output).toContain(name)
})
