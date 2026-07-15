import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useHive } from "../store";
import { pruneTelemetry, saveOverride } from "../store/wiring";
import { confirmAction, deleteProject } from "../store/raw";
import { deleteProjectSourceLogsRemote, fetchStorage, type StorageBreakdown } from "../api";
import { fmtBytes, fmtNum } from "../lib/format";

// One labelled metric tile in the storage summary. `accent` gives the prune-
// preview tile a subtly tinted card so it reads as the actionable figure.
function StorageTile(props: { label: string; value: string; valueClass?: string; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className={`storage-tile${props.accent ? " accent" : ""}`}>
      <div className="storage-tile-label">{props.label}</div>
      <div className={`storage-tile-value${props.valueClass ? ` ${props.valueClass}` : ""}`}>{props.value}</div>
      {props.hint && <div className="storage-tile-hint">{props.hint}</div>}
    </div>
  );
}

// Settings: rename projects (persisted by canonical project ID).
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
  const [pruneDays, setPruneDays] = useState<string>("30");
  const [pruning, setPruning] = useState(false);
  const [storage, setStorage] = useState<StorageBreakdown | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState(false);

  // Fetch storage usage + prune preview whenever the scope or the days input
  // settles. Debounced so typing in the days field doesn't spam the endpoint.
  useEffect(() => {
    const days = Number(pruneDays.trim());
    const validDays = Number.isFinite(days) && days >= 0 ? days : undefined;
    let cancelled = false;
    setStorageLoading(true);
    const t = setTimeout(async () => {
      const res = await fetchStorage(scopedProject, validDays);
      if (!cancelled) { setStorage(res); setStorageError(!res); setStorageLoading(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [scopedProject, pruneDays]);

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
        derived: g.derivedLabel,
        label: g.label,
        projectId: g.name,
        cwds: g.cwds,
        sessions: g.sessions.length,
        overridden: overrides.has(g.name),
      })),
    [projectGroups, overrides, scopedProject],
  );

  async function save(projectId: string, key: string, label: string) {
    if (!projectId) return;
    setBusy(key);
    await saveOverride(projectId, label);
    setBusy("");
  }

  function requestDelete(project: string, label: string, sessions: number) {
    confirmAction({
      title: "Delete project telemetry?",
      message: <>This permanently removes all telemetry for <b>{label}</b> — {sessions} session{sessions === 1 ? "" : "s"} plus their events, delegations, tool calls, and messages. Project files on disk are not touched.</>,
      confirmLabel: "Delete telemetry",
      danger: true,
      onConfirm: () => deleteProject(project),
    });
  }

  function requestDeleteSourceLogs(projectId: string, label: string) {
    confirmAction({
      title: "Delete project source logs?",
      message: <>This permanently deletes the on-disk JSONL telemetry logs and rotated archives for <b>{label}</b>. This is separate from dashboard database cleanup and cannot be undone. Export any session log first from its download URL if you need a backup.</>,
      confirmLabel: "Delete source logs",
      danger: true,
      onConfirm: async () => { await deleteProjectSourceLogsRemote(projectId); await refreshStorage(); },
    });
  }

  function requestPrune() {
    const days = Number(pruneDays.trim());
    if (!Number.isFinite(days) || days < 0) return;
    confirmAction({
      title: "Prune telemetry history?",
      message: <>This permanently deletes all telemetry older than <b>{days} day{days === 1 ? "" : "s"}</b> across every project — events, delegations, tool calls, and any session whose entire history predates the cutoff. Project logs on disk are not touched.</>,
      confirmLabel: "Prune history",
      danger: true,
      onConfirm: async () => {
        setPruning(true);
        try { await pruneTelemetry(days); await refreshStorage(); } finally { setPruning(false); }
      },
    });
  }

  async function refreshStorage() {
    const days = Number(pruneDays.trim());
    const validDays = Number.isFinite(days) && days >= 0 ? days : undefined;
    setStorageLoading(true);
    const next = await fetchStorage(scopedProject, validDays);
    setStorage(next);
    setStorageError(!next);
    setStorageLoading(false);
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
                    <div className="setting-path" title={r.cwds[0]}>{r.cwds[0] || "—"}{r.cwds.length > 1 ? ` (+${r.cwds.length - 1} more)` : ""} · {r.sessions} session{r.sessions === 1 ? "" : "s"}</div>
                  </div>
                  <input
                    className="setting-input"
                    value={value}
                    placeholder={r.derived}
                    aria-label={`Dashboard name for ${r.derived}`}
                    onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter" && dirty) void save(r.projectId, r.key, value); }}
                  />
                  <div className="setting-actions">
                    <button type="button" className="btn sm primary" disabled={!dirty || busy === r.key} onClick={() => { void save(r.projectId, r.key, value); }}>
                      {busy === r.key ? "Saving…" : "Save"}
                    </button>
                    {r.overridden && (
                      <button type="button" className="btn sm" disabled={busy === r.key} onClick={() => { setDraft((d) => ({ ...d, [r.key]: r.derived })); void save(r.projectId, r.key, ""); }}>Reset</button>
                    )}
                    <button type="button" className="btn sm danger" disabled={busy === r.key} onClick={() => requestDelete(r.projectId, r.label, r.sessions)}>Delete DB…</button>
                    <button type="button" className="btn sm danger" disabled={busy === r.key} onClick={() => requestDeleteSourceLogs(r.projectId, r.label)}>Delete logs…</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="tab-card settings-card">
        <div className="settings-head">
          <div>
            <h2 className="settings-title">Storage &amp; prune</h2>
            <p className="settings-sub">Dashboard database and project source logs are reported separately. Pruning removes old database rows only; it never deletes the JSONL logs under each project. Source-log deletion is a separate guarded action above.</p>
          </div>
        </div>

        <div className="storage-panel">
          <div className="storage-scope">{scopedProject ? "This project" : "All telemetry"}</div>
          {storageLoading && !storage ? (
            <div className="storage-muted">Measuring…</div>
          ) : storage ? (
            <div className="storage-tiles">
              <StorageTile label="DB content" value={fmtBytes(storage.database?.logicalBytes ?? storage.bytes)} hint={`${fmtBytes(storage.database?.fileBytes ?? 0)} on disk`} />
              <StorageTile label="Source logs" value={fmtBytes(storage.sourceLogs?.bytes ?? 0)} hint={`${storage.sourceLogs?.files ?? 0} file${storage.sourceLogs?.files === 1 ? "" : "s"}`} />
              <StorageTile label="Events" value={fmtNum(storage.events)} />
              <StorageTile label="Sessions" value={String(storage.sessions)} />
              {storage.prune && (
                storage.prune.removeEvents > 0 ? (
                  <StorageTile
                    accent
                    label={`Prune ≥ ${pruneDays.trim() || "0"}d frees`}
                    value={fmtBytes(storage.prune.removeBytes)}
                    valueClass="text-crit"
                    hint={<>{storage.prune.removeSessions > 0 && `${storage.prune.removeSessions} session${storage.prune.removeSessions === 1 ? "" : "s"} · `}{fmtBytes(storage.prune.keepBytes)} would remain</>}
                  />
                ) : (
                  <StorageTile accent label={`Prune ≥ ${pruneDays.trim() || "0"}d frees`} value="0 B" hint={`nothing older${scopedProject ? " here" : ""}`} />
                )
              )}
            </div>
          ) : (
            <div className="storage-muted" role={storageError ? "alert" : undefined}>Unavailable — is the dashboard daemon running? <button type="button" className="btn pill" disabled={storageLoading} onClick={() => void refreshStorage()}>Retry</button></div>
          )}
        </div>

        <div className="prune-row">
          <div className="prune-copy">
            <div className="prune-copy-title">Retain the last</div>
            <div className="prune-copy-sub">Older events are removed and sessions entirely older than this are dropped. Prune runs across <b>all</b> projects, not just this one.</div>
          </div>
          <div className="prune-control">
            <input
              className="prune-input"
              type="number"
              min={0}
              value={pruneDays}
              onChange={(e) => setPruneDays(e.target.value)}
              aria-label="Days of telemetry to retain"
            />
            <span className="prune-unit">day{pruneDays.trim() === "1" ? "" : "s"}</span>
            <button type="button" className="btn sm danger" disabled={pruning || !(Number(pruneDays) >= 0)} onClick={requestPrune}>
              {pruning ? "Pruning…" : "Prune…"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
