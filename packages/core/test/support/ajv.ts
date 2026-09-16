import { Ajv2020 } from 'ajv/dist/2020.js';
import formats, { type FormatsPlugin } from 'ajv-formats';

/**
 * One place where Ajv's packaging is reconciled with this repository's compiler settings.
 *
 * Both packages ship CommonJS behind ES-style declarations. Under `NodeNext` without
 * `esModuleInterop`, a default import is therefore typed as the module namespace rather than the
 * thing itself. Ajv exports its class by name as well, so that needs no help; ajv-formats exports
 * only a default, and at run time that default *is* the plugin — `module.exports` is the function,
 * which is why these tests have always passed and only the compiler disagreed. Hence exactly one
 * cast, as narrow as the declaration allows, rather than a loosened compiler option.
 */
const addFormats = formats as unknown as FormatsPlugin;

/** The validator the spec tests use: draft 2020-12, strict, with `date-time` from the plugin. */
export const strictAjv = (): Ajv2020 => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv;
};
