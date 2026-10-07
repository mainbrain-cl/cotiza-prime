import { itemUnitShort } from "./builder-model";
import { buildRequestSummary, type RequestSummary } from "./summary-model";

/**
 * El resumen de una solicitud YA recibida (pantalla del equipo, H-088), armado con el mismo
 * `buildRequestSummary` que usa el formulario público: así quien recibe ve exactamente lo que vio quien
 * la envió. Sin dinero: solo textos.
 */

const quantityFormat = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 });

export type StoredRequest = {
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    comuna: string | null;
    serviceAddress: string | null;
    message: string | null;
  };
  desiredDate: string | null;
  items: readonly { name: string; unit: string; quantityMilli: number | null }[];
};

export function buildStoredRequestSummary(request: StoredRequest): RequestSummary {
  const ids = request.items.map((_, index) => `stored-${index}`);
  return buildRequestSummary(
    {
      // Lo que llegó se muestra tal cual: ningún dato se oculta por la configuración actual del formulario.
      fields: {
        phone: "optional",
        company: "optional",
        comuna: "optional",
        serviceAddress: "optional",
        desiredDate: "optional",
        message: "optional",
      },
      items: request.items.map((item, index) => ({
        id: ids[index]!,
        publicName: item.name,
        unit: itemUnitShort(item.unit),
        quantityMode: item.quantityMilli === null ? "none" : "optional",
      })),
    },
    {
      ...request.contact,
      desiredDate: request.desiredDate,
      items: request.items.map((item, index) => ({
        formItemId: ids[index]!,
        quantity:
          item.quantityMilli === null ? "" : quantityFormat.format(item.quantityMilli / 1000),
      })),
    },
  );
}
