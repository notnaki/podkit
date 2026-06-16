import { useEffect, useState } from "react";
import { api, getToken, type TableInfo, type TableRows } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

const PAGE = 50;

// Browse + edit rows in the project's managed Postgres — the no-SQL path. Reads
// the table list (with columns + pk) once, then paginates rows for the selected
// table and inserts/updates/deletes through the scoped, ownership-gated endpoints.
export function DataEditor({ slug }: { slug: string }) {
  const tables = useApi<{ tables: TableInfo[] }>(() => api.getTables(slug), [slug]);
  const list = tables.data?.tables ?? [];
  const hasKey = getToken() !== "";

  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<TableRows | null>(null);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);

  // Editing form: add a new row, or edit an existing one (pk captured for the update).
  const [editing, setEditing] = useState<
    | { mode: "add" | "edit"; values: Record<string, string>; original: Record<string, unknown>; pk: Record<string, unknown> | null }
    | null
  >(null);
  const [mutErr, setMutErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<Record<string, unknown> | null>(null);

  // Default to the first table once the list loads.
  useEffect(() => {
    if (selected === null && list.length > 0) setSelected(list[0].name);
  }, [list, selected]);

  const table = list.find((t) => t.name === selected) ?? null;
  const cols = table?.columns ?? [];
  const pkCols = cols.filter((c) => c.isPk).map((c) => c.name);
  const canEdit = pkCols.length > 0;

  async function loadRows(name: string, off: number) {
    setLoadingRows(true);
    setRowsErr(null);
    const res = await api.getTableRows(slug, name, { limit: PAGE, offset: off });
    setLoadingRows(false);
    if (res.ok) setRows(res.data);
    else { setRows(null); setRowsErr(res.error.code + ": " + res.error.message); }
  }

  useEffect(() => {
    if (selected) { setOffset(0); loadRows(selected, 0); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  function pick(name: string) { setEditing(null); setConfirmDel(null); setSelected(name); }
  function page(next: number) { if (selected) { setOffset(next); loadRows(selected, next); } }

  function startAdd() {
    setMutErr(null);
    setEditing({ mode: "add", values: {}, original: {}, pk: null });
  }
  function startEdit(row: Record<string, unknown>) {
    setMutErr(null);
    const values: Record<string, string> = {};
    for (const c of cols) values[c.name] = row[c.name] === null || row[c.name] === undefined ? "" : String(row[c.name]);
    const pk: Record<string, unknown> = {};
    for (const k of pkCols) pk[k] = row[k];
    setEditing({ mode: "edit", values, original: row, pk });
  }

  async function save() {
    if (!editing || !selected) return;
    setMutErr(null);
    let res;
    if (editing.mode === "add") {
      const values: Record<string, unknown> = {};
      for (const c of cols) {
        const v = editing.values[c.name];
        if (v !== undefined && v !== "") values[c.name] = v; // empty -> use default/null
      }
      res = await api.insertRow(slug, selected, values);
    } else {
      const values: Record<string, unknown> = {};
      for (const c of cols) {
        if (c.isPk) continue;
        const v = editing.values[c.name] ?? "";
        const was = editing.original[c.name];
        const wasStr = was === null || was === undefined ? "" : String(was);
        if (v !== wasStr) values[c.name] = v === "" && c.nullable ? null : v;
      }
      if (Object.keys(values).length === 0) { setEditing(null); return; }
      res = await api.updateRow(slug, selected, editing.pk ?? {}, values);
    }
    if (res.ok) { setEditing(null); loadRows(selected, offset); tables.reload(); }
    else setMutErr(res.error.code + ": " + res.error.message);
  }

  async function del(pkVals: Record<string, unknown>) {
    if (!selected) return;
    setMutErr(null);
    const res = await api.deleteRow(slug, selected, pkVals);
    setConfirmDel(null);
    if (res.ok) loadRows(selected, offset);
    else setMutErr(res.error.code + ": " + res.error.message);
  }

  const total = rows?.total ?? 0;
  const shown = rows?.rows ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Tables</h3>
        {table && <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>{total} row{total === 1 ? "" : "s"}</span>}
      </div>

      {!hasKey ? (
        <div className="panel-body"><span className="status status-building"><span className="dot" />sign in to browse data</span></div>
      ) : tables.loading ? (
        <div className="panel-body"><span className="muted">Loading tables…</span></div>
      ) : list.length === 0 ? (
        <div className="state"><strong>No tables yet</strong><span>Your app creates tables on first run (or via a migration). They&apos;ll show up here.</span></div>
      ) : (
        <>
          <div className="panel-body" style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {list.map((t) => (
              <button
                key={t.name}
                className={"btn" + (t.name === selected ? " btn-invert" : "")}
                onClick={() => pick(t.name)}
              >
                {t.name}
              </button>
            ))}
          </div>

          {table && (
            <>
              <div className="panel-body" style={{ borderTop: "1px solid var(--border)", display: "flex", gap: "8px", alignItems: "center" }}>
                <button className="btn btn-invert" onClick={startAdd}>+ Add row</button>
                {!canEdit && <span className="faint" style={{ fontSize: "var(--t-sm)" }}>no primary key — rows are read-only</span>}
                <span style={{ flex: 1 }} />
                <button className="btn" disabled={offset === 0} onClick={() => page(Math.max(0, offset - PAGE))}>Prev</button>
                <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>{total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE, total)}`} / {total}</span>
                <button className="btn" disabled={offset + PAGE >= total} onClick={() => page(offset + PAGE)}>Next</button>
              </div>

              {mutErr && <div className="panel-body"><span className="status status-error"><span className="dot" />{mutErr}</span></div>}

              {editing && (
                <div className="panel-body stack" style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2, transparent)" }}>
                  <strong style={{ fontSize: "var(--t-sm)" }}>{editing.mode === "add" ? "New row" : "Edit row"}</strong>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "10px" }}>
                    {cols.map((c) => {
                      const isPkEdit = editing.mode === "edit" && c.isPk;
                      return (
                        <div className="field" key={c.name}>
                          <label>
                            {c.name} <span className="faint">{c.dataType}{c.isPk ? " · pk" : c.nullable ? "" : " · required"}</span>
                          </label>
                          <input
                            className="input mono"
                            value={editing.values[c.name] ?? ""}
                            disabled={isPkEdit}
                            placeholder={editing.mode === "add" && (c.isPk || c.nullable) ? "(default)" : ""}
                            onChange={(e) => setEditing({ ...editing, values: { ...editing.values, [c.name]: e.target.value } })}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="row">
                    <button className="btn btn-invert" onClick={save}>Save</button>
                    <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              )}

              <div className="panel-body flush" style={{ padding: 0, borderTop: "1px solid var(--border)" }}>
                {loadingRows ? (
                  <div className="panel-body"><span className="muted">Loading…</span></div>
                ) : rowsErr ? (
                  <div className="panel-body"><span className="status status-error"><span className="dot" />{rowsErr}</span></div>
                ) : shown.length === 0 ? (
                  <div className="state"><strong>No rows</strong><span>This table is empty.</span></div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        {cols.map((c) => <th key={c.name} className="mono">{c.name}</th>)}
                        {canEdit && <th style={{ width: 1 }} />}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r, i) => {
                        const pkVals: Record<string, unknown> = {};
                        for (const k of pkCols) pkVals[k] = r[k];
                        const isConfirming = confirmDel !== null && pkCols.every((k) => confirmDel[k] === r[k]);
                        return (
                          <tr key={i}>
                            {cols.map((c) => {
                              const v = r[c.name];
                              const display = v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
                              return (
                                <td
                                  key={c.name}
                                  className="mono"
                                  title={display}
                                  style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                >
                                  {display}
                                </td>
                              );
                            })}
                            {canEdit && (
                              <td style={{ whiteSpace: "nowrap" }}>
                                {isConfirming ? (
                                  <>
                                    <button className="btn btn-danger" onClick={() => del(pkVals)}>Confirm</button>{" "}
                                    <button className="btn" onClick={() => setConfirmDel(null)}>Cancel</button>
                                  </>
                                ) : (
                                  <>
                                    <button className="btn" onClick={() => startEdit(r)}>Edit</button>{" "}
                                    <button className="btn" onClick={() => setConfirmDel(pkVals)}>Delete</button>
                                  </>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
