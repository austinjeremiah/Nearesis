import type { Budget } from './types';

// The runtime reserves at least 32,000 tokens, 12 tool calls and USD 3 for one composer run; a lower cap is refused.
// This is a reservation ceiling, not a price: the run is charged what it uses.
export const MIN_BUDGET: Budget = { tokens: 32000, toolCalls: 12, usd: 3 };
