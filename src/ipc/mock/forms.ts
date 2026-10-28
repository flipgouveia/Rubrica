// Mock implementation of the "forms" domain (CONTRACTS §3/§5).
import type { FormField, MutationResult } from "../bindings";
import { commitMutation, type CommandResult, err, findDocById, ok } from "./state";

export async function formFields(docId: string): Promise<CommandResult<FormField[]>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  return ok(doc.mutable.formFields);
}

export async function formSetValue(docId: string, fieldId: string, value: string): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const field = doc.mutable.formFields.find((f) => f.id === fieldId);
  if (!field) return err("NOT_FOUND", `no form field with id "${fieldId}"`);
  if (field.readOnly) return err("INVALID_ARG", `field "${fieldId}" is read-only`);
  if ((field.kind === "combo" || field.kind === "listbox" || field.kind === "radio") && field.options && !field.options.includes(value)) {
    return err("INVALID_ARG", `"${value}" is not one of field "${fieldId}"'s options`);
  }

  const page = field.page;
  const result = commitMutation(doc, () => {
    const target = doc.mutable.formFields.find((f) => f.id === fieldId);
    if (target) target.value = value;
    return [page];
  });
  return ok(result);
}
