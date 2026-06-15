// Demonstrates the `action` mutation primitive: a POST form whose handler runs
// on the server, sets a cookie, and redirects (Post/Redirect/Get). GET renders
// the form and echoes back what the loader reads from the query string.
import type { ActionContext, LoaderContext, PageProps, LoaderData } from "@podkit/framework";

export function action({ formData }: ActionContext) {
  const message = formData.message ?? "";
  return {
    redirect: "/echo?said=" + encodeURIComponent(message),
    cookies: [{ name: "podkit_echo", value: message, path: "/" }],
  };
}

export function loader({ url }: LoaderContext) {
  return { said: url.searchParams.get("said") };
}

export default function Echo({ data }: PageProps<LoaderData<typeof loader>>) {
  return (
    <main>
      <h1>echo</h1>
      <p>{`said: ${String(data.said)}`}</p>
      <form method="post" action="/echo">
        <input name="message" />
        <button type="submit">send</button>
      </form>
    </main>
  );
}
