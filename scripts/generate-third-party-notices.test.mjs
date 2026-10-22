import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeLicenseText,
  productionNpmEntries,
  reachableCargoPackageIds,
  renderThirdPartyNotices,
  spdxLicenseIds,
} from './generate-third-party-notices.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('production npm inventory excludes packages marked development-only', () => {
  const entries = productionNpmEntries({
    packages: {
      '': {},
      'node_modules/runtime': { version: '1.0.0' },
      'node_modules/optional-runtime': { version: '2.0.0', optional: true },
      'node_modules/dev-only': { version: '3.0.0', dev: true },
    },
  })

  assert.deepEqual(
    entries.map(([path]) => path),
    ['node_modules/optional-runtime', 'node_modules/runtime'],
  )
})

test('Cargo inventory follows normal and build edges but not dev-only edges', () => {
  const metadata = {
    resolve: {
      root: 'root',
      nodes: [
        {
          id: 'root',
          deps: [
            { pkg: 'runtime', dep_kinds: [{ kind: null }] },
            { pkg: 'build', dep_kinds: [{ kind: 'build' }] },
            { pkg: 'dev', dep_kinds: [{ kind: 'dev' }] },
          ],
        },
        { id: 'runtime', deps: [{ pkg: 'transitive', dep_kinds: [{ kind: null }] }] },
        { id: 'build', deps: [] },
        { id: 'dev', deps: [{ pkg: 'dev-transitive', dep_kinds: [{ kind: null }] }] },
        { id: 'transitive', deps: [] },
        { id: 'dev-transitive', deps: [] },
      ],
    },
  }

  assert.deepEqual(new Set(reachableCargoPackageIds(metadata)), new Set(['runtime', 'build', 'transitive']))
})

test('license normalization and SPDX extraction are deterministic', () => {
  assert.equal(normalizeLicenseText('\uFEFFterms  \r\n\r\n'), 'terms\n')
  assert.deepEqual(spdxLicenseIds('MIT/Apache-2.0 WITH LLVM-exception OR (Unicode-3.0 AND Zlib)'), [
    'Apache-2.0',
    'LLVM-exception',
    'MIT',
    'Unicode-3.0',
    'Zlib',
  ])
})

test('notice rendering exposes lock hashes and full deduplicated text sections', () => {
  const digest = 'a'.repeat(64)
  const notice = renderThirdPartyNotices({
    packages: [
      {
        ecosystem: 'npm',
        name: 'example',
        version: '1.0.0',
        license: 'MIT',
        source: 'https://example.test/example',
        authors: ['Example Author'],
        texts: [{ digest, reason: 'package file LICENSE' }],
      },
    ],
    sections: new Map([
      [digest, { digest, content: 'Permission text\n', origins: new Set(['npm:example@1.0.0/LICENSE']) }],
    ]),
    target: 'aarch64-apple-darwin',
    npmLockHash: 'b'.repeat(64),
    cargoLockHash: 'c'.repeat(64),
  })

  assert.match(notice, /\[NPM\] example@1\.0\.0/)
  assert.match(notice, new RegExp(`TEXT SECTION sha256:${digest}`))
  assert.match(notice, /Permission text/)
  assert.match(notice, new RegExp(`desktop/package-lock\\.json SHA-256: ${'b'.repeat(64)}`))
})

test('Tauri packages the checked-in aggregate notice as a license resource', () => {
  const tauriConfig = JSON.parse(
    readFileSync(resolve(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8'),
  )
  assert.equal(
    tauriConfig.bundle?.resources?.['../THIRD_PARTY_NOTICES.txt'],
    'licenses/THIRD_PARTY_NOTICES.txt',
  )

  const notice = readFileSync(resolve(root, 'desktop/THIRD_PARTY_NOTICES.txt'), 'utf8')
  assert.match(notice, /^THIRD-PARTY SOFTWARE NOTICES$/m)
  assert.match(notice, /^Production npm packages: [1-9][0-9]*$/m)
  assert.match(notice, /^Reachable non-development Cargo packages: [1-9][0-9]*$/m)
  assert.match(notice, /^LICENSE AND NOTICE TEXTS$/m)
})
