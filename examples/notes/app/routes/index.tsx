import { randomUUID } from "node:crypto";
import { createAuth } from "@podkit/auth";
import { and, desc, eq } from "@podkit/db";
import type {
  ActionContext,
  ActionResult,
  CookieDirective,
  LoaderContext,
  PageProps,
  LoaderData,
} from "@podkit/framework";
import { getDb } from "../lib/db.ts";
import { notes as notesT, users as usersT } from "../db/schema.ts";

// The token the framework verifies for `auth` is signed with this secret, so the
// app must sign with the same one (both run in the same process).
const SECRET = process.env.PODKIT_AUTH_SECRET ?? "podkit-dev-secret";

// secure:false because this demo is served over http (no TLS on the local
// cloud); a Secure cookie would never come back. Flip to secure in production.
function sessionCookie(token: string): CookieDirective {
  return { name: "podkit_session", value: token, path: "/", httpOnly: true, secure: false };
}
const clearSession: CookieDirective = {
  name: "podkit_session",
  value: "",
  path: "/",
  maxAge: 0,
  secure: false,
};

interface Note { id: string; body: string }

export async function loader({ auth, url }: LoaderContext) {
  const error = url.searchParams.get("error");
  if (!auth) return { email: null as string | null, notes: [] as Note[], error };
  const { db } = await getDb();
  const rows = await db.select({ email: usersT.email }).from(usersT).where(eq(usersT.id, auth.userId));
  const notes = await db
    .select({ id: notesT.id, body: notesT.body })
    .from(notesT)
    .where(eq(notesT.userId, auth.userId))
    .orderBy(desc(notesT.createdAt));
  return { email: rows[0]?.email ?? null, notes, error };
}

export async function action({ formData, auth }: ActionContext): Promise<ActionResult> {
  const intent = formData.intent;
  const { db } = await getDb();
  const authApi = createAuth({ db, secret: SECRET });

  if (intent === "signup") {
    try {
      const email = (formData.email ?? "").trim().toLowerCase();
      await authApi.signup({ email, password: formData.password ?? "" });
      const { token } = await authApi.login({ email, password: formData.password ?? "" });
      return { redirect: "/", cookies: [sessionCookie(token)] };
    } catch {
      return { redirect: "/?error=" + encodeURIComponent("Could not sign up — that email may already be taken.") };
    }
  }

  if (intent === "login") {
    try {
      const email = (formData.email ?? "").trim().toLowerCase();
      const { token } = await authApi.login({ email, password: formData.password ?? "" });
      return { redirect: "/", cookies: [sessionCookie(token)] };
    } catch {
      return { redirect: "/?error=" + encodeURIComponent("Invalid email or password.") };
    }
  }

  if (intent === "logout") {
    return { redirect: "/", cookies: [clearSession] };
  }

  // Everything below requires a logged-in user, scoped to their own rows.
  if (!auth) return { redirect: "/?error=" + encodeURIComponent("Please log in.") };

  if (intent === "create") {
    const body = (formData.body ?? "").trim();
    if (body) await db.insert(notesT).values({ id: randomUUID(), userId: auth.userId, body });
    return { redirect: "/" };
  }

  if (intent === "delete") {
    await db.delete(notesT).where(and(eq(notesT.id, formData.id), eq(notesT.userId, auth.userId)));
    return { redirect: "/" };
  }

  return { redirect: "/" };
}

export default function Home({ data }: PageProps<LoaderData<typeof loader>>) {
  return (
    <div className="wrap">
      <style>{CSS}</style>
      <header className="top">
        <span className="brand">notes</span>
        {data.email ? (
          <span className="who">
            <span className="email">{data.email}</span>
            <form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value="logout" />
              <button className="link" type="submit">sign out</button>
            </form>
          </span>
        ) : null}
      </header>

      {data.error ? <p className="error">{data.error}</p> : null}

      {data.email ? <NotesView notes={data.notes} /> : <AuthView />}

      <footer className="foot">{`built with podkit · multi-account · managed postgres`}</footer>
    </div>
  );
}

function AuthView() {
  return (
    <div className="card">
      <h1>Your private notes</h1>
      <p className="sub">Create an account, or sign in. Every account only ever sees its own notes.</p>

      <form method="post" className="form">
        <input type="hidden" name="intent" value="login" />
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
        <button className="btn" type="submit">Sign in</button>
      </form>

      <div className="divider"><span>new here?</span></div>

      <form method="post" className="form">
        <input type="hidden" name="intent" value="signup" />
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Password<input name="password" type="password" required minLength={8} autoComplete="new-password" /></label>
        <button className="btn ghost" type="submit">Create account</button>
      </form>
    </div>
  );
}

function NotesView({ notes }: { notes: Note[] }) {
  return (
    <div className="card">
      <form method="post" className="compose">
        <input type="hidden" name="intent" value="create" />
        <input className="compose-input" name="body" placeholder="Write a note…" autoComplete="off" required />
        <button className="btn" type="submit">Add</button>
      </form>

      {notes.length === 0 ? (
        <p className="empty">No notes yet. Add your first one above.</p>
      ) : (
        <ul className="notes">
          {notes.map((n) => (
            <li className="note" key={n.id}>
              <span className="note-body">{n.body}</span>
              <form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={n.id} />
                <button className="x" type="submit" aria-label="delete">×</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #0b0b0c;
  color: #e8e8ea;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 560px; margin: 0 auto; padding: 48px 20px 80px; }
.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
.brand { font-weight: 650; letter-spacing: -0.02em; font-size: 18px; }
.who { display: inline-flex; align-items: center; gap: 12px; font-size: 13px; color: #a1a1aa; }
.email { color: #d4d4d8; }
.link { background: none; border: 0; color: #a1a1aa; cursor: pointer; font: inherit; padding: 0; text-decoration: underline; text-underline-offset: 3px; }
.link:hover { color: #e8e8ea; }
.card {
  background: #141416;
  border: 1px solid #232327;
  border-radius: 14px;
  padding: 28px;
}
h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 6px; }
.sub { color: #a1a1aa; font-size: 14px; margin: 0 0 22px; line-height: 1.5; }
.form { display: grid; gap: 12px; }
label { display: grid; gap: 6px; font-size: 13px; color: #a1a1aa; }
input {
  width: 100%; padding: 10px 12px; border-radius: 9px;
  border: 1px solid #2b2b30; background: #0e0e10; color: #e8e8ea;
  font: inherit; outline: none;
}
input:focus { border-color: #52525b; }
.btn {
  margin-top: 4px; padding: 10px 14px; border-radius: 9px; border: 1px solid transparent;
  background: #e8e8ea; color: #0b0b0c; font: inherit; font-weight: 600; cursor: pointer;
}
.btn:hover { background: #fff; }
.btn.ghost { background: transparent; border-color: #2b2b30; color: #e8e8ea; }
.btn.ghost:hover { border-color: #52525b; }
.divider { display: flex; align-items: center; gap: 12px; margin: 24px 0; color: #6b6b73; font-size: 12px; }
.divider::before, .divider::after { content: ""; height: 1px; background: #232327; flex: 1; }
.compose { display: flex; gap: 10px; margin-bottom: 18px; }
.compose-input { flex: 1; }
.notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.note {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border: 1px solid #232327; border-radius: 10px; background: #0e0e10;
}
.note-body { font-size: 14px; line-height: 1.4; word-break: break-word; }
.x { background: none; border: 0; color: #6b6b73; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }
.x:hover { color: #f87171; }
.empty { color: #6b6b73; font-size: 14px; text-align: center; padding: 18px 0; }
.error {
  background: #2a1416; border: 1px solid #5a2327; color: #fca5a5;
  padding: 10px 14px; border-radius: 9px; font-size: 13px; margin: 0 0 18px;
}
.foot { color: #6b6b73; font-size: 12px; text-align: center; margin-top: 22px; }
`;
