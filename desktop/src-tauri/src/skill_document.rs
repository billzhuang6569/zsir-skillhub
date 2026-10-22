//! Bounded SKILL.md frontmatter reader shared by the GUI and the CLI.
//!
//! Agent Skills declare their metadata in a YAML frontmatter block. SkillHub
//! only reads a handful of display fields, so this module interprets the YAML
//! subset those fields use in real Skills: plain, single- and double-quoted
//! scalars, literal (`|`) and folded (`>`) block scalars, multi-line plain
//! scalars, and inline or block lists. Nested mappings are kept verbatim for
//! display. Anything else is skipped rather than guessed.

use serde::{Deserialize, Serialize};

/// Upper bound on frontmatter lines considered; matches the read budget of
/// the list views so a pathological file cannot stall a scan.
const MAX_FRONTMATTER_LINES: usize = 200;
const MAX_LABELS: usize = 16;
pub(crate) const SPEC_NAME_MAX_CHARS: usize = 64;
pub(crate) const SPEC_DESCRIPTION_MAX_CHARS: usize = 1024;
pub(crate) const RECOMMENDED_SKILL_MD_BYTES: usize = 500 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum FrontmatterValue {
    Text(String),
    List(Vec<String>),
    /// A nested mapping or other structure, dedented and kept verbatim.
    Block(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterField {
    pub key: String,
    pub value: FrontmatterValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillDocument<'a> {
    pub has_frontmatter: bool,
    /// The opening `---` was never closed. Fields are still read so the
    /// Skill keeps a readable name, and lint reports the problem.
    pub unterminated: bool,
    pub fields: Vec<FrontmatterField>,
    pub body: &'a str,
}

impl SkillDocument<'_> {
    fn field(&self, key: &str) -> Option<&FrontmatterValue> {
        self.fields
            .iter()
            .find(|field| field.key == key)
            .map(|field| &field.value)
    }

    /// Non-empty text of the first field with this key.
    pub(crate) fn text(&self, key: &str) -> Option<&str> {
        match self.field(key)? {
            FrontmatterValue::Text(value) => Some(value.as_str()).filter(|value| !value.is_empty()),
            FrontmatterValue::List(_) | FrontmatterValue::Block(_) => None,
        }
    }

    /// Labels written as a YAML list, an inline `[a, b]` list, or a plain
    /// comma-separated value.
    pub(crate) fn list(&self, key: &str) -> Option<Vec<String>> {
        let items = match self.field(key)? {
            FrontmatterValue::List(items) => items.clone(),
            FrontmatterValue::Text(value) => value
                .split(',')
                .map(|item| unquote_plain(item.trim()))
                .collect(),
            FrontmatterValue::Block(_) => return None,
        };
        let mut unique = Vec::new();
        for item in items {
            if !item.is_empty() && !unique.contains(&item) {
                unique.push(item);
            }
            if unique.len() == MAX_LABELS {
                break;
            }
        }
        Some(unique)
    }

    /// Display name precedence shared with the Server: explicit display
    /// fields first, then the Skill's machine `name`.
    pub(crate) fn display_name(&self) -> Option<&str> {
        ["displayName", "display_name", "title", "name"]
            .into_iter()
            .find_map(|key| self.text(key))
    }
}

pub(crate) fn parse_skill_document(content: &str) -> SkillDocument<'_> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let no_frontmatter = SkillDocument {
        has_frontmatter: false,
        unterminated: false,
        fields: Vec::new(),
        body: content,
    };
    let mut lines = content.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return no_frontmatter;
    };
    if line_text(first).trim_end() != "---" {
        return no_frontmatter;
    }
    let mut frontmatter = Vec::new();
    let mut offset = first.len();
    for raw in lines.take(MAX_FRONTMATTER_LINES) {
        offset += raw.len();
        let text = line_text(raw);
        if matches!(text.trim_end(), "---" | "...") {
            return SkillDocument {
                has_frontmatter: true,
                unterminated: false,
                fields: parse_fields(&frontmatter),
                body: &content[offset..],
            };
        }
        frontmatter.push(text);
    }
    SkillDocument {
        has_frontmatter: true,
        unterminated: true,
        fields: parse_fields(&frontmatter),
        body: &content[content.len()..],
    }
}

fn line_text(raw: &str) -> &str {
    raw.trim_end_matches('\n').trim_end_matches('\r')
}

fn is_indented(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t')
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

fn indentation(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

fn top_level_key(line: &str) -> Option<(&str, &str)> {
    if is_indented(line) || line.starts_with('#') || line.starts_with('-') {
        return None;
    }
    let (key, rest) = line.split_once(':')?;
    let valid = !key.is_empty()
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        });
    if !valid || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    Some((key, rest.trim()))
}

fn parse_fields(lines: &[&str]) -> Vec<FrontmatterField> {
    let mut fields = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let Some((key, rest)) = top_level_key(lines[index]) else {
            index += 1;
            continue;
        };
        index += 1;
        let start = index;
        // Continuation lines: indented or blank lines, and compact block list
        // items written at column zero (`labels:\n- a`).
        while index < lines.len() {
            let line = lines[index];
            let compact_item = rest.is_empty() && (line.starts_with("- ") || line == "-");
            if is_blank(line) || is_indented(line) || compact_item {
                index += 1;
            } else {
                break;
            }
        }
        let mut continuation = &lines[start..index];
        while continuation.last().is_some_and(|line| is_blank(line)) {
            continuation = &continuation[..continuation.len() - 1];
        }
        if let Some(value) = parse_value(rest, continuation) {
            if !fields
                .iter()
                .any(|field: &FrontmatterField| field.key == key)
            {
                fields.push(FrontmatterField {
                    key: key.to_string(),
                    value,
                });
            }
        }
    }
    fields
}

fn parse_value(rest: &str, continuation: &[&str]) -> Option<FrontmatterValue> {
    if let Some(header) = rest.strip_prefix(['|', '>']) {
        let folded = rest.starts_with('>');
        let header = strip_comment(header).trim();
        let explicit_indent = header
            .chars()
            .find(|character| character.is_ascii_digit())
            .and_then(|digit| digit.to_digit(10))
            .map(|digit| digit as usize);
        return Some(FrontmatterValue::Text(block_scalar(
            continuation,
            folded,
            explicit_indent,
        )));
    }
    if rest.starts_with('"') || rest.starts_with('\'') {
        let joined = join_flow(rest, continuation);
        return Some(FrontmatterValue::Text(quoted_scalar(&joined)));
    }
    if rest.starts_with('[') {
        let joined = join_flow(rest, continuation);
        return Some(FrontmatterValue::List(flow_list(&joined)));
    }
    if rest.is_empty() {
        let first = continuation.iter().find(|line| !is_blank(line))?;
        let trimmed = first.trim_start();
        if trimmed.starts_with("- ") || trimmed == "-" {
            return Some(FrontmatterValue::List(block_list(continuation)));
        }
        if top_level_key(trimmed).is_some() {
            return Some(FrontmatterValue::Block(dedent(continuation)));
        }
        return Some(FrontmatterValue::Text(fold_plain(
            continuation.iter().copied(),
        )));
    }
    let first = strip_comment(rest);
    let lines = std::iter::once(first).chain(continuation.iter().copied());
    Some(FrontmatterValue::Text(unquote_plain(&fold_plain(lines))))
}

/// Removes a ` #` comment from a plain scalar.
fn strip_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'#' && (index == 0 || matches!(bytes[index - 1], b' ' | b'\t')) {
            return value[..index].trim_end();
        }
    }
    value
}

fn unquote_plain(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        return quoted_scalar(value);
    }
    value.to_string()
}

/// Plain multi-line scalars fold line breaks into spaces; an empty line
/// becomes a newline.
fn fold_plain<'a>(lines: impl Iterator<Item = &'a str>) -> String {
    let mut output = String::new();
    let mut pending_break = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !output.is_empty() {
                output.push('\n');
            }
            pending_break = false;
            continue;
        }
        if pending_break {
            output.push(' ');
        }
        output.push_str(trimmed);
        pending_break = true;
    }
    output.trim().to_string()
}

fn block_scalar(lines: &[&str], folded: bool, explicit_indent: Option<usize>) -> String {
    let indent = explicit_indent.unwrap_or_else(|| {
        lines
            .iter()
            .filter(|line| !is_blank(line))
            .map(|line| indentation(line))
            .min()
            .unwrap_or(0)
    });
    let content = lines
        .iter()
        .map(|line| {
            if is_blank(line) {
                ""
            } else {
                line.get(indent.min(indentation(line))..).unwrap_or("")
            }
        })
        .collect::<Vec<_>>();
    if !folded {
        return content.join("\n").trim_end().to_string();
    }
    let mut output = String::new();
    let mut previous_text = false;
    for line in content {
        if line.is_empty() {
            output.push('\n');
            previous_text = false;
        } else if line.starts_with([' ', '\t']) {
            // More-indented lines keep their own line in folded scalars.
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(line);
            output.push('\n');
            previous_text = false;
        } else {
            if previous_text {
                output.push(' ');
            }
            output.push_str(line);
            previous_text = true;
        }
    }
    output.trim_end().to_string()
}

fn join_flow(first: &str, continuation: &[&str]) -> String {
    std::iter::once(first)
        .chain(continuation.iter().map(|line| line.trim()))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn quoted_scalar(value: &str) -> String {
    let mut characters = value.chars();
    let Some(quote) = characters.next() else {
        return String::new();
    };
    let mut output = String::new();
    while let Some(character) = characters.next() {
        if quote == '\'' {
            if character == '\'' {
                if characters.clone().next() == Some('\'') {
                    characters.next();
                    output.push('\'');
                    continue;
                }
                break;
            }
            output.push(character);
            continue;
        }
        match character {
            '"' => break,
            '\\' => match characters.next() {
                Some('n') => output.push('\n'),
                Some('t') => output.push('\t'),
                Some('u') => {
                    let code = characters.by_ref().take(4).collect::<String>();
                    if let Some(decoded) =
                        u32::from_str_radix(&code, 16).ok().and_then(char::from_u32)
                    {
                        output.push(decoded);
                    }
                }
                Some(other) => output.push(other),
                None => break,
            },
            other => output.push(other),
        }
    }
    output.trim().to_string()
}

fn flow_list(value: &str) -> Vec<String> {
    let inner = value.trim().trim_start_matches('[');
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for character in inner.chars() {
        match (quote, character) {
            (None, ']') => break,
            (None, ',') => {
                items.push(unquote_plain(&current));
                current.clear();
            }
            (None, '"' | '\'') => {
                quote = Some(character);
                current.push(character);
            }
            (Some(open), _) if character == open => {
                quote = None;
                current.push(character);
            }
            _ => current.push(character),
        }
    }
    items.push(unquote_plain(&current));
    items.retain(|item| !item.is_empty());
    items
}

fn block_list(lines: &[&str]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let item = trimmed.strip_prefix('-')?;
            if !(item.is_empty() || item.starts_with(' ')) {
                return None;
            }
            Some(unquote_plain(strip_comment(item.trim())))
        })
        .filter(|item| !item.is_empty())
        .collect()
}

fn dedent(lines: &[&str]) -> String {
    let indent = lines
        .iter()
        .filter(|line| !is_blank(line))
        .map(|line| indentation(line))
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| line.get(indent.min(indentation(line))..).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

// ── metadata.skillhub.env declaration (#251) ─────────────────────────────────
//
// Authors declare the keys a Skill needs in its own frontmatter:
//
// ```yaml
// metadata:
//   skillhub:
//     env:
//       - key: FAL_KEY
//         required: true
//         description: fal.ai API Key
//         obtain: https://fal.ai/dashboard/keys
// ```
//
// The Server's `skill-env-declaration.ts` reads the same subset and both run
// `tests/fixtures/env-declaration-cases.json`. An invalid declaration is an
// explicit error, never silently dropped. Other `metadata` keys are ignored
// here and preserved byte for byte by `write_env_declarations`.

pub(crate) const MAX_ENV_DECLARATIONS: usize = 100;
pub(crate) const MAX_ENV_DESCRIPTION_CHARS: usize = 200;
const MAX_ENV_OBTAIN_CHARS: usize = 500;
const ENV_DECLARATION_ERROR: &str = "SKILL.md 中 metadata.skillhub.env 声明无效";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDeclaration {
    pub key: String,
    #[serde(default = "default_required")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtain: Option<String>,
}

fn default_required() -> bool {
    true
}

fn declaration_error(detail: impl std::fmt::Display) -> String {
    format!("{ENV_DECLARATION_ERROR}：{detail}")
}

pub(crate) fn valid_env_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    matches!(bytes.first(), Some(b'A'..=b'Z'))
        && bytes.len() <= 100
        && bytes
            .iter()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

fn valid_obtain(value: &str) -> bool {
    value.len() > "https://".len()
        && value.starts_with("https://")
        && value.chars().count() <= MAX_ENV_OBTAIN_CHARS
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

/// Validates the bounds shared with the Server: key format, `obtain` only as
/// an `https://` link, description length, entry count and unique keys.
pub(crate) fn validate_env_declarations(
    declarations: Vec<EnvDeclaration>,
) -> Result<Vec<EnvDeclaration>, String> {
    if declarations.len() > MAX_ENV_DECLARATIONS {
        return Err(declaration_error(format!(
            "最多声明 {MAX_ENV_DECLARATIONS} 项"
        )));
    }
    let mut seen = Vec::<String>::new();
    let mut output = Vec::with_capacity(declarations.len());
    for (index, declaration) in declarations.into_iter().enumerate() {
        let item = index + 1;
        let key = declaration.key.trim().to_string();
        if !valid_env_key(&key) {
            return Err(declaration_error(format!(
                "第 {item} 项的 key 不合法，只能使用大写字母、数字和下划线，并以大写字母开头"
            )));
        }
        if seen.contains(&key) {
            return Err(declaration_error(format!("key「{key}」重复声明")));
        }
        let description = declaration
            .description
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(description) = &description {
            if description.chars().count() > MAX_ENV_DESCRIPTION_CHARS {
                return Err(declaration_error(format!(
                    "{key} 的 description 超过 {MAX_ENV_DESCRIPTION_CHARS} 个字符"
                )));
            }
            if description.chars().any(char::is_control) {
                return Err(declaration_error(format!(
                    "{key} 的 description 不能包含换行或控制字符"
                )));
            }
        }
        let obtain = declaration
            .obtain
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if obtain.as_deref().is_some_and(|value| !valid_obtain(value)) {
            return Err(declaration_error(format!(
                "{key} 的 obtain 只能是 https:// 开头的链接"
            )));
        }
        seen.push(key.clone());
        output.push(EnvDeclaration {
            key,
            required: declaration.required,
            description,
            obtain,
        });
    }
    Ok(output)
}

/// `key: rest` entry of a mapping whose keys sit at column zero, with its
/// continuation lines (blank, indented, or compact `- ` items).
fn mapping_entry<'a>(lines: &[&'a str], wanted: &str) -> Option<(&'a str, Vec<&'a str>)> {
    let mut index = 0;
    while index < lines.len() {
        let Some((key, rest)) = top_level_key(lines[index]) else {
            index += 1;
            continue;
        };
        index += 1;
        let start = index;
        while index < lines.len() {
            let line = lines[index];
            let compact_item = rest.is_empty() && (line.starts_with("- ") || line == "-");
            if is_blank(line) || is_indented(line) || compact_item {
                index += 1;
            } else {
                break;
            }
        }
        if key == wanted {
            let mut continuation = lines[start..index].to_vec();
            while continuation.last().is_some_and(|line| is_blank(line)) {
                continuation.pop();
            }
            return Some((strip_comment(rest).trim(), continuation));
        }
    }
    None
}

fn dedent_lines<'a>(lines: &[&'a str]) -> Vec<&'a str> {
    let indent = lines
        .iter()
        .filter(|line| !is_blank(line))
        .map(|line| indentation(line))
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| line.get(indent.min(indentation(line))..).unwrap_or(""))
        .collect()
}

fn is_comment(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

fn declaration_scalar(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.starts_with(['|', '>']) {
        return Err(declaration_error("只支持单行取值，不支持 | 或 > 多行写法"));
    }
    if value.starts_with(['"', '\'']) {
        return Ok(quoted_scalar(value));
    }
    Ok(unquote_plain(strip_comment(value)))
}

fn parse_declaration_item(item: usize, lines: &[&str]) -> Result<EnvDeclaration, String> {
    let mut fields: Vec<(&str, String)> = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, rest)) = top_level_key(trimmed) else {
            return Err(declaration_error(format!(
                "第 {item} 项无法解析「{trimmed}」，每一行应写成 名称: 值"
            )));
        };
        if !fields.iter().any(|(existing, _)| *existing == key) {
            fields.push((key, declaration_scalar(rest)?));
        }
    }
    let value = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.clone())
    };
    let key = value("key")
        .filter(|key| !key.is_empty())
        .ok_or_else(|| declaration_error(format!("第 {item} 项缺少 key")))?;
    let required = match value("required").as_deref() {
        None | Some("") => true,
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "true" => true,
            "false" => false,
            _ => {
                return Err(declaration_error(format!(
                    "{key} 的 required 只能是 true 或 false"
                )))
            }
        },
    };
    Ok(EnvDeclaration {
        key,
        required,
        description: value("description"),
        obtain: value("obtain"),
    })
}

impl SkillDocument<'_> {
    /// Keys declared under `metadata.skillhub.env`; empty when absent.
    pub(crate) fn env_declarations(&self) -> Result<Vec<EnvDeclaration>, String> {
        let metadata = match self.field("metadata") {
            Some(FrontmatterValue::Block(metadata)) => metadata,
            _ => return Ok(Vec::new()),
        };
        let metadata_lines = metadata.split('\n').collect::<Vec<_>>();
        let Some((rest, continuation)) = mapping_entry(&metadata_lines, "skillhub") else {
            return Ok(Vec::new());
        };
        if !rest.is_empty() {
            return Err(declaration_error("metadata.skillhub 必须是多行映射"));
        }
        let skillhub = dedent_lines(&continuation);
        let Some((rest, continuation)) = mapping_entry(&skillhub, "env") else {
            return Ok(Vec::new());
        };
        if rest == "[]" {
            return Ok(Vec::new());
        }
        if !rest.is_empty() {
            return Err(declaration_error(
                "env 必须是列表，每一项写成 - key: 变量名",
            ));
        }
        let mut items: Vec<Vec<&str>> = Vec::new();
        for line in dedent_lines(&continuation) {
            if is_blank(line) || is_comment(line) {
                continue;
            }
            if !is_indented(line) {
                let Some(first) = line.strip_prefix('-') else {
                    return Err(declaration_error("env 的每一项必须以 - 开头"));
                };
                if !(first.is_empty() || first.starts_with(' ')) {
                    return Err(declaration_error("env 的每一项必须以 - 开头"));
                }
                items.push(vec![first]);
                continue;
            }
            let Some(item) = items.last_mut() else {
                return Err(declaration_error("env 的每一项必须以 - 开头"));
            };
            item.push(line);
        }
        let declarations = items
            .iter()
            .enumerate()
            .map(|(index, lines)| parse_declaration_item(index + 1, lines))
            .collect::<Result<Vec<_>, _>>()?;
        validate_env_declarations(declarations)
    }
}

fn render_env_block(indent: usize, declarations: &[EnvDeclaration], eol: &str) -> String {
    let pad = " ".repeat(indent);
    if declarations.is_empty() {
        return format!("{pad}env: []{eol}");
    }
    let mut output = format!("{pad}env:{eol}");
    for declaration in declarations {
        output.push_str(&format!("{pad}  - key: {}{eol}", declaration.key));
        output.push_str(&format!("{pad}    required: {}{eol}", declaration.required));
        if let Some(description) = &declaration.description {
            let quoted = serde_json::to_string(description).unwrap_or_else(|_| "\"\"".into());
            output.push_str(&format!("{pad}    description: {quoted}{eol}"));
        }
        if let Some(obtain) = &declaration.obtain {
            output.push_str(&format!("{pad}    obtain: {obtain}{eol}"));
        }
    }
    output
}

/// End (exclusive) of the block that starts after `start` and holds lines
/// that are blank or indented deeper than `parent`; trailing blank lines are
/// left outside so they stay where they were.
fn block_end(texts: &[&str], start: usize, limit: usize, parent: usize, compact: bool) -> usize {
    let mut end = start;
    let mut index = start;
    while index < limit {
        let line = texts[index];
        let compact_item = compact && indentation(line) == parent && {
            let trimmed = line.trim_start();
            trimmed == "-" || trimmed.starts_with("- ")
        };
        if is_blank(line) {
            index += 1;
            continue;
        }
        if indentation(line) > parent || compact_item {
            index += 1;
            end = index;
        } else {
            break;
        }
    }
    end
}

fn first_child_indent(texts: &[&str], start: usize, end: usize) -> Option<usize> {
    texts[start..end]
        .iter()
        .find(|line| !is_blank(line) && !is_comment(line))
        .map(|line| indentation(line))
}

fn find_child(texts: &[&str], start: usize, end: usize, indent: usize, key: &str) -> Option<usize> {
    (start..end).find(|index| {
        let line = texts[*index];
        indentation(line) == indent
            && top_level_key(&line[indent..]).is_some_and(|(found, _)| found == key)
    })
}

/// Rewrites only `metadata.skillhub.env` (creating `metadata` / `skillhub`
/// when missing); every other byte of SKILL.md, line endings included, is
/// kept. The result is re-read and must yield exactly `declarations`.
pub(crate) fn write_env_declarations(
    content: &str,
    declarations: &[EnvDeclaration],
) -> Result<String, String> {
    let declarations = validate_env_declarations(declarations.to_vec())?;
    let (bom, source) = match content.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", content),
    };
    let raw: Vec<&str> = source.split_inclusive('\n').collect();
    let eol = if raw.first().is_some_and(|line| line.ends_with("\r\n")) {
        "\r\n"
    } else {
        "\n"
    };
    let has_frontmatter = raw
        .first()
        .is_some_and(|line| line_text(line).trim_end() == "---");
    let updated = if !has_frontmatter {
        if declarations.is_empty() {
            return Ok(content.to_string());
        }
        let block = render_env_block(4, &declarations, eol);
        format!("{bom}---{eol}metadata:{eol}  skillhub:{eol}{block}---{eol}{source}")
    } else {
        let texts: Vec<&str> = raw.iter().map(|line| line_text(line)).collect();
        let close = texts
            .iter()
            .enumerate()
            .skip(1)
            .take(MAX_FRONTMATTER_LINES)
            .find(|(_, text)| matches!(text.trim_end(), "---" | "..."))
            .map(|(index, _)| index)
            .ok_or("SKILL.md 元数据缺少结尾的 ---，请先修复后再写入声明")?;
        let one_line = |what: &str| {
            format!("SKILL.md 中 {what} 写在同一行，无法安全改写；请改成多行写法后重试")
        };
        let (start, end, insert) = match (1..close)
            .find(|index| top_level_key(texts[*index]).is_some_and(|(key, _)| key == "metadata"))
        {
            None => (
                close,
                close,
                format!(
                    "metadata:{eol}  skillhub:{eol}{}",
                    render_env_block(4, &declarations, eol)
                ),
            ),
            Some(metadata) => {
                if top_level_key(texts[metadata])
                    .is_some_and(|(_, rest)| !strip_comment(rest).trim().is_empty())
                {
                    return Err(one_line("metadata"));
                }
                let metadata_end = block_end(&texts, metadata + 1, close, 0, false);
                let child = first_child_indent(&texts, metadata + 1, metadata_end).unwrap_or(2);
                match find_child(&texts, metadata + 1, metadata_end, child, "skillhub") {
                    None => (
                        metadata_end,
                        metadata_end,
                        format!(
                            "{}skillhub:{eol}{}",
                            " ".repeat(child),
                            render_env_block(child + 2, &declarations, eol)
                        ),
                    ),
                    Some(skillhub) => {
                        let (_, rest) =
                            top_level_key(&texts[skillhub][child..]).unwrap_or_default();
                        if !strip_comment(rest).trim().is_empty() {
                            return Err(one_line("metadata.skillhub"));
                        }
                        let skillhub_end =
                            block_end(&texts, skillhub + 1, metadata_end, child, false);
                        let grandchild = first_child_indent(&texts, skillhub + 1, skillhub_end)
                            .unwrap_or(child + 2);
                        match find_child(&texts, skillhub + 1, skillhub_end, grandchild, "env") {
                            None => (
                                skillhub_end,
                                skillhub_end,
                                render_env_block(grandchild, &declarations, eol),
                            ),
                            Some(env) => (
                                env,
                                block_end(&texts, env + 1, skillhub_end, grandchild, true),
                                render_env_block(grandchild, &declarations, eol),
                            ),
                        }
                    }
                }
            }
        };
        if declarations.is_empty() && start == end {
            return Ok(content.to_string());
        }
        let mut output = String::from(bom);
        raw[..start].iter().for_each(|line| output.push_str(line));
        output.push_str(&insert);
        raw[end..].iter().for_each(|line| output.push_str(line));
        output
    };
    let reread = parse_skill_document(&updated).env_declarations()?;
    if reread != declarations {
        return Err("写回后的 SKILL.md 无法读回同样的声明（元数据可能超过 200 行）".into());
    }
    Ok(updated)
}

/// First prose line of the body, used when the frontmatter has no
/// description.
pub(crate) fn first_paragraph_line(body: &str) -> Option<&str> {
    body.lines().map(str::trim).find(|line| {
        !line.is_empty()
            && !line.starts_with('#')
            && !line.starts_with("<!--")
            && !line.starts_with("```")
    })
}

/// First `# ` heading of the body.
pub(crate) fn first_heading(body: &str) -> Option<&str> {
    body.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|heading| !heading.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLintIssue {
    pub code: &'static str,
    pub message: String,
}

pub(crate) fn valid_spec_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
        && !name.contains("--")
}

/// Advisory checks against the Agent Skills metadata conventions. They never
/// block local use; they explain why some Agents may not pick a Skill up.
pub(crate) fn lint_skill_document(
    document: &SkillDocument<'_>,
    content_bytes: usize,
) -> Vec<SkillLintIssue> {
    let mut issues = Vec::new();
    if !document.has_frontmatter {
        issues.push(SkillLintIssue {
            code: "missing_frontmatter",
            message: "SKILL.md 开头缺少用 --- 包围的元数据（name、description），部分 Agent 可能无法识别。".into(),
        });
    } else {
        if document.unterminated {
            issues.push(SkillLintIssue {
                code: "unterminated_frontmatter",
                message: "元数据缺少结尾的 ---，部分 Agent 会读不到这个 Skill。".into(),
            });
        }
        match document.text("name") {
            None => issues.push(SkillLintIssue {
                code: "missing_name",
                message: "元数据缺少 name。".into(),
            }),
            Some(name) if name.chars().count() > SPEC_NAME_MAX_CHARS => {
                issues.push(SkillLintIssue {
                    code: "name_too_long",
                    message: format!("name 超过 {SPEC_NAME_MAX_CHARS} 个字符。"),
                })
            }
            Some(name) if !valid_spec_name(name) => issues.push(SkillLintIssue {
                code: "invalid_name",
                message: format!(
                    "name「{name}」建议只用小写字母、数字和连字符，且不以连字符开头或结尾；部分 Agent 要求这种格式。"
                ),
            }),
            Some(_) => {}
        }
        match document.text("description") {
            None => issues.push(SkillLintIssue {
                code: "missing_description",
                message: "元数据缺少 description。Agent 依靠它判断什么时候使用这个 Skill。".into(),
            }),
            Some(description) if description.chars().count() > SPEC_DESCRIPTION_MAX_CHARS => issues
                .push(SkillLintIssue {
                    code: "description_too_long",
                    message: format!("description 超过 {SPEC_DESCRIPTION_MAX_CHARS} 个字符。"),
                }),
            Some(_) => {}
        }
    }
    if content_bytes > RECOMMENDED_SKILL_MD_BYTES {
        issues.push(SkillLintIssue {
            code: "large_skill_md",
            message: "SKILL.md 超过 500 KB，建议把参考资料拆到单独的文件。".into(),
        });
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::{
        first_heading, first_paragraph_line, lint_skill_document, parse_skill_document,
        FrontmatterValue,
    };
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        input: String,
        expected: Expected,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        display_name: Option<String>,
        description: Option<String>,
        category: Option<String>,
        version: Option<String>,
        labels: Vec<String>,
    }

    /// The Server's SKILL.md reader runs the same fixture so both ends agree.
    const SHARED_CASES: &str = include_str!("../tests/fixtures/skill-frontmatter-cases.json");

    #[test]
    fn shared_frontmatter_cases_match_expected_fields() {
        let cases: Vec<Case> = serde_json::from_str(SHARED_CASES).expect("parse shared cases");
        assert!(cases.len() >= 10);
        for case in cases {
            let document = parse_skill_document(&case.input);
            let display_name = document
                .display_name()
                .map(str::to_string)
                .or_else(|| first_heading(document.body).map(str::to_string));
            let description = document
                .text("description")
                .map(str::to_string)
                .or_else(|| first_paragraph_line(document.body).map(str::to_string));
            let labels = document
                .list("labels")
                .or_else(|| document.list("tags"))
                .unwrap_or_default();
            assert_eq!(display_name, case.expected.display_name, "{}", case.name);
            assert_eq!(description, case.expected.description, "{}", case.name);
            assert_eq!(
                document.text("category").map(str::to_string),
                case.expected.category,
                "{}",
                case.name
            );
            assert_eq!(
                document.text("version").map(str::to_string),
                case.expected.version,
                "{}",
                case.name
            );
            assert_eq!(labels, case.expected.labels, "{}", case.name);
        }
    }

    #[test]
    fn nested_mappings_are_kept_verbatim_and_not_misread_as_text() {
        let document = parse_skill_document(
            "---\nname: pdf\nmetadata:\n  author: example\n  version: \"1.0\"\n---\nBody\n",
        );
        assert_eq!(
            document
                .fields
                .iter()
                .find(|field| field.key == "metadata")
                .map(|field| field.value.clone()),
            Some(FrontmatterValue::Block(
                "author: example\nversion: \"1.0\"".into()
            ))
        );
        assert_eq!(document.text("metadata"), None);
        assert_eq!(document.body, "Body\n");
    }

    #[test]
    fn unterminated_frontmatter_is_read_leniently_and_flagged() {
        let source = "---\nname: broken\ndescription: never closed\n";
        let document = parse_skill_document(source);
        assert!(document.has_frontmatter && document.unterminated);
        assert_eq!(document.text("name"), Some("broken"));
        assert_eq!(document.body, "");
        assert_eq!(
            lint_skill_document(&document, source.len())
                .into_iter()
                .map(|issue| issue.code)
                .collect::<Vec<_>>(),
            vec!["unterminated_frontmatter"]
        );
    }

    #[test]
    fn lint_reports_spec_problems_without_blocking_valid_skills() {
        let valid = "---\nname: pdf-tools\ndescription: Extract text from PDF files.\n---\n# PDF\n";
        assert!(lint_skill_document(&parse_skill_document(valid), valid.len()).is_empty());

        let chinese = "---\nname: 正式版验收\n---\n# 验收\n";
        let codes = lint_skill_document(&parse_skill_document(chinese), chinese.len())
            .into_iter()
            .map(|issue| issue.code)
            .collect::<Vec<_>>();
        assert_eq!(codes, vec!["invalid_name", "missing_description"]);

        let long_description = format!("---\nname: long\ndescription: {}\n---\n", "x".repeat(1025));
        assert_eq!(
            lint_skill_document(&parse_skill_document(&long_description), 10)
                .into_iter()
                .map(|issue| issue.code)
                .collect::<Vec<_>>(),
            vec!["description_too_long"]
        );

        let bare = "# No metadata\n\nJust prose.\n";
        assert_eq!(
            lint_skill_document(&parse_skill_document(bare), 600 * 1024)
                .into_iter()
                .map(|issue| issue.code)
                .collect::<Vec<_>>(),
            vec!["missing_frontmatter", "large_skill_md"]
        );

        for name in ["-leading", "trailing-", "double--dash", "Upper"] {
            let source = format!("---\nname: {name}\ndescription: ok\n---\n");
            assert!(
                lint_skill_document(&parse_skill_document(&source), source.len())
                    .iter()
                    .any(|issue| issue.code == "invalid_name"),
                "{name}"
            );
        }
    }

    /// The Server's package re-check runs the same declaration cases (#251).
    const DECLARATION_CASES: &str = include_str!("../tests/fixtures/env-declaration-cases.json");

    #[derive(Deserialize)]
    struct DeclarationCase {
        name: String,
        input: String,
        expected: Option<Vec<super::EnvDeclaration>>,
        #[serde(default)]
        error: bool,
    }

    #[test]
    fn shared_env_declaration_cases_match() {
        let cases: Vec<DeclarationCase> =
            serde_json::from_str(DECLARATION_CASES).expect("parse declaration cases");
        assert!(cases.len() >= 15);
        for case in cases {
            let result = parse_skill_document(&case.input).env_declarations();
            if case.error {
                let error = result.expect_err(&case.name);
                assert!(
                    error.contains("metadata.skillhub.env"),
                    "{}: {error}",
                    case.name
                );
            } else {
                assert_eq!(
                    result.unwrap_or_else(|error| panic!("{}: {error}", case.name)),
                    case.expected.expect("expected declarations"),
                    "{}",
                    case.name
                );
            }
        }
    }

    fn declaration(key: &str, required: bool, obtain: Option<&str>) -> super::EnvDeclaration {
        super::EnvDeclaration {
            key: key.into(),
            required,
            description: Some(format!("{key} \"说明\"")),
            obtain: obtain.map(str::to_string),
        }
    }

    #[test]
    fn writing_declarations_only_touches_the_env_block() {
        let source = "---\r\nname: demo\r\nmetadata:\r\n  author: someone\r\n  skillhub:\r\n    homepage: https://example.com\r\n    env:\r\n      - key: OLD_KEY\r\n        required: false\r\n\r\n  version: \"1.0\"\r\ntags: [a, b]\r\n---\r\n\r\n# Body\r\n`OLD_KEY` stays here.\r\n";
        let declarations = vec![
            declaration("FAL_KEY", true, Some("https://fal.ai/dashboard/keys")),
            declaration("OPENAI_API_KEY", false, None),
        ];
        let updated = super::write_env_declarations(source, &declarations).unwrap();
        assert_eq!(
            updated,
            "---\r\nname: demo\r\nmetadata:\r\n  author: someone\r\n  skillhub:\r\n    homepage: https://example.com\r\n    env:\r\n      - key: FAL_KEY\r\n        required: true\r\n        description: \"FAL_KEY \\\"说明\\\"\"\r\n        obtain: https://fal.ai/dashboard/keys\r\n      - key: OPENAI_API_KEY\r\n        required: false\r\n        description: \"OPENAI_API_KEY \\\"说明\\\"\"\r\n\r\n  version: \"1.0\"\r\ntags: [a, b]\r\n---\r\n\r\n# Body\r\n`OLD_KEY` stays here.\r\n"
        );
        let document = parse_skill_document(&updated);
        assert_eq!(document.env_declarations().unwrap(), declarations);
        assert_eq!(document.list("tags"), Some(vec!["a".into(), "b".into()]));
        // Writing the same declaration again is a no-op.
        assert_eq!(
            super::write_env_declarations(&updated, &declarations).unwrap(),
            updated
        );
    }

    #[test]
    fn writing_declarations_creates_missing_metadata_levels() {
        let declarations = vec![declaration("FAL_KEY", true, None)];
        let no_metadata = "---\nname: demo\ndescription: x\n---\nBody\n";
        assert_eq!(
            super::write_env_declarations(no_metadata, &declarations).unwrap(),
            "---\nname: demo\ndescription: x\nmetadata:\n  skillhub:\n    env:\n      - key: FAL_KEY\n        required: true\n        description: \"FAL_KEY \\\"说明\\\"\"\n---\nBody\n"
        );
        let other_metadata =
            "---\nname: demo\nmetadata:\n    author: me\nlicense: MIT\n---\nBody\n";
        assert_eq!(
            super::write_env_declarations(other_metadata, &declarations).unwrap(),
            "---\nname: demo\nmetadata:\n    author: me\n    skillhub:\n      env:\n        - key: FAL_KEY\n          required: true\n          description: \"FAL_KEY \\\"说明\\\"\"\nlicense: MIT\n---\nBody\n"
        );
        let skillhub_without_env =
            "---\nmetadata:\n  skillhub:\n    homepage: https://x.dev\n---\n";
        assert_eq!(
            super::write_env_declarations(skillhub_without_env, &[]).unwrap(),
            skillhub_without_env
        );
        assert!(super::write_env_declarations(skillhub_without_env, &declarations)
            .unwrap()
            .starts_with("---\nmetadata:\n  skillhub:\n    homepage: https://x.dev\n    env:\n      - key: FAL_KEY\n"));
        let bare = "# Title\n";
        let created = super::write_env_declarations(bare, &declarations).unwrap();
        assert!(created.ends_with("---\n# Title\n"));
        assert_eq!(
            parse_skill_document(&created).env_declarations().unwrap(),
            declarations
        );
        assert_eq!(super::write_env_declarations(bare, &[]).unwrap(), bare);
    }

    #[test]
    fn removing_all_declarations_keeps_an_explicit_empty_list() {
        let source = "---\nmetadata:\n  skillhub:\n    env:\n    - key: FAL_KEY\n    - key: OTHER_KEY\n    homepage: https://x.dev\n---\n";
        let updated = super::write_env_declarations(source, &[]).unwrap();
        assert_eq!(
            updated,
            "---\nmetadata:\n  skillhub:\n    env: []\n    homepage: https://x.dev\n---\n"
        );
        assert!(parse_skill_document(&updated)
            .env_declarations()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn writing_rejects_invalid_or_unsafe_targets() {
        let declarations = vec![declaration("FAL_KEY", true, None)];
        assert!(
            super::write_env_declarations("---\nname: x\nmetadata: {}\n---\n", &declarations)
                .is_err()
        );
        assert!(super::write_env_declarations("---\nname: x\n", &declarations).is_err());
        assert!(super::write_env_declarations(
            "---\nname: x\n---\n",
            &[declaration("FAL_KEY", true, Some("http://insecure"))]
        )
        .is_err());
        assert!(super::write_env_declarations(
            "---\nname: x\n---\n",
            &[declaration("lower", true, None)]
        )
        .is_err());
    }
}
