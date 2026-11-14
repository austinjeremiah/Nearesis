// Preload (node --import) for a server process: listening and answering are allowed, any OUTBOUND connection or fetch throws.
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

const deny = (what) => () => {
  throw new Error(`NETWORK_BLOCKED: ${what}`);
};
net.Socket.prototype.connect = deny("net.Socket.connect");
net.connect = deny("net.connect");
net.createConnection = deny("net.createConnection");
tls.connect = deny("tls.connect");
globalThis.fetch = deny("fetch");
const lookup = dns.lookup;
dns.lookup = (host, ...rest) => {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0")
    return lookup(host, ...rest);
  throw new Error(`NETWORK_BLOCKED: dns.lookup ${host}`);
};
