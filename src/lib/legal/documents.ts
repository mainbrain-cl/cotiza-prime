import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type LegalDocumentKind = "terms" | "privacy";

export type LegalDocument = {
  kind: LegalDocumentKind;
  /** Versión publicada, por ejemplo `2026-10-01-preliminar`. Va a `legal_documents.version`. */
  version: string;
  /** Fecha de publicación (aaaa-mm-dd). Va a `legal_documents.published_at`. */
  publishedOn: string;
  /** Texto en Markdown, con saltos de línea normalizados a `\n`. */
  content: string;
  /** SHA-256 en hexadecimal del `content`. Va a `legal_documents.content_sha256`. */
  contentSha256: string;
};

export const CURRENT_LEGAL_VERSION = "2026-10-01-preliminar";
const CURRENT_LEGAL_PUBLISHED_ON = "2026-10-01";

const LEGAL_CONTENT_DIR = path.join(process.cwd(), "src", "content", "legal");

const LEGAL_FILES: Record<LegalDocumentKind, string> = {
  terms: "terms.md",
  privacy: "privacy.md",
};

/** Normaliza saltos de línea para que la huella sea igual en Windows, Linux y macOS. */
export function normalizeLegalText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function hashLegalText(text: string): string {
  return createHash("sha256").update(normalizeLegalText(text), "utf8").digest("hex");
}

export function buildLegalDocument(
  kind: LegalDocumentKind,
  version: string,
  publishedOn: string,
  rawContent: string,
): LegalDocument {
  const content = normalizeLegalText(rawContent);
  return { kind, version, publishedOn, content, contentSha256: hashLegalText(content) };
}

function loadDocument(kind: LegalDocumentKind): LegalDocument {
  const raw = readFileSync(path.join(LEGAL_CONTENT_DIR, LEGAL_FILES[kind]), "utf8");
  return buildLegalDocument(kind, CURRENT_LEGAL_VERSION, CURRENT_LEGAL_PUBLISHED_ON, raw);
}

/** Los documentos vigentes. Fuente única de versión y huella para registro y reaceptación. */
export const legalDocuments: Record<LegalDocumentKind, LegalDocument> = {
  terms: loadDocument("terms"),
  privacy: loadDocument("privacy"),
};

export function getLegalDocument(kind: LegalDocumentKind): LegalDocument {
  return legalDocuments[kind];
}
