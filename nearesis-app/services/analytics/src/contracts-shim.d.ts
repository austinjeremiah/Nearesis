// Workaround (see INTEGRATION_QUEUE: contracts does not export the QuoteAttemptClass *type* that
// services/ingestion/src/normalized/types.ts imports). Merges the missing type alias; remove once the lead exports it.
import "@nearesis/contracts";
declare module "@nearesis/contracts" {
  export type QuoteAttemptClass = "OK" | "NO_QUOTE" | "NETWORK_ERROR" | "TIMEOUT" | "INVALID_OUTPUT";
}
