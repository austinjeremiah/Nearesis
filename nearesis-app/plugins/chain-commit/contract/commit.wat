;; Minimal hash-commitment contract for NEAR (hand-written WAT, no SDK, no Rust target needed).
;; commit_hash : callable only by majorlynx5104.testnet. Input JSON exactly {"hash":"<64 lowercase hex>"}.
;;               Stores key = the 64 hex bytes, value = block_timestamp (u64 LE, 8 bytes). First commit wins; a repeat panics.
;; get_commitment : view. Same input. Returns the 8 raw bytes (u64 LE nanosecond block timestamp) or the text null.
;; No transfers, no promises, no cross-contract calls, no other state. Build: ./build.sh (wasm-tools parse, reproducible).
(module
  (import "env" "input" (func $input (param i64)))
  (import "env" "register_len" (func $register_len (param i64) (result i64)))
  (import "env" "read_register" (func $read_register (param i64 i64)))
  (import "env" "predecessor_account_id" (func $predecessor (param i64)))
  (import "env" "block_timestamp" (func $block_timestamp (result i64)))
  (import "env" "storage_write" (func $storage_write (param i64 i64 i64 i64 i64) (result i64)))
  (import "env" "storage_read" (func $storage_read (param i64 i64 i64) (result i64)))
  (import "env" "storage_has_key" (func $storage_has_key (param i64 i64) (result i64)))
  (import "env" "value_return" (func $value_return (param i64 i64)))
  (import "env" "panic" (func $panic))
  (memory (export "memory") 1)
  (data (i32.const 0) "majorlynx5104.testnet")
  (data (i32.const 32) "{\22hash\22:\22")
  (data (i32.const 48) "\22}")
  (data (i32.const 56) "null")

  (func $eq (param $a i32) (param $b i32) (param $n i32) (result i32)
    (local $i i32)
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (if (i32.ne (i32.load8_u (i32.add (local.get $a) (local.get $i)))
                    (i32.load8_u (i32.add (local.get $b) (local.get $i))))
          (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.const 1))

  ;; read input into 256.., require the exact 75-byte shape with 64 lowercase hex characters
  (func $parse_input (param $hex_check i32)
    (local $i i32) (local $c i32)
    (call $input (i64.const 0))
    (if (i64.ne (call $register_len (i64.const 0)) (i64.const 75)) (then (call $panic)))
    (call $read_register (i64.const 0) (i64.const 256))
    (if (i32.eqz (call $eq (i32.const 256) (i32.const 32) (i32.const 9))) (then (call $panic)))
    (if (i32.eqz (call $eq (i32.const 329) (i32.const 48) (i32.const 2))) (then (call $panic)))
    (if (local.get $hex_check) (then
      (block $done
        (loop $l
          (br_if $done (i32.ge_u (local.get $i) (i32.const 64)))
          (local.set $c (i32.load8_u (i32.add (i32.const 265) (local.get $i))))
          (if (i32.eqz (i32.or
                (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57)))
                (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 102)))))
            (then (call $panic)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l))))))

  (func (export "commit_hash")
    (call $predecessor (i64.const 1))
    (if (i64.ne (call $register_len (i64.const 1)) (i64.const 21)) (then (call $panic)))
    (call $read_register (i64.const 1) (i64.const 512))
    (if (i32.eqz (call $eq (i32.const 512) (i32.const 0) (i32.const 21))) (then (call $panic)))
    (call $parse_input (i32.const 1))
    (if (i64.ne (call $storage_has_key (i64.const 64) (i64.const 265)) (i64.const 0)) (then (call $panic)))
    (i64.store (i32.const 1024) (call $block_timestamp))
    (drop (call $storage_write (i64.const 64) (i64.const 265) (i64.const 8) (i64.const 1024) (i64.const 2))))

  (func (export "get_commitment")
    (call $parse_input (i32.const 1))
    (if (i64.eq (call $storage_read (i64.const 64) (i64.const 265) (i64.const 0)) (i64.const 1))
      (then (call $read_register (i64.const 0) (i64.const 1100)) (call $value_return (i64.const 8) (i64.const 1100)))
      (else (call $value_return (i64.const 4) (i64.const 56)))))
)
