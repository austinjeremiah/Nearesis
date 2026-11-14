// Must be imported before any wallet code (first import in main.js).
// The NEAR/Meteor SDKs assume two Node globals: Buffer and process.env.
import { Buffer } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.process) globalThis.process = { env: {} };
else if (!globalThis.process.env) globalThis.process.env = {};
