'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Mail } from 'lucide-react';
import { Modal } from './overlays';
import { qk } from '@/lib/api/keys';
import { shellBrowser } from '@/lib/api/shell-browser';
import { creditsApi, creditsKey } from '@/lib/near/api';
import { CONTACT_EMAIL } from '@/lib/credits/usd';
import { dismissRefusal, getRefusalState, mailtoHref, refusalText, subscribeRefusal } from '@/lib/credits/refusal';

/**
 * The one app-wide "You have used your credits" popup. Mounted once in the app frame; opened by the central API
 * transport (a 402 CREDITS_EXHAUSTED or the global ceiling refusal), by a failed agent step, and on load of /agent
 * when /v1/credits says exhausted. State lives in lib/credits/refusal. Radix Dialog supplies the focus trap, Escape and ARIA.
 */
export default function CreditsPopup() {
  const st = useSyncExternalStore(subscribeRefusal, getRefusalState, getRefusalState);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  // Only fetched while the popup is open; supplies the allowance and the account when the refusal did not carry them.
  const credits = useQuery({ queryKey: creditsKey, queryFn: () => creditsApi.get(), enabled: st.open, retry: false, staleTime: 15_000 });
  const me = useQuery({ queryKey: qk.me, queryFn: () => shellBrowser.me(), enabled: st.open, retry: false, staleTime: 60_000 });
  const info = st.info;
  const allowance = info?.allowanceUsd ?? credits.data?.allowanceUsd ?? null;
  const email = info?.contactEmail ?? credits.data?.contactEmail ?? CONTACT_EMAIL;
  const href = mailtoHref({
    email,
    allowanceUsd: allowance,
    accountId: me.data?.principal.userId ?? null,
    displayName: me.data?.principal.displayName ?? null,
    nearAccountId: me.data?.nearAccountId ?? null,
  });
  const onOpenChange = useCallback((v: boolean) => {
    if (!v) {
      setCopied(null);
      dismissRefusal();
    }
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }
  return (
    <Modal
      open={st.open}
      onOpenChange={onOpenChange}
      title="You have used your credits"
      footer={
        <>
          <button type="button" className="btn" onClick={() => onOpenChange(false)} data-testid="credits-popup-close">
            Close
          </button>
          <button type="button" className="btn" onClick={() => void copy()} data-testid="credits-popup-copy">
            <Copy size={14} aria-hidden="true" />
            {copied === 'ok' ? 'Copied' : 'Copy address'}
          </button>
          <a className="btn primary" href={href} data-testid="credits-popup-mail" autoFocus>
            <Mail size={14} aria-hidden="true" />
            Write an email
          </a>
        </>
      }
    >
      <div className="col gap2" data-testid="credits-popup">
        <p className="small" style={{ margin: 0 }} data-testid="credits-popup-text">
          {refusalText({ allowanceUsd: allowance, contactEmail: email })}
        </p>
        <p className="small dim" style={{ margin: 0 }} role="status" aria-live="polite">
          {copied === 'failed' ? `Could not copy. The address is ${email}.` : copied === 'ok' ? `${email} copied.` : null}
        </p>
      </div>
    </Modal>
  );
}
