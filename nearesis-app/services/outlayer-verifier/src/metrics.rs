//! Exact integer metric definitions. No floating point anywhere.
//!
//! Bounds (enforced by schema.rs): n <= 4096, |v| <= 1e15.
//!   sum(v)        <= 4.1e18          fits i128
//!   sum(v^2)      <= 4.1e33          fits i128 (max 1.7e38)
//!   n*sum(xy)     <= 1.7e37          fits i128
//!   A*B (Pearson) <= 2.9e74          computed in U256 (max 1.1e77)
//!
//! Rounding everywhere: round half away from zero, `rdiv(a, b)`.

use primitive_types::U256;

/// Round-half-away-from-zero integer division, b > 0.
pub fn rdiv(a: i128, b: i128) -> i128 {
    debug_assert!(b > 0);
    let q = (2 * a.unsigned_abs() + b as u128) / (2 * b as u128);
    if a < 0 { -(q as i128) } else { q as i128 }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub sum: i128,
    pub min: i128,
    pub max: i128,
    /// mean * 1e6, rounded
    pub mean_micro: i128,
    /// (last - first) * 1e4 / first, rounded; None when first == 0
    pub growth_bps: Option<i128>,
}

pub fn summary(v: &[i128]) -> Summary {
    let n = v.len() as i128;
    let sum: i128 = v.iter().sum();
    let first = v[0];
    let last = v[v.len() - 1];
    let growth_bps = if first == 0 {
        None
    } else {
        // divide by |first| and carry the sign so rdiv keeps b > 0
        let num = (last - first) * 10_000;
        let q = rdiv(num, first.abs());
        Some(if first < 0 { -q } else { q })
    };
    Summary {
        sum,
        min: *v.iter().min().unwrap(),
        max: *v.iter().max().unwrap(),
        mean_micro: rdiv(sum * 1_000_000, n),
        growth_bps,
    }
}

/// Pearson correlation * 1e6 (ppm), rounded, clamped to [-1e6, 1e6].
///
/// r = (n*Sxy - Sx*Sy) / sqrt((n*Sxx - Sx^2) * (n*Syy - Sy^2))
/// den = floor(sqrt(A*B)) computed exactly in U256.
/// None when either series is constant (A == 0 or B == 0).
pub fn pearson_ppm(x: &[i128], y: &[i128]) -> Option<i128> {
    debug_assert_eq!(x.len(), y.len());
    let n = x.len() as i128;
    let (mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0i128, 0i128, 0i128, 0i128, 0i128);
    for (&a, &b) in x.iter().zip(y) {
        sx += a;
        sy += b;
        sxx += a * a;
        syy += b * b;
        sxy += a * b;
    }
    let num = n * sxy - sx * sy;
    let a = n * sxx - sx * sx;
    let b = n * syy - sy * sy;
    if a <= 0 || b <= 0 {
        return None;
    }
    let den_u = (U256::from(a as u128) * U256::from(b as u128)).integer_sqrt();
    // den <= sqrt(2.9e74) ~ 1.7e37 fits u128; |num| * 2e6 <= 3.4e43 needs U256.
    let two_num_scaled = U256::from(num.unsigned_abs()) * U256::from(2_000_000u64);
    let q = (two_num_scaled + den_u) / (den_u * U256::from(2u8));
    let q = q.low_u128() as i128; // q <= ~1e6 + 1 by Cauchy–Schwarz
    let q = q.min(1_000_000);
    Some(if num < 0 { -q } else { q })
}

/// Correlation of x[t] with y[t + k]: does x lead y by k days?
pub fn lag_pearson_ppm(x: &[i128], y: &[i128], k: usize) -> Option<i128> {
    let n = x.len();
    pearson_ppm(&x[..n - k], &y[k..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding() {
        assert_eq!(rdiv(5, 2), 3);
        assert_eq!(rdiv(-5, 2), -3);
        assert_eq!(rdiv(4, 3), 1);
        assert_eq!(rdiv(-4, 3), -1);
        assert_eq!(rdiv(0, 7), 0);
    }

    #[test]
    fn summary_values() {
        let s = summary(&[100, 110, 90, 120]);
        assert_eq!(s.sum, 420);
        assert_eq!((s.min, s.max), (90, 120));
        assert_eq!(s.mean_micro, 105_000_000);
        assert_eq!(s.growth_bps, Some(2_000));
        assert_eq!(summary(&[0, 5]).growth_bps, None);
        assert_eq!(summary(&[-10, -5]).growth_bps, Some(-5_000)); // (-5 - -10)/-10 = -0.5
    }

    #[test]
    fn pearson_exact_cases() {
        assert_eq!(pearson_ppm(&[1, 2, 3, 4], &[2, 4, 6, 8]), Some(1_000_000));
        assert_eq!(pearson_ppm(&[1, 2, 3, 4], &[8, 6, 4, 2]), Some(-1_000_000));
        assert_eq!(pearson_ppm(&[1, 2, 3], &[5, 5, 5]), None);
        // x=[1,2,3,4,5], y=[2,1,4,3,5]: Sxy=53, r = 0.8 exactly
        assert_eq!(pearson_ppm(&[1, 2, 3, 4, 5], &[2, 1, 4, 3, 5]), Some(800_000));
    }

    #[test]
    fn pearson_extreme_bounds_no_overflow() {
        let m = crate::schema::MAX_ABS_VALUE;
        let x: Vec<i128> = (0..4096).map(|i| if i % 2 == 0 { m } else { -m }).collect();
        let y: Vec<i128> = (0..4096).map(|i| if i % 3 == 0 { m } else { -m }).collect();
        let r = pearson_ppm(&x, &y).unwrap();
        assert!((-1_000_000..=1_000_000).contains(&r));
        assert_eq!(pearson_ppm(&x, &x), Some(1_000_000));
    }

    #[test]
    fn lag() {
        // y is x shifted by 2 days => perfect lag-2 correlation
        let x = [1, 5, 2, 8, 3, 9, 4];
        let y = [0, 0, 1, 5, 2, 8, 3];
        assert_eq!(lag_pearson_ppm(&x, &y, 2), Some(1_000_000));
    }
}
