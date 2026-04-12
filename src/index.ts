import { buildApp } from "./app";
import { loadSettings } from "./config";

const settings = loadSettings();
const app = buildApp();

app.listen({
  port: settings.app.port,
  hostname: settings.app.host
});

console.info(
  JSON.stringify({
    event: "app_started",
    service: settings.app.name,
    host: settings.app.host,
    port: settings.app.port
  })
);
