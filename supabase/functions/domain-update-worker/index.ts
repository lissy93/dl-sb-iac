import { serve } from '../shared/serveWithCors.ts';
import { getSupabaseClient } from '../shared/supabaseClient.ts';
import { Logger } from '../shared/logger.ts';
import { Monitor } from '../shared/monitor.ts';

const logger = new Logger('domain-update-worker');
const monitor = new Monitor('domain-update-batcher');
const DB_URL = Deno.env.get('DB_URL') ?? '';
const DOMAIN_UPDATER_URL = Deno.env.get('WORKER_DOMAIN_UPDATER_URL')
  ?? `${DB_URL}/functions/v1/domain-updater`;
const PER_JOB_TIMEOUT_MS = 45_000;
const JOBS_PER_RUN = Number(Deno.env.get('WORKER_JOBS_PER_RUN') ?? 20);

interface Job {
  domain: string;
  user_id: string;
  attempts: number;
}

serve(async (req) => {
  await monitor.start(req);
  const supabase = getSupabaseClient(req);
  const now = new Date();
  const retryCutoff = new Date(Date.now() - 60 * 1000);
  const authHeader = req.headers.get('Authorization') ?? '';

  try {
    const { data: jobs, error } = await supabase
      .from('domain_update_jobs')
      .select('*')
      .or(`status.eq.queued,and(status.eq.in_progress,last_attempt_at.lt.${retryCutoff.toISOString()})`)
      .order('last_attempt_at', { ascending: true })
      .limit(JOBS_PER_RUN);

    if (error) logger.error(`Failed to fetch jobs: ${error.message}`);
    if (error || !jobs?.length) {
      await monitor.success('No jobs to process');
      return new Response('No jobs to process', { status: 200 });
    }

    const results = await Promise.allSettled(
      jobs.map((job) => processJob(job, supabase, authHeader, now)),
    );
    const successCount = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    const failCount = results.length - successCount;

    const summary = `✅ ${successCount} succeeded, ❌ ${failCount} failed`;
    await monitor.success(summary);
    return new Response(summary, { status: 200 });
  } catch (err: any) {
    await monitor.fail(err);
    logger.error('Unexpected error: ' + err.message);
    return new Response('Internal Server Error', { status: 500 });
  }
});

// Mark a job in progress, dispatch the updater, and record the outcome.
async function processJob(
  job: Job,
  supabase: ReturnType<typeof getSupabaseClient>,
  authHeader: string,
  now: Date,
): Promise<boolean> {
  const { domain, user_id: userId } = job;
  const { error: markErr } = await supabase
    .from('domain_update_jobs')
    .update({
      status: 'in_progress',
      last_attempt_at: now.toISOString(),
      attempts: (job.attempts ?? 0) + 1,
    })
    .eq('domain', domain)
    .eq('user_id', userId);

  if (markErr) {
    logger.error(`Failed to mark in_progress: ${domain} - ${markErr.message}`);
    return false;
  }

  try {
    const res = await fetch(DOMAIN_UPDATER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ domain, user_id: userId }),
      signal: AbortSignal.timeout(PER_JOB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`updater returned ${res.status}: ${await res.text()}`);

    await supabase
      .from('domain_update_jobs')
      .update({ status: 'complete', last_updated_at: new Date().toISOString() })
      .eq('domain', domain)
      .eq('user_id', userId);
    return true;
  } catch (err) {
    await supabase
      .from('domain_update_jobs')
      .update({ status: 'failed' })
      .eq('domain', domain)
      .eq('user_id', userId);
    logger.warn(`Job failed: ${domain} - ${(err as Error).message}`);
    return false;
  }
}
