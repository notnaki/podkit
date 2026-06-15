import { describe, it, expect } from "vitest";
import type { PageProps, LoaderData, LoaderContext } from "../src/types.ts";

// These tests are about the *types* — they pass at runtime trivially, but the
// type annotations only compile (via `pnpm typecheck`) if PageProps/LoaderData
// behave as documented. A regression in the types breaks the typecheck, not this
// assertion.

describe("PageProps / LoaderData", () => {
  it("LoaderData infers an async loader's resolved return type", () => {
    async function loader(ctx: LoaderContext) {
      return { slug: ctx.params.slug, n: 1 };
    }
    type Data = LoaderData<typeof loader>;
    const props: PageProps<Data> = { data: { slug: "x", n: 1 } };
    // Field access is type-checked: `slug` is string, `n` is number.
    expect(props.data.slug).toBe("x");
    expect(props.data.n).toBe(1);
  });

  it("LoaderData infers a sync loader's return type", () => {
    function loader() {
      return { ok: true };
    }
    const props: PageProps<LoaderData<typeof loader>> = { data: { ok: true } };
    expect(props.data.ok).toBe(true);
  });

  it("LoaderData resolves to an empty record when there is no loader", () => {
    // A route without a loader receives `{}` at runtime (runLoader returns {}).
    const props: PageProps<LoaderData<undefined>> = { data: {} };
    expect(props.data).toEqual({});
  });
});
