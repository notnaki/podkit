import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

// `podkit init [name]` — scaffold a new podkit app so a user goes from nothing
// to a deployable app in one command. Files mirror the framework's conventions
// (app/routes/*.tsx with a default component + optional loader, app/entry-client.tsx).

// A project name doubles as a deploy slug, so keep it slug-safe.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

function tpl(name: string): Record<string, string> {
  return {
    "package.json":
      JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: {
            dev: "podkit dev",
            build: "podkit build",
            start: "podkit start",
          },
          dependencies: {
            // podkit packages aren't published to npm yet — see README. Inside a
            // podkit checkout these resolve as workspace packages; on deploy the
            // vendored base image provides them.
            "@podkit/framework": "workspace:*",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
          },
        },
        null,
        2,
      ) + "\n",

    "app/entry-client.tsx":
      `import { hydrateRoot } from "react-dom/client";\n` +
      `declare global { interface Window { __PODKIT_DATA__: unknown } }\n` +
      `const root = document.getElementById("root")!;\n` +
      `hydrateRoot(root, root.firstElementChild as never);\n`,

    "app/routes/index.tsx":
      `// A route module: optional loader(ctx) runs on the server, and its return\n` +
      `// value is passed to the default component as the { data } prop.\n` +
      `// PageProps<LoaderData<typeof loader>> keeps the component's data in sync\n` +
      `// with the loader's return type — no manual prop type to maintain.\n` +
      `import type { LoaderContext, PageProps, LoaderData } from "@podkit/framework";\n\n` +
      `export function loader({ url }: LoaderContext) {\n` +
      `  return { name: ${JSON.stringify(name)}, path: url.pathname };\n` +
      `}\n\n` +
      `export default function Home({ data }: PageProps<LoaderData<typeof loader>>) {\n` +
      `  return (\n` +
      `    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "8vh auto", padding: "0 20px" }}>\n` +
      `      <h1>{data.name}</h1>\n` +
      `      <p>Your podkit app is running. Edit <code>app/routes/index.tsx</code> and refresh.</p>\n` +
      `      <p>Add routes by creating files under <code>app/routes/</code> — e.g. <code>about.tsx</code>,\n` +
      `        <code>blog/[slug].tsx</code> (dynamic), <code>docs/[...path].tsx</code> (catch-all).</p>\n` +
      `      <p><a href="/about">/about →</a></p>\n` +
      `    </main>\n` +
      `  );\n` +
      `}\n`,

    "app/routes/about.tsx":
      `export default function About() {\n` +
      `  return (\n` +
      `    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "8vh auto", padding: "0 20px" }}>\n` +
      `      <h1>About</h1>\n` +
      `      <p>A second route — file-based routing, server-rendered, then hydrated.</p>\n` +
      `      <p><a href="/">← home</a></p>\n` +
      `    </main>\n` +
      `  );\n` +
      `}\n`,

    ".gitignore": "node_modules/\n.podkit/\ndist/\n.env\n",

    "README.md":
      `# ${name}\n\n` +
      `A [podkit](https://github.com/notnaki/podkit) app — file-based routing + React SSR,\n` +
      `with a managed Postgres and one-command deploys.\n\n` +
      `Full docs: run \`podkit docs\` for CLI topics, or open the **Docs** page in your\n` +
      `control-plane console (the \`#/docs\` route).\n\n` +
      `## Develop\n\n` +
      "```sh\n" +
      `pnpm install   # resolves @podkit/* (see note below)\n` +
      `podkit dev     # http://localhost:3000\n` +
      "```\n\n" +
      `## Deploy\n\n` +
      "```sh\n" +
      `podkit cloud login\n` +
      `podkit cloud create ${name}\n` +
      `podkit cloud deploy ${name}   # no Dockerfile, no flags\n` +
      "```\n\n" +
      `## Note on dependencies\n\n` +
      `podkit's packages aren't published to npm yet. Until they are, create this app\n` +
      `inside a podkit checkout (e.g. under \`examples/\` or \`apps/\`) so \`@podkit/*\`\n` +
      `resolve as workspace packages. Deploys work regardless — the cloud builds your\n` +
      `app on a base image that already has the framework.\n`,
  };
}

export async function initCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const arg = args[0];
    // `podkit init` / `podkit init .` -> scaffold the current directory.
    // `podkit init <name>` -> create and scaffold ./<name>.
    const inPlace = arg === undefined || arg === ".";
    const targetDir = inPlace ? process.cwd() : resolve(process.cwd(), arg);
    const name = inPlace ? basename(targetDir) : arg;

    if (!NAME_RE.test(name)) {
      throw new PodkitError(
        "E_BAD_ARGS",
        "invalid app name: " + name,
        "use lowercase letters, digits, hyphens (a valid deploy slug), e.g. podkit init my-app",
      );
    }

    const files = tpl(name);

    // Never clobber: refuse if any target file already exists.
    const existing = Object.keys(files).filter((rel) =>
      existsSync(join(targetDir, rel)),
    );
    if (existing.length > 0) {
      throw new PodkitError(
        "E_BAD_STATE",
        "refusing to overwrite existing files: " + existing.join(", "),
        "run in an empty directory, or pass a new name: podkit init my-app",
      );
    }

    for (const [rel, contents] of Object.entries(files)) {
      const full = join(targetDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    }

    return ok({
      name,
      path: targetDir,
      files: Object.keys(files).sort(),
      nextSteps: inPlace
        ? ["pnpm install", "podkit dev", "podkit cloud deploy " + name]
        : ["cd " + arg, "pnpm install", "podkit dev", "podkit cloud deploy " + name],
    });
  } catch (err) {
    return fail(err);
  }
}
