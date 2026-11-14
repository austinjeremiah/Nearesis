"use client";
import { Button } from "@nearesis/ui";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import { fmtTime, ModeBadge } from "./shared.tsx";

export function NotificationsTab(p: {
  store: MonitoringStore;
  onOpenMarker: (markerId: string) => void;
  onNotice: (m: string) => void;
}) {
  const list = [...p.store.data.notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!list.length)
    return (
      <p className="nz-sb-meta" data-testid="notifications-empty">
        No notifications.
      </p>
    );
  return (
    <ul className="nz-list" aria-label="Notifications" data-testid="notifications-tab">
      {list.map((n) => (
        <li
          key={n.notificationId}
          className="nz-list-item nz-list-item-col"
          data-testid={`notification-${n.notificationId}`}
          data-read={n.readAt !== null}
        >
          <div className="nz-row">
            <b className="nz-grow">{n.title}</b>
            <ModeBadge mode={n.mode} />
            <span className="nz-sb-meta nz-tabular">{fmtTime(n.createdAt)}</span>
          </div>
          <div>{n.body}</div>
          <div className="nz-page-actions">
            {n.markerId && (
              <Button size="sm" onClick={() => p.onOpenMarker(n.markerId!)}>
                Open marker
              </Button>
            )}
            {n.readAt === null ? (
              <Button
                size="sm"
                data-testid={`notification-read-${n.notificationId}`}
                onClick={async () => {
                  const r = await p.store.act((api) => api.markNotificationRead(n.notificationId));
                  if (!r.ok) p.onNotice(`${r.reasonCode}: ${r.message}`);
                }}
              >
                Mark read
              </Button>
            ) : (
              <span className="nz-sb-meta">Read {fmtTime(n.readAt)}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
