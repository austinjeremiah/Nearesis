ALTER TABLE intents_swaps MODIFY COLUMN amount_in_raw Nullable(String);
ALTER TABLE intents_swaps MODIFY COLUMN amount_out_raw Nullable(String);
ALTER TABLE intents_swaps MODIFY COLUMN amount_in Nullable(Decimal256(0));
ALTER TABLE intents_swaps MODIFY COLUMN amount_out Nullable(Decimal256(0));
