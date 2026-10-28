// RubricaError -> human message (CONTRACTS §2, R3 brief item 5: "typed RubricaError -> human
// messages (i18n), incl. encrypted/corrupt"). Tools should use `useRubricaErrorMessage()` rather
// than hand-rolling another error-code switch (see TOOL-API.md).
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { RubricaError, RubricaErrorCode } from "../ipc/bindings";
import { Button, Dialog } from "../tokens/components";

const CODE_KEY: Record<RubricaErrorCode, string> = {
  ENCRYPTED: "common.errors.encrypted",
  CORRUPT: "common.errors.corrupt",
  IO: "common.errors.io",
  NOT_FOUND: "common.errors.notFound",
  UNSUPPORTED: "common.errors.unsupported",
  FONT_MISSING: "common.errors.fontMissing",
  INVALID_ARG: "common.errors.invalidArg",
  INTERNAL: "common.errors.internal",
};

export interface ErrorMessage {
  title: string;
  description: string;
}

export function useRubricaErrorMessage(): (error: RubricaError) => ErrorMessage {
  const { t } = useTranslation("common");
  return useCallback(
    (error: RubricaError): ErrorMessage => {
      const key = CODE_KEY[error.code] ?? CODE_KEY.INTERNAL;
      return {
        title: t(`common:${key}.title`),
        description: t(`common:${key}.description`, { message: error.message }),
      };
    },
    [t],
  );
}

export interface ErrorDialogProps {
  error: RubricaError | null;
  onClose: () => void;
}

/** Blocking, single-acknowledgement error surface (open failed: encrypted/corrupt/etc). */
export function ErrorDialog({ error, onClose }: ErrorDialogProps) {
  const { t } = useTranslation("common");
  const toMessage = useRubricaErrorMessage();
  if (!error) return null;
  const { title, description } = toMessage(error);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
        <div className="mt-5 flex justify-end">
          <Dialog.Close asChild>
            <Button onClick={onClose}>{t("common:common.actions.close")}</Button>
          </Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
