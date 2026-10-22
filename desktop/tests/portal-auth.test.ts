import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const rust = readFileSync('src-tauri/src/portal_auth.rs', 'utf8')
const rustApp = readFileSync('src-tauri/src/lib.rs', 'utf8')
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8')
const tauriClient = readFileSync('src/lib/tauri.ts', 'utf8')
const authDialog = readFileSync('src/components/AuthDialog.tsx', 'utf8')
const accountSettings = readFileSync('src/components/AccountSettings.tsx', 'utf8')
const authStorage = readFileSync('src/lib/auth.ts', 'utf8')
const runtimeSession = readFileSync('src-tauri/src/runtime_env.rs', 'utf8')
const cliGuard = readFileSync('src-tauri/src/cli_auth.rs', 'utf8')

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing start marker: ${start}`)
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('desktop portal login uses Authorization Code with PKCE S256 and the frozen production contract', () => {
  const authorize = between(rust, 'fn authorization_url(', 'fn form_body(')
  assert.match(rust, /account\.whatonearth\.work\/realms\/yitan\/protocol\/openid-connect\/auth/)
  assert.match(rust, /account\.whatonearth\.work\/realms\/yitan\/protocol\/openid-connect\/token/)
  assert.match(rust, /const CLIENT_ID: &str = "skillhub-desktop"/)
  assert.match(rust, /const SCOPES: &str = "openid profile email"/)
  assert.match(authorize, /"response_type", "code"/)
  assert.match(authorize, /"code_challenge_method", "S256"/)
  assert.match(authorize, /"state", state/)
  assert.match(authorize, /"nonce", nonce/)
  assert.doesNotMatch(authorize, /offline_access|client_secret/)
})

test('loopback callback is IPv4-only, random-port, exact-path, bounded, cancellable and single-active', () => {
  assert.match(rust, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/)
  assert.match(rust, /const CALLBACK_PATH: &str = "\/oauth2\/callback"/)
  assert.match(rust, /http:\/\/127\.0\.0\.1:\{port\}\{CALLBACK_PATH\}/)
  assert.match(rust, /value\.path\(\) == CALLBACK_PATH/)
  assert.match(rust, /state_matches\(actual, expected_state\)/)
  assert.match(rust, /unique_query_values/)
  assert.match(rust, /AUTH_TIMEOUT/)
  assert.match(rust, /cancel\.changed\(\)/)
  assert.match(rust, /active\.replace\(ActivePortalAuth/)
  assert.match(rust, /open::that\(authorize_url\.as_str\(\)\)/)
})

test('portal credentials go only from native token exchange to the SkillHub exchange endpoints', () => {
  const exchange = between(rust, 'async fn exchange_with_skillhub(', 'enum CallbackDecision')
  assert.match(exchange, /registry\s*\.portal_request\(mode\)/)
  assert.match(readFileSync('src-tauri/src/server_request.rs', 'utf8'), /"api", "auth", "yitan", action/)
  assert.match(exchange, /access_token: &tokens\.access_token/)
  assert.match(exchange, /id_token: &tokens\.id_token/)
  assert.match(exchange, /nonce: nonce\.as_str\(\)/)
  assert.match(exchange, /expected_local_user_id,/)
  assert.match(rust, /product_session\.as_ref\(\)\.map\(LinkProductSession::user_id\)/)
  assert.match(exchange, /request = request\.bearer_auth\(token\)/)
  assert.match(rust, /self\.access_token\.zeroize\(\)/)
  assert.match(rust, /self\.id_token\.zeroize\(\)/)
  assert.match(rust, /self\.refresh_token\.zeroize\(\)/)
  assert.doesNotMatch(tauriClient, /accessToken|idToken|refreshToken/)
  assert.doesNotMatch(authDialog, /accessToken|idToken|refreshToken/)
  assert.doesNotMatch(accountSettings, /accessToken|idToken|refreshToken/)
  assert.doesNotMatch(authStorage, /accessToken|idToken|refreshToken/)
  assert.doesNotMatch(runtimeSession, /access_token|id_token|refresh_token/)
  assert.doesNotMatch(cliGuard, /access_token|id_token|refresh_token/)
})

test('legacy users retain the product JWT and get one explicit portal binding path', () => {
  assert.match(accountSettings, /currentUser\.yitanAccountLinked !== true/)
  assert.match(accountSettings, /startYitanPortalAuth\('link', currentUser\.id\)/)
  assert.match(rust, /session\.user_id\(\) != expected/)
  assert.match(accountSettings, /!sameSpace\(state, session\.space\)/)
  assert.match(accountSettings, /state\.userId !== session\.user\.id/)
  assert.match(accountSettings, /setAuthSession\(session\.user, session\.space\)/)
  assert.match(accountSettings, /账号、密码与找回/)
  assert.match(accountSettings, /openYitanAccountPortal\(\)/)
  assert.doesNotMatch(accountSettings, /apiChangePassword|type="password"/)
  assert.match(authDialog, /startYitanPortalAuth\('login'\)/)
  assert.match(authDialog, /已有旧 SkillHub 账号？迁移账号/)
  assert.doesNotMatch(authDialog, /apiRegister/)
})

test('a logged-out legacy user gets a migration-only bearer before the required portal link', () => {
  const migration = between(
    authDialog,
    'const migrateLegacyAccount',
    'const openAccountHelp',
  )
  const legacyLogin = migration.indexOf('const legacySession = await apiLogin(')
  const passwordClear = migration.indexOf("setPassword('')", legacyLogin)
  const portalLink = migration.indexOf("const linkedSession = await startYitanPortalAuth(")
  const finalCommit = migration.indexOf('await onAuthenticated(linkedSession)')
  assert.ok(legacyLogin >= 0)
  assert.ok(passwordClear > legacyLogin)
  assert.ok(passwordClear < portalLink)
  assert.ok(portalLink > legacyLogin)
  assert.ok(finalCommit > portalLink)
  assert.match(migration, /legacySession\.user\.id,/)
  assert.doesNotMatch(migration, /legacySession\.token/)
  assert.doesNotMatch(migration, /onAuthenticated\(legacySession\)|setAuthSession|syncRuntimeSession/)
  assert.match(rust, /LinkProductSession::Transient/)
  assert.match(rust, /auth_token: SecretString/)
  assert.match(rust, /expected_local_user_id: Option<&'a str>/)
  assert.match(rust, /Some\("YITAN_LOCAL_USER_MISMATCH"\)/)
})

test('native loopback callback headers are zeroized on every exit path', () => {
  const callbackReader = between(
    rust,
    'async fn read_callback_headers(',
    'async fn write_callback_page(',
  )
  const callbackWaiter = between(
    rust,
    'async fn wait_for_callback(',
    'async fn run_portal_auth(',
  )
  assert.match(rust, /struct SecretBytes\(Vec<u8>\)/)
  assert.match(rust, /impl Drop for SecretBytes/)
  assert.match(rust, /self\.0\.zeroize\(\)/)
  assert.match(callbackReader, /Result<SecretBytes, String>/)
  assert.match(callbackReader, /SecretBytes::with_capacity/)
  assert.match(callbackWaiter, /parse_callback_request\(request\.as_slice\(\), expected_state\)/)
})

test('macOS and Windows share the same native portal commands without adding a platform-only branch', () => {
  const unconditionalCargo = cargo.split("[target.'cfg(")[0] ?? cargo
  assert.match(unconditionalCargo, /tokio\s*=\s*\{[^\n]*"full"/)
  assert.match(unconditionalCargo, /open\s*=\s*"5"/)
  assert.match(unconditionalCargo, /sha2\s*=\s*"0\.10"/)
  assert.match(unconditionalCargo, /zeroize\s*=\s*"1\.8"/)
  assert.match(rustApp, /mod portal_auth;/)
  assert.match(readFileSync('src-tauri/src/server_request.rs', 'utf8'), /portal: crate::portal_auth::PortalAuthState::default\(\)/)
  assert.match(rustApp, /portal_auth::start_yitan_portal_auth/)
  assert.match(rustApp, /portal_auth::cancel_yitan_portal_auth/)
  assert.match(rustApp, /portal_auth::open_yitan_account_portal/)
  assert.doesNotMatch(rust, /cfg\((?:target_os|windows|macos)/)
})

test('CLI continues to inherit only the stable SkillHub runtime session', () => {
  assert.match(cliGuard, /runtime_session_snapshot/)
  assert.match(cliGuard, /snapshot\s*\.auth_token\(\)/)
  assert.match(runtimeSession, /struct RuntimeSession \{[^}]*user_id: String,[^}]*auth_token: Option<String>/s)
  assert.doesNotMatch(runtimeSession, /portal|oidc|refresh_token|id_token|access_token/i)
})
