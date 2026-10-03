import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// the web app; `yoinks --web` serves the build from dist/web
export default defineConfig({
	root: "web",
	base: "/downloader/",
	plugins: [react()],
	build: { outDir: "../dist/web", emptyOutDir: true },
	server: {
		// `npm run dev:web` — the api comes from `yoinks --web --no-open` on 4455
		proxy: { "/api": { target: "http://127.0.0.1:4455", changeOrigin: true } },
	},
});
