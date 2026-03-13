import { useSyncExternalStore } from "react";

/**
 * React hook that subscribes to a specific key on `window.openai`.
 * Automatically updates when the Athena host sends new globals via
 * the `openai:set_globals` custom event.
 *
 * Usage: const toolOutput = useOpenAiGlobal("toolOutput");
 */
export function useOpenAiGlobal(key) {
  return useSyncExternalStore(
    (onChange) => {
      const handleSetGlobal = (event) => {
        if (event.detail?.globals?.[key] !== undefined) onChange();
      };
      window.addEventListener("openai:set_globals", handleSetGlobal);
      return () =>
        window.removeEventListener("openai:set_globals", handleSetGlobal);
    },
    () => window.openai?.[key]
  );
}
