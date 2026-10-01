import Link from "next/link";
import { SearchX } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/** Mismo mensaje para "no existe" y "no tienes acceso": nunca se revela cuál de los dos es. */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
        <SearchX aria-hidden strokeWidth={1.75} className="size-7" />
      </div>
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="text-xl">No encontrado</h1>
        <p className="text-fg-muted">La página que buscas no existe o no tienes acceso a ella.</p>
      </div>
      <Link href="/" className={buttonVariants({ size: "lg" })}>
        Ir al inicio
      </Link>
    </main>
  );
}
