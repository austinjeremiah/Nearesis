'use client';

import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Button, LinkButton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { shellBrowser } from '@/lib/api/shell-browser';
import { newKey } from '@/lib/api/transport';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function Inner({ token }: { token: string }) {
  const router = useRouter();
  const [key] = useState(newKey);
  const accept = useMutation({
    mutationFn: () => shellBrowser.acceptInvite(token, { idempotencyKey: key }),
    onSuccess: (r) => {
      router.replace(r.workspaceId ? `/w/${r.workspaceId}/overview` : '/home');
      router.refresh();
    },
  });
  return (
    <div className="col gap2">
      {accept.isError && <ApiErrorState error={accept.error} />}
      <div className="row gap2">
        <Button variant="primary" size="lg" pending={accept.isPending} onClick={() => accept.mutate()} data-testid="accept-invite">
          Accept invitation
        </Button>
        <LinkButton href="/home" size="lg">
          Decline
        </LinkButton>
      </div>
    </div>
  );
}

/** The (auth) group has no query provider, so this button brings its own. */
export default function AcceptButton({ token }: { token: string }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <Inner token={token} />
    </QueryClientProvider>
  );
}
