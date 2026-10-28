// Mock implementation of the "annotations" domain (CONTRACTS §3/§5).
import type { Annot, AnnotPatch, AnnotSpec, MutationResult } from "../bindings";
import { applyBBoxToAnnot } from "../../tools/annotate/geometry";
import { commitMutation, type CommandResult, err, findDocById, generateId, ok } from "./state";

export async function annotList(docId: string, page: number): Promise<CommandResult<Annot[]>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  return ok(doc.mutable.annotations.filter((a) => a.page === page));
}

export async function annotAdd(docId: string, spec: AnnotSpec): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  if (spec.page < 0 || spec.page >= doc.mutable.pages.length) {
    return err("INVALID_ARG", `page ${spec.page} out of range`);
  }
  const page = spec.page;
  const result = commitMutation(doc, () => {
    const annotId = generateId("annot");
    // `Annot` = `{ annotId, page } & AnnotSpec`; `spec` already carries its
    // own `page`, so spreading it after `annotId` gives the exact shape.
    const annot = { annotId, ...spec } as Annot;
    doc.mutable.annotations.push(annot);
    return [page];
  });
  return ok(result);
}

/**
 * `AnnotPatch`'s fields are all `T | null` rather than optional — CONTRACTS
 * describes it as "every field optional", so `null` is the "leave
 * unchanged" sentinel (an annotation's color/rect can never legitimately be
 * null). `color`/`opacity`/`contents` are silently ignored on variants that
 * don't carry that field (e.g. `color` on a `note`) — a cast is needed here
 * since discriminated union members don't share these fields structurally.
 *
 * `rect` is interpreted generically as "the annotation's new bounding box,"
 * not literally as a `rect` field — see `tools/annotate/geometry.ts`'s
 * header comment for why (common move/resize machinery across every
 * annotation kind needs this; CONTRACTS' `AnnotPatch` has no per-kind
 * geometry field). `applyBBoxToAnnot` maps quadpoints/strokes/point/rect
 * from the annotation's current bbox onto the patch's `rect` accordingly.
 */
function applyAnnotPatch(target: Annot, patch: AnnotPatch): void {
  const mutable = target as unknown as Record<string, unknown>;
  if (patch.color !== null && "color" in mutable) mutable.color = patch.color;
  if (patch.opacity !== null && "opacity" in mutable) mutable.opacity = patch.opacity;
  if (patch.contents !== null && "contents" in mutable) mutable.contents = patch.contents;
  if (patch.rect !== null) Object.assign(mutable, applyBBoxToAnnot(target, patch.rect));
}

export async function annotUpdate(docId: string, annotId: string, patch: AnnotPatch): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const existing = doc.mutable.annotations.find((a) => a.annotId === annotId);
  if (!existing) return err("NOT_FOUND", `no annotation with id "${annotId}"`);
  const page = existing.page;
  const result = commitMutation(doc, () => {
    const target = doc.mutable.annotations.find((a) => a.annotId === annotId);
    if (target) applyAnnotPatch(target, patch);
    return [page];
  });
  return ok(result);
}

export async function annotDelete(docId: string, annotId: string): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const existing = doc.mutable.annotations.find((a) => a.annotId === annotId);
  if (!existing) return err("NOT_FOUND", `no annotation with id "${annotId}"`);
  const page = existing.page;
  const result = commitMutation(doc, () => {
    doc.mutable.annotations = doc.mutable.annotations.filter((a) => a.annotId !== annotId);
    return [page];
  });
  return ok(result);
}
