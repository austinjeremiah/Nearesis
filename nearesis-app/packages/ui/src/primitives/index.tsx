import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Slot } from "@radix-ui/react-slot";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  forwardRef,
} from "react";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "honesty" | "plain";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
  asChild?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", asChild, className, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      className={`nz-btn${className ? ` ${className}` : ""}`}
      data-variant={variant}
      data-size={size}
      {...rest}
    />
  );
});

/** Icon-only button. `label` is mandatory: it is the accessible name and the tooltip text. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "children"> & { label: string; children: ReactNode; shortcut?: string }
>(function IconButton({ label, children, shortcut, className, size, ...rest }, ref) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <Button
        ref={ref}
        aria-label={label}
        size={size}
        className={`nz-iconbtn${className ? ` ${className}` : ""}`}
        data-variant={rest.variant ?? "ghost"}
        {...rest}
        variant={rest.variant ?? "ghost"}
      >
        {children}
      </Button>
    </Tooltip>
  );
});

export function Badge({
  tone = "neutral",
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span className={`nz-badge${className ? ` ${className}` : ""}`} data-tone={tone} {...rest}>
      {children}
    </span>
  );
}

export function StatusDot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return (
    <span className="nz-dot" data-tone={tone} data-pulse={pulse ? "true" : undefined} aria-hidden="true" />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="nz-kbd">{children}</kbd>;
}

export function Tooltip({
  content,
  shortcut,
  children,
  side = "bottom",
}: {
  content: ReactNode;
  shortcut?: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="nz-tooltip" side={side} sideOffset={6}>
            {content}
            {shortcut ? <span style={{ marginLeft: 8, opacity: 0.7 }}>{shortcut}</span> : null}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function Skeleton({
  width,
  height = 12,
  style,
}: {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}) {
  return <div className="nz-skeleton" aria-hidden="true" style={{ width, height, ...style }} />;
}

export function Meter({
  value,
  max,
  tone,
  label,
}: {
  value: number;
  max: number;
  tone?: "warn" | "bad";
  label: string;
}) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  const auto = tone ?? (pct >= 90 ? "bad" : pct >= 70 ? "warn" : undefined);
  return (
    <div
      className="nz-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      data-tone={auto}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
