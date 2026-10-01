import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Cotiza Prime</h1>
      <p className="text-muted-foreground">
        Cotiza en minutos, con tu marca, sin perder el control.
      </p>
      <Button>Comenzar</Button>
    </main>
  );
}
