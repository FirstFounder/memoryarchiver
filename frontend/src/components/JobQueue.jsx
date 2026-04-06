import { useJobs } from '../hooks/useJobs.js';
import { JobCard } from './JobCard.jsx';

export function JobQueue() {
  const { jobs, loading, error } = useJobs();

  const counts = jobs.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-slate-200 font-semibold text-sm">Processing Queue</h2>
        <div className="flex gap-3 text-xs text-slate-500">
          {counts.processing > 0 && (
            <span className="text-amber-400">{counts.processing} encoding</span>
          )}
          {counts.pending > 0 && (
            <span>{counts.pending} queued</span>
          )}
          {counts.done > 0 && (
            <span className="text-green-500">{counts.done} done</span>
          )}
        </div>
      </div>

      {/* Job list */}
      <div className="flex-1 overflow-y-auto space-y-3 min-h-0 pr-1">
        {loading && (
          <p className="text-slate-500 text-sm text-center mt-8">Loading queue…</p>
        )}
        {error && (
          <p className="text-red-400 text-sm text-center mt-8">{error}</p>
        )}
        {!loading && jobs.length === 0 && (
          <p className="text-slate-600 text-sm text-center mt-8">
            No jobs yet. Upload some clips to get started.
          </p>
        )}
        {jobs.map(job => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>
    </div>
  );
}
