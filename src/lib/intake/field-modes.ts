/** Cómo se pide cada dato en un formulario público. Nombre y correo siempre son obligatorios. */
export type FieldMode = "off" | "optional" | "required";
export type QuantityMode = "none" | "optional" | "required";

export type FieldModes = {
  phone: FieldMode;
  company: FieldMode;
  comuna: FieldMode;
  serviceAddress: FieldMode;
  desiredDate: FieldMode;
  message: FieldMode;
};
