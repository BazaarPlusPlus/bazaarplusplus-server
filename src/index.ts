import type { Env } from "./env";
import { createFetchHandler } from "./http/route-shell";
import { V5_ROUTES } from "./http/routes";

const fetch = createFetchHandler(V5_ROUTES);

export default { fetch } satisfies ExportedHandler<Env>;
