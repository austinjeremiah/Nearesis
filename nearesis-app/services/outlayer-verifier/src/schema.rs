//! Input schema `nearesis.verifier.input.v1` — strict parsing and validation.

use serde::{Deserialize, Serialize};

pub const INPUT_SCHEMA: &str = "nearesis.verifier.input.v1";
pub const MIN_POINTS: usize = 2;
pub const MAX_POINTS: usize = 4096;
/// |value| bound keeps every intermediate sum inside i128 (see metrics.rs).
pub const MAX_ABS_VALUE: i128 = 1_000_000_000_000_000; // 1e15
pub const MAX_LAG: u32 = 90;
pub const MAX_LAG_METRICS: usize = 4;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub schema_version: String,
    pub claim_id: String,
    pub source: Source,
    pub series: SeriesPair,
    pub metrics: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<Expected>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub dataset: String,
    pub snapshot_id: String,
    /// Bible ch.0 invariant 9: fixtures must be visibly labeled.
    pub synthetic: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SeriesPair {
    pub x: Series,
    pub y: Series,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Series {
    pub name: String,
    pub unit: String,
    /// `[["YYYY-MM-DD", "<decimal integer>"], ...]`
    pub points: Vec<(String, String)>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Expected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_sha256: Option<String>,
    pub results_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Metric {
    Summary,
    Pearson,
    LagPearson(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
    pub code: &'static str,
    pub path: String,
}

impl SchemaError {
    fn new(code: &'static str, path: impl Into<String>) -> Self {
        SchemaError { code, path: path.into() }
    }
}

/// Validated, numeric view of the input.
#[derive(Debug, Clone)]
pub struct Validated {
    pub x: Vec<i128>,
    pub y: Vec<i128>,
    pub metrics: Vec<Metric>,
}

fn is_safe_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| (0x20..=0x7e).contains(&b) && b != b'"' && b != b'\\')
}

fn is_id(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-' | b'/'))
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Strict decimal integer: `-?(0|[1-9][0-9]*)`, no `-0`, |v| <= MAX_ABS_VALUE.
pub fn parse_int(s: &str) -> Option<i128> {
    let (neg, digits) = match s.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, s),
    };
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if digits.len() > 1 && digits.starts_with('0') {
        return None;
    }
    if neg && digits == "0" {
        return None;
    }
    let mag: i128 = digits.parse().ok()?;
    if mag > MAX_ABS_VALUE {
        return None;
    }
    Some(if neg { -mag } else { mag })
}

/// Strict `YYYY-MM-DD`, years 1970..=2100, returns days since 1970-01-01.
pub fn parse_date(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = &s[r];
        if part.bytes().all(|c| c.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1970..=2100).contains(&y) || !(1..=12).contains(&m) {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(m - 1) as usize];
    if d < 1 || d > dim {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Howard Hinnant's days_from_civil (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_metric(s: &str) -> Option<Metric> {
    match s {
        "summary" => Some(Metric::Summary),
        "pearson" => Some(Metric::Pearson),
        _ => {
            let k = s.strip_prefix("lag_pearson:")?;
            if k.is_empty() || k.len() > 2 || k.starts_with('0') || !k.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let k: u32 = k.parse().ok()?;
            (1..=MAX_LAG).contains(&k).then_some(Metric::LagPearson(k))
        }
    }
}

fn validate_series(s: &Series, path: &str) -> Result<(Vec<i64>, Vec<i128>), SchemaError> {
    if !is_id(&s.name, 64) {
        return Err(SchemaError::new("bad_series_name", format!("{path}.name")));
    }
    if !is_id(&s.unit, 32) {
        return Err(SchemaError::new("bad_series_unit", format!("{path}.unit")));
    }
    let n = s.points.len();
    if !(MIN_POINTS..=MAX_POINTS).contains(&n) {
        return Err(SchemaError::new("bad_point_count", format!("{path}.points")));
    }
    let mut days = Vec::with_capacity(n);
    let mut vals = Vec::with_capacity(n);
    for (i, (d, v)) in s.points.iter().enumerate() {
        let day = parse_date(d).ok_or_else(|| SchemaError::new("bad_date", format!("{path}.points[{i}][0]")))?;
        if let Some(&prev) = days.last() {
            if day != prev + 1 {
                return Err(SchemaError::new("dates_not_contiguous", format!("{path}.points[{i}][0]")));
            }
        }
        let val = parse_int(v).ok_or_else(|| SchemaError::new("bad_value", format!("{path}.points[{i}][1]")))?;
        days.push(day);
        vals.push(val);
    }
    Ok((days, vals))
}

pub fn validate(inp: &Input) -> Result<Validated, SchemaError> {
    if inp.schema_version != INPUT_SCHEMA {
        return Err(SchemaError::new("unsupported_schema_version", "schema_version"));
    }
    if !is_id(&inp.claim_id, 64) {
        return Err(SchemaError::new("bad_claim_id", "claim_id"));
    }
    if !is_safe_text(&inp.source.dataset, 128) {
        return Err(SchemaError::new("bad_text", "source.dataset"));
    }
    if !is_safe_text(&inp.source.snapshot_id, 128) {
        return Err(SchemaError::new("bad_text", "source.snapshot_id"));
    }
    let (dx, x) = validate_series(&inp.series.x, "series.x")?;
    let (dy, y) = validate_series(&inp.series.y, "series.y")?;
    if dx != dy {
        return Err(SchemaError::new("series_dates_misaligned", "series"));
    }

    if inp.metrics.is_empty() {
        return Err(SchemaError::new("no_metrics", "metrics"));
    }
    // Canonical requirement: metric ids strictly ascending (sorted, unique).
    for w in inp.metrics.windows(2) {
        if w[0] >= w[1] {
            return Err(SchemaError::new("metrics_not_sorted_unique", "metrics"));
        }
    }
    let mut metrics = Vec::with_capacity(inp.metrics.len());
    let mut lags = 0usize;
    for (i, m) in inp.metrics.iter().enumerate() {
        let parsed = parse_metric(m).ok_or_else(|| SchemaError::new("unknown_metric", format!("metrics[{i}]")))?;
        if let Metric::LagPearson(k) = parsed {
            lags += 1;
            if (k as usize) + MIN_POINTS > x.len() {
                return Err(SchemaError::new("lag_too_large", format!("metrics[{i}]")));
            }
        }
        metrics.push(parsed);
    }
    if lags > MAX_LAG_METRICS {
        return Err(SchemaError::new("too_many_lag_metrics", "metrics"));
    }

    if let Some(e) = &inp.expected {
        if let Some(h) = &e.input_sha256 {
            if !is_hex64(h) {
                return Err(SchemaError::new("bad_digest", "expected.input_sha256"));
            }
        }
        if !is_hex64(&e.results_sha256) {
            return Err(SchemaError::new("bad_digest", "expected.results_sha256"));
        }
    }
    Ok(Validated { x, y, metrics })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ints() {
        assert_eq!(parse_int("0"), Some(0));
        assert_eq!(parse_int("-15"), Some(-15));
        assert_eq!(parse_int("1000000000000000"), Some(MAX_ABS_VALUE));
        for bad in ["", "-", "-0", "01", "1.0", "1e3", "+1", " 1", "1000000000000001", "abc"] {
            assert_eq!(parse_int(bad), None, "{bad}");
        }
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("1970-01-01"), Some(0));
        assert_eq!(parse_date("2026-11-10"), Some(20_767));
        assert_eq!(parse_date("2024-02-29").unwrap() + 1, parse_date("2024-03-01").unwrap());
        for bad in ["2025-02-29", "2026-13-01", "2026-00-10", "2026-1-01", "2026/11/01", "1969-12-31", "2026-11-31"] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
    }

    #[test]
    fn metric_ids() {
        assert_eq!(parse_metric("lag_pearson:7"), Some(Metric::LagPearson(7)));
        for bad in ["lag_pearson:0", "lag_pearson:07", "lag_pearson:91", "lag_pearson:", "mean", "Pearson"] {
            assert_eq!(parse_metric(bad), None, "{bad}");
        }
    }
}
