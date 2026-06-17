// Public landing page: the product front door. Built entirely on the existing
// monochrome token system plus the one brand accent (#3551f3). Left-aligned,
// dense, terminal-forward. Deliberately avoids the icon-card / gradient-text /
// section-number-eyebrow templates the design context bans.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Logo } from "../components/Logo.tsx";

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

// Adds .is-in when the element scrolls into view. CSS gates the transition behind
// prefers-reduced-motion, so this is a no-op visual for reduced-motion users.
// ponytail: IntersectionObserver reveal; a scroll-animation lib would be overkill.
function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.18 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={"reveal " + className}>
      {children}
    </div>
  );
}

function Hero() {
  return (
    <section className="lp-hero wrap-tight">
      <div className="lp-hero-copy">
        <span className="lp-eyebrow mono">the agents-first app platform</span>
        <h1 className="lp-title">
          Vercel plus Supabase,<br />
          <span className="accent">built for agents.</span>
        </h1>
        <p className="lp-lede">
          A React framework, a managed Postgres per project, and one-command
          deploys, wrapped in a CLI that speaks JSON.
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
        <span className="lp-term-title mono">myapp · zsh</span>
      </div>
      <pre className="lp-term-body mono">
        <span className="lp-line"><span className="lp-prompt">$</span> podkit cloud deploy myapp</span>
        <span className="lp-line lp-dim">  packaging app · uploading 1.2 MB</span>
        <span className="lp-line lp-dim">  building standalone image (no Dockerfile)</span>
        <span className="lp-line lp-dim">  starting container · health check ok</span>
        <span className="lp-line lp-ok">✓ live at https://myapp.podkit.sh</span>
        <span className="lp-line lp-dim">  zero downtime · 6.4s</span>
        <span className="lp-line"><span className="lp-prompt">$</span> <span className="lp-caret">▋</span></span>
      </pre>
    </div>
  );
}

function Pitch() {
  return (
    <section className="lp-pitch wrap-tight">
      <Reveal>
        <p className="lp-pitch-text">
          No Dockerfile. No YAML. No dashboard click-path. Point the CLI at an app
          directory and podkit tars it, builds a standalone image, boots a
          container, health-checks it, then swaps the route. The old version keeps
          serving until the new one is ready.
        </p>
      </Reveal>
    </section>
  );
}

// Feature blocks: intentionally NOT a uniform icon-card grid. Each block leads
// with a mono label and varies in span, so the grid reads as a spec sheet, not a
// marketing template. No section-number eyebrow (the headline alone is enough).
function Features() {
  return (
    <section className="lp-features wrap-tight">
      <Reveal>
        <header className="lp-section-head">
          <h2>Three layers, one tool.</h2>
        </header>
      </Reveal>

      <Reveal>
        <div className="lp-feature-grid">
          <article className="lp-feat lp-feat-wide">
            <div className="lp-feat-tag mono">framework</div>
            <h3>File-based routing, React SSR.</h3>
            <p>
              Drop components in <code className="lp-ic">app/routes</code>. Static,
              <code className="lp-ic">[slug]</code>, and{" "}
              <code className="lp-ic">[...catchall]</code> segments map straight to
              URLs. Every route renders on the server and hydrates on the client,
              with a per-route <code className="lp-ic">loader</code> for data.
            </p>
          </article>

          <article className="lp-feat">
            <div className="lp-feat-tag mono">database</div>
            <h3>Managed Postgres, per project.</h3>
            <p>
              Each project gets its own isolated database and a scoped role,
              provisioned on create, connection string shown once.
            </p>
          </article>

          <article className="lp-feat">
            <div className="lp-feat-tag mono">deploy</div>
            <h3>One command, zero downtime.</h3>
            <p>
              Upload-based deploys build server-side. A new container health-checks
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
      </Reveal>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "1",
      t: "Write a podkit app",
      d: "File-based routes in app/routes, loaders for data, a schema in app/db. podkit dev serves it with SSR and hot reload.",
    },
    {
      n: "2",
      t: "podkit cloud deploy",
      d: "From the app directory, run one command. The CLI packages the source and streams it to the control-plane, which builds and boots it.",
    },
    {
      n: "3",
      t: "It is live, with previews",
      d: "Production at <slug>.<domain>. Branch the database, deploy a preview per branch, and promote or roll back when you are ready.",
    },
  ];
  return (
    <section className="lp-how wrap-tight">
      <Reveal>
        <header className="lp-section-head">
          <h2>From directory to production in one command.</h2>
        </header>
      </Reveal>
      <Reveal>
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
      </Reveal>
    </section>
  );
}

function Cta() {
  return (
    <section className="lp-cta wrap-tight">
      <Reveal>
        <div className="lp-cta-inner">
          <h2>Ship your first app today.</h2>
          <p>Create an account, point the CLI at your project, and deploy.</p>
          <div className="lp-actions">
            <a className="btn btn-invert" href="#/login">Get started</a>
            <a className="btn" href="#/docs">Read the docs</a>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-footer wrap-tight">
      <div className="lp-foot-brand">
        <Logo size={16} />
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
