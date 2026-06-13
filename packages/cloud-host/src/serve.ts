import { createCloud } from "./host.ts";

// Runnable entrypoint for the podkit control-plane.
//
// Reads configuration from the environment, boots the cloud (API + gateway),
// prints the resolved URLs as a single JSON line, then stays alive until it
// receives SIGTERM/SIGINT, at which point it shuts the cloud down cleanly.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const controlPlaneConnectionString = requireEnv("PODKIT_CP_DATABASE_URL");
  const adminConnectionString =
    process.env.PODKIT_ADMIN_DATABASE_URL || controlPlaneConnectionString;
  const apiKey = process.env.PODKIT_API_KEY || undefined;
  const apiPort = Number(process.env.PODKIT_API_PORT ?? "8080");
  const gatewayPort = Number(process.env.PODKIT_GATEWAY_PORT ?? "8090");

  const cloud = createCloud({
    controlPlaneConnectionString,
    adminConnectionString,
    apiKey,
  });

  const { apiUrl, gatewayUrl } = await cloud.listen({ apiPort, gatewayPort });
  console.log(JSON.stringify({ apiUrl, gatewayUrl }));

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`received ${signal}, shutting down`);
    cloud
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(
          "error during shutdown:",
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Keep the process alive indefinitely until a signal arrives.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error(
    "control-plane failed to start:",
    err instanceof Error ? err.stack ?? err.message : String(err),
  );
  process.exit(1);
});
