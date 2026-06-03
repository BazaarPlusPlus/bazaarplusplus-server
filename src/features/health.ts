import { json } from "../http/json";

export function handleHealth(): Response {
  return json({
    status: "ok",
    server_time_utc: new Date().toISOString(),
  });
}
