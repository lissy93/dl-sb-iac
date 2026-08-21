/**
 * Monitor class for job health checks and error reporting
 * Integrates with healthchecks.io and GlitchTip for simple
 * monitoring of job status and error reporting.
 */
import { Logger } from "./logger.ts";

const MONITORED_JOBS = [
  "trigger-updates",
  "expiration-invites",
  "expiration-reminders",
  "website-monitor",
  "cleanup-notifications",
  "user-billing-check",
  "cleanup-monitor-data",
  "domain-update-batcher",
];

// healthchecks.io orders events by arrival, so pings are spaced to stay in sequence
const MIN_PING_GAP_MS = 150;
const PING_TIMEOUT_MS = 5000;

type PingType = "start" | "fail" | "success";

export interface MonitorOptions {
  healthcheckUrl?: string; // healthchecks.io UUID ping URL
  glitchtipUrl?: string; // GlitchTip endpoint (optional)
  glitchtipToken?: string; // GlitchTip auth token (optional)
  cronHeader?: string; // Header marking a run as cron-triggered
}

export class Monitor {
  private readonly logger: Logger;
  private readonly jobName: string;
  private readonly monitored: boolean;
  private readonly cronHeader: string;
  private readonly healthcheckUrl?: string;
  private readonly glitchtipUrl?: string;
  private readonly glitchtipToken?: string;
  private enabled = false;
  private pingChain: Promise<void> = Promise.resolve();
  private lastPingAt = 0;

  constructor(jobName: string, opts: MonitorOptions = {}) {
    this.jobName = jobName;
    this.logger = new Logger(jobName);
    this.monitored = MONITORED_JOBS.includes(jobName);
    this.cronHeader = opts.cronHeader ?? "X-Cron-Run";
    this.healthcheckUrl = opts.healthcheckUrl ?? Deno.env.get("HC_URL");
    this.glitchtipUrl = opts.glitchtipUrl ?? Deno.env.get("GLITCHTIP_URL");
    this.glitchtipToken = opts.glitchtipToken ?? Deno.env.get("GLITCHTIP_TOKEN");
  }

  /** Begin a run; only cron-triggered runs are reported to healthchecks.io */
  public start(req?: Request): Promise<void> {
    this.enabled = this.monitored &&
      req?.headers.get(this.cronHeader) === "true";
    this.logger.info("Job started");
    return this.ping("start");
  }

  /** Log and report a successful run */
  public success(msg = "Job completed successfully"): Promise<void> {
    this.logger.success(msg);
    return this.ping("success", msg);
  }

  /** Log the error, report it to GlitchTip, then signal failure */
  public async fail(error: unknown, context: Record<string, unknown> = {}) {
    this.logger.error(errMessage(error));
    if (this.glitchtipUrl && this.glitchtipToken) {
      await this.sendToGlitchTip(error, context);
    }
    await this.ping("fail");
  }

  /** Queue a ping behind any in-flight one, so events arrive in order */
  private ping(type: PingType, message?: string): Promise<void> {
    if (!this.healthcheckUrl || !this.enabled) return Promise.resolve();
    this.pingChain = this.pingChain.then(() => this.sendPing(type, message));
    return this.pingChain;
  }

  /** Send one ping, spaced from the previous. Never throws, to keep the chain alive */
  private async sendPing(type: PingType, message?: string): Promise<void> {
    const sinceLast = Date.now() - this.lastPingAt;
    if (this.lastPingAt && sinceLast < MIN_PING_GAP_MS) {
      await delay(MIN_PING_GAP_MS - sinceLast);
    }

    const isSuccess = type === "success";
    const url = `${this.healthcheckUrl}/${this.jobName}` +
      (isSuccess ? "" : `/${type}`);

    try {
      const res = await fetch(url, {
        method: isSuccess ? "POST" : "GET",
        headers: isSuccess ? { "Content-Type": "text/plain" } : undefined,
        body: isSuccess ? message ?? "" : undefined,
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      await res.body?.cancel();
    } catch (err) {
      this.logger.warn(`Healthcheck ${type} ping failed: ${errMessage(err)}`);
    } finally {
      this.lastPingAt = Date.now();
    }
  }

  /** Send a structured error report to GlitchTip (or any Sentry-compatible sink) */
  private async sendToGlitchTip(error: unknown, context: Record<string, unknown>) {
    const err = error as Error;
    const body = {
      exception: {
        values: [{
          type: err?.name ?? "Error",
          value: errMessage(error),
          stacktrace: {
            frames: (err?.stack ?? "").split("\n").map((line: string) => ({
              function: line.trim(),
            })),
          },
        }],
      },
      message: errMessage(error),
      level: "error",
      platform: "javascript",
      timestamp: Math.floor(Date.now() / 1000),
      tags: { job: this.jobName },
      contexts: context,
    };

    try {
      const res = await fetch(this.glitchtipUrl!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.glitchtipToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      await res.body?.cancel();
    } catch (err) {
      this.logger.warn(`GlitchTip reporting failed: ${errMessage(err)}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(error: unknown): string {
  return (error as Error)?.message || String(error ?? "") || "Unknown error";
}
