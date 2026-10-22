import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'
import ts from 'typescript'

type ButtonLocation = { file: string; line: number }

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

function attributeNames(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  source: ts.SourceFile
): Set<string> {
  return new Set(node.attributes.properties.flatMap((attribute) => (
    ts.isJsxAttribute(attribute) ? [attribute.name.getText(source)] : []
  )))
}

function isSubmitButton(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  source: ts.SourceFile
): boolean {
  return node.attributes.properties.some((attribute) => (
    ts.isJsxAttribute(attribute)
    && attribute.name.getText(source) === 'type'
    && attribute.initializer
    && ts.isStringLiteral(attribute.initializer)
    && attribute.initializer.text === 'submit'
  ))
}

test('every visible button is wired to an action or an explicit form submit', () => {
  const inertButtons: ButtonLocation[] = []

  for (const file of tsxFiles('src')) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        && node.tagName.getText(source) === 'button'
      ) {
        const attributes = attributeNames(node, source)
        if (!attributes.has('onClick') && !isSubmitButton(node, source)) {
          inertButtons.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  assert.deepEqual(inertButtons, [])
})
