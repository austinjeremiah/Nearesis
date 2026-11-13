/**
 * Display-only tidy-up of numbers inside agent-written sentences. The agents quote result cells at full precision
 * ("432082145.1030823 USD"), which is exact but hard to read. The exact value stays in the finding's facts and on the
 * evidence pages; here large values get thousands separators and long fractions are shortened. Dates are left alone.
 */
export function tidyNumbers(text: string): string {
  return text
    .replace(/(?<![\w.,-])\d+\.\d{4,}(?![\w-])/g, (m) => {
      const n = Number(m);
      if (!Number.isFinite(n)) return m;
      if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString('en-US');
      return m.split('.')[1]!.length >= 7 ? String(Number(n.toPrecision(4))) : m;
    })
    .replace(/(?<![\w.,-])\d{5,}(?![\w.-])/g, (m) => Number(m).toLocaleString('en-US'));
}
