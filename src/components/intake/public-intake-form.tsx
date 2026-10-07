"use client";

import { CheckCircle2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { brandStyle } from "@/lib/share/brand-vars";
import { itemUnitShort } from "@/lib/intake/builder-model";
import { buildRequestSummary } from "@/lib/intake/summary-model";
import { consentFingerprint } from "@/lib/intake/consent-fingerprint";
import { MSG_ERROR, type SubmitResponse } from "@/lib/intake/submit-response";
import { buildSubmitSchema, fieldErrors, HONEYPOT_FIELD } from "@/lib/intake/submit-schema";
import type { PublicFormContent, PublicFormView } from "@/lib/intake/public-view";
import { AntibotWidget } from "./antibot-widget";
import { FormView, type TextFieldKey } from "./form-view";
import { RequestSummary } from "./request-summary";
import { SummarySheet } from "./summary-sheet";

/**
 * La página pública del formulario (H-087), del lado del navegador. Maneja lo que la persona escribe y
 * habla SOLO con `POST /api/v1/public/forms/[publicId]/requests`; nunca con la base. Todo lo que escribe
 * viaja como texto y se muestra como texto.
 *
 * Doble envío: la clave de envío la entrega el servidor junto con el sello de tiempo (el sello queda atado
 * a ella) y se reenvía igual si se corta la red o el servidor falla, así un reintento nunca crea dos
 * solicitudes. La prueba anti-robot sirve una sola vez, por eso el widget se vuelve a montar después de
 * cada intento.
 *
 * Datos personales fuera de la dirección: el formulario es `method="post"` y sus campos NO llevan `name`,
 * y el botón de enviar queda desactivado hasta que la página está lista. Así, sin JavaScript o antes de que
 * cargue, el navegador nunca arma `?nombre=...&correo=...` con lo que la persona escribió.
 *
 * Los errores de tipeo se detectan aquí, con el mismo esquema que usa el servidor, sin llamarlo: no gastan
 * intentos del límite por IP ni pruebas anti-robot.
 */

const API_PREFIX = "/api/v1/public/forms";
const ANTIBOT_ACTION = "intake_submit";
/** El servidor rechaza un envío hecho antes de 3 s desde que mostró el formulario: se espera un poco más. */
const MIN_FILL_MS = 3_300;
const EMPTY_VALUES: Record<TextFieldKey, string> = {
  name: "",
  email: "",
  phone: "",
  company: "",
  comuna: "",
  serviceAddress: "",
  desiredDate: "",
  message: "",
};
/** Marca de relleno: el esquema pide un token anti-robot, que aquí se revisa aparte. */
const ANTIBOT_PLACEHOLDER = "pendiente";
const MSG_ANTIBOT_MISSING = "Confirma que no eres un robot.";
const MSG_FIX_FIELDS = "Revisa los datos marcados en rojo.";
const MSG_NETWORK =
  "No pudimos enviar tu solicitud. Revisa tu conexión e inténtalo de nuevo: no se duplicará.";

export type PublicIntakeFormProps = {
  publicId: string;
  view: PublicFormView;
  renderToken: string;
  /** Clave de envío que el servidor creó y a la que quedó atado el sello de tiempo. */
  submitKey: string;
  /** Encabezado de la marca, ya dibujado en el servidor (logo reducido incluido). */
  header: ReactNode;
  antibot: { provider: "turnstile" | "memory"; siteKey: string | null };
};

const subscribeNothing = () => () => undefined;
/** `false` al armar la página en el servidor y antes de que cargue; `true` cuando ya funciona en el navegador. */
const useHydrated = () =>
  useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Banner = { tone: "error" | "info"; text: string };

/** Claves de error del servidor -> claves de la pantalla (`items.N.quantity` -> `item:<id>`). */
function mapErrors(
  fieldErrors: Record<string, string>,
  pickedIds: readonly string[],
): { errors: Record<string, string>; general: string | null } {
  const errors: Record<string, string> = {};
  let general: string | null = null;
  for (const [key, message] of Object.entries(fieldErrors)) {
    const itemMatch = /^items\.(\d+)(?:\.|$)/.exec(key);
    if (itemMatch) {
      const id = pickedIds[Number(itemMatch[1])];
      if (id) errors[`item:${id}`] ??= message;
      else errors.items ??= message;
    } else if (key === "items" || key === "consent") {
      errors[key] = message;
    } else if (key in EMPTY_VALUES) {
      errors[key] = message;
    } else {
      // form, renderToken, antibotToken, submitKey…: un aviso general, nunca un campo
      general ??= message;
    }
  }
  return { errors, general };
}

function Success({
  view,
  header,
  message,
}: {
  view: PublicFormView;
  header: ReactNode;
  message: string;
}) {
  const contact = [view.organization.contactEmail, view.organization.contactPhone].filter(Boolean);
  return (
    <div
      className="customer-light overflow-hidden rounded-lg border border-border shadow-2"
      style={brandStyle(view.brand) as CSSProperties}
      data-testid="intake-success"
    >
      {header}
      <div
        role="status"
        className="flex flex-col items-center gap-4 bg-surface p-6 text-center sm:p-10"
      >
        <div className="flex size-14 items-center justify-center rounded-lg bg-success-soft text-success">
          <CheckCircle2 aria-hidden strokeWidth={1.75} className="size-7" />
        </div>
        <h1 className="text-xl font-semibold">Recibimos tu solicitud</h1>
        <p
          className="break-words whitespace-pre-line text-fg-muted"
          data-testid="intake-success-message"
        >
          {message}
        </p>
        {contact.length > 0 ? (
          <p className="text-sm break-words text-fg-subtle">Contacto: {contact.join(" · ")}</p>
        ) : null}
      </div>
    </div>
  );
}

export function PublicIntakeForm({
  publicId,
  view,
  renderToken,
  submitKey,
  header,
  antibot,
}: PublicIntakeFormProps) {
  const ready = useHydrated();
  const [content, setContent] = useState<PublicFormContent>(view);
  const [stamp, setStamp] = useState(renderToken);
  const [values, setValues] = useState<Record<TextFieldKey, string>>(EMPTY_VALUES);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [antibotToken, setAntibotToken] = useState<string | null>(null);
  const [antibotEpoch, setAntibotEpoch] = useState(0);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    shownAt.current = Date.now();
  }, []);

  // El resumen se arma SOLO aquí, en el navegador y con lo que hay escrito: nada se consulta al servidor
  // por tecla y el borrador no se guarda en ningún lado (ni en el almacenamiento del navegador).
  const summary = useMemo(
    () =>
      buildRequestSummary(
        {
          fields: content.fields,
          items: content.items.map((item) => ({
            id: item.id,
            publicName: item.name,
            unit: itemUnitShort(item.unit),
            quantityMode: item.quantityMode,
          })),
        },
        {
          ...values,
          // En el orden en que se eligieron: es el mismo orden en que se envían y en que los ve el equipo.
          items: Object.entries(picked).map(([formItemId, quantity]) => ({ formItemId, quantity })),
        },
      ),
    [content, values, picked],
  );

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid-group="true"]')
        ?.focus();
    });
  };

  const setValue = (key: TextFieldKey, value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  async function submit() {
    if (submitting || !ready) return;

    const pickedIds = Object.keys(picked);
    const asked = (key: keyof PublicFormContent["fields"]) => content.fields[key] !== "off";
    const payload = {
      name: values.name,
      email: values.email,
      phone: asked("phone") ? values.phone : undefined,
      company: asked("company") ? values.company : undefined,
      comuna: asked("comuna") ? values.comuna : undefined,
      serviceAddress: asked("serviceAddress") ? values.serviceAddress : undefined,
      desiredDate: asked("desiredDate") ? values.desiredDate : undefined,
      message: asked("message") ? values.message : undefined,
      items: pickedIds.map((formItemId) => ({ formItemId, quantity: picked[formItemId] })),
      consent,
      consentFingerprint: consentFingerprint(content.consentText, content.privacyPolicyUrl),
      submitKey,
      formRevision: content.revision,
      [HONEYPOT_FIELD]: honeypot,
      renderToken: stamp,
      antibotToken: antibotToken ?? ANTIBOT_PLACEHOLDER,
    };

    // Mismas reglas que el servidor, sin llamarlo: un error de tipeo no gasta intentos ni pruebas anti-robot.
    const checked = buildSubmitSchema({
      fields: content.fields,
      items: content.items,
    }).safeParse(payload);
    if (!checked.success || !antibotToken) {
      const mapped = checked.success
        ? { errors: {}, general: null }
        : mapErrors(fieldErrors(checked.error), pickedIds);
      setErrors(mapped.errors);
      setBanner({
        tone: "error",
        text: !antibotToken ? MSG_ANTIBOT_MISSING : (mapped.general ?? MSG_FIX_FIELDS),
      });
      focusFirstError();
      return;
    }

    setErrors({});
    setBanner(null);
    setSubmitting(true);

    // El servidor no acepta un envío antes de 3 s desde que mostró el formulario (trampa contra robots).
    const wait = MIN_FILL_MS - (Date.now() - (shownAt.current ?? 0));
    if (wait > 0) await sleep(wait);

    let response: SubmitResponse | null = null;
    try {
      const res = await fetch(`${API_PREFIX}/${publicId}/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      });
      response = (await res.json()) as SubmitResponse;
    } catch {
      response = null;
    }

    // La prueba anti-robot ya se gastó: hay que pedir otra para el siguiente intento.
    setAntibotToken(null);
    setAntibotEpoch((epoch) => epoch + 1);
    setSubmitting(false);

    if (!response || typeof response.status !== "string") {
      setBanner({ tone: "error", text: response ? MSG_ERROR : MSG_NETWORK });
      return;
    }

    switch (response.status) {
      case "ok":
        setDone(response.message);
        window.scrollTo({ top: 0 });
        return;
      case "invalid": {
        const mapped = mapErrors(response.fieldErrors, pickedIds);
        setErrors(mapped.errors);
        setBanner({ tone: "error", text: mapped.general ?? MSG_FIX_FIELDS });
        focusFirstError();
        return;
      }
      case "form_changed": {
        // El formulario cambió: se muestra el vigente SIN perder lo escrito (salvo servicios que ya no existen).
        const stillThere = new Set(response.content.items.map((item) => item.id));
        setPicked((previous) =>
          Object.fromEntries(Object.entries(previous).filter(([id]) => stillThere.has(id))),
        );
        const sameNotice =
          consentFingerprint(response.content.consentText, response.content.privacyPolicyUrl) ===
          consentFingerprint(content.consentText, content.privacyPolicyUrl);
        if (!sameNotice) setConsent(false);
        setContent(response.content);
        setStamp(response.renderToken);
        shownAt.current = Date.now();
        setBanner({ tone: "info", text: response.message });
        return;
      }
      default:
        setBanner({ tone: "error", text: response.message });
    }
  }

  if (done !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Success view={view} header={header} message={done} />
      </div>
    );
  }

  const form = (
    <FormView
      brand={view.brand}
      organizationName={view.organization.name}
      header={header}
      title={content.title}
      intro={content.intro}
      fields={content.fields}
      items={content.items.map((item) => ({
        id: item.id,
        publicName: item.name,
        publicDescription: item.description,
        unit: item.unit,
        quantityMode: item.quantityMode,
      }))}
      consentText={content.consentText}
      privacyPolicyUrl={content.privacyPolicyUrl}
      headingLevel={1}
      idPrefix="pf"
      interaction={{
        values,
        onValueChange: setValue,
        picked,
        onToggleItem: (id, checked) =>
          setPicked((previous) => {
            if (checked) return id in previous ? previous : { ...previous, [id]: "" };
            return Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id));
          }),
        onQuantityChange: (id, value) => setPicked((previous) => ({ ...previous, [id]: value })),
        consent,
        onConsentChange: setConsent,
        errors,
        submitting,
        onSubmit: () => void submit(),
        ready,
        action: `${API_PREFIX}/${publicId}/requests`,
        beforeSubmit: (
          <div className="flex min-w-0 flex-col gap-3">
            {/* Campo trampa: una persona nunca lo ve ni lo llena; un robot que llena todo, sí. */}
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: "-10000px",
                width: 1,
                height: 1,
                overflow: "hidden",
              }}
            >
              <label>
                No llenes este campo
                <input
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-form-type="other"
                  value={honeypot}
                  onChange={(event) => setHoneypot(event.target.value)}
                />
              </label>
            </div>
            <AntibotWidget
              key={antibotEpoch}
              provider={antibot.provider}
              siteKey={antibot.siteKey}
              action={ANTIBOT_ACTION}
              onToken={setAntibotToken}
            />
            {banner ? (
              <p
                role={banner.tone === "error" ? "alert" : "status"}
                data-testid="intake-banner"
                className={
                  banner.tone === "error"
                    ? "rounded-md bg-danger-soft p-3 text-sm text-danger"
                    : "rounded-md bg-accent-soft p-3 text-sm text-fg"
                }
              >
                {banner.text}
              </p>
            ) : null}
          </div>
        ),
      }}
    />
  );

  return (
    <div className="grid items-start gap-6 pb-20 lg:grid-cols-[minmax(0,42rem)_22rem] lg:justify-center lg:pb-0">
      {form}
      {/* Escritorio: el resumen va al lado y se queda a la vista. Teléfono: botón fijo y hoja. */}
      <aside
        aria-label="Resumen de tu solicitud"
        data-testid="summary-aside"
        className="customer-light hidden rounded-lg border border-border bg-surface p-5 shadow-1 lg:sticky lg:top-6 lg:block"
        style={brandStyle(view.brand) as CSSProperties}
      >
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Resumen de tu solicitud</h2>
          <RequestSummary summary={summary} announce />
        </div>
      </aside>
      <SummarySheet count={summary.itemCount}>
        <RequestSummary summary={summary} />
      </SummarySheet>
    </div>
  );
}
