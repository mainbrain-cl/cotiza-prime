/**
 * Memoria de corta vida, acotada: cada valor dura `ttlMs` y nunca hay más de `maxEntries`. Al llenarse
 * descarta primero lo vencido y luego lo más antiguo. Sirve para no leer la base en cada petición del marco
 * incrustable (H-093) sin que identificadores inventados hagan crecer la memoria sin límite.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > now ? entry.value : undefined;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      for (const [other, entry] of this.entries) {
        if (entry.expiresAt <= now) this.entries.delete(other);
      }
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
