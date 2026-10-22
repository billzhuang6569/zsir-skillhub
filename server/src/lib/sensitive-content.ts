import secretTokenPatterns from './secret-token-patterns.json' with { type: 'json' }

// Shared with the native text runner; keep token recognition identical.
const SECRET_TOKEN_PATTERNS = secretTokenPatterns.map(pattern => new RegExp(pattern, 'g'))

export type SanitizedContent = {
  content: string
  redactedSecrets: number
}

type SensitiveContentOptions = {
  allowFixture?: boolean
}

// Keep both expressions strictly bounded. The previous all-in-one expression
// nested unbounded quantifiers around the name segments, which made a long
// identifier such as `a-a-a-...` take quadratic/exponential time to reject.
const ASSIGNMENT_PREFIX = /(^|[^A-Za-z0-9_-])([A-Za-z0-9][A-Za-z0-9_-]{0,255})[ \t\r\n]*[:=][ \t\r\n]*/g
const SENSITIVE_ASSIGNMENT_NAME = /^(?:[a-z0-9]+[_-]){0,32}(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|password|passwd|private[_-]?key|credentials?|database[_-]?url|redis[_-]?url|mongodb[_-]?uri|connection[_-]?string)(?:[_-][a-z0-9]+){0,32}$/i

type AssignmentRedaction = {
  start: number
  end: number
}

// A real `KEY=value`, empty `KEY=` or `key: value` line on the next line. Name
// segments are word-like (`OPENAI_API_KEY`, `S3_BUCKET`), so base64 text such
// as `c2VjcmV0cGFzc3dvcmQx=` is not one; an empty `name=` must be an
// upper-case env-template name, so base64 with `=` padding is not one.
const NEXT_LINE_ASSIGNMENT = /^([A-Za-z]{1,32}[0-9]{0,2}(?:[_-][A-Za-z]{1,32}[0-9]{0,2}){0,15})[ \t]{0,8}(?:(=)(?=[^=\s])|(=)(?=[\r\n]|$)|:(?=[ \t\r\n]|$))/

function nextLineAssignment(text: string): boolean {
  const match = NEXT_LINE_ASSIGNMENT.exec(text)
  if (match === null) return false
  if (match[3] === undefined) return true
  // An empty `NAME=` line: only an upper-case env-template name with an
  // underscore or a sensitive name, so `SECRETVALUEABCDEF=` is not one.
  const name = match[1] ?? ''
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(name)
    && (name.includes('_') || SENSITIVE_ASSIGNMENT_NAME.test(name))
}
const MAX_PLACEHOLDER_LENGTH = 256
const MAX_EXPRESSION_TAIL_LENGTH = 1024

// Every placeholder rule matches the complete value with bounded quantifiers.
// A value is never exempt merely because it contains a word such as
// `example` or `placeholder` somewhere inside it.
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  // <RIVET_TOKEN>, <your api key>
  /^<[^<>\r\n]{1,100}>$/,
  // {{ TOKEN }}
  /^\{\{[ \t]{0,4}[A-Za-z_][A-Za-z0-9_.]{0,99}[ \t]{0,4}\}\}$/,
  // $TOKEN, %TOKEN%
  /^\$[A-Za-z_][A-Za-z0-9_]{0,99}$/,
  /^%[A-Za-z_][A-Za-z0-9_]{0,99}%$/,
  // your_token_here, your-api-key
  /^your(?:[_-][a-z]{1,16}){1,6}$/i,
  // replace_me, changeme, replace-me-with-token
  /^(?:replace|change)[_-]?me(?:[_-](?:with|your|the|an?|api|key|token|secret|password|value|here|later|now)){0,4}$/i,
  /^\[redacted\]$/i,
  // xxxxxxxx, ********, ...
  /^(?:x{1,256}|\*{1,256}|\.{3,256}|\u2026{1,256})$/i,
  // sk_..., sk-..., sk_live_xxxx, ghp_****: a short prefix followed by elision.
  /^(?:[a-z]{1,8}[_-]){1,3}(?:\.{3,64}|\u2026{1,64}|x{3,64}|\*{3,64})$/i,
  // AKIAIOSFODNN7EXAMPLE, AIzaEXAMPLEXXXX, sk_test_example_key: a short
  // letters-only prefix (or AWS's documented example prefix), then a canonical
  // example word, an optional key noun and X padding only.
  /^(?:[a-z]{1,8}[_-]?|akiaiosfodnn7)?(?:(?:live|test|proj|your|my|an?|api|key|token|secret)[_-]){0,2}(?:example|placeholder|dummy|sample)(?:[_-]?(?:api[_-]?key|key|token|secret|password|value))?x{0,64}$/i,
]

const SHELL_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_.]{0,99}(?:(:?[-=?+])([^{}\s]{0,200}))?\}$/
const UPPERCASE_ENV_REFERENCE = /^[A-Z][A-Z0-9_]{1,99}$/
const UPPERCASE_ENV_SENSITIVE_NAME = /(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|REDIS_URL|MONGODB_URI|CONNECTION_STRING)/

function documentedPlaceholder(value: string, allowFixture: boolean): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_PLACEHOLDER_LENGTH) return false
  const normalized = trimmed.toLocaleLowerCase('en-US')
  if (UPPERCASE_ENV_REFERENCE.test(trimmed) && UPPERCASE_ENV_SENSITIVE_NAME.test(trimmed)) return true
  if (allowFixture && (normalized.startsWith('fixture-') || normalized.startsWith('fixture_'))) return true
  // ${TOKEN}, ${env.TOKEN}; a `${TOKEN:-default}` default or `${TOKEN:?message}`
  // message must itself be empty or not a secret candidate.
  const shellReference = SHELL_REFERENCE.exec(trimmed)
  if (shellReference !== null) {
    const fallback = shellReference[2] ?? ''
    return fallback.length === 0 || !secretCandidate(fallback, allowFixture, 1)
  }
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed))
}

// A word-like code identifier: letters/underscore/`$`, optionally ending in up
// to two digits (`s3`, `v2`). Random credential text such as `a1b2c3` does not
// qualify, so it cannot be mistaken for an identifier.
const WORD_IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]{0,63}[0-9]{0,2}/
// The root of a reference looks like code (`options`, `process`, `os`, `this`,
// `_env`), not like a capitalized passphrase word such as `Correct.Horse`.
const CODE_ROOT = /^[a-z_$]/
const MAX_EXPRESSION_DEPTH = 4
// Plain property access (no call or index) is code only from a well-known root
// or when a segment is camelCase or contains `_`/`$` (`authConfig.apiToken`);
// `hunter.two` and `correct.horse.battery.staple` remain literal values.
const KNOWN_CODE_ROOTS: ReadonlySet<string> = new Set([
  'process', 'os', 'env', 'config', 'cfg', 'options', 'opts', 'settings', 'this', 'self',
  'ctx', 'context', 'args', 'params', 'req', 'request', 'secrets', 'vault', 'window',
  'globalThis', 'import', 'credentials', 'creds', 'auth', 'conf', 'props', 'state', 'session',
])

type ReferenceShape = {
  calls: number
}
const EXPRESSION_BOUNDARY = /^(?:$|[\s,;)\]}])/

function skipInlineSpace(text: string, index: number): number {
  let cursor = index
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1
  return cursor
}

function parseIdentifier(text: string, index: number): number {
  const match = WORD_IDENTIFIER.exec(text.slice(index, index + 66))
  if (match === null) return -1
  const end = index + match[0].length
  // `Zq8vR2` must not be read as the identifier `Zq` followed by text.
  return /^[A-Za-z0-9_$]/.test(text.slice(end, end + 1)) ? -1 : end
}

function parseQuotedLiteral(text: string, index: number): number {
  const quote = text[index]
  if (quote !== '"' && quote !== "'" && quote !== '`') return -1
  const close = text.indexOf(quote, index + 1)
  if (close < 0 || /[\r\n\\]/.test(text.slice(index + 1, close))) return -1
  return close + 1
}

function parseArgument(text: string, index: number, depth: number, shape: ReferenceShape): number {
  const literalEnd = parseQuotedLiteral(text, index)
  if (literalEnd >= 0) return literalEnd
  const number = /^[0-9]{1,20}/.exec(text.slice(index, index + 21))
  if (number !== null) return index + number[0].length
  return parseReference(text, index, depth + 1, shape)
}

/**
 * Parses one well-formed reference such as `getToken()`, `options.token`,
 * `process.env.TOKEN`, `os.environ["TOKEN"]` or `config.get("token", user.id)`
 * and returns its end, or -1. Arguments may only be quoted literals, integers
 * or nested references. The source is never executed; literals inside it are
 * scanned separately by `expressionLiteralRedactions()`.
 */
function parseReference(text: string, index: number, depth: number, shape: ReferenceShape): number {
  if (depth > MAX_EXPRESSION_DEPTH || !CODE_ROOT.test(text.slice(index, index + 1))) return -1
  let cursor = parseIdentifier(text, index)
  if (cursor < 0) return -1
  let segments = 1
  while (cursor < text.length && segments <= 32) {
    const character = text[cursor]
    if (character === '.' || (character === '?' && text[cursor + 1] === '.')) {
      cursor = parseIdentifier(text, cursor + (character === '?' ? 2 : 1))
      if (cursor < 0) return -1
    } else if (character === '(' || character === '[') {
      const close = character === '(' ? ')' : ']'
      shape.calls += 1
      cursor = skipInlineSpace(text, cursor + 1)
      if (text[cursor] !== close) {
        for (let argument = 0; ; argument += 1) {
          if (argument > 8 || (close === ']' && argument > 0)) return -1
          cursor = parseArgument(text, cursor, depth, shape)
          if (cursor < 0) return -1
          cursor = skipInlineSpace(text, cursor)
          if (text[cursor] !== ',') break
          cursor = skipInlineSpace(text, cursor + 1)
        }
        if (text[cursor] !== close) return -1
      }
      cursor += 1
    } else {
      break
    }
    segments += 1
  }
  return cursor
}

/** True when the complete unquoted value is a code reference, not a literal. */
function codeExpression(tail: string): boolean {
  const shape: ReferenceShape = { calls: 0 }
  const end = parseReference(tail, 0, 0, shape)
  if (end <= 0 || !EXPRESSION_BOUNDARY.test(tail.slice(end, end + 1))) return false
  if (shape.calls > 0) return true
  const segments = tail.slice(0, end).split(/\??\./)
  return KNOWN_CODE_ROOTS.has(segments[0] ?? '')
    || segments.some((segment) => /[a-z][A-Z]|[_$]/.test(segment))
}

// Literals that only name something: `"TOKEN"`, `"api_key"`, `"accessToken"`,
// `"env.API_TOKEN"`. At most 40 characters, and every `_`/`.` segment is a
// word with at most two trailing digits, so `Zq8vR2mN...` is not a name.
const NAME_LIKE_LITERAL = /^[A-Za-z_][A-Za-z0-9_.]{0,39}$/
const NAME_SEGMENT = /^[A-Za-z]{0,40}[0-9]{0,2}$/
const URL_LITERAL = /^[a-z][a-z0-9+.-]{0,31}:\/\//i

function nameLikeLiteral(value: string): boolean {
  return NAME_LIKE_LITERAL.test(value)
    && value.split(/[_.]/).every((segment) => NAME_SEGMENT.test(segment))
}

/**
 * Generic secret heuristic for one whitespace-free value inside an expression.
 * Fails closed: anything that is not short, a name, a placeholder or a URL
 * whose query values all pass is a secret candidate.
 */
function secretCandidate(value: string, allowFixture: boolean, depth: number): boolean {
  if (value.length < 8 || nameLikeLiteral(value)) return false
  if (depth < 3 && documentedPlaceholder(value, allowFixture)) return false
  if (URL_LITERAL.test(value)) {
    // URL user information is detected separately; query values are checked
    // with the same heuristic so `?key=<secret>` is not hidden by the URL.
    const queryStart = value.indexOf('?')
    if (queryStart < 0) return false
    const query = value.slice(queryStart + 1).split('#')[0] ?? ''
    return query.split('&').some((parameter) => {
      const separator = parameter.indexOf('=')
      if (separator < 0) return false
      let parameterValue = parameter.slice(separator + 1)
      try {
        parameterValue = decodeURIComponent(parameterValue)
      } catch {
        // Keep the raw value when it is not valid percent-encoding.
      }
      return depth < 3 && secretCandidate(parameterValue, allowFixture, depth + 1)
    })
  }
  return true
}

/** A quoted literal is a secret when any whitespace-separated part is one. */
function secretLiteral(literal: string, allowFixture: boolean): boolean {
  return literal.split(/\s+/).some((part) => secretCandidate(part, allowFixture, 0))
}

type ExpressionTail = {
  text: string
  overflow: boolean
}

/**
 * The rest of the statement: up to a line break or a `;` outside quotes. A
 * statement longer than the bounded window is reported as overflow so the
 * caller fails closed instead of skipping unscanned text.
 */
function expressionTail(content: string, start: number): ExpressionTail {
  const limit = Math.min(content.length, start + MAX_EXPRESSION_TAIL_LENGTH)
  let quote: string | null = null
  let end = start
  for (; end < limit; end += 1) {
    const character = content[end]
    if (character === '\n' || character === '\r') return { text: content.slice(start, end), overflow: false }
    if (quote !== null) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character
    } else if (character === ';') {
      return { text: content.slice(start, end), overflow: false }
    }
  }
  return { text: content.slice(start, end), overflow: end < content.length }
}

/**
 * Every quoted literal inside an expression is a secret candidate: call
 * arguments, defaults, fallbacks (`||`, `??`, `or`) and concatenations alike,
 * of any length. An unterminated literal runs to the end of the statement.
 */
function expressionLiteralRedactions(
  tail: ExpressionTail,
  start: number,
  allowFixture: boolean
): AssignmentRedaction[] {
  if (tail.overflow) return [{ start, end: start + tail.text.length }]
  const text = tail.text
  const redactions: AssignmentRedaction[] = []
  for (let index = 0; index < text.length; index += 1) {
    const quote = text[index]
    if (quote !== '"' && quote !== "'" && quote !== '`') continue
    const close = text.indexOf(quote, index + 1)
    const literalEnd = close < 0 ? text.length : close
    const literal = text.slice(index + 1, literalEnd)
    const end = close < 0 ? text.length : close + 1
    // Replace the literal including its quotes, as for a quoted assignment.
    if (secretLiteral(literal, allowFixture)) redactions.push({ start: start + index, end: start + end })
    index = end - 1
  }
  return redactions
}

function redactSensitiveAssignments(
  content: string,
  allowFixture: boolean
): SanitizedContent {
  const redactions: AssignmentRedaction[] = []
  ASSIGNMENT_PREFIX.lastIndex = 0

  for (let match = ASSIGNMENT_PREFIX.exec(content); match !== null; match = ASSIGNMENT_PREFIX.exec(content)) {
    const name = match[2]
    if (name === undefined || !SENSITIVE_ASSIGNMENT_NAME.test(name)) continue

    const assignmentEnd = ASSIGNMENT_PREFIX.lastIndex
    const openingQuote = content[assignmentEnd]
    const quote = openingQuote === '"' || openingQuote === "'" ? openingQuote : null
    const tokenStart = assignmentEnd + (quote === null ? 0 : 1)
    let tokenEnd = tokenStart
    while (tokenEnd < content.length) {
      const character = content[tokenEnd]
      if (
        character === undefined
        || /\s/.test(character)
        || character === '"'
        || character === "'"
        || character === '`'
        || character === ','
        || character === ';'
      ) break
      tokenEnd += 1
    }

    const value = content.slice(tokenStart, tokenEnd)
    const hasClosingQuote = quote === null || content[tokenEnd] === quote
    if (
      quote === null
      && /[\r\n]/.test(match[0])
      && nextLineAssignment(content.slice(tokenStart, tokenStart + 600))
    ) {
      // `API_TOKEN=` with an empty value followed by another `NAME=value`
      // line, as in an env template: the next line is its own assignment.
      ASSIGNMENT_PREFIX.lastIndex = tokenStart - 1
      continue
    }
    if (quote === null) {
      const tail = expressionTail(content, assignmentEnd)
      if (tail.overflow) {
        // Too long to classify within the bounded window: fail closed.
        const overflowEnd = assignmentEnd + tail.text.length
        redactions.push({ start: assignmentEnd, end: overflowEnd })
        ASSIGNMENT_PREFIX.lastIndex = overflowEnd
        continue
      }
      if (documentedPlaceholder(value, allowFixture) || codeExpression(tail.text)) {
        // The reference itself is not a secret, but every concrete literal
        // inside the expression is still a candidate.
        const literals = expressionLiteralRedactions(tail, assignmentEnd, allowFixture)
        redactions.push(...literals)
        // Resume after the reference so `${TOKEN:?message}` is not rescanned
        // as a `TOKEN:` assignment of its own.
        ASSIGNMENT_PREFIX.lastIndex = Math.max(tokenEnd, literals.at(-1)?.end ?? tokenEnd)
        continue
      }
    }
    if (value.length < 8 || !hasClosingQuote || documentedPlaceholder(value, allowFixture)) {
      continue
    }

    const replacementEnd = tokenEnd + (quote === null ? 0 : 1)
    redactions.push({ start: assignmentEnd, end: replacementEnd })
    // A value can contain many `=` characters. Resume after the complete value
    // so those characters cannot trigger overlapping rescans.
    ASSIGNMENT_PREFIX.lastIndex = replacementEnd
    if (quote === null) {
      // An unquoted literal such as `prefix.value + "..."` may continue with
      // more literals; scan them like an expression.
      const rest = expressionLiteralRedactions(
        expressionTail(content, replacementEnd),
        replacementEnd,
        allowFixture
      )
      if (rest.length > 0) {
        redactions.push(...rest)
        ASSIGNMENT_PREFIX.lastIndex = rest.at(-1)?.end ?? replacementEnd
      }
    }
  }

  if (redactions.length === 0) return { content, redactedSecrets: 0 }

  const parts: string[] = []
  let cursor = 0
  for (const redaction of redactions) {
    parts.push(content.slice(cursor, redaction.start), '[REDACTED]')
    cursor = redaction.end
  }
  parts.push(content.slice(cursor))
  return { content: parts.join(''), redactedSecrets: redactions.length }
}

export function redactSensitiveContent(
  content: string,
  options: SensitiveContentOptions = {}
): SanitizedContent {
  const allowFixture = options.allowFixture ?? false
  let sanitized = content
  let redactedSecrets = 0
  const redactToken = (value: string): string => {
    if (documentedPlaceholder(value, allowFixture)) return value
    redactedSecrets += 1
    return '[REDACTED]'
  }

  sanitized = sanitized.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    (): string => {
      redactedSecrets += 1
      return '[REDACTED]'
    }
  )
  // A truncated key block is unsafe too. Complete blocks were consumed above,
  // so this catches only a remaining private-key header.
  sanitized = sanitized.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    (): string => {
      redactedSecrets += 1
      return '[REDACTED]'
    }
  )
  sanitized = sanitized.replace(
    /([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)([^\s/@]+)(@)/gi,
    (match, prefix: string, value: string, suffix: string): string => {
      if (documentedPlaceholder(value, allowFixture)) return match
      redactedSecrets += 1
      return `${prefix}[REDACTED]${suffix}`
    }
  )
  const assignmentRedaction = redactSensitiveAssignments(sanitized, allowFixture)
  sanitized = assignmentRedaction.content
  redactedSecrets += assignmentRedaction.redactedSecrets
  for (const pattern of SECRET_TOKEN_PATTERNS) sanitized = sanitized.replace(pattern, redactToken)
  // Google API keys have exactly 35 URL-safe characters after the AIza
  // prefix. Explicit boundaries prevent a longer example string from being
  // partially classified as a real key.
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
    redactToken
  )
  sanitized = sanitized.replace(
    /(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    (match, prefix: string, value: string): string => {
      if (documentedPlaceholder(value, allowFixture)) return match
      redactedSecrets += 1
      return `${prefix}[REDACTED]`
    }
  )
  return { content: sanitized, redactedSecrets }
}

export function containsSensitiveContent(
  content: string,
  options: SensitiveContentOptions = {}
): boolean {
  return redactSensitiveContent(content, options).redactedSecrets > 0
}
