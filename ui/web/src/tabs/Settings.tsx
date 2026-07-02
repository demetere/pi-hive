import { useEffect, useMemo, useState } from "react";
import { useHive } from "../store";
import { saveOverride } from "../store/wiring";

// Settings: rename projects (persisted in the telemetry DB, keyed by cwd).
// Future settings can be added as additional sections below.
export default function Settings() {
  const projectGroups = useHive((s) => s.projectGroups);
  const overrides = useHive((s) => s.projectOverrides);
  const scope = useHive((s) => s.scope);

  // Settings is scoped to the selected project.
  const scopedProject = scope.level !== "fleet" ? scope.project : undefined;

  // Local edit buffer per group key so typing doesn't fight the store.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>("");

  // Seed the draft from current labels when the group set changes.
  useEffect(() => {
    setDraft((prev) => {
      const next = { ...prev };
      for (const g of projectGroups) if (next[g.name] === undefined) next[g.name] = g.label;
      return next;
    });
  }, [projectGroups]);

  const rows = useMemo(
    () => projectGroups
      .filter((g) => !scopedProject || g.name === scopedProject)
      .map((g) => ({
        key: g.name,
        derived: g.name,
        label: g.label,
        cwd: g.cwds[0] || "",
        cwds: g.cwds,
        sessions: g.sessions.length,
        overridden: g.cwds.some((c) => overrides.has(c)),
      })),
    [projectGroups, overrides, scopedProject],
  );

  async function save(cwd: string, key: string, label: string) {
    if (!cwd) return;
    setBusy(key);
    await saveOverride(cwd, label);
    setBusy("");
  }

  return (
    <div className="settings">
      <section className="tab-card settings-card">
        <div className="settings-head">
          <div>
            <h2 className="settings-title">Projects</h2>
            <p className="settings-sub">Rename how a project appears across the dashboard. The change is saved locally and applies to every session from that working directory.</p>
          </div>
        </div>

        {!rows.length ? <div className="empty">No projects yet.</div> : (
          <div className="settings-list">
            {rows.map((r) => {
              const value = draft[r.key] ?? r.label;
              const dirty = value.trim() !== r.label && value.trim() !== "";
              return (
                <div className="setting-row" key={r.key}>
                  <div className="setting-meta">
                    <div className="setting-name">
                      {r.derived}
                      {r.overridden && <span className="setting-badge">renamed</span>}
                    </div>
                    <div className="setting-path" title={r.cwd}>{r.cwd || "—"}{r.cwds.length > 1 ? ` (+${r.cwds.length - 1} more)` : ""} · {r.sessions} session{r.sessions === 1 ? "" : "s"}</div>
                  </div>
                  <input
                    className="setting-input"
                    value={value}
                    placeholder={r.derived}
                    onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter" && dirty) save(r.cwd, r.key, value); }}
                  />
                  <div className="setting-actions">
                    <button className="btn sm primary" disabled={!dirty || busy === r.key} onClick={() => save(r.cwd, r.key, value)}>
                      {busy === r.key ? "Saving…" : "Save"}
                    </button>
                    {r.overridden && (
                      <button className="btn sm" disabled={busy === r.key} onClick={() => { setDraft((d) => ({ ...d, [r.key]: r.derived })); save(r.cwd, r.key, ""); }}>Reset</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
