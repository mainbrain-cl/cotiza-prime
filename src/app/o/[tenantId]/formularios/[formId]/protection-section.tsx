import { CapReachedAlert } from "@/components/intake/cap-reached-alert";
import { DailyCapControl } from "@/components/intake/daily-cap-control";
import {
  ProtectionCounters,
  ProtectionError,
  ProtectionExplainer,
  ProtectionShell,
} from "@/components/intake/protection-panel";
import {
  capStateOfForm,
  summaryOfForm,
  type ProtectionData,
} from "@/lib/intake/protection-queries";

/**
 * «Protección contra abusos» del editor (H-092). Solo para Dueño y Administrador: para los demás roles
 * `loadProtection` ni consulta (devuelve `forbidden`) y aquí no se pinta nada. Son componentes de servidor que
 * esperan una lectura única (`dataPromise`) dentro de `<Suspense>`, para mostrar el estado de carga.
 */

/** Aviso de tope alcanzado, arriba de todo (en el teléfono el panel queda al final de la página). */
export async function ProtectionAlert({
  dataPromise,
  formId,
}: {
  dataPromise: Promise<ProtectionData>;
  formId: string;
}) {
  const data = await dataPromise;
  if (!data.ok) return null;
  return <CapReachedAlert state={capStateOfForm(data, formId)} href="#tope-diario" />;
}

/** Contadores de este formulario, tope diario y explicación. */
export async function ProtectionSection({
  dataPromise,
  tenantId,
  formId,
  archived,
}: {
  dataPromise: Promise<ProtectionData>;
  tenantId: string;
  formId: string;
  archived: boolean;
}) {
  const data = await dataPromise;
  if (!data.ok) {
    if (data.reason === "forbidden") return null;
    return (
      <ProtectionShell description="Cuántos envíos llegaron y cuántos se bloquearon.">
        <ProtectionError />
      </ProtectionShell>
    );
  }
  const cap = data.caps.get(formId);
  return (
    <ProtectionShell description="Cuántos envíos llegaron y cuántos se bloquearon en este formulario. Solo cuentas: no se guarda quién intentó enviar.">
      <ProtectionCounters
        summary={summaryOfForm(data, formId)}
        emptyText="Todavía no hay movimiento: en los últimos 30 días no llegó ni se bloqueó ningún envío."
      />
      {cap === undefined ? null : (
        <DailyCapControl
          tenantId={tenantId}
          formId={formId}
          initialCap={cap}
          editable={!archived}
        />
      )}
      <ProtectionExplainer />
    </ProtectionShell>
  );
}
