import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { AppError } from './errors';
import { t } from './i18n';
import type { FitnessService } from './domain/service';

export async function handleMcp(request: Request, service: FitnessService): Promise<Response> {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: 'OpenFitness', version: '0.1.0' },
        { instructions: t(service.actor.locale, 'botInstructions') },
      );
      for (const operation of service.operations.values()) {
        server.registerTool(
          operation.name,
          {
            description: operation.description,
            inputSchema: operation.schema as any,
            annotations: {
              readOnlyHint: operation.readOnly,
              destructiveHint: operation.name.startsWith('delete_'),
              idempotentHint: !operation.readOnly,
              openWorldHint: [
                'lookup_food',
                'search_food_catalog',
                'search_foods',
                'import_food',
                'refresh_food',
                'import_recipe_image',
              ].includes(operation.name),
            },
          },
          async (args: any) => {
            try {
              const data = await service.execute(operation.name, args);
              const result = { data };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                structuredContent: result,
              };
            } catch (error) {
              const app =
                error instanceof AppError
                  ? error
                  : new AppError(500, 'INTERNAL_ERROR', 'internalError');
              if (!(error instanceof AppError))
                console.error(
                  JSON.stringify({
                    event: 'tool_failed',
                    operation: operation.name,
                    code: 'INTERNAL_ERROR',
                  }),
                );
              const result = {
                error: {
                  code: app.code,
                  message: t(service.actor.locale, app.messageKey),
                  ...(app.details ? { details: app.details } : {}),
                },
              };
              return {
                isError: true,
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                structuredContent: result,
              };
            }
          },
        );
      }
      return server;
    },
    { legacy: 'stateless', responseMode: 'auto' },
  );
  return handler.fetch(request);
}
