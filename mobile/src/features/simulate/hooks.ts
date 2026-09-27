import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, twinApi } from '../../api';
import type {
  DecisionContext,
  ScenarioSimulateResponse,
  SimulationRunSummary,
} from '../../api/types';
import { AGENTS } from './constants';

/**
 * One Simulate session.
 *
 * The screen sends a sentence and renders the reply. Every figure, every
 * projection and both pieces of generated prose come from
 * POST /twin/simulate-scenario — the same endpoint, the same deterministic
 * calculators and the same grounding the website uses. Nothing here computes
 * anything about money.
 */

export type StageState = 'queued' | 'running' | 'done' | 'skipped';

/** Keyed by the agent name the backend sends in `stages[].agent`. */
export type PipelineState = Record<string, StageState>;

function allQueued(): PipelineState {
  return Object.fromEntries(AGENTS.map((a) => [a.agent, 'queued' as StageState]));
}

/**
 * The finished state of a pipeline: whatever the backend reported having run is
 * Done, everything else Skipped.
 *
 * Used when a *stored* run is reopened. The staged reveal below would be a lie
 * there — nothing is executing, and the trace was recorded minutes or weeks ago
 * — so a reopened run shows its outcome at once.
 */
function pipelineFromStages(stages: { agent: string }[] | undefined): PipelineState {
  const next = allQueued();
  for (const key of Object.keys(next)) next[key] = 'skipped';
  for (const s of stages ?? []) next[s.agent] = 'done';
  return next;
}

/**
 * How long each stage is held before the next lights up.
 *
 * The web spaces the reveal by `220 + Math.random() * 140` ms. This is not a
 * loading spinner pretending to be work: the request has already returned by
 * the time any of this runs, and the rows are replaying the *real* stage trace
 * the backend sent, in the order it ran them. The pacing exists so the trace is
 * readable rather than appearing all at once.
 */
const STAGE_REVEAL_MS = () => 220 + Math.random() * 140;

/** A row in the history list. The server's shape, unchanged. */
export type HistoryEntry = SimulationRunSummary;

export function useSimulation() {
  const [result, setResult] = useState<ScenarioSimulateResponse | null>(null);
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Past runs, from the server.
   *
   * This used to be an in-memory array that a reload cleared, on the reasoning
   * that the backend did not persist simulations. It does now
   * (`simulation_runs`), so history survives a restart, a reinstall and a move
   * to the website — the same account sees the same runs everywhere, exactly as
   * chat sessions already behaved.
   */
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  /** Which stored run is on screen, so the list can mark it. Null while showing
   *  a run that just finished but failed to save, or nothing at all. */
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  /** Set while a stored run is being fetched, so its row can show progress. */
  const [openingId, setOpeningId] = useState<string | null>(null);

  /** Guards the staged reveal against a screen that unmounted mid-animation. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Load (or reload) the history list. Safe to call on every focus. */
  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const runs = await twinApi.listSimulations();
      if (!mounted.current) return;
      setHistory(runs);
    } catch (err) {
      if (!mounted.current) return;
      // A history that will not load must not look like a history that is
      // empty — the difference matters when someone is hunting for a past
      // decision they know they ran.
      setHistoryError(
        err instanceof ApiError ? err.detail : "Couldn't load your past simulations.",
      );
    } finally {
      if (mounted.current) setHistoryLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setPipeline(null);
    setError(null);
    setOpenRunId(null);
  }, []);

  const run = useCallback(async (
    scenario: string,
    /* The chat hand-off. Forwarded untouched to POST /twin/simulate-scenario,
       where it replaces the sentence-parsing step — so a decision worked out
       in conversation keeps its amount, purpose, horizon and stated risk
       constraints instead of being re-derived from one line of text. */
    decisionContext?: DecisionContext | null,
  ) => {
    const text = scenario.trim();
    if (!text) return;

    setRunning(true);
    setError(null);
    setResult(null);
    setOpenRunId(null);
    setPipeline(allQueued());

    let res: ScenarioSimulateResponse;
    try {
      res = await twinApi.simulateScenario(text, decisionContext ?? null);
    } catch (err) {
      if (!mounted.current) return;
      setError(
        err instanceof ApiError
          ? err.detail
          : "Couldn't run that simulation — please try again.",
      );
      setPipeline(null);
      setRunning(false);
      return;
    }
    if (!mounted.current) return;

    // Walk the stages the backend actually reported.
    for (const stage of res.stages ?? []) {
      if (!mounted.current) return;
      setPipeline((prev) => ({ ...(prev ?? allQueued()), [stage.agent]: 'running' }));
      await new Promise((r) => setTimeout(r, STAGE_REVEAL_MS()));
      if (!mounted.current) return;
      setPipeline((prev) => ({ ...(prev ?? allQueued()), [stage.agent]: 'done' }));
    }

    if (!mounted.current) return;

    // An informational answer runs only a subset of the pipeline — there is no
    // hypothetical to project — so the rest are marked Skipped. Leaving them on
    // "Queued" would read as a stalled run rather than a shorter one.
    setPipeline((prev) => {
      const next = { ...(prev ?? allQueued()) };
      for (const key of Object.keys(next)) {
        if (next[key] !== 'done') next[key] = 'skipped';
      }
      return next;
    });

    setResult(res);

    /* The backend stored the run and sent its id back, so the row goes in from
       what we already have rather than costing a second round trip. An empty id
       means the write failed: the simulation is still valid and still shown, it
       just is not in the list, and the next refresh will agree with that. */
    const runId = res.run_id;
    if (runId) {
      setOpenRunId(runId);
      setHistory((prev) => [
        {
          id: runId,
          scenario: text,
          scenario_type: res.scenario_type,
          mode: res.mode,
          headline: (res.recommendation || '').split(/\s+/).join(' ').slice(0, 160),
          created_at: new Date().toISOString(),
        },
        ...prev.filter((h) => h.id !== runId),
      ]);
    }

    setRunning(false);
  }, []);

  /**
   * Reopen a stored run.
   *
   * What comes back is the response the pipeline produced at the time, not a
   * re-simulation — so the numbers are the ones the decision was made on.
   */
  const openRun = useCallback(async (runId: string) => {
    setOpeningId(runId);
    setError(null);
    try {
      const detail = await twinApi.getSimulation(runId);
      if (!mounted.current) return null;
      setResult(detail.result);
      setPipeline(pipelineFromStages(detail.result.stages));
      setOpenRunId(detail.id);
      return detail;
    } catch (err) {
      if (!mounted.current) return null;
      setError(err instanceof ApiError ? err.detail : "Couldn't open that simulation.");
      return null;
    } finally {
      if (mounted.current) setOpeningId(null);
    }
  }, []);

  /** Remove a stored run. The row goes at once and is put back if the server
   *  refuses, so a failed delete never silently loses someone's record. */
  const removeRun = useCallback(async (runId: string) => {
    let snapshot: HistoryEntry[] = [];
    setHistory((prev) => {
      snapshot = prev;
      return prev.filter((h) => h.id !== runId);
    });
    if (openRunId === runId) {
      setResult(null);
      setPipeline(null);
      setOpenRunId(null);
    }
    try {
      await twinApi.deleteSimulation(runId);
    } catch (err) {
      if (!mounted.current) return;
      setHistory(snapshot);
      setHistoryError(
        err instanceof ApiError ? err.detail : "Couldn't delete that simulation.",
      );
    }
  }, [openRunId]);

  return {
    result,
    pipeline,
    running,
    error,
    history,
    historyLoading,
    historyError,
    openRunId,
    openingId,
    run,
    reset,
    refreshHistory,
    openRun,
    removeRun,
  };
}
