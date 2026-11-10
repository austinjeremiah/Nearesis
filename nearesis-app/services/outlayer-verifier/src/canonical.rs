//! Canonical JSON + SHA-256.
//!
//! Canonical form (spec: docs in README "Canonical JSON"):
//! * objects with keys sorted by byte order (serde_json `Map` is a BTreeMap
//!   because the `preserve_order` feature is NOT enabled),
//! * no insignificant whitespace,
//! * strings restricted by schema to printable ASCII excluding `"` and `\`,
//!   so no escape sequences can ever appear,
//! * integers are carried as decimal strings, so no number formatting rules apply.
//!
//! Under those restrictions this coincides with RFC 8785 (JCS) output.

use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn to_canonical_string(v: &Value) -> String {
    // serde_json compact writer + BTreeMap ordering == canonical form for our
    // restricted value space. A unit test pins this against a hand-written string.
    serde_json::to_string(v).expect("serializing a serde_json::Value cannot fail")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

pub fn canonical_sha256(v: &Value) -> String {
    sha256_hex(to_canonical_string(v).as_bytes())
}

const HEX: &[u8; 16] = b"0123456789abcdef";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_sorted_compact() {
        let v = json!({"b": "2", "a": {"d": [1, "x"], "c": null}, "A": true});
        assert_eq!(to_canonical_string(&v), r#"{"A":true,"a":{"c":null,"d":[1,"x"]},"b":"2"}"#);
    }

    #[test]
    fn sha256_known_vector() {
        // FIPS 180-2 test vector "abc"
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
