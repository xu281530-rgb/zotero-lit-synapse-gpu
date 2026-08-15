import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "./package.json";

export default {
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      description: pkg.description,
      buildVersion: pkg.version,
      addonVersion: pkg.config.addonVersion,
      buildTime: "{{buildTime}}",
    },
    hooks: {
      async "build:fluent"(ctx: { dist: string }) {
        for (const locale of ["en-US", "zh-CN"]) {
          const targetDir = join(ctx.dist, "addon", "locale", locale);
          await mkdir(targetDir, { recursive: true });
          await copyFile(
            join(
              ctx.dist,
              "addon",
              "mark-reader",
              "locale",
              locale,
              "zotero-mark-reader.ftl",
            ),
            join(targetDir, "zotero-mark-reader.ftl"),
          );
        }
        for (const locale of [
          "de-DE",
          "en-US",
          "es-ES",
          "fr-FR",
          "ja-JP",
          "zh-CN",
        ]) {
          const path = join(
            ctx.dist,
            "addon",
            "locale",
            locale,
            `${pkg.config.addonRef}-preferences.ftl`,
          );
          const contents = await readFile(path, "utf8");
          await writeFile(
            path,
            contents
              .replace(
                "\n# Hardened build security settings",
                "\n\n\n# Hardened build security settings",
              )
              .replace(
                "\n# ============ PDF reading and translation",
                "\n\n# ============ PDF reading and translation",
              )
              .replace(
                "\n# ============ PDF 阅读与翻译",
                "\n\n# ============ PDF 阅读与翻译",
              )
              .replace(
                "\n# Unified PDF Markdown pipeline",
                "\n\n# Unified PDF Markdown pipeline",
              ),
            "utf8",
          );
        }
        await rm(join(ctx.dist, "addon", "mark-reader", "locale"), {
          recursive: true,
          force: true,
        });
      },
      async "build:makeUpdateJSON"(ctx: { dist: string }) {
        const stable = !pkg.config.addonVersion.includes("-");
        await rm(join(ctx.dist, stable ? "update-beta.json" : "update.json"), {
          force: true,
        });
        for (const name of ["update.json", "update-beta.json"]) {
          const path = join(ctx.dist, name);
          try {
            const contents = await readFile(path, "utf8");
            await writeFile(
              path,
              contents
                .replaceAll(pkg.version, pkg.config.addonVersion)
                .replaceAll(
                  `/v${pkg.config.addonVersion}/zotero-mcp-plugin.xpi`,
                  `/v${pkg.config.addonVersion}/zotero-mcp-plugin-${pkg.config.addonVersion}.xpi`,
                ),
              "utf8",
            );
          } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
      },
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
};
