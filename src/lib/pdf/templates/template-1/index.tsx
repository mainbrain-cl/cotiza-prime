import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { PDF_MONO, PDF_SANS } from "../../fonts";
import type { PdfLine, QuoteDocumentData } from "../../types";

/**
 * Plantilla 1 del PDF de cotización (diseño aprobado en `docs/diseno/plantilla-1-pdf-vista-previa.html`).
 * Recibe un objeto cerrado y tipado; no calcula nada ni acepta HTML: todo es texto plano.
 *
 * Medidas en puntos. Equivalen a las de la vista previa (px × 0,75).
 */

const PAPER = "#FFFFFF";
const INK = "#1A1F2B";
const MUTED = "#5B6273";
const LINE = "#E3E6EC";
const ZEBRA = "#F7F8FA";

const BODY_LINE_HEIGHT = 1.4;
const MARGIN_X = 45;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 68;
const BAR_HEIGHT = 4.5;
const ACCENT_HEIGHT = 2.25;
const ACCENT_WIDTH = "34%";
const LOGO_HEIGHT = 39;
const LOGO_MAX_WIDTH = 150;
const TOTALS_WIDTH = 225;
const FOOTER_BOTTOM = 24;

// Qué tan largo puede ser un bloque para tratarlo como "sin partir". Más largo que esto, el texto
// puede continuar en la página siguiente: nunca se recorta ni se pierde nada. Las cifras son
// aproximadas (caracteres por renglón según el ancho de la columna) y quedan muy por debajo del
// alto de una hoja, para que un bloque "sin partir" siempre quepa en una.
const DESCRIPTION_CHARS_PER_LINE = 48;
const NOTES_CHARS_PER_LINE = 58;
const MAX_UNBROKEN_ROW_LINES = 8;
const MAX_SIDE_BY_SIDE_NOTE_LINES = 22;
const TITLE_MIN_PRESENCE_AHEAD = 40;

/** Renglones aproximados de un texto: cada salto de línea y cada desborde cuentan. */
export function estimateLines(text: string, charsPerLine: number): number {
  return text
    .split("\n")
    .reduce((sum, paragraph) => sum + Math.max(1, Math.ceil(paragraph.length / charsPerLine)), 0);
}

/** Una fila corta no se parte entre páginas; una muy larga sí puede continuar, sin perder texto. */
export function isCompactLine(line: PdfLine): boolean {
  const lines =
    estimateLines(line.name, DESCRIPTION_CHARS_PER_LINE) +
    (line.description ? estimateLines(line.description, DESCRIPTION_CHARS_PER_LINE) : 0);
  return lines <= MAX_UNBROKEN_ROW_LINES;
}

const COLUMNS = {
  description: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  quantity: { width: 38, textAlign: "right" as const },
  unit: { width: 54 },
  unitPrice: { width: 70, textAlign: "right" as const },
  discount: { width: 48, textAlign: "right" as const },
  total: { width: 70, textAlign: "right" as const },
};

const s = StyleSheet.create({
  page: {
    fontFamily: PDF_SANS,
    // Sin `lineHeight` en la página: con un interlineado heredado, el texto dinámico (número de
    // página) queda con alto cero y no se dibuja. Se declara en cada bloque de texto.
    fontSize: 10.5,
    color: INK,
    backgroundColor: PAPER,
    paddingTop: MARGIN_TOP,
    paddingBottom: MARGIN_BOTTOM,
    paddingHorizontal: MARGIN_X,
  },
  bar: { position: "absolute", top: 0, left: 0, right: 0, height: BAR_HEIGHT },
  accent: {
    position: "absolute",
    top: BAR_HEIGHT,
    left: 0,
    width: ACCENT_WIDTH,
    height: ACCENT_HEIGHT,
  },
  compactHeader: {
    position: "absolute",
    top: 18,
    left: MARGIN_X,
    right: MARGIN_X,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    fontSize: 8.5,
    color: MUTED,
  },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  issuer: { flexDirection: "column", flexShrink: 1, paddingRight: 18 },
  logoRow: { flexDirection: "row", alignItems: "center", minHeight: LOGO_HEIGHT },
  logo: { height: LOGO_HEIGHT, maxWidth: LOGO_MAX_WIDTH, objectFit: "contain", marginRight: 9 },
  issuerName: { fontSize: 15, fontWeight: 700, letterSpacing: -0.15, flexShrink: 1 },
  issuerData: { marginTop: 7, fontSize: 8.5, color: MUTED, lineHeight: 1.55 },
  docId: { flexDirection: "column", alignItems: "flex-end" },
  kind: { fontSize: 9, fontWeight: 600, letterSpacing: 1.6 },
  number: { fontFamily: PDF_MONO, fontSize: 17, fontWeight: 500, marginTop: 3 },
  version: { fontSize: 8.5, color: MUTED, marginTop: 3 },
  dates: { marginTop: 8, fontSize: 8.5 },
  dateRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 1.5 },
  dateLabel: { color: MUTED, marginRight: 10 },
  dateValue: { fontWeight: 600, textAlign: "right" },
  dateNote: { marginTop: 1.5, color: MUTED, textAlign: "right" },
  parties: {
    marginTop: 24,
    flexDirection: "row",
    paddingVertical: 12,
    paddingHorizontal: 13.5,
    borderRadius: 4.5,
  },
  partyWide: { flexGrow: 1.3, flexShrink: 1, flexBasis: 0, paddingRight: 18 },
  partyNarrow: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  label: { fontSize: 7.5, fontWeight: 600, letterSpacing: 1.05, marginBottom: 3 },
  partyName: { fontWeight: 600, fontSize: 11, lineHeight: BODY_LINE_HEIGHT },
  partyData: { fontSize: 8.5, color: MUTED, lineHeight: 1.55 },
  table: { marginTop: 20 },
  thead: {
    flexDirection: "row",
    paddingHorizontal: 6,
    paddingBottom: 6,
    borderBottomWidth: 1.1,
    borderBottomColor: INK,
    fontSize: 7.5,
    fontWeight: 600,
    letterSpacing: 0.75,
    color: MUTED,
    backgroundColor: PAPER,
  },
  row: {
    flexDirection: "row",
    paddingHorizontal: 6,
    paddingVertical: 7.5,
    borderBottomWidth: 0.75,
    borderBottomColor: LINE,
    fontSize: 9.5,
    lineHeight: BODY_LINE_HEIGHT,
  },
  nameRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  name: { fontWeight: 600 },
  tag: {
    marginLeft: 5,
    paddingHorizontal: 3,
    borderWidth: 0.75,
    borderColor: LINE,
    borderRadius: 2.25,
    fontSize: 7,
    fontWeight: 600,
    letterSpacing: 0.4,
    color: MUTED,
  },
  lineDescription: { fontSize: 8.5, color: MUTED },
  muted: { color: MUTED, fontSize: 8.5 },
  summary: { marginTop: 17, flexDirection: "row", alignItems: "flex-start" },
  notes: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    paddingRight: 21,
    fontSize: 8.5,
    lineHeight: BODY_LINE_HEIGHT,
    color: MUTED,
  },
  summaryStacked: { marginTop: 17 },
  totalsRight: { flexDirection: "row", justifyContent: "flex-end" },
  notesFull: { marginTop: 16, fontSize: 8.5, lineHeight: BODY_LINE_HEIGHT, color: MUTED },
  noteBlock: { marginBottom: 10 },
  noteTitle: { fontSize: 7.5, fontWeight: 600, letterSpacing: 1.05, marginBottom: 3 },
  totals: { width: TOTALS_WIDTH, fontSize: 9.5, lineHeight: BODY_LINE_HEIGHT },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4.5,
    paddingHorizontal: 1.5,
    borderBottomWidth: 0.75,
    borderBottomColor: LINE,
  },
  totalLabel: { color: MUTED },
  grand: {
    marginTop: 8,
    borderRadius: 4.5,
    paddingVertical: 9,
    paddingHorizontal: 10.5,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  grandLabel: { fontSize: 8, fontWeight: 600, letterSpacing: 1.1 },
  grandValue: { fontSize: 16, fontWeight: 700 },
  terms: { marginTop: 8, fontSize: 8, color: MUTED },
  footer: {
    position: "absolute",
    bottom: FOOTER_BOTTOM,
    left: MARGIN_X,
    right: MARGIN_X,
    paddingTop: 8,
    borderTopWidth: 0.75,
    borderTopColor: LINE,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: MUTED,
  },
});

function Head({ data }: { data: QuoteDocumentData }) {
  const { organization: org, quote } = data;
  return (
    <View style={s.head}>
      <View style={s.issuer}>
        <View style={s.logoRow}>
          {org.logo ? (
            // `Image` de react-pdf: dibuja en el PDF, no es una etiqueta <img>; no admite `alt`.
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={{ data: org.logo.data, format: org.logo.format }} style={s.logo} />
          ) : null}
          <Text style={s.issuerName}>{org.name}</Text>
        </View>
        {org.detailLines.length > 0 ? (
          <Text style={s.issuerData}>{org.detailLines.join("\n")}</Text>
        ) : null}
      </View>
      <View style={s.docId}>
        <Text style={[s.kind, { color: data.brand.primaryText }]}>COTIZACIÓN</Text>
        <Text style={s.number}>{quote.number}</Text>
        {quote.versionLabel ? <Text style={s.version}>{quote.versionLabel}</Text> : null}
        <View style={s.dates}>
          <View style={s.dateRow}>
            <Text style={s.dateLabel}>Fecha</Text>
            <Text style={s.dateValue}>{quote.issueDate}</Text>
          </View>
          {quote.validUntil ? (
            <View style={s.dateRow}>
              <Text style={s.dateLabel}>Válida hasta</Text>
              <Text style={s.dateValue}>{quote.validUntil}</Text>
            </View>
          ) : null}
          {quote.validityNote ? <Text style={s.dateNote}>({quote.validityNote})</Text> : null}
        </View>
      </View>
    </View>
  );
}

function Parties({ data }: { data: QuoteDocumentData }) {
  const color = { color: data.brand.primaryText };
  return (
    <View style={[s.parties, { backgroundColor: data.brand.primaryTint }]}>
      <View style={s.partyWide}>
        <Text style={[s.label, color]}>PARA</Text>
        <Text style={s.partyName}>{data.customer.name}</Text>
        {data.customer.detailLines.length > 0 ? (
          <Text style={s.partyData}>{data.customer.detailLines.join("\n")}</Text>
        ) : null}
      </View>
      <View style={s.partyNarrow}>
        <Text style={[s.label, color]}>PREPARADA POR</Text>
        <Text style={s.partyName}>{data.preparedBy.name}</Text>
        {data.preparedBy.detailLines.length > 0 ? (
          <Text style={s.partyData}>{data.preparedBy.detailLines.join("\n")}</Text>
        ) : null}
      </View>
    </View>
  );
}

function TableHead() {
  return (
    <View style={s.thead} fixed>
      <Text style={COLUMNS.description}>DESCRIPCIÓN</Text>
      <Text style={COLUMNS.quantity}>CANT.</Text>
      <Text style={[COLUMNS.unit, { paddingLeft: 8 }]}>UNIDAD</Text>
      <Text style={COLUMNS.unitPrice}>PRECIO UNIT.</Text>
      <Text style={COLUMNS.discount}>DESC.</Text>
      <Text style={COLUMNS.total}>TOTAL</Text>
    </View>
  );
}

function Row({ line, index }: { line: PdfLine; index: number }) {
  return (
    // Una fila corta nunca se corta entre páginas. Si la descripción es larguísima, continúa en la
    // página siguiente en vez de recortarse (el nombre y los montos quedan arriba, enteros).
    <View
      wrap={!isCompactLine(line)}
      style={[s.row, index % 2 === 1 ? { backgroundColor: ZEBRA } : {}]}
    >
      <View style={COLUMNS.description}>
        <View style={s.nameRow}>
          <Text style={s.name}>{line.name}</Text>
          {line.exempt ? <Text style={s.tag}>EXENTO</Text> : null}
        </View>
        {line.description ? <Text style={s.lineDescription}>{line.description}</Text> : null}
      </View>
      <Text style={COLUMNS.quantity}>{line.quantity}</Text>
      <Text style={[COLUMNS.unit, { paddingLeft: 8 }]}>{line.unit}</Text>
      <Text style={COLUMNS.unitPrice}>{line.unitPrice}</Text>
      <Text style={[COLUMNS.discount, s.muted]}>{line.discount}</Text>
      <Text style={[COLUMNS.total, { fontWeight: 600 }]}>{line.total}</Text>
    </View>
  );
}

function Totals({ data }: { data: QuoteDocumentData }) {
  const { totals, brand } = data;
  return (
    // Los totales nunca se parten: si no caben, pasan enteros a la página siguiente.
    <View wrap={false} style={s.totals}>
      <TotalRow label="Subtotal" value={totals.subtotal} />
      {totals.globalDiscount ? (
        <TotalRow label="Descuento global" value={totals.globalDiscount} />
      ) : null}
      <TotalRow label="Neto afecto" value={totals.netTaxable} />
      {totals.exempt ? <TotalRow label="Exento" value={totals.exempt} /> : null}
      <TotalRow label={totals.taxLabel} value={totals.tax} />
      <View style={[s.grand, { backgroundColor: brand.primary }]}>
        <Text style={[s.grandLabel, { color: brand.onPrimary }]}>TOTAL</Text>
        <Text style={[s.grandValue, { color: brand.onPrimary }]}>{totals.total}</Text>
      </View>
      <Text style={s.terms}>Valores en pesos chilenos.</Text>
    </View>
  );
}

function Notes({ blocks, color }: { blocks: NoteBlock[]; color: string }) {
  return blocks.map((block) => (
    <View key={block.title} style={s.noteBlock}>
      {/* El título nunca queda solo al pie de una página. */}
      <Text minPresenceAhead={TITLE_MIN_PRESENCE_AHEAD} style={[s.noteTitle, { color }]}>
        {block.title}
      </Text>
      <Text>{block.text}</Text>
    </View>
  ));
}

type NoteBlock = { title: string; text: string };

function Summary({ data }: { data: QuoteDocumentData }) {
  const blocks: NoteBlock[] = [];
  if (data.observations) blocks.push({ title: "OBSERVACIONES", text: data.observations });
  if (data.conditions) blocks.push({ title: "CONDICIONES", text: data.conditions });
  if (data.paymentTerms) blocks.push({ title: "FORMA DE PAGO", text: data.paymentTerms });
  const noteLines = blocks.reduce(
    (sum, block) => sum + 2 + estimateLines(block.text, NOTES_CHARS_PER_LINE),
    0,
  );

  if (noteLines <= MAX_SIDE_BY_SIDE_NOTE_LINES) {
    // Lo habitual: notas a la izquierda y totales a la derecha, todo junto en una página.
    return (
      <View wrap={false} style={s.summary}>
        <View style={s.notes}>
          <Notes blocks={blocks} color={data.brand.primaryText} />
        </View>
        <Totals data={data} />
      </View>
    );
  }
  // Notas largas: los totales primero (a la derecha) y las notas debajo, a todo el ancho, que
  // pueden continuar en la página siguiente sin perder ni una línea.
  return (
    <View style={s.summaryStacked}>
      <View style={s.totalsRight}>
        <Totals data={data} />
      </View>
      <View style={s.notesFull}>
        <Notes blocks={blocks} color={data.brand.primaryText} />
      </View>
    </View>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.totalRow}>
      <Text style={s.totalLabel}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

export function Template1({ data }: { data: QuoteDocumentData }) {
  const { brand, quote, organization } = data;
  return (
    <Document
      title={`Cotización ${quote.number}`}
      author={organization.name}
      creator={organization.name}
      producer={organization.name}
      language="es-CL"
    >
      <Page size={data.paper === "a4" ? "A4" : "LETTER"} style={s.page}>
        <View fixed style={[s.bar, { backgroundColor: brand.primary }]} />
        <View fixed style={[s.accent, { backgroundColor: brand.secondary }]} />

        {/* Páginas siguientes: encabezado compacto con el número, para no perder el hilo. */}
        <View
          fixed
          style={s.compactHeader}
          render={({ pageNumber }) =>
            pageNumber > 1 ? (
              <>
                <Text style={{ fontWeight: 600, color: INK }}>{organization.name}</Text>
                <Text>
                  {quote.number}
                  {quote.versionLabel ? ` · ${quote.versionLabel}` : ""}
                </Text>
              </>
            ) : null
          }
        />

        <Head data={data} />
        <Parties data={data} />

        <View style={s.table}>
          <TableHead />
          {data.lines.map((line, index) => (
            <Row key={index} line={line} index={index} />
          ))}
        </View>

        <Summary data={data} />

        <View fixed style={s.footer}>
          <Text>
            {organization.name} · {quote.number}
          </Text>
          <Text>Esta cotización no es un documento tributario.</Text>
          <Text render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
