import assert from "node:assert/strict";
import { fitCosine, fitData, fitExponential, fitInverse, fitLinear, fitLogarithmic, fitPower, fitQuadratic, fitSine } from "../lib/curve-fitting";

const closeTo = (actual: number | undefined, expected: number, label: string) => {
  if (actual === undefined) assert.fail(`${label} should be defined`);
  assert.ok(Math.abs(actual - expected) < 1e-10, `${label}: expected ${expected}, received ${actual}`);
};

const linear = fitLinear([0, 1, 2, 3].map((t) => ({ t, value: 2 * t + 1 })));
assert.ok(linear.ok, "linear fit should solve");
if (linear.ok) {
  closeTo(linear.m, 2, "linear slope");
  closeTo(linear.b, 1, "linear intercept");
  closeTo(linear.rSquared, 1, "linear R²");
  closeTo(linear.rmse, 0, "linear RMSE");
}

const quadratic = fitQuadratic([-1, 0, 1, 2, 3].map((t) => ({ t, value: -4.9 * t ** 2 + 3 * t + 2 })));
assert.ok(quadratic.ok, "quadratic fit should solve");
if (quadratic.ok) {
  closeTo(quadratic.a, -4.9, "quadratic A");
  closeTo(quadratic.b, 3, "quadratic B");
  closeTo(quadratic.c, 2, "quadratic C");
  closeTo(quadratic.rSquared, 1, "quadratic R²");
}

const exponential = fitExponential([0, 1, 2, 3, 4].map((t) => ({ t, value: 2 * Math.exp(0.5 * t) })));
assert.ok(exponential.ok, "exponential fit should solve");
if (exponential.ok) {
  closeTo(exponential.coefficients.A, 2, "exponential A");
  closeTo(exponential.coefficients.B, 0.5, "exponential B");
  closeTo(exponential.rSquared, 1, "exponential R²");
  closeTo(exponential.rmse, 0, "exponential RMSE");
}

const logarithmic = fitLogarithmic([0.5, 1, 2, 3, 5, 8].map((t) => ({ t, value: 3 * Math.log(t) + 1 })));
assert.ok(logarithmic.ok, "logarithmic fit should solve");
if (logarithmic.ok) {
  closeTo(logarithmic.coefficients.A, 3, "logarithmic A");
  closeTo(logarithmic.coefficients.B, 1, "logarithmic B");
  closeTo(logarithmic.rSquared, 1, "logarithmic R²");
}

const power = fitPower([0.5, 1, 2, 3, 4].map((t) => ({ t, value: 2 * t ** 1.5 })));
assert.ok(power.ok, "power fit should solve");
if (power.ok) {
  closeTo(power.coefficients.A, 2, "power A");
  closeTo(power.coefficients.B, 1.5, "power B");
  closeTo(power.rSquared, 1, "power R²");
  closeTo(power.rmse, 0, "power RMSE");
}

const inverse = fitInverse([1, 2, 3, 4, 5].map((t) => ({ t, value: 6 / t + 1.5 })));
assert.ok(inverse.ok, "inverse fit should solve");
if (inverse.ok) {
  closeTo(inverse.coefficients.A, 6, "inverse A");
  closeTo(inverse.coefficients.B, 1.5, "inverse B");
  closeTo(inverse.rSquared, 1, "inverse R²");
  closeTo(inverse.rmse, 0, "inverse RMSE");
}

const harmonicPoints = Array.from({ length: 61 }, (_, index) => {
  const t = index * 0.1;
  return { t, value: 2 * Math.sin(3 * t + 0.5) + 1 };
});
const sine = fitSine(harmonicPoints);
assert.ok(sine.ok, "sine fit should solve");
if (sine.ok) {
  closeTo(sine.coefficients.A, 2, "sine A");
  assert.ok(Math.abs(sine.coefficients.omega - 3) < 1e-6, `sine omega: expected 3, received ${sine.coefficients.omega}`);
  closeTo(sine.coefficients.C, 1, "sine C");
  closeTo(sine.rSquared, 1, "sine R²");
  assert.ok(sine.rmse < 1e-5, `sine RMSE should be near zero, received ${sine.rmse}`);
}

const cosine = fitCosine(Array.from({ length: 61 }, (_, index) => {
  const t = index * 0.1;
  return { t, value: 2 * Math.cos(3 * t + 0.5) + 1 };
}));
assert.ok(cosine.ok, "cosine fit should solve");
if (cosine.ok) {
  closeTo(cosine.coefficients.A, 2, "cosine A");
  assert.ok(Math.abs(cosine.coefficients.omega - 3) < 1e-6, `cosine omega: expected 3, received ${cosine.coefficients.omega}`);
  closeTo(cosine.coefficients.C, 1, "cosine C");
}

const generic = fitData("linear", [{ t: 0, value: 1 }, { t: 1, value: 3 }]);
assert.ok(generic?.ok, "generic model dispatcher should solve linear data");

process.stdout.write("Curve-fitting verification passed.\n");
