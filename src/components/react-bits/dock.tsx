"use client";

/*
 * Basado en "Dock" de React Bits (https://reactbits.dev, David Haz), licencia MIT + Commons Clause:
 * ver ./LICENSE.md. Adaptado para Cotiza Prime: en vertical, con vidrio y colores del sistema de
 * diseño, enlaces reales (teclado y lectores de pantalla), etiqueta que aparece al lado y sin
 * magnificación con "reducir movimiento" ni con dedo (solo con ratón).
 */

import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { cn } from "@/lib/utils";

/** Lado de cada ítem en reposo y al pasar el ratón cerca (px). Caben en el ancho del menú. */
const BASE_ITEM_SIZE = 44;
const MAGNIFIED_ITEM_SIZE = 54;
/** Distancia (px) a la que el ratón deja de agrandar un ítem. */
const MAGNIFY_DISTANCE = 110;
const ICON_MAX_SCALE = 1.2;
const SPRING = { mass: 0.1, stiffness: 150, damping: 14 } as const;

const DockContext = createContext<{ pointerY: MotionValue<number>; animate: boolean } | null>(null);

/** Menú flotante vertical: los ítems se agrandan un poco cerca del ratón (solo escritorio con ratón). */
export function Dock({ className, children }: { className?: string; children: ReactNode }) {
  const pointerY = useMotionValue(Infinity);
  const reduced = useReducedMotion();

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") pointerY.set(event.clientY);
  }

  return (
    <DockContext.Provider value={{ pointerY, animate: !reduced }}>
      <div
        onPointerMove={reduced ? undefined : onPointerMove}
        onPointerLeave={() => pointerY.set(Infinity)}
        className={className}
      >
        {children}
      </div>
    </DockContext.Provider>
  );
}

type DockItemProps = {
  /** Texto que lee el lector de pantalla y que aparece al lado al pasar el ratón o tabular. */
  label: string;
  /** Segunda línea de la etiqueta visible (por ejemplo, quién tiene la sesión abierta). */
  hint?: string;
  icon: ReactNode;
  /** Número corto sobre el ícono (por ejemplo, cuántas solicitudes esperan). Lo lee el nombre accesible. */
  badge?: string;
  active?: boolean;
  className?: string;
} & (
  | { href: string; type?: never; onClick?: never }
  | { href?: never; type?: ComponentProps<"button">["type"]; onClick?: () => void }
);

const ITEM_BASE_CLASS =
  "flex size-full items-center justify-center rounded-md outline-none transition-colors duration-(--dur-fast) ease-ios focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.96]";

export function DockItem({
  label,
  hint,
  icon,
  badge,
  active,
  href,
  type = "button",
  onClick,
  className,
}: DockItemProps) {
  const context = useContext(DockContext);
  const ref = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const fallbackY = useMotionValue(Infinity);
  const pointerY = context?.pointerY ?? fallbackY;

  const distance = useTransform(pointerY, (y) => {
    const top = ref.current?.getBoundingClientRect().top ?? 0;
    return y - top - BASE_ITEM_SIZE / 2;
  });
  const target = useTransform(
    distance,
    [-MAGNIFY_DISTANCE, 0, MAGNIFY_DISTANCE],
    [BASE_ITEM_SIZE, MAGNIFIED_ITEM_SIZE, BASE_ITEM_SIZE],
  );
  const size = useSpring(target, SPRING);
  const iconScale = useTransform(size, [BASE_ITEM_SIZE, MAGNIFIED_ITEM_SIZE], [1, ICON_MAX_SCALE]);

  const animate = context?.animate ?? false;
  // Los valores de movimiento escriben directo en el elemento: sin componentes animados de más peso.
  useEffect(() => {
    if (!animate) return;
    const unsubscribeSize = size.on("change", (value) => {
      if (!ref.current) return;
      ref.current.style.width = `${value}px`;
      ref.current.style.height = `${value}px`;
    });
    const unsubscribeScale = iconScale.on("change", (value) => {
      if (iconRef.current) iconRef.current.style.transform = `scale(${value})`;
    });
    return () => {
      unsubscribeSize();
      unsubscribeScale();
    };
  }, [animate, size, iconScale]);

  const itemClass = cn(
    ITEM_BASE_CLASS,
    active
      ? "bg-accent-soft text-accent glass-strong"
      : "text-fg-muted hover:bg-surface/70 hover:text-fg",
    className,
  );
  const content = (
    <span ref={iconRef} className="flex">
      {icon}
    </span>
  );

  return (
    <div
      ref={ref}
      style={{ width: BASE_ITEM_SIZE, height: BASE_ITEM_SIZE }}
      className="group relative flex shrink-0 items-center justify-center"
    >
      {href ? (
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={itemClass}
        >
          {content}
        </Link>
      ) : (
        <button type={type} onClick={onClick} aria-label={label} className={itemClass}>
          {content}
        </button>
      )}
      {badge ? (
        <span
          aria-hidden
          data-testid="dock-badge"
          className="pointer-events-none absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-on-accent shadow-1"
        >
          {badge}
        </span>
      ) : null}
      {/* Etiqueta visual: el nombre accesible ya está en aria-label, por eso no se repite. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-full z-50 ml-4 -translate-y-1/2 rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm font-semibold whitespace-nowrap text-fg opacity-0 shadow-2 transition-opacity duration-(--dur-fast) ease-ios group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {label}
        {hint ? <span className="block text-xs font-normal text-fg-muted">{hint}</span> : null}
      </span>
    </div>
  );
}
