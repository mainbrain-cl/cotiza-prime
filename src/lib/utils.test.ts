import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("une clases y resuelve conflictos de Tailwind", () => {
    expect(cn("p-2", "p-4", false && "hidden")).toBe("p-4");
  });
});
