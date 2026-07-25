import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.js";
import DatasetRail from "./components/DatasetRail.jsx";
import GroupList from "./components/GroupList.jsx";
import RunLedger from "./components/RunLedger.jsx";
import ScanFooter from "./components/ScanFooter.jsx";

export default function App() {
  const [datasets, setDatasets] = useState([]);
  const [selectedName, setSelectedName] = useState(null);
  const [dataset, setDataset] = useState(null);
  const [groups, setGroups] = useState([]);
  const [runs, setRuns] = useState([]);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const selectedNameRef = useRef(selectedName);
  useEffect(() => {
    selectedNameRef.current = selectedName;
  }, [selectedName]);

  const refreshDatasets = useCallback(async () => {
    try {
      const list = await api.listDatasets();
      setDatasets(list);
      return list;
    } catch (err) {
      setError(err.message);
      return [];
    }
  }, []);

  const loadDatasetDetail = useCallback(async (name) => {
    try {
      const [detail, groupList, runList] = await Promise.all([
        api.getDataset(name),
        api.getGroups(name),
        api.getRuns(name),
      ]);
      if (selectedNameRef.current === name) {
        setDataset(detail);
        setGroups(groupList);
        setRuns(runList);
      }
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // initial load
  useEffect(() => {
    refreshDatasets().then((list) => {
      if (list.length > 0) {
        setSelectedName(list[0].name);
      }
    });
  }, [refreshDatasets]);

  // load detail whenever selection changes
  useEffect(() => {
    if (selectedName) {
      loadDatasetDetail(selectedName);
    } else {
      setDataset(null);
      setGroups([]);
      setRuns([]);
    }
  }, [selectedName, loadDatasetDetail]);

  const attachJob = useCallback(
    (datasetName, jobId, initialStatus) => {
      setJob({ jobId, datasetName, status: initialStatus });

      const handleUpdate = (status) => {
        setJob((prev) => (prev && prev.jobId === jobId ? { ...prev, status } : prev));
        if (status.state === "completed" || status.state === "stopped") {
          unsubscribe();
          setJob((prev) => (prev && prev.jobId === jobId ? null : prev));
          refreshDatasets();
          if (selectedNameRef.current === datasetName) {
            loadDatasetDetail(datasetName);
          }
          if (status.warned > 0) {
            setNotice(
              `Scan ${status.state}: ${status.warned} file(s) were indexed but couldn't be perceptually hashed ` +
                `(likely corrupted) - still checked for exact duplicates, just not near-duplicates.`
            );
          }
        }
      };

      const unsubscribe = api.subscribeToScan(jobId, {
        onStatus: handleUpdate,
        onProgress: handleUpdate,
        onError: () => {
          // Connection dropped (e.g. server restarted mid-scan). Progress already
          // committed to SQLite isn't lost - surface this so the user knows to check.
          setError("Lost connection to the scan progress stream.");
        },
      });
    },
    [refreshDatasets, loadDatasetDetail]
  );

  async function handleScan(name, rootPath) {
    setError(null);
    try {
      const result = await api.startScan(name, rootPath ? { rootPath } : {});
      await refreshDatasets();
      setSelectedName(name);
      attachJob(name, result.jobId, {
        state: "running",
        processed: 0,
        total: result.total,
        hashed: 0,
        unchanged: 0,
        failed: 0,
        warned: 0,
      });
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePause() {
    if (job) await api.pauseScan(job.jobId);
  }
  async function handleResume() {
    if (job) await api.resumeScan(job.jobId);
  }
  async function handleStop() {
    if (job) await api.stopScan(job.jobId);
  }

  async function handleArchive(photoIds, dryRun) {
    if (!selectedName || photoIds.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.prune(selectedName, { dryRun, photoIds });
      if (dryRun) {
        setNotice(`Dry run: would archive ${result.moved.length} file(s).`);
      } else {
        // Refresh before showing the notice, so "Archived" never appears
        // while the group list still shows the stale, pre-archive state.
        await Promise.all([refreshDatasets(), loadDatasetDetail(selectedName)]);
        setNotice(`Archived ${result.moved.length} file(s)${result.runId ? ` as run #${result.runId}` : ""}.`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(runId) {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.rollback(selectedName, { runId });
      // Refresh before showing the notice, for the same reason as handleArchive.
      await Promise.all([refreshDatasets(), loadDatasetDetail(selectedName)]);
      setNotice(`Restored ${result.restored.length} file(s) from run #${result.runId}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="brand">
          <div className="brand-mark">
            LIGHT<span>TABLE</span>
          </div>
          <div className="brand-sub">local photo duplicate review</div>
        </div>
      </div>

      {(error || notice) && (
        <div className={`banner${error ? " banner-error" : ""}`}>
          <span>{error || notice}</span>
          <button type="button" className="banner-dismiss" onClick={() => (error ? setError(null) : setNotice(null))}>
            ×
          </button>
        </div>
      )}

      <div className="app">
        <DatasetRail
          datasets={datasets}
          selectedName={selectedName}
          onSelect={setSelectedName}
          onScan={handleScan}
          scanBusy={Boolean(job)}
        />
        <GroupList dataset={dataset} groups={groups} onArchive={handleArchive} busy={busy} />
        <RunLedger runs={runs} onRollback={handleRollback} busy={busy} />
      </div>

      <ScanFooter job={job} onPause={handlePause} onResume={handleResume} onStop={handleStop} />
    </>
  );
}
