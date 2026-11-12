import 'server-only';
import { createShellApi } from './shell';
import { serverTransport } from './server';

export const shellServer = createShellApi(serverTransport);
