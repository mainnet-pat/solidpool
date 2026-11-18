// The few assertion forms the verifier uses, without Node's assert module.
const fail = (message) => { throw new Error(message ?? 'assertion failed'); };

export const ok = (value, message) => { if (!value) fail(message); };

export const equal = (actual, expected, message) => {
  if (actual !== expected) fail(message ?? `${actual} !== ${expected}`);
};

export const deepEqual = (actual, expected, message) => {
  if (!actual || !expected || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) fail(message ?? 'not deeply equal');
};

const assert = { ok, equal, deepEqual };
export default assert;
