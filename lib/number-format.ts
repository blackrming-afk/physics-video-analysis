export function formatSignificant(value: number | undefined, digits = 4) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return Number(value.toPrecision(digits)).toString();
}

