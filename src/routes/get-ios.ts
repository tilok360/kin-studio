import { createFileRoute } from "@tanstack/react-router";
import { iosWebclipResponse } from "../../scripts/ios-webclip.mjs";

export const Route = createFileRoute("/get-ios")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const { body, headers } = iosWebclipResponse(request);
        return new Response(body, { headers });
      },
    },
  },
});
