//! Verification pipeline: parse -> validate -> recompute -> digest -> compare.

use crate::canonical::{canonical_sha256, to_canonical_string};
use crate::metrics::{lag_pearson_ppm, pearson_ppm, summary, Summary};
use crate::schema::{validate, Input, Metric, SchemaError};
use serde_json::{json, Map, Value};

pub const OUTPUT_SCHEMA: &str = "nearesis.verifier.output.v1";
pub const VERIFIER_ID: &str = concat!("nearesis-verifier@", env!("CARGO_PKG_VERSION"));
/// OutLayer documented output limit (NEAR protocol constraint).
pub const MAX_OUTPUT_BYTES: usize = 900;

fn s(v: i128) -> Value {
    Value::String(v.to_string())
}
fn opt(v: Option<i128>) -> Value {
    v.map(s).unwrap_or(Value::Null)
}

fn summary_json(sm: &Summary) -> Value {
    json!({
        "growth_bps": opt(sm.growth_bps),
        "max": s(sm.max),
        "mean_micro": s(sm.mean_micro),
        "min": s(sm.min),
        "sum": s(sm.sum),
    })
}

/// Recompute requested metrics. Integers are emitted as decimal strings.
pub fn compute_results(x: &[i128], y: &[i128], metrics: &[Metric]) -> Value {
    let mut r = Map::new();
    r.insert("n".into(), s(x.len() as i128));
    let mut lags = Map::new();
    for m in metrics {
        match m {
            Metric::Summary => {
                r.insert("x".into(), summary_json(&summary(x)));
                r.insert("y".into(), summary_json(&summary(y)));
            }
            Metric::Pearson => {
                r.insert("pearson_ppm".into(), opt(pearson_ppm(x, y)));
            }
            Metric::LagPearson(k) => {
                lags.insert(k.to_string(), opt(lag_pearson_ppm(x, y, *k as usize)));
            }
        }
    }
    if !lags.is_empty() {
        r.insert("lag_pearson_ppm".into(), Value::Object(lags));
    }
    Value::Object(r)
}

/// Digest of the canonical input *without* its `expected` block (the claim
/// cannot be part of the thing it claims about).
pub fn input_digest(inp: &Input) -> String {
    let mut stripped = inp.clone();
    stripped.expected = None;
    let v = serde_json::to_value(&stripped).expect("typed input serializes");
    canonical_sha256(&v)
}

fn finish(mut out: Map<String, Value>) -> String {
    out.insert("schema_version".into(), Value::String(OUTPUT_SCHEMA.into()));
    out.insert("verifier".into(), Value::String(VERIFIER_ID.into()));
    let full = to_canonical_string(&Value::Object(out.clone()));
    if full.len() <= MAX_OUTPUT_BYTES {
        return full;
    }
    // Deterministic fallback: results are reproducible from input; digests are kept.
    out.remove("results");
    out.insert("results_omitted".into(), Value::Bool(true));
    to_canonical_string(&Value::Object(out))
}

fn invalid(code: &str, path: &str) -> String {
    let mut o = Map::new();
    o.insert("status".into(), "INVALID_INPUT".into());
    o.insert("error".into(), json!({ "code": code, "path": path }));
    finish(o)
}

pub fn io_error_output() -> String {
    invalid("io_error", "stdin")
}

pub fn run(raw: &[u8]) -> String {
    if raw.len() > crate::MAX_INPUT_BYTES {
        return invalid("input_too_large", "$");
    }
    let inp: Input = match serde_json::from_slice(raw) {
        Ok(v) => v,
        // serde messages are not part of the contract; only the code is.
        Err(e) if e.is_syntax() || e.is_eof() => return invalid("malformed_json", "$"),
        Err(_) => return invalid("schema_violation", "$"),
    };
    let val = match validate(&inp) {
        Ok(v) => v,
        Err(SchemaError { code, path }) => return invalid(code, &path),
    };

    let results = compute_results(&val.x, &val.y, &val.metrics);
    let results_sha = canonical_sha256(&results);
    let input_sha = input_digest(&inp);

    let mut checks = Map::new();
    let status = match &inp.expected {
        None => "COMPUTED",
        Some(exp) => {
            let mut ok = true;
            if let Some(h) = &exp.input_sha256 {
                let m = *h == input_sha;
                ok &= m;
                checks.insert("input_sha256".into(), Value::Bool(m));
            }
            let m = exp.results_sha256 == results_sha;
            ok &= m;
            checks.insert("results_sha256".into(), Value::Bool(m));
            if ok { "VERIFIED" } else { "MISMATCH" }
        }
    };

    let mut o = Map::new();
    o.insert("status".into(), status.into());
    o.insert("claim_id".into(), Value::String(inp.claim_id.clone()));
    o.insert("synthetic".into(), Value::Bool(inp.source.synthetic));
    o.insert("input_sha256".into(), Value::String(input_sha));
    o.insert("results_sha256".into(), Value::String(results_sha));
    o.insert("checks".into(), Value::Object(checks));
    o.insert("results".into(), results);
    finish(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Value {
        json!({
            "schema_version": "nearesis.verifier.input.v1",
            "claim_id": "test:claim-1",
            "source": {"dataset": "SYNTHETIC unit fixture", "snapshot_id": "unit-0", "synthetic": true},
            "series": {
                "x": {"name": "x_metric", "unit": "count", "points": [
                    ["2026-11-01","1"],["2026-11-02","2"],["2026-11-03","3"],["2026-11-04","4"],["2026-11-05","5"]]},
                "y": {"name": "y_metric", "unit": "count", "points": [
                    ["2026-11-01","2"],["2026-11-02","1"],["2026-11-03","4"],["2026-11-04","3"],["2026-11-05","5"]]}
            },
            "metrics": ["lag_pearson:1", "pearson", "summary"]
        })
    }

    fn run_v(v: &Value) -> Value {
        serde_json::from_str(&run(v.to_string().as_bytes())).unwrap()
    }

    fn with_expected(mut v: Value) -> Value {
        let out = run_v(&v);
        v["expected"] = json!({
            "input_sha256": out["input_sha256"], "results_sha256": out["results_sha256"]
        });
        v
    }

    #[test]
    fn computed_values_correct() {
        let o = run_v(&base());
        assert_eq!(o["status"], "COMPUTED");
        assert_eq!(o["results"]["pearson_ppm"], "800000");
        assert_eq!(o["results"]["x"]["sum"], "15");
        assert_eq!(o["results"]["x"]["mean_micro"], "3000000");
        assert_eq!(o["results"]["y"]["growth_bps"], "15000");
        assert_eq!(o["results"]["n"], "5");
    }

    #[test]
    fn verified_roundtrip() {
        let o = run_v(&with_expected(base()));
        assert_eq!(o["status"], "VERIFIED");
        assert_eq!(o["checks"], json!({"input_sha256": true, "results_sha256": true}));
    }

    #[test]
    fn altered_value_detected() {
        let mut v = with_expected(base());
        v["series"]["y"]["points"][2][1] = json!("40");
        let o = run_v(&v);
        assert_eq!(o["status"], "MISMATCH");
        assert_eq!(o["checks"]["input_sha256"], false);
        assert_eq!(o["checks"]["results_sha256"], false);
    }

    #[test]
    fn altered_metadata_detected_by_input_digest_only() {
        let mut v = with_expected(base());
        v["source"]["snapshot_id"] = json!("unit-1");
        let o = run_v(&v);
        assert_eq!(o["status"], "MISMATCH");
        assert_eq!(o["checks"]["input_sha256"], false);
        assert_eq!(o["checks"]["results_sha256"], true);
    }

    #[test]
    fn altered_expected_digest_detected() {
        let mut v = with_expected(base());
        v["expected"]["results_sha256"] = json!("0".repeat(64));
        assert_eq!(run_v(&v)["status"], "MISMATCH");
    }

    #[test]
    fn key_order_and_whitespace_do_not_change_digests() {
        let a = run(base().to_string().as_bytes());
        // Same content, reversed key order at every level, irregular whitespace.
        let reordered = r#"
          { "metrics" : ["lag_pearson:1","pearson","summary"],
            "series": { "y": {"points":[["2026-11-01","2"],["2026-11-02","1"],["2026-11-03","4"],["2026-11-04","3"],["2026-11-05","5"]], "unit":"count","name":"y_metric"},
                        "x": {"points":[["2026-11-01","1"],["2026-11-02","2"],["2026-11-03","3"],["2026-11-04","4"],["2026-11-05","5"]], "unit":"count","name":"x_metric"} },
            "source": {"synthetic": true, "snapshot_id":"unit-0", "dataset":"SYNTHETIC unit fixture"},
            "claim_id":"test:claim-1",
            "schema_version":"nearesis.verifier.input.v1" }"#;
        assert_ne!(base().to_string(), reordered);
        assert_eq!(a, run(reordered.as_bytes()));
    }

    #[test]
    fn output_is_deterministic_and_bounded() {
        let v = with_expected(base());
        let a = run(v.to_string().as_bytes());
        for _ in 0..20 {
            assert_eq!(a, run(v.to_string().as_bytes()));
        }
        assert!(a.len() <= MAX_OUTPUT_BYTES);
    }

    fn code_of(v: &Value) -> String {
        let o = run_v(v);
        assert_eq!(o["status"], "INVALID_INPUT");
        o["error"]["code"].as_str().unwrap().to_string()
    }

    #[test]
    fn invalid_schemas_rejected() {
        let mut cases: Vec<(Value, &str)> = vec![];
        let mut v = base(); v["schema_version"] = json!("v0"); cases.push((v, "unsupported_schema_version"));
        let mut v = base(); v["extra"] = json!(1); cases.push((v, "schema_violation"));
        let mut v = base(); v["series"]["x"]["points"][1][1] = json!(2); cases.push((v, "schema_violation"));
        let mut v = base(); v["series"]["x"]["points"][1][1] = json!("2.5"); cases.push((v, "bad_value"));
        let mut v = base(); v["series"]["x"]["points"][1][1] = json!("1000000000000001"); cases.push((v, "bad_value"));
        let mut v = base(); v["series"]["x"]["points"][2][0] = json!("2026-11-04"); cases.push((v, "dates_not_contiguous"));
        let mut v = base(); v["series"]["y"]["points"].as_array_mut().unwrap().pop(); cases.push((v, "series_dates_misaligned"));
        let mut v = base(); v["metrics"] = json!(["summary", "pearson"]); cases.push((v, "metrics_not_sorted_unique"));
        let mut v = base(); v["metrics"] = json!(["mean"]); cases.push((v, "unknown_metric"));
        let mut v = base(); v["metrics"] = json!(["lag_pearson:4"]); cases.push((v, "lag_too_large"));
        let mut v = base(); v["claim_id"] = json!("bad id"); cases.push((v, "bad_claim_id"));
        let mut v = base(); v["source"]["dataset"] = json!("quote\"inside"); cases.push((v, "bad_text"));
        let mut v = base(); v["expected"] = json!({"results_sha256": "ABC"}); cases.push((v, "bad_digest"));
        let mut v = base(); v.as_object_mut().unwrap().remove("source"); cases.push((v, "schema_violation"));
        for (v, code) in cases {
            assert_eq!(code_of(&v), code, "case {v}");
        }
        assert_eq!(serde_json::from_str::<Value>(&run(b"{not json")).unwrap()["error"]["code"], "malformed_json");
        let dup = br#"{"schema_version":"a","schema_version":"b"}"#;
        assert_eq!(serde_json::from_str::<Value>(&run(dup)).unwrap()["error"]["code"], "schema_violation");
    }

    #[test]
    fn oversized_input_rejected() {
        let big = vec![b' '; crate::MAX_INPUT_BYTES + 1];
        assert_eq!(serde_json::from_str::<Value>(&run(&big)).unwrap()["error"]["code"], "input_too_large");
    }
}
