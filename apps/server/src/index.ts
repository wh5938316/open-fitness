import { createApp, scheduled } from './app';
import type { Env } from './types';
import { AppError } from './errors';

export { FitnessSyncDurableObject } from './sync/object';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await createApp(env).fetch(request, env, ctx);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE';
      console.error(JSON.stringify({ event: 'worker_unavailable', code }));
      return Response.json(
        {
          error: { code, message: 'The service is not configured or is temporarily unavailable.' },
        },
        { status: 503 },
      );
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await scheduled(env);
  },
} satisfies ExportedHandler<Env>;
