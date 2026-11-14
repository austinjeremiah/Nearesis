/**
 * Bounded, strict JSON parsing for every untrusted boundary (API bodies, MCP requests, provider pages).
 * One linear scan validates the text before `JSON.parse` sees it: size, UTF-8, nesting depth, duplicate object keys,
 * prototype-pollution keys, number literal length, and finiteness. Nothing here recurses, so a 10,000-deep input costs
 * one pass and never touches the call stack.
 */
export interface StrictJsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxNumberChars: number;
  /** Maximum number of values (objects, arrays, scalars) in the document. */
  maxNodes: number;
  /** Maximum elements in any single array. */
  maxArrayItems: number;
}

export const DEFAULT_LIMITS: StrictJsonLimits = {
  maxBytes: 1_000_000,
  maxDepth: 64,
  maxNumberChars: 32,
  maxNodes: 200_000,
  maxArrayItems: 100_000,
};

export type StrictJsonCode =
  | "TOO_LARGE"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "TOO_DEEP"
  | "DUPLICATE_KEY"
  | "FORBIDDEN_KEY"
  | "NUMBER_OUT_OF_RANGE"
  | "TOO_MANY_NODES"
  | "TOO_MANY_ITEMS"
  | "EMPTY";

export type StrictJsonResult =
  { ok: true; value: unknown } | { ok: false; code: StrictJsonCode; detail: string };

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function parseStrictJson(
  input: Uint8Array | string,
  limits: Partial<StrictJsonLimits> = {},
): StrictJsonResult {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const size = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
  if (size > L.maxBytes) return err("TOO_LARGE", `body exceeds ${L.maxBytes} bytes`);
  if (size === 0) return err("EMPTY", "empty body");
  let text: string;
  if (typeof input === "string") text = input;
  else
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input);
    } catch {
      return err("INVALID_UTF8", "body is not valid UTF-8");
    }
  if (text.charCodeAt(0) === 0xfeff) return err("INVALID_JSON", "byte order mark");
  const n = text.length;
  let i = 0;
  let nodes = 0;
  // stack frame: container kind, key set (objects), item count (arrays), last key
  type Frame = { kind: "o" | "a"; keys: Set<string> | null; items: number; lastKey: string | null };
  const stack: Frame[] = [];
  const skipWs = () => {
    while (i < n && WS.has(text.charCodeAt(i))) i++;
  };
  const readString = (): string | StrictJsonResult => {
    // text[i] === '"'
    let j = i + 1;
    let hasEscape = false;
    for (;;) {
      if (j >= n) return err("INVALID_JSON", "unterminated string");
      const c = text.charCodeAt(j);
      if (c === 0x22) break;
      if (c < 0x20) return err("INVALID_JSON", "control character in string");
      if (c === 0x5c) {
        hasEscape = true;
        const e = text[j + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(j + 2, j + 6)))
            return err("INVALID_JSON", "bad unicode escape");
          j += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) return err("INVALID_JSON", "bad escape");
        j += 2;
        continue;
      }
      j++;
    }
    const raw = text.slice(i + 1, j);
    i = j + 1;
    return hasEscape ? (JSON.parse(`"${raw}"`) as string) : raw;
  };
  const value = (): StrictJsonResult | undefined => {
    // parses the start of a value; containers push a frame and return undefined; scalars are consumed
    skipWs();
    if (i >= n) return err("INVALID_JSON", "unexpected end");
    if (++nodes > L.maxNodes) return err("TOO_MANY_NODES", `more than ${L.maxNodes} values`);
    const c = text[i]!;
    if (c === "{" || c === "[") {
      if (stack.length >= L.maxDepth) return err("TOO_DEEP", `nesting deeper than ${L.maxDepth}`);
      stack.push({
        kind: c === "{" ? "o" : "a",
        keys: c === "{" ? new Set() : null,
        items: 0,
        lastKey: null,
      });
      i++;
      return undefined;
    }
    if (c === '"') {
      const s = readString();
      return typeof s === "string" ? undefined : s;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + L.maxNumberChars + 1));
      if (!m) return err("INVALID_JSON", "bad number");
      if (m[0].length > L.maxNumberChars) return err("NUMBER_OUT_OF_RANGE", "number literal too long");
      if (!Number.isFinite(Number(m[0]))) return err("NUMBER_OUT_OF_RANGE", "number is not finite");
      i += m[0].length;
      return undefined;
    }
    for (const lit of ["true", "false", "null"])
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return undefined;
      }
    return err("INVALID_JSON", "unexpected token");
  };

  // iterative grammar walk
  let r = value();
  if (r) return r;
  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    skipWs();
    if (i >= n) return err("INVALID_JSON", "unexpected end");
    const c = text[i]!;
    const close = f.kind === "o" ? "}" : "]";
    if (c === close) {
      i++;
      stack.pop();
      continue;
    }
    if (f.items > 0) {
      if (c !== ",") return err("INVALID_JSON", "expected ','");
      i++;
      skipWs();
    }
    if (f.kind === "a") {
      if (++f.items > L.maxArrayItems) return err("TOO_MANY_ITEMS", `array longer than ${L.maxArrayItems}`);
      r = value();
      if (r) return r;
      continue;
    }
    // object member
    if (text[i] !== '"') return err("INVALID_JSON", "expected key");
    const k = readString();
    if (typeof k !== "string") return k;
    if (f.keys!.has(k)) return err("DUPLICATE_KEY", "duplicate object key");
    f.keys!.add(k);
    if (k === "__proto__") return err("FORBIDDEN_KEY", "forbidden key __proto__");
    const parent = stack.length > 1 ? stack[stack.length - 2]! : null;
    if (k === "prototype" && parent?.kind === "o" && parent.lastKey === "constructor")
      return err("FORBIDDEN_KEY", "forbidden key path constructor.prototype");
    f.lastKey = k;
    skipWs();
    if (text[i] !== ":") return err("INVALID_JSON", "expected ':'");
    i++;
    f.items++;
    r = value();
    if (r) return r;
  }
  skipWs();
  if (i < n) return err("INVALID_JSON", "trailing data");
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return err("INVALID_JSON", "invalid JSON");
  }
}

function err(code: StrictJsonCode, detail: string): { ok: false; code: StrictJsonCode; detail: string } {
  return { ok: false, code, detail };
}
