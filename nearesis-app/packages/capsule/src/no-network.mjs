// Preload (node --import) that makes any network use throw. The offline rebuild runs with it, so a rebuild that
// secretly needed the network would fail instead of passing.
import net from "node:net";
import dns from "node:dns";
import tls from "node:tls";

const deny = (what) => () => {
  throw new Error(`NETWORK_BLOCKED: ${what}`);
};
net.Socket.prototype.connect = deny("net.Socket.connect");
net.connect = deny("net.connect");
net.createConnection = deny("net.createConnection");
tls.connect = deny("tls.connect");
dns.lookup = deny("dns.lookup");
dns.resolve = deny("dns.resolve");
globalThis.fetch = deny("fetch");
