"use client";

import { CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { brandStyle } from "@/lib/share/brand-vars";
import { MSG_ERROR, type SubmitResponse } from "@/lib/intake/submit-response";
import type { PublicFormContent, PublicFormView } from "@/lib/intake/public-view";
import { AntibotWidget } from "./antibot-widget";
import { FormView, type TextFieldKey } from "./form-view";

/**
 * La página pública del formulario (H-087), del lado del navegador. Maneja lo que la persona escribe y
 * habla SOLO con `POST /api/v1/public/forms/[publicId]/requests`; nunca con la base. Todo lo que escribe
 * viaja como texto y se muestra como texto.
 *
 * Doble envío: la clave de envío se crea UNA vez al cargar la página y se reenvía igual si se corta la
 * red o el servidor falla, así un reintento nunca crea dos solicitudes. La prueba anti-robot sirve una
 * sola vez, por eso el widget se vuelve a montar después de cada intento.
 */

const API_PREFIX = "/api/v1/public/forms";
const ANTIBOT_ACTION = "intake_submit";
/** El servidor rechaza un envío hecho antes de 3 s desde que mostró el formulario: se espera un poco más. */
const MIN_FILL_MS = 3_300;
const HONEYPOT_FIELD = "website";
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
const MSG_PICK_ONE = "Elige al menos un servicio.";
const MSG_CONSENT = "Para enviar tienes que aceptar el aviso de privacidad.";
const MSG_ANTIBOT_MISSING = "Confirma que no eres un robot.";
const MSG_FIX_FIELDS = "Revisa los datos marcados en rojo.";
const MSG_NETWORK =
  "No pudimos enviar tu solicitud. Revisa tu conexión e inténtalo de nuevo: no se duplicará.";

export type PublicIntakeFormProps = {
  publicId: string;
  view: PublicFormView;
  renderToken: string;
  antibot: { provider: "turnstile" | "memory"; siteKey: string | null };
};

function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Páginas sin contexto seguro (http fuera de localhost) no tienen randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

function Success({ view, message }: { view: PublicFormView; message: string }) {
  const contact = [view.organization.contactEmail, view.organization.contactPhone].filter(Boolean);
  return (
    <div
      className="customer-light overflow-hidden rounded-lg border border-border shadow-2"
      style={brandStyle(view.brand) as CSSProperties}
      data-testid="intake-success"
    >
      <header className="flex min-w-0 items-center gap-3 bg-[var(--brand)] p-4 text-[var(--on-brand)] sm:p-6">
        <p className="min-w-0 text-lg font-semibold break-words">{view.organization.name}</p>
      </header>
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

export function PublicIntakeForm({ publicId, view, renderToken, antibot }: PublicIntakeFormProps) {
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
  // Se crea una vez al cargar la página y se reenvía igual en cada reintento.
  const [submitKey] = useState(newUuid);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    shownAt.current = Date.now();
  }, []);

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  };

  const setValue = (key: TextFieldKey, value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  async function submit() {
    if (submitting) return;
    const problems: Record<string, string> = {};
    if (Object.keys(picked).length === 0) problems.items = MSG_PICK_ONE;
    if (!consent) problems.consent = MSG_CONSENT;
    if (!antibotToken) problems.antibot = MSG_ANTIBOT_MISSING;
    if (Object.keys(problems).length > 0) {
      const { antibot: antibotProblem, ...fieldProblems } = problems;
      setErrors(fieldProblems);
      setBanner({ tone: "error", text: antibotProblem ?? MSG_FIX_FIELDS });
      focusFirstError();
      return;
    }

    setErrors({});
    setBanner(null);
    setSubmitting(true);

    // El servidor no acepta un envío antes de 3 s desde que mostró el formulario (trampa contra robots).
    const wait = MIN_FILL_MS - (Date.now() - (shownAt.current ?? 0));
    if (wait > 0) await sleep(wait);

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
      consent: true,
      submitKey,
      requestId: newUuid(),
      formRevision: content.revision,
      [HONEYPOT_FIELD]: honeypot,
      renderToken: stamp,
      antibotToken,
    };

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
        if (response.content.consentText !== content.consentText) setConsent(false);
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

  if (done !== null) return <Success view={view} message={done} />;

  return (
    <FormView
      brand={view.brand}
      organizationName={view.organization.name}
      logoSrc={view.logoDataUrl}
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
                  name={HONEYPOT_FIELD}
                  tabIndex={-1}
                  autoComplete="off"
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
}
