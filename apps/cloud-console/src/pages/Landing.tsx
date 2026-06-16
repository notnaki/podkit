// Public landing page — the product front door. Built entirely on the existing
// monochrome token system (no new colors/fonts). Left-aligned, dense, terminal-
// forward; deliberately avoids the icon-card / gradient-text / accent-stripe
// templates the design context bans.

export function Landing() {
  return (
    <main className="landing">
      <Hero />
      <Pitch />
      <Features />
      <HowItWorks />
      <Cta />
      <Footer />
    </main>
  );
}

function Hero() {
  return (
    <section className="lp-hero wrap-tight">
      <div className="lp-hero-copy">
        <span className="lp-eyebrow mono">the agents-first app platform</span>
        <h1 className="lp-title">
          Vercel + Supabase,<br />built for agents.
        </h1>
        <p className="lp-lede">
          A React framework, a managed Postgres per project, and one-command
          deploys — wrapped in a CLI that speaks JSON, so the agent writing your
          app can ship it too.
        </p>
        <div className="lp-actions">
          <a className="btn btn-invert" href="#/login">Get started</a>
          <a className="btn" href="#/docs">Read the docs</a>
        </div>
      </div>

      {/* A real terminal: the one command that takes an app to production. */}
      <Terminal />
    </section>
  );
}

function Terminal() {
  return (
    <div className="lp-term" aria-hidden>
      <div className="lp-term-bar">
        <span className="lp-term-dot" />
        <span className="lp-term-dot" />
        <span className="lp-term-dot" />
        <span className="lp-term-title mono">myapp — zsh</span>
      </div>
      <pre className="lp-term-body mono">
        <span className="lp-line"><span className="lp-prompt">$</span> podkit cloud deploy myapp</span>
        <span className="lp-line lp-dim">  packaging app · uploading 1.2 MB</span>
        <span className="lp-line lp-dim">  building standalone image · no Dockerfile</span>
        <span className="lp-line lp-dim">  starting container · health check ok</span>
        <span className="lp-line lp-ok">✓ live at https://cloud.podkit.sh/_p/myapp/</span>
        <span className="lp-line lp-dim">  version v9f3c1a · zero-downtime · 6.4s</span>
        <span className="lp-line"><span className="lp-prompt">$</span> <span className="lp-caret">▋</span></span>
      </pre>
    </div>
  );
}

function Pitch() {
  return (
    <section className="lp-pitch wrap-tight">
      <p className="lp-pitch-text">
        No Dockerfile. No YAML. No dashboard click-path. Point the CLI at an app
        directory and podkit tars it, builds a standalone image on a vendored
        base, boots a container, health-checks it, and swaps the route — the old
        version keeps serving until the new one is ready.
      </p>
    </section>
  );
}

// Feature blocks — intentionally NOT a uniform icon-card grid. Each block leads
// with a mono index + label and varies in span, so the grid reads as a spec
// sheet, not a marketing template.
function Features() {
  return (
    <section className="lp-features wrap-tight">
      <header className="lp-section-head">
        <span className="lp-section-kicker mono">01 — what you get</span>
        <h2>Three layers, one tool.</h2>
      </header>

      <div className="lp-feature-grid">
        <article className="lp-feat lp-feat-wide">
          <div className="lp-feat-tag mono">framework</div>
          <h3>File-based routing, React SSR.</h3>
          <p>
            Drop components in <code className="lp-ic">app/routes</code>. Static,
            <code className="lp-ic">[slug]</code>, and{" "}
            <code className="lp-ic">[...catchall]</code> segments map straight to
            URLs. Every route renders on the server and hydrates on the client —
            with a per-route <code className="lp-ic">loader</code> for data.
          </p>
        </article>

        <article className="lp-feat">
          <div className="lp-feat-tag mono">database</div>
          <h3>Managed Postgres, per project.</h3>
          <p>
            Each project gets its own isolated database and a scoped role —
            provisioned on create, connection string shown once.
          </p>
        </article>

        <article className="lp-feat">
          <div className="lp-feat-tag mono">deploy</div>
          <h3>One command, zero downtime.</h3>
          <p>
            Upload-based deploys build server-side. New container health-checks
            before it takes the route; rollback is one id away.
          </p>
        </article>

        <article className="lp-feat lp-feat-wide">
          <div className="lp-feat-tag mono">agents-first</div>
          <h3>Every command is machine-legible.</h3>
          <p>
            The CLI returns a typed <code className="lp-ic">Envelope</code> on
            every call, and <code className="lp-ic">--json</code> prints it raw.
            Issue scoped agent tokens with{" "}
            <code className="lp-ic">podkit auth token</code> so an agent can build,
            deploy, query, and roll back without a human in the loop.
          </p>
        </article>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "1",
      t: "Write a podkit app",
      d: "File-based routes in app/routes, loaders for data, a schema in app/db. podkit dev serves it with SSR + hot reload.",
    },
    {
      n: "2",
      t: "podkit cloud deploy",
      d: "From the app directory, run one command. The CLI packages the source and streams it to the control-plane, which builds and boots it.",
    },
    {
      n: "3",
      t: "It's live — with previews",
      d: "Production routes at /_p/<slug>/. Branch the database, deploy a preview per branch, and promote or roll back when you're ready.",
    },
  ];
  return (
    <section className="lp-how wrap-tight">
      <header className="lp-section-head">
        <span className="lp-section-kicker mono">02 — how it works</span>
        <h2>From directory to production in one command.</h2>
      </header>
      <ol className="lp-steps">
        {steps.map((s) => (
          <li key={s.n} className="lp-step">
            <span className="lp-step-n mono">{s.n}</span>
            <div>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Cta() {
  return (
    <section className="lp-cta wrap-tight">
      <div className="lp-cta-inner">
        <h2>Ship your first app today.</h2>
        <p>Create an account, point the CLI at your project, and deploy.</p>
        <div className="lp-actions">
          <a className="btn btn-invert" href="#/login">Get started</a>
          <a className="btn" href="#/docs">Read the docs</a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-footer wrap-tight">
      <div className="lp-foot-brand">
        <span className="logo" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="1" y="1" width="7" height="7" rx="2.2" fill="currentColor" /><rect x="10" y="1" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /><rect x="1" y="10" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /><rect x="10" y="10" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /></svg>
        </span>
        <span className="mono">podkit</span>
      </div>
      <nav className="lp-foot-links">
        <a href="#/docs">Docs</a>
        <a href="#/login">Sign in</a>
        <a href="#/login">Get started</a>
      </nav>
      <span className="faint lp-foot-note">The agents-first app platform.</span>
    </footer>
  );
}
