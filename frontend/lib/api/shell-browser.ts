'use client';
import { createShellApi } from './shell';
import { browserTransport } from './browser';

export const shellBrowser = createShellApi(browserTransport);
