import { FileText } from "lucide-react";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center md:p-12">
      <div className="flex size-14 items-center justify-center rounded-lg bg-accent-soft text-accent shadow-1">
        <FileText aria-hidden strokeWidth={1.75} className="size-6" />
      </div>
      <div className="flex max-w-xl flex-col gap-3">
        <h1 className="text-2xl md:text-3xl">Cotiza Prime</h1>
        <p className="text-md text-fg-muted">
          Cotiza en minutos, con tu marca, sin perder el control.
        </p>
      </div>
    </main>
  );
}
