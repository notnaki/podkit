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
