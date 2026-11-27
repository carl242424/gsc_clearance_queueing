import "dotenv/config";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

const protectedRoutes = new Map([
  ["/staff/dashboard", ["staff", "admin"]],
  ["/staff/history", ["staff", "admin"]],
  ["/admin/dashboard", ["admin"]],
  ["/admin/staff", ["admin"]],
  ["/admin/settings", ["admin"]],
  ["/admin/history", ["admin"]],
  ["/qr", ["admin"]],
]);

function dashboardAuthGuard(apiUrl) {
  const guard = (req, res, next) => {
    let route;
    try {
      route = decodeURIComponent(new URL(req.url, "http://localhost").pathname)
        .replace(/\/index\.html$/, "")
        .replace(/\/+$/, "") || "/";
    } catch {
      res.statusCode = 400;
      return res.end("Invalid route.");
    }
    const roles = protectedRoutes.get(route);
    if (!roles) return next();
    fetch(`${apiUrl}/api/auth/me`, { headers: { cookie: req.headers.cookie || "" } })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
          res.statusCode = 302;
          res.setHeader("Location", "/login");
          return res.end();
        }
        if (!response.ok) {
          res.statusCode = 503;
          return res.end("Unable to verify your session.");
        }
        if (!roles.includes(data.user?.role)) {
          res.statusCode = 403;
          return res.end("You do not have permission to view this page.");
        }
        next();
      })
      .catch(() => {
        res.statusCode = 503;
        res.end("Unable to verify your session.");
      });
  };
  return {
    name: "dashboard-auth-guard",
    configureServer(server) {
      server.middlewares.use(guard);
    },
    configurePreviewServer(server) {
      server.middlewares.use(guard);
    },
  };
}

export default defineConfig({
  vite: {
    plugins: [
      tailwindcss(),
      dashboardAuthGuard(process.env.PUBLIC_API_URL || "http://localhost:3001"),
    ],
  },
  output: "static",
  server: { port: 4321 },
});
