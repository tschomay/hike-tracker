import { defineConfig, type Plugin } from "vite";

// Serve api/*.ts in `vite dev` the way Vercel does in production.
const devApi = (): Plugin => ({
  name: "dev-api",
  configureServer(server) {
    server.middlewares.use("/api/", async (req, res, next) => {
      const name = req.url!.split("?")[0].replace(/^\//, "");
      try {
        const mod = await server.ssrLoadModule(`/api/${name}.ts`);
        const response: Response = await mod.GET(new Request(`http://localhost${req.originalUrl}`));
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (e) {
        next(e);
      }
    });
  },
});

export default defineConfig({ plugins: [devApi()] });
