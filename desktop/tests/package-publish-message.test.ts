import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, apiSubmitMarketplaceSkill } from '../src/lib/api.ts'
import { userMessage } from '../src/lib/user-message.ts'

const fallback = '该版本当前没有可公开的安装包，请重新上传版本后再试'
const cases = [
  ['forbidden_file', '安装包里的「tokens.json」被识别为凭据文件，请改名或移除后重新上传版本'],
  ['sensitive_content', '「tokens.json」中有疑似密钥或令牌的文本，请改为占位内容后重新上传版本'],
  ['invalid_text', '「tokens.json」不是有效的文本文件，请检查编码后重新上传版本'],
  ['limits', '安装包超过公开发布的大小限制，请精简后重新上传版本'],
  ['review_limit', '安装包超过公开发布的大小限制，请精简后重新上传版本'],
  ['structure', '安装包结构不完整（缺少 SKILL.md 或 ZIP 结构异常），请重新上传版本'],
  ['missing_skill_md', '安装包结构不完整（缺少 SKILL.md 或 ZIP 结构异常），请重新上传版本'],
  ...['missing_package', 'unavailable', 'env_declaration', 'unknown', null].map(reason => [reason, fallback]),
]

test('submission preserves structured errors for the existing dialog message mapper', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let payload
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command) => {
      if (command === 'current_space') return { spaceId: 'official', generation: 1 }
      assert.equal(command, 'server_request')
      return { status: 409, headers: {}, body: { kind: 'json', value: payload } }
    } },
  } })
  try {
    for (const [reason, expected] of cases) {
      payload = { error: 'The selected version has no safe installable package', code: 'PACKAGE_NOT_PUBLISHABLE', reason, path: 'tokens.json' }
      await assert.rejects(apiSubmitMarketplaceSkill('skill', { versionId: 'version', note: 'review' }), error => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.reason, reason)
        assert.equal(error.path, 'tokens.json')
        assert.equal(userMessage(error), expected)
        return true
      })
    }
    payload = { error: 'rejected', code: 'PACKAGE_NOT_PUBLISHABLE', reason: {}, path: [] }
    await assert.rejects(apiSubmitMarketplaceSkill('skill', { versionId: 'version' }), error => {
      assert.equal(error.reason, null)
      assert.equal(error.path, null)
      assert.equal(userMessage(error), fallback)
      return true
    })
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  }
})

test('mapping requires both status and code and handles missing paths', () => {
  for (const details of [{ status: 400, code: 'PACKAGE_NOT_PUBLISHABLE' }, { status: 409, code: 'OTHER' }]) {
    assert.equal(userMessage(new ApiError('http', 'unchanged', { ...details, reason: 'forbidden_file' })), 'unchanged')
  }
  assert.equal(userMessage(new ApiError('http', 'rejected', {
    status: 409, code: 'PACKAGE_NOT_PUBLISHABLE', reason: 'forbidden_file',
  })), '安装包里的「未知文件」被识别为凭据文件，请改名或移除后重新上传版本')
})
