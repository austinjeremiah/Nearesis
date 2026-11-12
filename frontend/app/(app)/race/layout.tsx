import { Suspense, type ReactNode } from 'react';
export default function L({ children }: { children: ReactNode }) { return <Suspense>{children}</Suspense>; }
