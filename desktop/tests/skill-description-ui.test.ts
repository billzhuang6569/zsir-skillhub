import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { descriptionOverflows } from '../src/lib/description-overflow.ts'

const sheet = readFileSync(new URL('../src/components/SkillDetailSheet.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/SkillDetailSheet.css', import.meta.url), 'utf8')

test('description overflow uses rendered heights, including an exact three-line fit', () => {
  assert.equal(descriptionOverflows({ scrollHeight: 0, clientHeight: 0 }), false)
  assert.equal(descriptionOverflows({ scrollHeight: 20, clientHeight: 20 }), false)
  assert.equal(descriptionOverflows({ scrollHeight: 60, clientHeight: 60 }), false)
  assert.equal(descriptionOverflows({ scrollHeight: 61, clientHeight: 60 }), true)
  assert.equal(descriptionOverflows({ scrollHeight: 2000, clientHeight: 60 }), true)
})

test('only overflowing nonempty descriptions offer a keyboard accessible More button', () => {
  assert.match(sheet, /skill\.description && <>.*ref=\{descriptionRef\}.*descriptionOverflow && <button type="button" className="connection-link sh-desc-more"/)
  assert.match(css, /\.sh-desc\s*\{[^}]*-webkit-line-clamp: 3;/)
  assert.match(css, /\.sh-desc\s*\{[^}]*overflow-wrap: anywhere;[^}]*white-space: pre-wrap;/)
  assert.match(css, /\.sh-desc-more\s*\{ -webkit-app-region: no-drag;/)
})

test('full text opens separately and both close paths use the existing focus-restoring dialog', () => {
  assert.match(sheet, /event\.currentTarget\.focus\(\); setDescriptionOpen\(true\)/)
  assert.match(sheet, /descriptionOpen && <FocusTrapDialog[^>]*onEscape=\{\(\) => setDescriptionOpen\(false\)\}/)
  assert.match(sheet, /onClick=\{\(\) => setDescriptionOpen\(false\)\} aria-label="关闭完整描述"/)
  assert.match(sheet, /<p className="modal-copy" tabIndex=\{0\}>\{skill\.description\}<\/p>/)
  assert.match(css, /\.sh-description-modal \.modal-copy\s*\{ white-space: pre-wrap; overflow-wrap: anywhere;/)
  const dialog = readFileSync(new URL('../src/components/FocusTrapDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /restoreFocus\.focus\(\{ preventScroll: true \}\)/)
  assert.match(dialog, /isTopmostDialog\(dialog\)/)
})

test('Skill and description changes reset the modal and remeasure; resize observers are cleaned up', () => {
  const effect = sheet.slice(sheet.indexOf('  useLayoutEffect(() => {'), sheet.indexOf('  const unanalysed'))
  assert.match(effect, /setDescriptionOpen\(false\)/)
  assert.match(effect, /if \(!element\)\s*\{\s*setDescriptionOverflow\(false\)/)
  assert.match(effect, /setDescriptionOverflow\(descriptionOverflows\(element\)\)/)
  assert.match(effect, /measure\(\)[\s\S]*new ResizeObserver\(measure\)[\s\S]*observer\.observe\(element\)/)
  assert.match(effect, /observer\.disconnect\(\)/)
  assert.match(effect, /removeEventListener\('resize', measure\)/)
  assert.match(effect, /\[skillId, skill\?\.description, mode\]/)
})
