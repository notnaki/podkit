import type { CookieDirective } from "./request/cookie.ts";

export type RouteKind = "static" | "dynamic" | "catchall";

export interface Route {
  pattern: string;
  kind: RouteKind;
  file: string;
  params: string[];
}

export interface LoaderContext {
  params: Record<string, string>;
  url: URL;
  auth?: { userId: string; isAgent: boolean } | null;
}

// A route may export `action(ctx)` to handle non-GET requests (form POSTs).
// It receives the same identity/params as a loader, plus the HTTP method and the
// parsed `application/x-www-form-urlencoded` body, and returns a directive the
// server turns into a 303 redirect (Post/Redirect/Get) with optional cookies.
export interface ActionContext {
  params: Record<string, string>;
  url: URL;
  auth?: { userId: string; isAgent: boolean } | null;
  method: string;
  formData: Record<string, string>;
}

export interface ActionResult {
  redirect: string;
  cookies?: CookieDirective[];
}

// A route's default export is server-rendered and receives its loader's return
// value as the `data` prop. `PageProps<T>` types that prop; `LoaderData<L>`
// infers `T` from a `loader` so a component and its loader can never drift:
//
//   export async function loader(ctx: LoaderContext) {
//     return { slug: ctx.params.slug };
//   }
//   export default function Post({ data }: PageProps<LoaderData<typeof loader>>) {
//     return <h1>{data.slug}</h1>; // data is fully typed
//   }
//
// Both are pure types (erasable): they emit no runtime code.
export interface PageProps<T> {
  data: T;
}

// Resolves a loader's (sync or async) return type. A route with no loader
// receives `{}` at runtime (see runLoader), which `Record<string, never>` models.
export type LoaderData<L> = L extends (...args: never[]) => infer R
  ? Awaited<R>
  : Record<string, never>;
