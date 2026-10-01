import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Botón de Cotiza Prime (docs/DISENO.md): primario, secundario, fantasma y peligro.
 * Alto táctil de 44 px en teléfono; más compacto desde tableta. Al pulsar se achica al 97%.
 * `default`, `outline` y `destructive` son alias para los componentes de shadcn que se agreguen.
 */
const PRIMARY = "bg-accent text-on-accent shadow-1 hover:bg-accent-hover";
const SECONDARY =
  "border-border-strong bg-surface text-fg shadow-1 hover:bg-surface-2 aria-expanded:bg-surface-2";
const DANGER = "bg-danger-soft text-danger hover:bg-danger hover:text-on-accent";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-sm border border-transparent text-sm font-semibold whitespace-nowrap transition-[background-color,color,transform,box-shadow] duration-(--dur-fast) ease-ios outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5 md:[&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      variant: {
        primary: PRIMARY,
        secondary: SECONDARY,
        ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg aria-expanded:bg-surface-2",
        danger: DANGER,
        link: "text-accent underline-offset-4 hover:underline",
        default: PRIMARY,
        outline: SECONDARY,
        destructive: DANGER,
      },
      size: {
        sm: "h-11 gap-1.5 px-3 md:h-8",
        default: "h-11 gap-2 px-4 md:h-9",
        lg: "h-12 gap-2 px-5 text-base md:h-11",
        icon: "size-11 md:size-9",
        "icon-sm": "size-11 md:size-8",
        "icon-lg": "size-12 md:size-11",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "primary",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
