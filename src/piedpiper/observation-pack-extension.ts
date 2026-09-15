import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateObservationPackRuntime } from "./observation-pack.js";

/** Verifies and registers ObservationPack when Pi loads this package-owned extension. */
export default async function registerPiedPiperObservationPack(
  pi: ExtensionAPI,
): Promise<void> {
  await validateObservationPackRuntime();
  const { registerObservationPack } = await import(
    "../third-party/sol-pi/extensions/observation-pack/index.js"
  );
  registerObservationPack(pi);
}
